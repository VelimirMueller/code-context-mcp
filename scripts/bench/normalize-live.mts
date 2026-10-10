/**
 * Fold live-bench sessions into the `agent-glm` / `agent-deepseek` / `agent-opus` run JSON
 * (PLAN.md task 8, data contract "Run JSON — kind agent-*").
 *
 * Pure: the caller supplies clock, git ref and versions, so normalisation is
 * deterministic and unit-testable without a model, opencode or network.
 * The result never carries key VALUES — `auth` holds the env NAME only.
 */
import type { AgentRun, GitRef, SessionResult } from './lib/types.mts';
import type { LiveTask } from './live/tasks.mts';
import { formatDate, formatStamp, formatTs } from './lib/stamp.mts';

export type LiveProvider = 'glm' | 'deepseek' | 'opus';

export interface LiveSessions {
  vanilla: SessionResult[];
  cc: SessionResult[];
  indexMs: number | null;
  dbBytes: number | null;
}

export interface NormalizeLiveCtx {
  trigger: 'manual' | 'ci';
  git: GitRef;
  durationMs: number;
  codeContextVersion: string;
  agentVersion: string;
  /** Agent CLI name (opencode for glm/deepseek, claude-code for opus). */
  agentName?: string;
  now?: Date;
  notes?: string[];
}

/**
 * `total` = input + cache_read + output: every token the model processed.
 * Since 2026-10-11 cache reads count — before, a provider cache hit made an
 * arm look cheaper than it was. Runs published earlier keep input + output.
 */
export interface TokenAgg {
  input: number;
  cache_read: number;
  output: number;
  total: number;
}

export interface PerTaskArmAgg {
  success_rate: number;
  tokens: TokenAgg;
  tool_calls: number;
  mcp_tool_calls: number;
  wall_ms_mean: number;
}

export interface PerTaskRow {
  task_id: string;
  vanilla: PerTaskArmAgg;
  cc: PerTaskArmAgg;
}

export interface AgentAggregate {
  success_rate: { vanilla: number; cc: number };
  tokens: { vanilla: TokenAgg; cc: TokenAgg; saved_pct: number };
  tool_calls: { vanilla: number; cc: number; saved_pct: number };
  wall_ms: { vanilla_mean: number; cc_mean: number };
  per_task: PerTaskRow[];
}

export interface AgentArms {
  vanilla: { results: SessionResult[] };
  cc: { results: SessionResult[]; index_ms: number | null; db_bytes: number | null };
}

const PROVIDER_META: Record<
  LiveProvider,
  { prefix: string; kind: AgentRun['kind']; keyEnv: string; fixture: string }
> = {
  glm: {
    prefix: 'glm-',
    kind: 'agent-glm',
    keyEnv: 'ZAI_API_KEY',
    fixture: 'test/fixtures/sample-project',
  },
  deepseek: {
    prefix: 'dsk-',
    kind: 'agent-deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    fixture: 'test/fixtures/sample-project',
  },
  opus: {
    prefix: 'opus-',
    kind: 'agent-opus',
    keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    fixture: 'test/fixtures/sample-project',
  },
};

/** Run-id prefix per provider (run.mts uses it for the artefact dir). */
export const RUN_ID_PREFIX: Record<LiveProvider, string> = {
  glm: PROVIDER_META.glm.prefix,
  deepseek: PROVIDER_META.deepseek.prefix,
  opus: PROVIDER_META.opus.prefix,
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function savedPct(vanilla: number, cc: number): number {
  return vanilla > 0 ? round1(((vanilla - cc) / vanilla) * 100) : 0;
}

function tokensOf(results: SessionResult[]): TokenAgg {
  const input = results.reduce((s, r) => s + r.tokens.input, 0);
  const cacheRead = results.reduce((s, r) => s + r.tokens.cache_read, 0);
  const output = results.reduce((s, r) => s + r.tokens.output, 0);
  return { input, cache_read: cacheRead, output, total: input + cacheRead + output };
}

function perTaskArm(results: SessionResult[]): PerTaskArmAgg {
  const n = results.length;
  return {
    success_rate: n > 0 ? results.filter((r) => r.success).length / n : 0,
    tokens: tokensOf(results),
    tool_calls: results.reduce((s, r) => s + r.tool_calls, 0),
    mcp_tool_calls: results.reduce((s, r) => s + r.mcp_tool_calls, 0),
    wall_ms_mean: n > 0 ? Math.round(results.reduce((s, r) => s + r.wall_ms, 0) / n) : 0,
  };
}

export function normalizeLive(
  provider: LiveProvider,
  model: string,
  tasks: LiveTask[],
  sessions: LiveSessions,
  ctx: NormalizeLiveCtx,
): AgentRun {
  const meta = PROVIDER_META[provider];
  const knownIds = new Set(tasks.map((t) => t.id));
  for (const r of [...sessions.vanilla, ...sessions.cc]) {
    if (!knownIds.has(r.task_id)) {
      throw new Error(`normalizeLive: session result has unknown task_id ${r.task_id}`);
    }
  }

  const now = ctx.now ?? new Date();
  const rate = (results: SessionResult[]): number =>
    results.length > 0 ? results.filter((r) => r.success).length / results.length : 0;

  const vanTokens = tokensOf(sessions.vanilla);
  const ccTokens = tokensOf(sessions.cc);
  const vanCalls = sessions.vanilla.reduce((s, r) => s + r.tool_calls, 0);
  const ccCalls = sessions.cc.reduce((s, r) => s + r.tool_calls, 0);
  const mean = (results: SessionResult[]): number =>
    results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.wall_ms, 0) / results.length)
      : 0;

  const per_task: PerTaskRow[] = tasks.map((t) => ({
    task_id: t.id,
    vanilla: perTaskArm(sessions.vanilla.filter((r) => r.task_id === t.id)),
    cc: perTaskArm(sessions.cc.filter((r) => r.task_id === t.id)),
  }));

  const aggregate: AgentAggregate = {
    success_rate: { vanilla: rate(sessions.vanilla), cc: rate(sessions.cc) },
    tokens: {
      vanilla: vanTokens,
      cc: ccTokens,
      saved_pct: savedPct(vanTokens.total, ccTokens.total),
    },
    tool_calls: { vanilla: vanCalls, cc: ccCalls, saved_pct: savedPct(vanCalls, ccCalls) },
    wall_ms: { vanilla_mean: mean(sessions.vanilla), cc_mean: mean(sessions.cc) },
    per_task,
  };

  const arms: AgentArms = {
    vanilla: { results: sessions.vanilla },
    cc: { results: sessions.cc, index_ms: sessions.indexMs, db_bytes: sessions.dbBytes },
  };

  return {
    schema: 'ccc-bench/1',
    run_id: `${meta.prefix}${formatStamp(now)}`,
    kind: meta.kind,
    date: formatDate(now),
    ts: formatTs(now),
    trigger: ctx.trigger,
    duration_ms: ctx.durationMs,
    code_context_version: ctx.codeContextVersion,
    git: ctx.git,
    notes: ctx.notes ?? [],
    model,
    agent_cli: { name: ctx.agentName ?? 'opencode', version: ctx.agentVersion },
    fixture: tasks.some((t) => t.fixture === 'src') ? 'per task' : meta.fixture,
    auth: { keyEnv: meta.keyEnv },
    tasks: tasks.map((t) => ({
      id: t.id,
      ...(t.size ? { size: t.size } : {}),
      fixture: t.fixture === 'src' ? 'src/ (this repo)' : meta.fixture,
      prompt: t.prompt,
      checker: t.checker,
    })),
    arms,
    aggregate,
    headline: {
      success_vanilla_pct: round1(rate(sessions.vanilla) * 100),
      success_cc_pct: round1(rate(sessions.cc) * 100),
      tokens_saved_pct: aggregate.tokens.saved_pct,
      tool_calls_saved_pct: aggregate.tool_calls.saved_pct,
    },
  };
}
