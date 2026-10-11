/**
 * Bench data-contract types (PLAN.md "Data contract").
 *
 * These scripts live under scripts/bench/ and are excluded from the npm package
 * via the `!scripts/bench` entry in package.json `files`. They are also outside
 * tsconfig `include`, so they are typechecked only incidentally (tsx/esbuild)
 * and kept clean via `npm run lint`.
 */

export type NewRunKind = 'simulated' | 'agent-glm' | 'agent-deepseek' | 'agent-opus';
export type IndexKind = NewRunKind | 'agent-claude';

export interface GitRef {
  commit: string;
  branch: string;
  dirty: boolean;
}

export interface RunEnvelope {
  schema: 'ccc-bench/1';
  run_id: string;
  kind: NewRunKind;
  date: string;
  ts: string;
  trigger: 'manual' | 'ci';
  duration_ms: number;
  code_context_version: string;
  git: GitRef;
  notes: string[];
}

export interface SimulatedHeadline {
  tokensSavedPct: number;
  callsSavedPct: number;
  mcpWinsPct: number;
  wilcoxonP: number;
  effectSizeR: number;
}

export interface SimulatedRun extends RunEnvelope {
  kind: 'simulated';
  model: null;
  deterministic: unknown;
  stochastic: unknown;
  headline: SimulatedHeadline;
}

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface SessionResult {
  task_id: string;
  success: boolean;
  timeout: boolean;
  tokens: SessionTokens;
  /**
   * cache_read of the session's first model call; 0 = the session started
   * cold. Absent in runs before 2026-10-11 (not measured). For deepseek and
   * opus a value above 0 aborts the run, so a published run always has 0.
   */
  first_call_cache_read?: number;
  /**
   * Cost in USD as the agent CLI reported it (opencode step cost, Claude Code
   * total_cost_usd). null = not known (e.g. a subscription plan such as the
   * GLM coding plan). Absent in runs before 2026-10-11.
   */
  cost_usd?: number | null;
  tool_calls: number;
  mcp_tool_calls: number;
  /**
   * Session wall time. In cold-warm runs a cold cc session's index build is
   * included (see index_ms); otherwise the index build is not part of it.
   */
  wall_ms: number;
  /**
   * Cache phase in cold-warm runs (`--cache-mode cold-warm`, since
   * 2026-10-11): repeat 1 of each (task, arm) is 'cold', repeats 2..N 'warm'.
   * Absent in cold-only runs.
   */
  cache_phase?: 'cold' | 'warm';
  /**
   * Index build time already contained in wall_ms (cold-warm runs only):
   * the fresh build for a cold cc session, 0 for warm sessions (the index is
   * reused) and for vanilla.
   */
  index_ms?: number;
  session_id: string;
  events_path: string;
}

export interface AgentHeadline {
  success_vanilla_pct: number;
  success_cc_pct: number;
  tokens_saved_pct: number;
  tool_calls_saved_pct: number;
  /** cc-guided arm (runs since 2026-10-11). */
  success_cc_guided_pct?: number;
  guided_tokens_saved_pct?: number;
}

export interface AgentRun extends RunEnvelope {
  kind: 'agent-glm' | 'agent-deepseek' | 'agent-opus';
  model: string;
  agent_cli: { name: string; version: string };
  fixture: string;
  auth: { keyEnv: string };
  tasks: unknown[];
  arms: unknown;
  aggregate: unknown;
  headline: AgentHeadline;
}

export type Run = SimulatedRun | AgentRun;

export interface IndexEntry {
  run_id: string;
  kind: IndexKind;
  date: string;
  ts: string;
  model: string | null;
  trigger: string;
  headline: unknown;
}

export interface IndexJson {
  schema: 'ccc-bench-index/1';
  runs: IndexEntry[];
}
