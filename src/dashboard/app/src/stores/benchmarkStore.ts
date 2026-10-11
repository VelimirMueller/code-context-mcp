import { create } from 'zustand';
import { get } from '@/lib/api';

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
  byTemplate: Record<string, { count: number; mcpMean: number; vanillaMean: number; savingsPct: number }>;
}

/* ─── Real bench runs (ccc-bench/1, served by /api/bench/*) ─────────────── */

export type BenchKind = 'agent-opus' | 'agent-glm' | 'agent-deepseek' | 'simulated' | 'agent-claude';

export interface AgentHeadline {
  success_vanilla_pct: number;
  success_cc_pct: number;
  tokens_saved_pct: number;
  tool_calls_saved_pct: number;
  /** cc-guided arm (runs since 2026-10-11). */
  success_cc_guided_pct?: number;
  guided_tokens_saved_pct?: number;
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
}

export interface BenchSourceInfo {
  type: 'dir' | 'git' | 'none';
  label: string;
}

export interface BenchArmStats {
  success_rate: number;
  tokens: { total: number };
  tool_calls: number;
  mcp_tool_calls: number;
  wall_ms_mean: number;
}

export interface BenchPerTask {
  task_id: string;
  vanilla?: BenchArmStats;
  cc?: BenchArmStats;
  cc_guided?: BenchArmStats;
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
  tasks?: Array<{ id: string; size?: string; prompt?: string }>;
  aggregate?: { per_task?: BenchPerTask[] };
}

interface BenchIndexResponse {
  source: BenchSourceInfo;
  index: { schema: string; runs: BenchIndexEntry[] } | null;
  message?: string;
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
  runDetails: Record<string, BenchRun>;
  runErrors: Record<string, string>;
  selectedRunId: string | null;
  fetchBenchIndex: () => Promise<void>;
  fetchRun: (runId: string) => Promise<void>;
  selectRun: (runId: string) => void;
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
        selectedRunId: current && runs.some((r) => r.run_id === current) ? current : (runs[0]?.run_id ?? null),
      });
      // Version + notes live only in the run files: load the newest run per kind.
      await Promise.all(latestPerKind(runs).map((r) => getState().fetchRun(r.run_id)));
    } catch (e) {
      set({ benchError: (e as Error).message });
    } finally {
      set({ benchLoading: false });
    }
  },

  fetchRun: async (runId) => {
    if (getState().runDetails[runId]) return;
    try {
      const res = await get<{ run: BenchRun }>(`/api/bench/run/${encodeURIComponent(runId)}`);
      set((s) => ({ runDetails: { ...s.runDetails, [runId]: res.run } }));
    } catch (e) {
      set((s) => ({ runErrors: { ...s.runErrors, [runId]: (e as Error).message } }));
    }
  },

  selectRun: (runId) => {
    set({ selectedRunId: runId });
    void getState().fetchRun(runId);
  },
}));
