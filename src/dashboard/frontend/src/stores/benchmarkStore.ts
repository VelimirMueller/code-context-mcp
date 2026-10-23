import { create } from 'zustand';
import { get } from '@/lib/api';
import type { RunVerdict } from '@bench/verdict.mts';

export interface BenchmarkTask {
  id: string;
  label: string;
  category: string;
  points: number;
  mcp: { tokens: number; calls: number; files: number };
  vanilla: { tokens: number; calls: number; files: number };
  tokenSavingsPct: number;
  callSavingsPct: number;
}

export interface BenchmarkMeta {
  fixture: string;
  fileCount: number;
  tsFileCount: number;
  exportCount: number;
  depCount: number;
  generatedAt: string;
  methodology: string;
  tokenEstimation: string;
}

export interface BenchmarkSummary {
  totalMcpTokens: number;
  totalVanillaTokens: number;
  totalSavingsPct: number;
  totalMcpCalls: number;
  totalVanillaCalls: number;
  callSavingsPct: number;
  totalPoints: number;
  taskCount: number;
  categories: Record<string, { mcpTokens: number; vanillaTokens: number; savingsPct: number }>;
}

export interface BenchmarkData {
  meta: BenchmarkMeta;
  tasks: BenchmarkTask[];
  summary: BenchmarkSummary;
}

export interface StochasticReport {
  config: {
    trials: number;
    seed: number;
    poissonLambda: number;
    bootstrapResamples: number;
    fixtureFiles: number;
    tsFiles: number;
  };
  results: {
    mcpWins: number;
    vanillaWins: number;
    ties: number;
    mcpWinRate: number;
  };
  tokens: {
    mcpMean: number;
    vanillaMean: number;
    savingsMean: number;
    savingsPct: number;
    ci95: { lower: number; upper: number };
  };
  calls: { mcpMean: number; vanillaMean: number };
  statistics: {
    wilcoxon: { W: number; z: number; p: number; n: number };
    effectSize: number;
    effectLabel: string;
    significant: boolean;
  };
  byTemplate: Record<
    string,
    { count: number; mcpMean: number; vanillaMean: number; savingsPct: number }
  >;
}

/* ─── Real bench runs (ccc-bench/1, served by /api/bench/*) ─────────────── */

export type BenchKind =
  | 'agent-opus'
  | 'agent-glm'
  | 'agent-deepseek'
  | 'simulated'
  | 'agent-claude';

/** Min–max of a per-repeat saved % (CCA-08). */
export interface SavedSpread {
  min: number;
  max: number;
  repeats: number;
}

/**
 * Mirrors scripts/bench/lib/types.mts AgentHeadline. The CCA-08 fields are
 * optional: index entries built before CCA-08 lack them.
 */
export interface AgentHeadline {
  success_vanilla_pct: number;
  success_cc_pct: number;
  /** cc-guided arm (runs since 2026-10-11). */
  success_cc_guided_pct?: number;
  /** Saved % on input + output + cache_write. */
  uncached_saved_pct?: number;
  guided_uncached_saved_pct?: number;
  uncached_saved_spread?: SavedSpread | null;
  guided_uncached_saved_spread?: SavedSpread | null;
  /** Saved % on reported USD; null when any cost is unknown. */
  cost_saved_pct?: number | null;
  guided_cost_saved_pct?: number | null;
  /** Uncached tokens / passing sessions; null when nothing passed. */
  uncached_per_pass?: { vanilla: number | null; cc: number | null; cc_guided?: number | null };
  /** Demoted: input + cache_read + output, mostly cache reads. */
  tokens_saved_pct: number;
  tool_calls_saved_pct: number;
  guided_tokens_saved_pct?: number;
  /** Rule-based verdict (CCA-20); absent in index entries built before it. */
  verdict?: RunVerdict | null;
}

export interface SimulatedHeadline {
  tokensSavedPct: number;
  callsSavedPct: number;
  mcpWinsPct: number;
  wilcoxonP: number;
  effectSizeR: number;
}

/** Legacy overdrive-bench/2 runs (kind agent-claude). */
export interface LegacyHeadline {
  nv_mean: number;
  nv_lo: number | null;
  nv_hi: number | null;
  verdict: string | null;
}

export interface BenchIndexEntry {
  run_id: string;
  kind: BenchKind;
  date: string;
  ts: string;
  model: string | null;
  trigger: string;
  headline: AgentHeadline | SimulatedHeadline | LegacyHeadline | null;
  /** Private suite run (CODE_CONTEXT_BENCH_PRIVATE_DIRS, CCA-19): local only. */
  private?: boolean;
  /** Private suite alias. */
  suite?: string;
  /** Private suite dir key (p0, p1, …) for /api/bench/run/:id?suite=. */
  source_key?: string;
}

export type BenchFilter = 'all' | 'public' | 'private';

/** Unique key of a run in the merged index: a private run id may repeat a public one. */
export function runKey(r: Pick<BenchIndexEntry, 'run_id' | 'source_key'>): string {
  return r.source_key ? `${r.source_key}/${r.run_id}` : r.run_id;
}

export function filterRuns(runs: BenchIndexEntry[], filter: BenchFilter): BenchIndexEntry[] {
  if (filter === 'public') return runs.filter((r) => !r.private);
  if (filter === 'private') return runs.filter((r) => !!r.private);
  return runs;
}

export interface BenchSourceInfo {
  type: 'dir' | 'git' | 'none';
  label: string;
}

export interface BenchArmStats {
  success_rate: number;
  tokens: { total: number };
  /** input + output + cache_write (CCA-08; absent in older runs). */
  uncached_tokens?: number;
  tool_calls: number;
  mcp_tool_calls: number;
  wall_ms_mean: number;
}

/** Paired uncached delta vs vanilla over repeats (saved %, min … max). */
export interface BenchPairedDelta {
  pairs: number;
  saved_pct: number;
  min: number;
  max: number;
}

export interface BenchPerTask {
  task_id: string;
  vanilla?: BenchArmStats;
  cc?: BenchArmStats;
  cc_guided?: BenchArmStats;
  /** CCA-08; absent in older runs. null = no pair. */
  delta?: { cc?: BenchPairedDelta | null; cc_guided?: BenchPairedDelta | null };
}

/** One arm in one cache phase (cold-warm runs). Means are per session. */
export interface BenchPhaseArmStats {
  sessions: number;
  success_rate: number;
  tokens: { total: number };
  /** input + output + cache_write: the tokens a cache could not serve. */
  uncached_tokens: number;
  tool_calls: number;
  mcp_tool_calls: number;
  wall_ms_mean: number;
  index_ms_mean?: number;
  /** null when the provider reports no price. */
  cost_usd?: number | null;
}

export interface BenchPhaseStats {
  vanilla?: BenchPhaseArmStats;
  cc?: BenchPhaseArmStats;
  cc_guided?: BenchPhaseArmStats;
}

/** `aggregate.by_phase`: present only in `--cache-mode cold-warm` runs. */
export interface BenchByPhase {
  cold?: BenchPhaseStats;
  warm?: BenchPhaseStats;
}

/** The fields of a run file the page reads; the rest stays untyped. */
export interface BenchRun {
  run_id: string;
  schema: string;
  kind: string;
  date: string;
  ts: string;
  duration_ms?: number;
  code_context_version?: string;
  model?: string | null;
  notes?: string[];
  agent_cli?: { name: string; version: string };
  /** Redacted suite runs carry prompt_sha256 instead of prompt. */
  tasks?: Array<{ id: string; size?: string; prompt?: string; prompt_sha256?: string }>;
  /** Suite runs (CCA-17): privacy flags; sources are hashes when redacted. */
  suite?: { id: string; private: boolean; redact: boolean };
  aggregate?: {
    per_task?: BenchPerTask[];
    by_phase?: BenchByPhase;
    /** Mean wall time per session and arm (the verdict's speed input). */
    wall_ms?: { vanilla_mean?: number; cc_mean?: number; cc_guided_mean?: number };
  };
  /** Run headline; `verdict` since CCA-20. */
  headline?: { verdict?: RunVerdict | null } & Record<string, unknown>;
  /** Sessions per arm (the verdict's repeat count). */
  arms?: { vanilla?: { results?: Array<{ task_id: string }> } };
}

interface BenchIndexResponse {
  source: BenchSourceInfo;
  index: { schema: string; runs: BenchIndexEntry[] } | null;
  message?: string;
  private?: Array<{ key: string; alias: string; runs: number }>;
}

/** Newest run of each kind, in index order (the index is newest-first). */
export function latestPerKind(runs: BenchIndexEntry[]): BenchIndexEntry[] {
  const seen = new Set<string>();
  return runs.filter((r) => (seen.has(r.kind) ? false : (seen.add(r.kind), true)));
}

interface BenchmarkStore {
  data: BenchmarkData | null;
  stochastic: StochasticReport | null;
  loading: boolean;
  error: string | null;
  fetchBenchmark: () => Promise<void>;

  benchRuns: BenchIndexEntry[];
  benchSource: BenchSourceInfo | null;
  benchMessage: string | null;
  benchLoading: boolean;
  benchError: string | null;
  /** Keyed by runKey(entry). */
  runDetails: Record<string, BenchRun>;
  runErrors: Record<string, string>;
  /** runKey of the selected run. */
  selectedRunId: string | null;
  benchFilter: BenchFilter;
  fetchBenchIndex: () => Promise<void>;
  /** `key` is runKey(entry); a bare run id works for public runs. */
  fetchRun: (key: string) => Promise<void>;
  selectRun: (key: string) => void;
  setBenchFilter: (f: BenchFilter) => void;
}

export const useBenchmarkStore = create<BenchmarkStore>((set, getState) => ({
  data: null,
  stochastic: null,
  loading: false,
  error: null,

  benchRuns: [],
  benchSource: null,
  benchMessage: null,
  benchLoading: false,
  benchError: null,
  runDetails: {},
  runErrors: {},
  selectedRunId: null,
  benchFilter: 'all',

  fetchBenchmark: async () => {
    set({ loading: true, error: null });
    try {
      const [data, stochastic] = await Promise.all([
        get<BenchmarkData>('/api/benchmark').catch(() => null),
        get<StochasticReport>('/api/benchmark-stochastic').catch(() => null),
      ]);
      set({ data: data ?? null, stochastic: stochastic ?? null });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  fetchBenchIndex: async () => {
    set({ benchLoading: true, benchError: null });
    try {
      const res = await get<BenchIndexResponse>('/api/bench/index');
      const runs = res.index?.runs ?? [];
      const current = getState().selectedRunId;
      set({
        benchRuns: runs,
        benchSource: res.source,
        benchMessage: res.message ?? null,
        selectedRunId:
          current && runs.some((r) => runKey(r) === current)
            ? current
            : runs[0]
              ? runKey(runs[0])
              : null,
      });
      // Version + notes live only in the run files: load the newest run per kind
      // (public and private apart, so both filters have their cards filled).
      const newest = [
        ...latestPerKind(filterRuns(runs, 'public')),
        ...latestPerKind(filterRuns(runs, 'private')),
      ];
      await Promise.all(newest.map((r) => getState().fetchRun(runKey(r))));
    } catch (e) {
      set({ benchError: (e as Error).message });
    } finally {
      set({ benchLoading: false });
    }
  },

  fetchRun: async (key) => {
    if (getState().runDetails[key]) return;
    const entry = getState().benchRuns.find((r) => runKey(r) === key);
    const runId = entry?.run_id ?? key;
    // Private runs come from the same local server, from their own suite dir.
    const query = entry?.source_key ? `?suite=${encodeURIComponent(entry.source_key)}` : '';
    try {
      const res = await get<{ run: BenchRun }>(
        `/api/bench/run/${encodeURIComponent(runId)}${query}`,
      );
      set((s) => ({ runDetails: { ...s.runDetails, [key]: res.run } }));
    } catch (e) {
      set((s) => ({ runErrors: { ...s.runErrors, [key]: (e as Error).message } }));
    }
  },

  selectRun: (key) => {
    set({ selectedRunId: key });
    void getState().fetchRun(key);
  },

  setBenchFilter: (f) => {
    const { benchRuns, selectedRunId } = getState();
    const visible = filterRuns(benchRuns, f);
    const keep = visible.some((r) => runKey(r) === selectedRunId);
    const next = keep ? selectedRunId : visible[0] ? runKey(visible[0]) : selectedRunId;
    set({ benchFilter: f, selectedRunId: next });
    if (next) void getState().fetchRun(next);
  },
}));
