/**
 * Task 8 unit tests — normalizeLive (live-bench run JSON folding).
 *
 * Pure maths over hand-built SessionResults: no model, no opencode, no
 * network, no filesystem. Also asserts the run JSON carries no key values.
 */
import { describe, it, expect } from 'vitest';
import { normalizeLive, type LiveSessions } from '../scripts/bench/normalize-live.mts';
import { LIVE_TASKS } from '../scripts/bench/live/tasks.mts';
import type { SessionResult } from '../scripts/bench/lib/types.mts';

const L1 = LIVE_TASKS.find((t) => t.id === 'L1')!;
const L2 = LIVE_TASKS.find((t) => t.id === 'L2')!;

function session(taskId: string, over: Partial<SessionResult> = {}): SessionResult {
  return {
    task_id: taskId,
    success: true,
    timeout: false,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    tool_calls: 0,
    mcp_tool_calls: 0,
    wall_ms: 0,
    session_id: 'ses_x',
    events_path: `${taskId}.jsonl`,
    ...over,
  };
}

const ctx = {
  trigger: 'manual' as const,
  git: { commit: 'abc1234', branch: 'feat/x', dirty: false },
  durationMs: 42_000,
  codeContextVersion: '2.8.0',
  agentVersion: '1.18.30',
  now: new Date('2026-10-10T14:03:22Z'), // UTC: stamps are UTC-only, stable across machines
};

const sessions: LiveSessions = {
  vanilla: [
    session('L1', {
      success: true,
      tokens: { input: 6_000, output: 400, cache_read: 1_000, cache_write: 0 },
      tool_calls: 10,
      mcp_tool_calls: 0,
      wall_ms: 30_000,
    }),
    session('L2', {
      success: false,
      tokens: { input: 10_000, output: 800, cache_read: 0, cache_write: 200 },
      tool_calls: 14,
      mcp_tool_calls: 0,
      wall_ms: 50_000,
    }),
  ],
  cc: [
    session('L1', {
      success: true,
      tokens: { input: 2_000, output: 150, cache_read: 500, cache_write: 0 },
      tool_calls: 4,
      mcp_tool_calls: 3,
      wall_ms: 20_000,
    }),
    session('L2', {
      success: true,
      tokens: { input: 5_000, output: 300, cache_read: 0, cache_write: 100 },
      tool_calls: 6,
      mcp_tool_calls: 5,
      wall_ms: 25_000,
    }),
  ],
  indexMs: 123,
  dbBytes: 456_789,
};

describe('normalizeLive', () => {
  it('builds the agent envelope with the right kind, run_id and auth NAME', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, ctx);
    expect(run.schema).toBe('ccc-bench/1');
    expect(run.kind).toBe('agent-glm');
    expect(run.run_id).toBe('glm-20261010-140322');
    expect(run.ts).toBe('2026-10-10T14:03:22Z');
    expect(run.model).toBe('zai-coding-plan/glm-5.3');
    expect(run.agent_cli).toEqual({ name: 'opencode', version: '1.18.30' });
    expect(run.fixture).toBe('test/fixtures/sample-project');
    expect(run.auth).toEqual({ keyEnv: 'ZAI_API_KEY' });
  });

  it('uses the dsk- prefix and DEEPSEEK key name for deepseek', () => {
    const run = normalizeLive(
      'deepseek',
      'deepseek/deepseek-v4-pro',
      [L1],
      { ...sessions, vanilla: sessions.vanilla.slice(0, 1), cc: sessions.cc.slice(0, 1) },
      ctx,
    );
    expect(run.kind).toBe('agent-deepseek');
    expect(run.run_id).toBe('dsk-20261010-140322');
    expect(run.auth).toEqual({ keyEnv: 'DEEPSEEK_API_KEY' });
  });

  it('computes arm aggregates: totals include cache reads, saved_pct rounds to 1 decimal', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, ctx);
    const agg = run.aggregate as {
      tokens: { vanilla: { total: number }; cc: { total: number }; saved_pct: number };
      tool_calls: { vanilla: number; cc: number; saved_pct: number };
    };
    // total = input + cache_read + output; cache_write is not processed input
    expect(agg.tokens.vanilla.total).toBe(18_200); // (6000 + 1000 + 400) + (10000 + 800)
    expect(agg.tokens.cc.total).toBe(7_950); // (2000 + 500 + 150) + (5000 + 300)
    // (18200 - 7950) / 18200 * 100 = 56.318… → 56.3
    expect(agg.tokens.saved_pct).toBe(56.3);
    expect(agg.tool_calls).toEqual({ vanilla: 24, cc: 10, saved_pct: 58.3 });
  });

  it('computes success rates and the headline', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, ctx);
    const agg = run.aggregate as {
      success_rate: { vanilla: number; cc: number };
      wall_ms: { vanilla_mean: number; cc_mean: number };
    };
    expect(agg.success_rate).toEqual({ vanilla: 0.5, cc: 1 });
    expect(agg.wall_ms).toEqual({ vanilla_mean: 40_000, cc_mean: 22_500 });
    expect(run.headline).toEqual({
      success_vanilla_pct: 50,
      success_cc_pct: 100,
      tokens_saved_pct: 56.3,
      tool_calls_saved_pct: 58.3,
    });
  });

  it('builds per-task rows grouping repeats per arm', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, ctx);
    const agg = run.aggregate as {
      per_task: Array<{
        task_id: string;
        vanilla: { tokens: { total: number } };
        cc: { tokens: { total: number } };
      }>;
    };
    expect(agg.per_task.map((p) => p.task_id)).toEqual(['L1', 'L2']);
    expect(agg.per_task[0].vanilla.tokens.total).toBe(7_400); // 6000 + 1000 cached + 400
    expect(agg.per_task[1].cc.tokens.total).toBe(5_300);
  });

  it('carries arms with index stats on the cc arm only', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, ctx);
    const arms = run.arms as {
      vanilla: { results: unknown[] };
      cc: { results: unknown[]; index_ms: number | null; db_bytes: number | null };
    };
    expect(arms.vanilla.results).toHaveLength(2);
    expect(arms.cc.results).toHaveLength(2);
    expect(arms.cc.index_ms).toBe(123);
    expect(arms.cc.db_bytes).toBe(456_789);
  });

  it('throws on a session result with an unknown task id', () => {
    const bad = { ...sessions, vanilla: [...sessions.vanilla, session('L9')] };
    expect(() => normalizeLive('glm', 'm', [L1], bad, ctx)).toThrow(/unknown task_id/);
  });

  it('never carries key values anywhere in the JSON', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, {
      ...ctx,
      notes: ['env quirks: none'],
    });
    const json = JSON.stringify(run);
    expect(json).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(json).not.toMatch(/apiKey/i);
    expect(run.auth).toEqual({ keyEnv: 'ZAI_API_KEY' }); // name only
  });

  it('opus runs get their own kind, run-id prefix and agent CLI name', () => {
    const run = normalizeLive('opus', 'claude-opus-5-5', [L1, L2], sessions, {
      ...ctx,
      agentName: 'claude-code',
    });
    expect(run.kind).toBe('agent-opus');
    expect(run.run_id.startsWith('opus-')).toBe(true);
    expect(run.agent_cli.name).toBe('claude-code');
    expect(run.auth).toEqual({ keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN' });
  });

  it('folds a cc-guided arm, MCP call counts and costs', () => {
    const g = sessions.cc.map((r) => ({ ...r, mcp_tool_calls: 2, cost_usd: 0.01 }));
    const run = normalizeLive(
      'deepseek',
      'deepseek/deepseek-v4-pro',
      [L1, L2],
      { ...sessions, ccGuided: g },
      ctx,
    );
    const agg = run.aggregate as {
      tokens: { cc_guided?: { total: number }; guided_saved_pct?: number };
      mcp_tool_calls: { cc: number; cc_guided?: number };
      cost_usd: { vanilla: number | null; cc_guided?: number | null };
      per_task: Array<{ cc_guided?: unknown }>;
    };
    expect(agg.tokens.cc_guided?.total).toBe(7_950);
    expect(agg.tokens.guided_saved_pct).toBe(56.3);
    expect(agg.mcp_tool_calls.cc_guided).toBe(4);
    expect(agg.cost_usd.cc_guided).toBe(0.02);
    expect(agg.cost_usd.vanilla).toBeNull(); // fixture sessions carry no cost
    expect(agg.per_task.every((p) => p.cc_guided)).toBe(true);
    expect(run.headline.success_cc_guided_pct).toBe(100);
  });
  it('omits every cc-guided field for a two-arm run', () => {
    const run = normalizeLive('glm', 'zai-coding-plan/glm-5.3', [L1, L2], sessions, ctx);
    expect('success_cc_guided_pct' in run.headline).toBe(false);
    expect('cc_guided' in (run.arms as object)).toBe(false);
  });
});
