/**
 * Rule-based verdict for an agent run (CCA-20). Pure, no imports: the bench
 * scripts, the index builder and the dashboard import this file; the static
 * site carries a port in site/data.js (BenchData.computeVerdict) that a test
 * runs against this module on the same inputs (test/bench-verdict.test.ts).
 *
 * The owner's rule: "a feature that is 5 % better but 25 % slower is not
 * worth it". Each code-context arm (cc, cc_guided) is compared with vanilla:
 *
 *   SUBOPTIMAL  the success rate drops by more than 5 percentage points, OR
 *               the uncached-token spread is below 0 in every repeat (max < 0), OR
 *               with fewer than 3 repeats: the uncached tokens increase by
 *               10 % or more (uncached saving <= -10 %), OR
 *               the tasks are more than 25 % slower (mean wall time).
 *   BENEFICIAL  not SUBOPTIMAL, AND the success rate does not drop by more than
 *               5 pp, AND the uncached tokens decrease in every repeat
 *               (spread min > 0; with fewer than 3 repeats: the uncached
 *               saving is at least 10 %), AND the tasks are not more than
 *               25 % slower, AND the cost does not increase (cost saved is
 *               unknown or >= 0).
 *   NO_CLEAR_EFFECT  every other case.
 *
 * A run with fewer than 3 repeats still gets a verdict, marked "indicative".
 * The run verdict is the verdict of the best arm (BENEFICIAL > NO_CLEAR_EFFECT
 * > SUBOPTIMAL; on a tie, cc_guided wins).
 *
 * Before #158 the lowest outcome was called HARMFUL. Stored verdicts with that
 * code are read as SUBOPTIMAL (LEGACY_VERDICT_CODES, normalizeVerdict).
 *
 * Every sentence is generated from fixed ASD-STE100 templates and whole-%
 * numbers only: short, active voice, present tense, one fact per sentence.
 * The private summary (private-summary.mts) relies on that: its verdict text
 * holds no suite-derived word.
 */

/** All verdict thresholds in one place. Edges: "more than" is strict. */
export const VERDICT_RULE = Object.freeze({
  /** Fewer repeats than this: the verdict is "indicative". */
  minRepeats: 3,
  /** SUBOPTIMAL when the success rate drops by more than this (percentage points). */
  maxSuccessDropPp: 5,
  /** SUBOPTIMAL when the mean wall time is more than this % slower than vanilla. */
  maxSlowerPct: 25,
  /** With fewer than minRepeats repeats, BENEFICIAL needs this uncached saving (%). */
  minSavedPctFewRepeats: 10,
  /** With fewer than minRepeats repeats, SUBOPTIMAL when the uncached tokens increase by at least this (%). */
  minIncreasePctFewRepeats: 10,
  /** NO_CLEAR_EFFECT with |uncached saved| below this reads "the effect is small". */
  smallEffectPct: 10,
});

export type VerdictCode = 'BENEFICIAL' | 'NO_CLEAR_EFFECT' | 'SUBOPTIMAL';
export const VERDICT_CODES: readonly VerdictCode[] = [
  'BENEFICIAL',
  'NO_CLEAR_EFFECT',
  'SUBOPTIMAL',
];
/** Old stored codes and the code they mean now (#158). */
export const LEGACY_VERDICT_CODES: Readonly<Record<string, VerdictCode>> = Object.freeze({
  HARMFUL: 'SUBOPTIMAL',
});
/** Display label per code (dashboard chip, site badge). */
export const VERDICT_LABELS: Readonly<Record<VerdictCode, string>> = Object.freeze({
  BENEFICIAL: 'BENEFICIAL',
  NO_CLEAR_EFFECT: 'NO CLEAR EFFECT',
  SUBOPTIMAL: 'SUBOPTIMAL',
});

export type VerdictArmKey = 'cc' | 'cc_guided';

export interface VerdictSpread {
  min: number;
  max: number;
  repeats: number;
}

/** One code-context arm against vanilla. null = not known. */
export interface VerdictArmInput {
  success_vanilla_pct: number | null;
  success_arm_pct: number | null;
  /** (vanilla − arm) / vanilla on input + output + cache_write, %. */
  uncached_saved_pct: number | null;
  /** Min–max of uncached_saved_pct over repeats; null with one repeat. */
  spread: VerdictSpread | null;
  /** (vanilla − arm) / vanilla on USD, %; null when unknown. */
  cost_saved_pct: number | null;
  /** (vanilla mean − arm mean) / vanilla mean wall time, %; positive = faster. */
  wall_faster_pct: number | null;
}

export interface VerdictInput {
  /** Repeats per task and arm. */
  repeats: number;
  cc: VerdictArmInput | null;
  cc_guided?: VerdictArmInput | null;
}

export interface ArmVerdict {
  code: VerdictCode;
  sentences: string[];
}

export interface RunVerdict {
  code: VerdictCode;
  /** true when repeats < VERDICT_RULE.minRepeats. */
  indicative: boolean;
  repeats: number;
  /** The arm the run verdict comes from. */
  arm: VerdictArmKey;
  arms: { cc?: ArmVerdict; cc_guided?: ArmVerdict };
  /** Headline sentence first, then the facts, warnings and the indicative note. */
  sentences: string[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const round1 = (x: number): number => Math.round(x * 10) / 10;
/** Whole number, never "-0". */
const whole = (x: number): number => {
  const r = Math.round(x);
  return r === 0 ? 0 : r;
};

interface ArmFacts {
  code: VerdictCode;
  successDropTooBig: boolean;
  alwaysWorse: boolean;
  tooSlow: boolean;
  unstable: boolean;
  /** Fewer than minRepeats repeats and the uncached tokens increase by >= 10 %. */
  fewRepeatsWorse: boolean;
  repeats: number;
  /** Uncached token increase in %, whole number (for the reason sentence). */
  increasePct: number;
}

/** The rule for one arm. Exported for the rule-table test. */
export function armCode(a: VerdictArmInput, repeats: number): VerdictCode {
  return armFacts(a, repeats).code;
}

function armFacts(a: VerdictArmInput, repeats: number): ArmFacts {
  const R = VERDICT_RULE;
  const delta =
    isNum(a.success_vanilla_pct) && isNum(a.success_arm_pct)
      ? round1(a.success_arm_pct - a.success_vanilla_pct)
      : 0;
  const successDropTooBig = delta < -R.maxSuccessDropPp;
  const sp = a.spread && isNum(a.spread.min) && isNum(a.spread.max) ? a.spread : null;
  const alwaysWorse = !!sp && sp.max < 0;
  const tooSlow = isNum(a.wall_faster_pct) && a.wall_faster_pct < -R.maxSlowerPct;
  const unstable = !!sp && sp.min <= 0 && sp.max >= 0;
  // The spread decides with enough repeats; else the point estimate (both ways).
  const useSpread = repeats >= R.minRepeats && !!sp;
  const fewRepeatsWorse =
    !useSpread &&
    isNum(a.uncached_saved_pct) &&
    a.uncached_saved_pct <= -R.minIncreasePctFewRepeats;
  const increasePct = isNum(a.uncached_saved_pct) ? whole(-a.uncached_saved_pct) : 0;
  let code: VerdictCode;
  if (successDropTooBig || alwaysWorse || fewRepeatsWorse || tooSlow) code = 'SUBOPTIMAL';
  else {
    const tokensOk = useSpread
      ? (sp as VerdictSpread).min > 0
      : isNum(a.uncached_saved_pct) && a.uncached_saved_pct >= R.minSavedPctFewRepeats;
    const costOk = !isNum(a.cost_saved_pct) || a.cost_saved_pct >= 0;
    code = tokensOk && costOk ? 'BENEFICIAL' : 'NO_CLEAR_EFFECT';
  }
  return {
    code,
    successDropTooBig,
    alwaysWorse,
    tooSlow,
    unstable,
    fewRepeatsWorse,
    repeats,
    increasePct,
  };
}

const PREFIX: Record<VerdictArmKey, string> = {
  cc: 'Without guidance, ',
  cc_guided: 'With guidance, ',
};

/** "<prefix>code-context decreases the token use by 28 %." and the other fact sentences. */
function factSentences(a: VerdictArmInput, prefix: string): string[] {
  const out: string[] = [];
  let subject = prefix ? `${prefix}code-context` : 'Code-context';
  if (isNum(a.uncached_saved_pct)) {
    const s = whole(a.uncached_saved_pct);
    out.push(
      s > 0
        ? `${subject} decreases the token use by ${s} %.`
        : s < 0
          ? `${subject} increases the token use by ${-s} %.`
          : `${subject} does not change the token use.`,
    );
    subject = 'It';
  }
  if (isNum(a.cost_saved_pct)) {
    const c = whole(a.cost_saved_pct);
    out.push(
      c > 0
        ? `${subject} decreases the cost by ${c} %.`
        : c < 0
          ? `${subject} increases the cost by ${-c} %.`
          : `${subject} does not change the cost.`,
    );
  }
  if (isNum(a.wall_faster_pct)) {
    const w = whole(a.wall_faster_pct);
    out.push(
      w > 0
        ? `The tasks complete ${w} % faster.`
        : w < 0
          ? `The tasks complete ${-w} % slower.`
          : 'The tasks complete in the same time.',
    );
  } else {
    out.push('The wall time is not known.');
  }
  if (isNum(a.success_vanilla_pct) && isNum(a.success_arm_pct)) {
    const v = whole(a.success_vanilla_pct);
    const r = whole(a.success_arm_pct);
    out.push(
      r > v
        ? `The success rate increases from ${v} % to ${r} %.`
        : r < v
          ? `The success rate decreases from ${v} % to ${r} %.`
          : `The success rate is ${v} % with and without code-context.`,
    );
  }
  return out;
}

function warningSentences(f: ArmFacts): string[] {
  const R = VERDICT_RULE;
  const out: string[] = [];
  if (f.successDropTooBig)
    out.push(`The success rate decreases by more than ${R.maxSuccessDropPp} percentage points.`);
  if (f.tooSlow) out.push(`The tasks are more than ${R.maxSlowerPct} % slower.`);
  if (f.alwaysWorse) out.push('The token use increases in all repeats.');
  if (f.fewRepeatsWorse)
    out.push(
      `The token use increases by ${f.increasePct} % in ${f.repeats} ${f.repeats === 1 ? 'repeat' : 'repeats'}.`,
    );
  if (f.unstable) out.push('The result is not stable across repeats.');
  return out;
}

function headlineSentence(
  best: VerdictArmKey,
  codes: Partial<Record<VerdictArmKey, VerdictCode>>,
): string {
  const code = codes[best] as VerdictCode;
  if (code === 'SUBOPTIMAL') return 'Result: code-context is suboptimal for these tasks.';
  if (code === 'NO_CLEAR_EFFECT') return 'Result: code-context shows no clear effect.';
  const both = codes.cc !== undefined && codes.cc_guided !== undefined;
  if (!both) return 'Result: code-context helps.';
  if (codes.cc === 'BENEFICIAL' && codes.cc_guided === 'BENEFICIAL')
    return 'Result: code-context helps with and without the instruction to use it.';
  return best === 'cc_guided'
    ? 'Result: code-context helps when the agent gets the instruction to use it.'
    : 'Result: code-context helps when the agent gets no instruction to use it.';
}

/** The short summary of the arm that is not the best one. */
function otherArmSentences(
  key: VerdictArmKey,
  a: VerdictArmInput,
  f: ArmFacts,
  bestCode: VerdictCode,
): string[] {
  const p = PREFIX[key];
  if (f.code === 'BENEFICIAL') {
    const out = [`${p}code-context also helps.`];
    if (isNum(a.uncached_saved_pct) && whole(a.uncached_saved_pct) > 0)
      out.push(`It decreases the token use by ${whole(a.uncached_saved_pct)} %.`);
    return out;
  }
  if (f.code === 'SUBOPTIMAL')
    return [
      `${p}code-context is ${bestCode === 'SUBOPTIMAL' ? 'also ' : ''}suboptimal.`,
      ...warningSentences(f),
    ];
  const small =
    !isNum(a.uncached_saved_pct) || Math.abs(a.uncached_saved_pct) < VERDICT_RULE.smallEffectPct;
  return [`${p}the effect is ${small ? 'small' : 'not clear'}.`];
}

function indicativeSentence(repeats: number): string {
  return `This result is indicative only: the run has ${repeats} ${repeats === 1 ? 'repeat' : 'repeats'}.`;
}

const RANK: Record<VerdictCode, number> = { BENEFICIAL: 2, NO_CLEAR_EFFECT: 1, SUBOPTIMAL: 0 };

/** The run verdict; null when no arm has data. Deterministic for given numbers. */
export function computeVerdict(input: VerdictInput): RunVerdict | null {
  const repeats = isNum(input.repeats) && input.repeats > 0 ? Math.round(input.repeats) : 1;
  const keys: VerdictArmKey[] = [];
  if (input.cc) keys.push('cc');
  if (input.cc_guided) keys.push('cc_guided');
  if (keys.length === 0) return null;
  const both = keys.length === 2;
  const facts: Partial<Record<VerdictArmKey, ArmFacts>> = {};
  const codes: Partial<Record<VerdictArmKey, VerdictCode>> = {};
  const arms: RunVerdict['arms'] = {};
  for (const k of keys) {
    const a = input[k] as VerdictArmInput;
    const f = armFacts(a, repeats);
    facts[k] = f;
    codes[k] = f.code;
    arms[k] = {
      code: f.code,
      sentences: [...factSentences(a, both ? PREFIX[k] : ''), ...warningSentences(f)],
    };
  }
  // Best arm; on a tie cc_guided wins (it is checked last with >=).
  let best: VerdictArmKey = keys[0];
  for (const k of keys)
    if (RANK[codes[k] as VerdictCode] >= RANK[codes[best] as VerdictCode]) best = k;
  const bestCode = codes[best] as VerdictCode;
  const indicative = repeats < VERDICT_RULE.minRepeats;
  const sentences = [headlineSentence(best, codes), ...(arms[best] as ArmVerdict).sentences];
  for (const k of keys)
    if (k !== best)
      sentences.push(
        ...otherArmSentences(k, input[k] as VerdictArmInput, facts[k] as ArmFacts, bestCode),
      );
  if (indicative) sentences.push(indicativeSentence(repeats));
  return { code: bestCode, indicative, repeats, arm: best, arms, sentences };
}

// ─── adapters ─────────────────────────────────────────────────────────────────

/** (vanilla − arm) / vanilla × 100, one decimal; null when unknown. Positive = faster. */
export function wallFasterPct(vanillaMs: unknown, armMs: unknown): number | null {
  if (!isNum(vanillaMs) || !isNum(armMs) || vanillaMs <= 0) return null;
  return round1(((vanillaMs - armMs) / vanillaMs) * 100);
}

/** Repeats per task of one arm: the highest session count of any task. */
export function repeatsOf(results: ReadonlyArray<{ task_id: string }>): number {
  const n = new Map<string, number>();
  for (const r of results) n.set(r.task_id, (n.get(r.task_id) ?? 0) + 1);
  return Math.max(0, ...n.values());
}

const asRec = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};

function spreadOf(x: unknown): VerdictSpread | null {
  const s = asRec(x);
  return isNum(s.min) && isNum(s.max)
    ? { min: s.min, max: s.max, repeats: isNum(s.repeats) ? s.repeats : 0 }
    : null;
}
const numOrNull = (x: unknown): number | null => (isNum(x) ? x : null);

export interface HeadlineVerdictOptions {
  /** Repeats per task and arm; default: the largest spread.repeats, else 1. */
  repeats?: number | null;
  /** aggregate.wall_ms of the run ({ vanilla_mean, cc_mean, cc_guided_mean }). */
  wall?: unknown;
}

/** Verdict input from an agent headline (+ the run's wall means when known). */
export function verdictInputFromHeadline(
  headline: unknown,
  opts: HeadlineVerdictOptions = {},
): VerdictInput | null {
  const h = asRec(headline);
  // No uncached-token figure (a pre-CCA-08 entry without sessions): no verdict.
  if (!isNum(h.success_vanilla_pct) || !isNum(h.success_cc_pct) || !isNum(h.uncached_saved_pct))
    return null;
  const w = asRec(opts.wall);
  const cc: VerdictArmInput = {
    success_vanilla_pct: h.success_vanilla_pct,
    success_arm_pct: h.success_cc_pct,
    uncached_saved_pct: numOrNull(h.uncached_saved_pct),
    spread: spreadOf(h.uncached_saved_spread),
    cost_saved_pct: numOrNull(h.cost_saved_pct),
    wall_faster_pct: wallFasterPct(w.vanilla_mean, w.cc_mean),
  };
  const guided: VerdictArmInput | null = isNum(h.success_cc_guided_pct)
    ? {
        success_vanilla_pct: h.success_vanilla_pct,
        success_arm_pct: h.success_cc_guided_pct,
        uncached_saved_pct: numOrNull(h.guided_uncached_saved_pct),
        spread: spreadOf(h.guided_uncached_saved_spread),
        cost_saved_pct: numOrNull(h.guided_cost_saved_pct),
        wall_faster_pct: wallFasterPct(w.vanilla_mean, w.cc_guided_mean),
      }
    : null;
  const fromSpread = Math.max(cc.spread?.repeats ?? 0, guided?.spread?.repeats ?? 0);
  const repeats = isNum(opts.repeats) && opts.repeats > 0 ? opts.repeats : fromSpread || 1;
  return { repeats, cc, ...(guided ? { cc_guided: guided } : {}) };
}

export function verdictFromHeadline(
  headline: unknown,
  opts: HeadlineVerdictOptions = {},
): RunVerdict | null {
  const input = verdictInputFromHeadline(headline, opts);
  return input ? computeVerdict(input) : null;
}

/**
 * Verdict input from a private-summary block ({ arms, saved }, CCA-19):
 * success_pct and wall_mean_ms per arm, saved.* per code-context arm.
 */
export function verdictInputFromBlock(block: unknown, repeats: number): VerdictInput | null {
  const b = asRec(block);
  const arms = asRec(b.arms);
  const saved = asRec(b.saved);
  const v = asRec(arms.vanilla);
  if (!isNum(v.success_pct)) return null;
  const arm = (k: VerdictArmKey): VerdictArmInput | null => {
    const a = asRec(arms[k]);
    const s = asRec(saved[k]);
    if (!isNum(a.success_pct) || !(k in saved)) return null;
    return {
      success_vanilla_pct: v.success_pct as number,
      success_arm_pct: a.success_pct,
      uncached_saved_pct: numOrNull(s.uncached_saved_pct),
      spread: spreadOf(s.uncached_saved_spread),
      cost_saved_pct: numOrNull(s.cost_saved_pct),
      wall_faster_pct: wallFasterPct(v.wall_mean_ms, a.wall_mean_ms),
    };
  };
  const cc = arm('cc');
  const g = arm('cc_guided');
  return { repeats, cc, ...(g ? { cc_guided: g } : {}) };
}

/** A stored verdict object that is safe to render as is (codes known, text only). */
export function isRunVerdict(x: unknown): x is RunVerdict {
  const v = asRec(x);
  return (
    VERDICT_CODES.includes(v.code as VerdictCode) &&
    typeof v.indicative === 'boolean' &&
    (v.arm === 'cc' || v.arm === 'cc_guided') &&
    Array.isArray(v.sentences) &&
    v.sentences.every((s) => typeof s === 'string')
  );
}

/** Old sentence templates (before #158) and their current text. */
const LEGACY_HEADLINE = 'Result: code-context makes the result worse.';
const LEGACY_ARM_RE = /^(.*)code-context (also )?makes the result worse\.$/;

function legacySentence(s: string): string {
  if (s === LEGACY_HEADLINE) return 'Result: code-context is suboptimal for these tasks.';
  const m = LEGACY_ARM_RE.exec(s);
  return m ? `${m[1]}code-context is ${m[2] ?? ''}suboptimal.` : s;
}

const currentCode = (c: unknown): unknown =>
  typeof c === 'string' && c in LEGACY_VERDICT_CODES ? LEGACY_VERDICT_CODES[c] : c;

/** true when a stored verdict uses an old code (HARMFUL) anywhere. */
export function isLegacyVerdict(x: unknown): boolean {
  const v = asRec(x);
  if (typeof v.code === 'string' && v.code in LEGACY_VERDICT_CODES) return true;
  return Object.values(asRec(v.arms)).some((a) => {
    const c = asRec(a).code;
    return typeof c === 'string' && c in LEGACY_VERDICT_CODES;
  });
}

/**
 * A stored verdict in the current vocabulary, or null when it is not a
 * verdict. Old codes (HARMFUL) become SUBOPTIMAL and the old sentences get
 * the current text; a current verdict comes back unchanged.
 */
export function normalizeVerdict(x: unknown): RunVerdict | null {
  if (!isLegacyVerdict(x)) return isRunVerdict(x) ? x : null;
  const v = asRec(x);
  const arms: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(asRec(v.arms))) {
    const ar = asRec(a);
    arms[k] = {
      ...ar,
      code: currentCode(ar.code),
      ...(Array.isArray(ar.sentences)
        ? { sentences: ar.sentences.map((s) => (typeof s === 'string' ? legacySentence(s) : s)) }
        : {}),
    };
  }
  const out = {
    ...v,
    code: currentCode(v.code),
    arms,
    sentences: Array.isArray(v.sentences)
      ? v.sentences.map((s) => (typeof s === 'string' ? legacySentence(s) : s))
      : v.sentences,
  };
  return isRunVerdict(out) ? out : null;
}

// ─── short summary (#160) ─────────────────────────────────────────────────────

/** The warning templates of warningSentences(), as one pattern. */
const WARNING_RE =
  /^The (success rate decreases by more than |tasks are more than |token use increases (in all repeats|by \d+ % in )|result is not stable across repeats)/;

/**
 * Two sentences for a plain summary line (#160): the result sentence of the
 * verdict and its main reason. The reason is the first warning sentence when
 * the verdict is not BENEFICIAL and has one, else the first fact of the best
 * arm (the token sentence when the token use is known). No new rule: both
 * sentences come from the verdict as is.
 */
export function verdictSummary(v: RunVerdict | null | undefined): string[] {
  if (!v || v.sentences.length === 0) return [];
  const [head, ...rest] = v.sentences;
  const warning = v.code === 'BENEFICIAL' ? undefined : rest.find((s) => WARNING_RE.test(s));
  const reason = warning ?? rest[0];
  return reason ? [head, reason] : [head];
}
