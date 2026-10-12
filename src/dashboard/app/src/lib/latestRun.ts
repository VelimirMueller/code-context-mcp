import type { AgentHeadline, BenchIndexEntry, BenchRun } from '@/stores/benchmarkStore';
import {
  normalizeVerdict,
  repeatsOf,
  verdictFromHeadline,
  verdictInputFromHeadline,
  verdictSummary,
  type RunVerdict,
  type VerdictArmInput,
  type VerdictArmKey,
} from '@bench/verdict.mts';

/** The agent models of the latest-run table, in row order (#160). */
export const MODEL_ROWS = [
  { kind: 'agent-glm', label: 'GLM' },
  { kind: 'agent-opus', label: 'Opus' },
  { kind: 'agent-deepseek', label: 'DeepSeek' },
] as const;

export function isAgentHeadline(h: BenchIndexEntry['headline']): h is AgentHeadline {
  return !!h && 'success_vanilla_pct' in h;
}

/**
 * "Latest run" (#160): for each agent model (GLM, Opus, DeepSeek) its newest
 * run among ALL runs, public and private alike. The merged index is newest
 * first, so the first run of each kind wins. The run filter does not apply:
 * the table always shows the newest measurement of each model.
 */
export function latestPerModel(runs: BenchIndexEntry[]): BenchIndexEntry[] {
  return MODEL_ROWS.map((m) => runs.find((r) => r.kind === m.kind)).filter(
    (r): r is BenchIndexEntry => !!r,
  );
}

/**
 * The CCA-20 verdict of an agent run: the stored one (run file, then index
 * entry), else computed from the headline with the run's wall means and
 * repeats when the run file is loaded. Same rule as scripts/bench.
 */
export function verdictOf(entry: BenchIndexEntry, run: BenchRun | undefined): RunVerdict | null {
  const h = entry.headline;
  if (!isAgentHeadline(h)) return null;
  // normalizeVerdict reads an old HARMFUL verdict as SUBOPTIMAL (#158).
  const stored = normalizeVerdict(run?.headline?.verdict) ?? normalizeVerdict(h.verdict);
  if (stored) return stored;
  const results = run?.arms?.vanilla?.results;
  return verdictFromHeadline(h, {
    wall: run?.aggregate?.wall_ms,
    repeats: Array.isArray(results) ? repeatsOf(results) : null,
  });
}

export interface SimpleRow {
  kind: string;
  label: string;
  entry: BenchIndexEntry;
  verdict: RunVerdict | null;
  successVanillaPct: number | null;
  successArmPct: number | null;
  /** Uncached tokens saved, %: positive = fewer tokens than vanilla. */
  tokensSavedPct: number | null;
  costSavedPct: number | null;
  /** Mean wall time, %: positive = faster than vanilla. */
  fasterPct: number | null;
  repeats: number | null;
  /** Result sentence + main reason (verdictSummary). */
  summary: string[];
}

/** The table row of one run: the verdict and the numbers of its best arm. */
export function simpleRow(entry: BenchIndexEntry, run: BenchRun | undefined): SimpleRow {
  const label = MODEL_ROWS.find((m) => m.kind === entry.kind)?.label ?? entry.kind;
  const verdict = verdictOf(entry, run);
  const results = run?.arms?.vanilla?.results;
  const input = verdictInputFromHeadline(entry.headline, {
    wall: run?.aggregate?.wall_ms,
    repeats: Array.isArray(results) ? repeatsOf(results) : null,
  });
  // Only a code-context arm is "with code-context"; never vanilla.
  const best: VerdictArmKey = verdict?.arm === 'cc_guided' ? 'cc_guided' : 'cc';
  const a: VerdictArmInput | null = input?.[best] || input?.cc || null;
  return {
    kind: entry.kind,
    label,
    entry,
    verdict,
    successVanillaPct: a?.success_vanilla_pct ?? null,
    successArmPct: a?.success_arm_pct ?? null,
    tokensSavedPct: a?.uncached_saved_pct ?? null,
    costSavedPct: a?.cost_saved_pct ?? null,
    fasterPct: a?.wall_faster_pct ?? null,
    repeats: verdict?.repeats ?? input?.repeats ?? null,
    summary: verdictSummary(verdict),
  };
}

const whole = (x: number): number => {
  const r = Math.round(x);
  return r === 0 ? 0 : r;
};

/**
 * Sign of a change as the table shows it: the whole-% value decides, so a
 * value that rounds to 0 is "same" in the text and neutral in the colour.
 * null when unknown.
 */
export function changeSign(savedPct: number | null | undefined): -1 | 0 | 1 | null {
  if (typeof savedPct !== 'number' || !Number.isFinite(savedPct)) return null;
  return Math.sign(whole(savedPct)) as -1 | 0 | 1;
}

/** "25 % less" / "8 % more" / "same"; "—" when unknown. */
export function changeText(
  savedPct: number | null | undefined,
  better: string,
  worse: string,
): string {
  const s = changeSign(savedPct);
  if (s === null) return '—';
  const r = Math.abs(whole(savedPct as number));
  return s > 0 ? `${r} % ${better}` : s < 0 ? `${r} % ${worse}` : 'same';
}

/** "92 % → 86 %" (vanilla → with code-context); "—" when unknown. */
export function successText(row: Pick<SimpleRow, 'successVanillaPct' | 'successArmPct'>): string {
  const { successVanillaPct: v, successArmPct: a } = row;
  return typeof v === 'number' && typeof a === 'number' ? `${whole(v)} % → ${whole(a)} %` : '—';
}

/** The summary line without a leading "Result: ", first letter in upper case. */
export function plainSummary(summary: string[]): string {
  const t = summary.join(' ').replace(/^Result:\s*/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
