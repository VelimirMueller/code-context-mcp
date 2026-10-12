/**
 * Bench data-contract types (PLAN.md "Data contract").
 *
 * These scripts live under scripts/bench/ and are excluded from the npm package
 * via the `!scripts/bench` entry in package.json `files`. They are also outside
 * tsconfig `include`, so they are typechecked only incidentally (tsx/esbuild)
 * and kept clean via `npm run lint`.
 */

import type { RunVerdict } from './verdict.mts';

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

/** Min–max of a per-repeat saved % (CCA-08). */
export interface SavedSpread {
  min: number;
  max: number;
  repeats: number;
}

/**
 * Agent-run headline. Reading order (CCA-08): success per arm, uncached
 * tokens saved %, cost saved %, uncached tokens per PASS per arm. The
 * CCA-08 fields are optional: run files from before 2026-10-11 lack them
 * until `npm run bench:renormalize` recomputes them from the sessions.
 */
export interface AgentHeadline {
  success_vanilla_pct: number;
  success_cc_pct: number;
  /** cc-guided arm (runs since 2026-10-11). */
  success_cc_guided_pct?: number;
  /** (vanilla − cc) / vanilla on input + output + cache_write. */
  uncached_saved_pct?: number;
  guided_uncached_saved_pct?: number;
  /** Min–max of uncached_saved_pct over repeats; null with one repeat. */
  uncached_saved_spread?: SavedSpread | null;
  guided_uncached_saved_spread?: SavedSpread | null;
  /** (vanilla − cc) / vanilla on reported USD; null when any cost is unknown. */
  cost_saved_pct?: number | null;
  guided_cost_saved_pct?: number | null;
  /** Uncached tokens of all sessions / passing sessions; null when none passed. */
  uncached_per_pass?: { vanilla: number | null; cc: number | null; cc_guided?: number | null };
  /**
   * Demoted (CCA-08): on input + cache_read + output, so mostly cache-read
   * volume, which providers bill at about 1 % of input. Kept for old consumers.
   */
  tokens_saved_pct: number;
  tool_calls_saved_pct: number;
  guided_tokens_saved_pct?: number;
  /**
   * Rule-based verdict with ASD-STE100 sentences (CCA-20, lib/verdict.mts).
   * Absent in runs normalised before 2026-10-12: the index builder, the
   * dashboard and the site compute it from the same fields.
   */
  verdict?: RunVerdict | null;
}

export interface AgentRun extends RunEnvelope {
  kind: 'agent-glm' | 'agent-deepseek' | 'agent-opus';
  model: string;
  agent_cli: { name: string; version: string };
  fixture: string;
  auth: { keyEnv: string };
  /**
   * Suite runs (CCA-17): suite id, privacy flags and source commits.
   * `bench:publish` refuses any run with `suite.private: true`.
   */
  suite?: { id: string; private: boolean; redact: boolean; sources: unknown[] };
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
