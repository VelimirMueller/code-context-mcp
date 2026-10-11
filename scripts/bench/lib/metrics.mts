/**
 * Honest live-bench metrics (CCA-08). Pure maths over SessionResults.
 *
 * Why: `tokens.total` = input + cache_read + output. Providers bill a cache
 * read at about 1 % of an input token, so a "total tokens saved" figure is
 * mostly cache-read volume and says little about cost. The headline therefore
 * leads with:
 *   - uncached tokens = input + output + cache_write (what a cache could not serve),
 *   - cost in USD (when the agent CLI reports it),
 *   - tokens per PASS = all tokens of an arm / passing sessions of that arm
 *     (a cheap arm that fails more is not cheaper),
 *   - per-task paired deltas vs vanilla with the min–max spread over repeats
 *     (at n = 3 the run-to-run spread is wide; one mean hides it).
 */
import type { SavedSpread, SessionResult } from './types.mts';

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** (vanilla − arm) / vanilla × 100, one decimal; 0 when vanilla is 0. */
export function savedPct(vanilla: number, arm: number): number {
  return vanilla > 0 ? round1(((vanilla - arm) / vanilla) * 100) : 0;
}

/** Like savedPct, but null when either side is unknown or vanilla is not positive. */
export function savedPctOrNull(vanilla: number | null, arm: number | null): number | null {
  if (typeof vanilla !== 'number' || typeof arm !== 'number' || vanilla <= 0) return null;
  return savedPct(vanilla, arm);
}

/** input + output + cache_write of one session: the tokens no cache served. */
export function uncachedOf(r: SessionResult): number {
  return r.tokens.input + r.tokens.output + (r.tokens.cache_write ?? 0);
}

/** input + cache_read + output of one session: every token the model processed. */
export function totalOf(r: SessionResult): number {
  return r.tokens.input + (r.tokens.cache_read ?? 0) + r.tokens.output;
}

/** Sum of session costs; null when there are none or any one is unknown. */
export function costOf(results: SessionResult[]): number | null {
  if (results.length === 0) return null;
  let sum = 0;
  for (const r of results) {
    if (typeof r.cost_usd !== 'number') return null;
    sum += r.cost_usd;
  }
  return Math.round(sum * 1e6) / 1e6;
}

/** One arm over all its sessions. Per-PASS values are null when nothing passed. */
export interface ArmEfficiency {
  sessions: number;
  passes: number;
  tokens_total: number;
  uncached_tokens: number;
  cost_usd: number | null;
  tokens_per_pass: number | null;
  uncached_per_pass: number | null;
  cost_per_pass: number | null;
}

export function armEfficiency(results: SessionResult[]): ArmEfficiency {
  const passes = results.filter((r) => r.success).length;
  const total = results.reduce((s, r) => s + totalOf(r), 0);
  const uncached = results.reduce((s, r) => s + uncachedOf(r), 0);
  const cost = costOf(results);
  const per = (x: number): number | null => (passes > 0 ? Math.round(x / passes) : null);
  return {
    sessions: results.length,
    passes,
    tokens_total: total,
    uncached_tokens: uncached,
    cost_usd: cost,
    tokens_per_pass: per(total),
    uncached_per_pass: per(uncached),
    cost_per_pass: passes > 0 && cost !== null ? Math.round((cost / passes) * 1e6) / 1e6 : null,
  };
}

/** Repeat number of a session: `-rN` in its events file, else its 1-based position. */
export function repeatOf(r: SessionResult, position: number): number {
  const m = /-r(\d+)\.jsonl$/.exec(r.events_path ?? '');
  return m ? Number(m[1]) : position + 1;
}

function byRepeat(results: SessionResult[]): Map<number, SessionResult> {
  const out = new Map<number, SessionResult>();
  results.forEach((r, i) => out.set(repeatOf(r, i), r));
  return out;
}

/** Min–max of a per-repeat saved % (needs at least 2 repeats). */
export type Spread = SavedSpread;

/**
 * Paired delta of one arm vs vanilla for one task, on uncached tokens.
 * Repeat k of the arm pairs with repeat k of vanilla. `saved_pct` is on the
 * summed pairs; `min` / `max` are the per-pair saved %.
 */
export interface PairedDelta {
  pairs: number;
  saved_pct: number;
  min: number;
  max: number;
}

export function pairedDelta(vanilla: SessionResult[], arm: SessionResult[]): PairedDelta | null {
  const v = byRepeat(vanilla);
  const a = byRepeat(arm);
  const pcts: number[] = [];
  let vSum = 0;
  let aSum = 0;
  for (const [k, vr] of v) {
    const ar = a.get(k);
    if (!ar) continue;
    const vu = uncachedOf(vr);
    if (vu <= 0) continue;
    const au = uncachedOf(ar);
    vSum += vu;
    aSum += au;
    pcts.push(savedPct(vu, au));
  }
  if (pcts.length === 0) return null;
  return {
    pairs: pcts.length,
    saved_pct: savedPct(vSum, aSum),
    min: Math.min(...pcts),
    max: Math.max(...pcts),
  };
}

/**
 * Spread of the run-level uncached saved % over repeats: for each repeat k,
 * sum uncached over the tasks where both arms have repeat k, then saved %.
 * Null with fewer than two repeats.
 */
export function repeatSpread(
  taskIds: string[],
  vanilla: SessionResult[],
  arm: SessionResult[],
): Spread | null {
  const sums = new Map<number, { v: number; a: number }>();
  for (const id of taskIds) {
    const v = byRepeat(vanilla.filter((r) => r.task_id === id));
    const a = byRepeat(arm.filter((r) => r.task_id === id));
    for (const [k, vr] of v) {
      const ar = a.get(k);
      if (!ar) continue;
      const s = sums.get(k) ?? { v: 0, a: 0 };
      s.v += uncachedOf(vr);
      s.a += uncachedOf(ar);
      sums.set(k, s);
    }
  }
  const pcts = [...sums.values()].filter((s) => s.v > 0).map((s) => savedPct(s.v, s.a));
  if (pcts.length < 2) return null;
  return { min: Math.min(...pcts), max: Math.max(...pcts), repeats: pcts.length };
}

/** The honest headline fields (merged into AgentHeadline). */
export interface HonestHeadline {
  uncached_saved_pct: number;
  guided_uncached_saved_pct?: number;
  uncached_saved_spread: Spread | null;
  guided_uncached_saved_spread?: Spread | null;
  cost_saved_pct: number | null;
  guided_cost_saved_pct?: number | null;
  uncached_per_pass: { vanilla: number | null; cc: number | null; cc_guided?: number | null };
}

export interface HonestAggregate {
  per_pass: { vanilla: ArmEfficiency; cc: ArmEfficiency; cc_guided?: ArmEfficiency };
  uncached_tokens: {
    vanilla: number;
    cc: number;
    saved_pct: number;
    spread: Spread | null;
    cc_guided?: number;
    guided_saved_pct?: number;
    guided_spread?: Spread | null;
  };
  cost_saved_pct: { cc: number | null; cc_guided?: number | null };
}

/** Run-level honest metrics. `guided` empty = a two-arm run (no guided fields). */
export function honestMetrics(
  taskIds: string[],
  vanilla: SessionResult[],
  cc: SessionResult[],
  guided: SessionResult[],
): { aggregate: HonestAggregate; headline: HonestHeadline } {
  const hasGuided = guided.length > 0;
  const ev = armEfficiency(vanilla);
  const ec = armEfficiency(cc);
  const eg = hasGuided ? armEfficiency(guided) : null;
  const uSaved = savedPct(ev.uncached_tokens, ec.uncached_tokens);
  const spread = repeatSpread(taskIds, vanilla, cc);
  const costSaved = savedPctOrNull(ev.cost_usd, ec.cost_usd);
  const gUSaved = eg ? savedPct(ev.uncached_tokens, eg.uncached_tokens) : 0;
  const gSpread = eg ? repeatSpread(taskIds, vanilla, guided) : null;
  const gCostSaved = eg ? savedPctOrNull(ev.cost_usd, eg.cost_usd) : null;

  const aggregate: HonestAggregate = {
    per_pass: { vanilla: ev, cc: ec, ...(eg ? { cc_guided: eg } : {}) },
    uncached_tokens: {
      vanilla: ev.uncached_tokens,
      cc: ec.uncached_tokens,
      saved_pct: uSaved,
      spread,
      ...(eg
        ? { cc_guided: eg.uncached_tokens, guided_saved_pct: gUSaved, guided_spread: gSpread }
        : {}),
    },
    cost_saved_pct: { cc: costSaved, ...(eg ? { cc_guided: gCostSaved } : {}) },
  };
  const headline: HonestHeadline = {
    uncached_saved_pct: uSaved,
    ...(eg ? { guided_uncached_saved_pct: gUSaved } : {}),
    uncached_saved_spread: spread,
    ...(eg ? { guided_uncached_saved_spread: gSpread } : {}),
    cost_saved_pct: costSaved,
    ...(eg ? { guided_cost_saved_pct: gCostSaved } : {}),
    uncached_per_pass: {
      vanilla: ev.uncached_per_pass,
      cc: ec.uncached_per_pass,
      ...(eg ? { cc_guided: eg.uncached_per_pass } : {}),
    },
  };
  return { aggregate, headline };
}
