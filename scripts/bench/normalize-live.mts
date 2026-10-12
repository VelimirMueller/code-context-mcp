/**
 * Fold live-bench sessions into the `agent-glm` / `agent-deepseek` / `agent-opus` run JSON
 * (PLAN.md task 8, data contract "Run JSON — kind agent-*").
 *
 * Pure: the caller supplies clock, git ref and versions, so normalisation is
 * deterministic and unit-testable without a model, opencode or network.
 * The result never carries key VALUES — `auth` holds the env NAME only.
 */
import type { AgentHeadline, AgentRun, GitRef, SessionResult } from './lib/types.mts';
import type { LiveTask } from './live/tasks.mts';
import { runSuiteInfo, runTaskEntry, type LoadedSuite } from './live/suite.mts';
import { formatDate, formatStamp, formatTs } from './lib/stamp.mts';
import {
  costOf,
  honestMetrics,
  pairedDelta,
  round1,
  savedPct,
  uncachedOf,
  type HonestAggregate,
  type PairedDelta,
} from './lib/metrics.mts';

export type LiveProvider = 'glm' | 'deepseek' | 'opus';

export interface LiveSessions {
  vanilla: SessionResult[];
  cc: SessionResult[];
  /** cc + the rig's "use code-context first" instruction (runs since 2026-10-11). */
  ccGuided?: SessionResult[];
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
  /** Private/external suite the tasks come from (CCA-17). */
  suite?: LoadedSuite;
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
  /** input + output + cache_write (CCA-08; absent in older runs). */
  uncached_tokens?: number;
  /** Sum of reported session costs; null when any session's cost is unknown. */
  cost_usd: number | null;
  tool_calls: number;
  mcp_tool_calls: number;
  wall_ms_mean: number;
}

export interface PerTaskRow {
  task_id: string;
  vanilla: PerTaskArmAgg;
  cc: PerTaskArmAgg;
  cc_guided?: PerTaskArmAgg;
  /**
   * Paired uncached-token delta vs vanilla, repeat k against repeat k, with
   * the min–max over repeats (CCA-08; absent in older runs). null = no pair.
   */
  delta?: { cc: PairedDelta | null; cc_guided?: PairedDelta | null };
}

export interface AgentAggregate extends Partial<HonestAggregate> {
  success_rate: { vanilla: number; cc: number; cc_guided?: number };
  tokens: {
    vanilla: TokenAgg;
    cc: TokenAgg;
    saved_pct: number;
    cc_guided?: TokenAgg;
    guided_saved_pct?: number;
  };
  tool_calls: {
    vanilla: number;
    cc: number;
    saved_pct: number;
    cc_guided?: number;
    guided_saved_pct?: number;
  };
  /** MCP tool calls per arm: proof the server was actually used. */
  mcp_tool_calls: { cc: number; cc_guided?: number };
  cost_usd: { vanilla: number | null; cc: number | null; cc_guided?: number | null };
  wall_ms: { vanilla_mean: number; cc_mean: number; cc_guided_mean?: number };
  per_task: PerTaskRow[];
  /** Cold vs warm per arm (cold-warm runs only). */
  by_phase?: ByPhaseAgg;
}

/** One arm in one cache phase (cold-warm runs). Means are per session. */
export interface PhaseArmAgg {
  sessions: number;
  success_rate: number;
  /** total = input + cache_read + output (as everywhere else). */
  tokens: TokenAgg;
  /** input + output + cache_write: the tokens a cache could not serve. */
  uncached_tokens: number;
  tool_calls: number;
  mcp_tool_calls: number;
  /** Cold cc sessions include their index build (index_ms). */
  wall_ms_mean: number;
  /** Mean index build time contained in wall_ms_mean. */
  index_ms_mean: number;
  cost_usd: number | null;
}

export interface PhaseAgg {
  vanilla: PhaseArmAgg;
  cc: PhaseArmAgg;
  cc_guided?: PhaseArmAgg;
}

/** `aggregate.by_phase` — present only when sessions carry cache_phase. */
export interface ByPhaseAgg {
  cold?: PhaseAgg;
  warm?: PhaseAgg;
}

export interface AgentArms {
  vanilla: { results: SessionResult[] };
  cc: { results: SessionResult[]; index_ms: number | null; db_bytes: number | null };
  cc_guided?: { results: SessionResult[] };
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
    uncached_tokens: results.reduce((s, r) => s + uncachedOf(r), 0),
    cost_usd: costOf(results),
    tool_calls: results.reduce((s, r) => s + r.tool_calls, 0),
    mcp_tool_calls: results.reduce((s, r) => s + r.mcp_tool_calls, 0),
    wall_ms_mean: n > 0 ? Math.round(results.reduce((s, r) => s + r.wall_ms, 0) / n) : 0,
  };
}

function phaseArm(results: SessionResult[]): PhaseArmAgg {
  const n = results.length;
  const sum = (f: (r: SessionResult) => number): number => results.reduce((s, r) => s + f(r), 0);
  const meanOf = (f: (r: SessionResult) => number): number => (n > 0 ? Math.round(sum(f) / n) : 0);
  return {
    sessions: n,
    success_rate: n > 0 ? results.filter((r) => r.success).length / n : 0,
    tokens: tokensOf(results),
    uncached_tokens: sum((r) => r.tokens.input + r.tokens.output + r.tokens.cache_write),
    tool_calls: sum((r) => r.tool_calls),
    mcp_tool_calls: sum((r) => r.mcp_tool_calls),
    wall_ms_mean: meanOf((r) => r.wall_ms),
    index_ms_mean: meanOf((r) => r.index_ms ?? 0),
    cost_usd: costOf(results),
  };
}

/**
 * Cold vs warm per arm. Undefined when no session carries cache_phase (a
 * cold-only run), so those run files stay byte-identical to before.
 */
export function byPhase(
  vanilla: SessionResult[],
  cc: SessionResult[],
  ccGuided: SessionResult[],
): ByPhaseAgg | undefined {
  const all = [...vanilla, ...cc, ...ccGuided];
  if (!all.some((r) => r.cache_phase)) return undefined;
  const out: ByPhaseAgg = {};
  for (const phase of ['cold', 'warm'] as const) {
    const of = (rs: SessionResult[]): SessionResult[] => rs.filter((r) => r.cache_phase === phase);
    if (!all.some((r) => r.cache_phase === phase)) continue;
    out[phase] = {
      vanilla: phaseArm(of(vanilla)),
      cc: phaseArm(of(cc)),
      ...(ccGuided.length > 0 ? { cc_guided: phaseArm(of(ccGuided)) } : {}),
    };
  }
  return out;
}

/**
 * Aggregate + headline from the session results alone (no envelope). Shared by
 * normalizeLive and `bench:renormalize`, so an old run file recomputed from
 * its sessions gets exactly what a new run would get.
 */
export function aggregateLive(
  taskIds: string[],
  sessions: Pick<LiveSessions, 'vanilla' | 'cc' | 'ccGuided'>,
): { aggregate: AgentAggregate; headline: AgentHeadline } {
  const guided = sessions.ccGuided ?? [];
  const hasGuided = guided.length > 0;
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
  const ofTask = (rs: SessionResult[], id: string): SessionResult[] =>
    rs.filter((r) => r.task_id === id);

  const per_task: PerTaskRow[] = taskIds.map((id) => ({
    task_id: id,
    vanilla: perTaskArm(ofTask(sessions.vanilla, id)),
    cc: perTaskArm(ofTask(sessions.cc, id)),
    ...(hasGuided ? { cc_guided: perTaskArm(ofTask(guided, id)) } : {}),
    delta: {
      cc: pairedDelta(ofTask(sessions.vanilla, id), ofTask(sessions.cc, id)),
      ...(hasGuided
        ? { cc_guided: pairedDelta(ofTask(sessions.vanilla, id), ofTask(guided, id)) }
        : {}),
    },
  }));
  const gTokens = tokensOf(guided);
  const gCalls = guided.reduce((s, r) => s + r.tool_calls, 0);
  const mcpCalls = (rs: SessionResult[]): number => rs.reduce((s, r) => s + r.mcp_tool_calls, 0);
  const honest = honestMetrics(taskIds, sessions.vanilla, sessions.cc, guided);

  const aggregate: AgentAggregate = {
    success_rate: {
      vanilla: rate(sessions.vanilla),
      cc: rate(sessions.cc),
      ...(hasGuided ? { cc_guided: rate(guided) } : {}),
    },
    // Honest metrics first (CCA-08): uncached tokens, cost and per-PASS values.
    ...honest.aggregate,
    tokens: {
      vanilla: vanTokens,
      cc: ccTokens,
      saved_pct: savedPct(vanTokens.total, ccTokens.total),
      ...(hasGuided
        ? { cc_guided: gTokens, guided_saved_pct: savedPct(vanTokens.total, gTokens.total) }
        : {}),
    },
    tool_calls: {
      vanilla: vanCalls,
      cc: ccCalls,
      saved_pct: savedPct(vanCalls, ccCalls),
      ...(hasGuided ? { cc_guided: gCalls, guided_saved_pct: savedPct(vanCalls, gCalls) } : {}),
    },
    mcp_tool_calls: {
      cc: mcpCalls(sessions.cc),
      ...(hasGuided ? { cc_guided: mcpCalls(guided) } : {}),
    },
    cost_usd: {
      vanilla: costOf(sessions.vanilla),
      cc: costOf(sessions.cc),
      ...(hasGuided ? { cc_guided: costOf(guided) } : {}),
    },
    wall_ms: {
      vanilla_mean: mean(sessions.vanilla),
      cc_mean: mean(sessions.cc),
      ...(hasGuided ? { cc_guided_mean: mean(guided) } : {}),
    },
    per_task,
  };
  const phases = byPhase(sessions.vanilla, sessions.cc, guided);
  if (phases) aggregate.by_phase = phases;

  // Order is the reading order: success, then the honest numbers; the
  // all-tokens figure (mostly cache reads) stays for old consumers, last.
  const headline: AgentHeadline = {
    success_vanilla_pct: round1(rate(sessions.vanilla) * 100),
    success_cc_pct: round1(rate(sessions.cc) * 100),
    ...(hasGuided ? { success_cc_guided_pct: round1(rate(guided) * 100) } : {}),
    ...honest.headline,
    tokens_saved_pct: aggregate.tokens.saved_pct,
    tool_calls_saved_pct: aggregate.tool_calls.saved_pct,
    ...(hasGuided ? { guided_tokens_saved_pct: aggregate.tokens.guided_saved_pct } : {}),
  };
  return { aggregate, headline };
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
  const guided = sessions.ccGuided ?? [];
  const hasGuided = guided.length > 0;
  for (const r of [...sessions.vanilla, ...sessions.cc, ...guided]) {
    if (!knownIds.has(r.task_id)) {
      throw new Error(`normalizeLive: session result has unknown task_id ${r.task_id}`);
    }
  }

  const now = ctx.now ?? new Date();
  const { aggregate, headline } = aggregateLive(
    tasks.map((t) => t.id),
    sessions,
  );

  const arms: AgentArms = {
    vanilla: { results: sessions.vanilla },
    cc: { results: sessions.cc, index_ms: sessions.indexMs, db_bytes: sessions.dbBytes },
    ...(hasGuided ? { cc_guided: { results: guided } } : {}),
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
    fixture: ctx.suite
      ? `suite ${ctx.suite.id}`
      : tasks.some((t) => t.fixture === 'src' || t.fixture === 'large')
        ? 'per task'
        : meta.fixture,
    auth: { keyEnv: meta.keyEnv },
    // CCA-17: suite id + source commits; redacted suites store tasks by id + hash.
    ...(ctx.suite ? { suite: runSuiteInfo(ctx.suite) } : {}),
    tasks: tasks.map((t) =>
      t.fixture === 'suite'
        ? runTaskEntry(t, ctx.suite?.redact ?? true)
        : {
            id: t.id,
            ...(t.size ? { size: t.size } : {}),
            fixture:
              t.fixture === 'src'
                ? 'src/ (this repo)'
                : t.fixture === 'large'
                  ? 'large synthetic (683 files)'
                  : meta.fixture,
            prompt: t.prompt,
            checker: t.checker,
          },
    ),
    arms,
    aggregate,
    headline,
  };
}
