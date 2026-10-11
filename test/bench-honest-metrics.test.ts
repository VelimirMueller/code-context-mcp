/**
 * CCA-08: honest live-bench metrics — uncached tokens, cost, tokens per PASS,
 * paired per-task deltas with min–max spread, `bench:renormalize`, and the
 * index headline derived for old run files. Pure maths, no model, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  armEfficiency,
  honestMetrics,
  pairedDelta,
  repeatSpread,
  savedPctOrNull,
  uncachedOf,
} from '../scripts/bench/lib/metrics.mts';
import { aggregateLive } from '../scripts/bench/normalize-live.mts';
import { renormalizeProblem, renormalizeRun } from '../scripts/bench/renormalize.mts';
import { buildIndex } from '../scripts/bench/lib/index-builder.mts';
import type { SessionResult } from '../scripts/bench/lib/types.mts';

function s(
  task: string,
  arm: string,
  rep: number,
  t: [input: number, output: number, cacheRead: number, cacheWrite: number],
  success = true,
  cost?: number | null,
): SessionResult {
  return {
    task_id: task,
    success,
    timeout: false,
    tokens: { input: t[0], output: t[1], cache_read: t[2], cache_write: t[3] },
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    tool_calls: 1,
    mcp_tool_calls: arm === 'vanilla' ? 0 : 1,
    wall_ms: 1_000,
    session_id: 'ses_x',
    events_path: `${arm}-${task}-r${rep}.jsonl`,
  };
}

// Two tasks × two repeats. Cache reads are huge and must not move the honest numbers.
const vanilla = [
  s('L1', 'vanilla', 1, [1_000, 100, 50_000, 0], true, 0.01),
  s('L1', 'vanilla', 2, [2_000, 100, 90_000, 0], false, 0.02),
  s('L2', 'vanilla', 1, [4_000, 200, 10_000, 100], true, 0.04),
  s('L2', 'vanilla', 2, [3_000, 200, 10_000, 100], true, 0.03),
];
const cc = [
  s('L1', 'cc', 1, [800, 100, 1_000, 0], true, 0.008),
  s('L1', 'cc', 2, [1_000, 100, 1_000, 0], true, 0.01),
  s('L2', 'cc', 1, [4_400, 200, 1_000, 100], true, 0.045),
  s('L2', 'cc', 2, [2_000, 200, 1_000, 100], true, 0.02),
];

describe('honest metrics: per arm', () => {
  it('uncached = input + output + cache_write (cache reads excluded)', () => {
    expect(uncachedOf(vanilla[2])).toBe(4_300);
  });

  it('per-PASS divides all sessions by passing sessions', () => {
    const e = armEfficiency(vanilla);
    expect(e).toEqual({
      sessions: 4,
      passes: 3,
      tokens_total: 1_100 + 50_000 + 2_100 + 90_000 + 4_200 + 10_000 + 3_200 + 10_000,
      uncached_tokens: 1_100 + 2_100 + 4_300 + 3_300, // 10_800
      cost_usd: 0.1,
      tokens_per_pass: Math.round(170_600 / 3),
      uncached_per_pass: 3_600,
      cost_per_pass: 0.033333,
    });
  });

  it('per-PASS is null when nothing passed; cost is null when any cost is unknown', () => {
    const e = armEfficiency([
      s('L1', 'cc', 1, [10, 1, 0, 0], false, 0.1),
      s('L1', 'cc', 2, [10, 1, 0, 0], false, null),
    ]);
    expect(e.passes).toBe(0);
    expect(e.uncached_per_pass).toBeNull();
    expect(e.tokens_per_pass).toBeNull();
    expect(e.cost_usd).toBeNull();
    expect(e.cost_per_pass).toBeNull();
  });

  it('savedPctOrNull is null for unknown or zero vanilla', () => {
    expect(savedPctOrNull(null, 1)).toBeNull();
    expect(savedPctOrNull(0, 1)).toBeNull();
    expect(savedPctOrNull(0.1, 0.09)).toBe(10);
  });
});

describe('honest metrics: paired deltas and spread', () => {
  it('pairs repeat k with repeat k (by -rN, not by position)', () => {
    // cc repeats listed in reverse order: pairing must still match r1↔r1.
    const d = pairedDelta(vanilla.slice(0, 2), [cc[1], cc[0]]);
    // r1: 1100 → 900 = +18.2 %, r2: 2100 → 1100 = +47.6 %, summed 3200 → 2000 = +37.5 %
    expect(d).toEqual({ pairs: 2, saved_pct: 37.5, min: 18.2, max: 47.6 });
  });

  it('is null without a pair', () => {
    expect(pairedDelta(vanilla.slice(0, 1), cc.slice(1, 2))).toBeNull();
  });

  it('run-level spread sums every task per repeat', () => {
    // r1: van 1100 + 4300 = 5400, cc 900 + 4700 = 5600 → −3.7 %
    // r2: van 2100 + 3300 = 5400, cc 1100 + 2300 = 3400 → +37 %
    expect(repeatSpread(['L1', 'L2'], vanilla, cc)).toEqual({ min: -3.7, max: 37, repeats: 2 });
    expect(repeatSpread(['L1'], vanilla.slice(0, 1), cc.slice(0, 1))).toBeNull();
  });

  it('honestMetrics headline: uncached saved, cost saved, per PASS per arm', () => {
    const { headline, aggregate } = honestMetrics(['L1', 'L2'], vanilla, cc, []);
    expect(headline).toEqual({
      uncached_saved_pct: 16.7, // 10_800 → 9_000
      uncached_saved_spread: { min: -3.7, max: 37, repeats: 2 },
      cost_saved_pct: 17, // 0.1 → 0.083
      uncached_per_pass: { vanilla: 3_600, cc: 2_250 },
    });
    expect(aggregate.uncached_tokens).toMatchObject({
      vanilla: 10_800,
      cc: 9_000,
      saved_pct: 16.7,
    });
    expect(aggregate.cost_saved_pct).toEqual({ cc: 17 });
    expect('cc_guided' in aggregate.per_pass).toBe(false);
  });

  it('honestMetrics carries the guided arm when present', () => {
    const guided = cc.map((r) => ({ ...r, events_path: r.events_path.replace('cc-', 'g-') }));
    const { headline } = honestMetrics(['L1', 'L2'], vanilla, cc, guided);
    expect(headline.guided_uncached_saved_pct).toBe(16.7);
    expect(headline.guided_cost_saved_pct).toBe(17);
    expect(headline.uncached_per_pass.cc_guided).toBe(2_250);
    expect(headline.guided_uncached_saved_spread).toEqual({ min: -3.7, max: 37, repeats: 2 });
  });

  it('aggregateLive adds per-task paired deltas and uncached tokens', () => {
    const { aggregate } = aggregateLive(['L1', 'L2'], { vanilla, cc });
    const l2 = aggregate.per_task[1];
    expect(l2.vanilla.uncached_tokens).toBe(7_600);
    // r1: 4300 → 4700 = −9.3 %, r2: 3300 → 2300 = +30.3 %, summed 7600 → 7000 = +7.9 %
    expect(l2.delta).toEqual({ cc: { pairs: 2, saved_pct: 7.9, min: -9.3, max: 30.3 } });
  });
});

/** A pre-CCA-08 run file: old headline only, no honest fields. */
function oldRun(): Record<string, unknown> {
  return {
    schema: 'ccc-bench/1',
    run_id: 'glm-20261011-000000',
    kind: 'agent-glm',
    date: '2026-10-11',
    ts: '2026-10-11T00:00:00Z',
    model: 'm',
    trigger: 'manual',
    notes: [],
    tasks: [{ id: 'L1' }, { id: 'L2' }],
    arms: { vanilla: { results: vanilla }, cc: { results: cc, index_ms: 1, db_bytes: 1 } },
    aggregate: { success_rate: { vanilla: 0.75, cc: 1 }, per_task: [] },
    headline: {
      success_vanilla_pct: 75,
      success_cc_pct: 100,
      tokens_saved_pct: 88.2,
      tool_calls_saved_pct: 0,
    },
  };
}

describe('bench:renormalize', () => {
  it('recomputes aggregate + headline from sessions; never mutates the input', () => {
    const input = oldRun();
    const before = structuredClone(input);
    const { run, before: oldHeadline, after } = renormalizeRun(input);
    expect(input).toEqual(before);
    expect(oldHeadline).toEqual(before.headline);
    expect(after).toMatchObject({
      success_vanilla_pct: 75,
      success_cc_pct: 100,
      uncached_saved_pct: 16.7,
      cost_saved_pct: 17,
      uncached_per_pass: { vanilla: 3_600, cc: 2_250 },
    });
    const r = run as { arms: unknown; aggregate: { per_pass: unknown; per_task: unknown[] } };
    expect(r.arms).toEqual(before.arms); // session facts untouched
    expect(r.aggregate.per_pass).toBeDefined();
    expect(r.aggregate.per_task).toHaveLength(2);
  });

  it('is idempotent', () => {
    const once = renormalizeRun(oldRun()).run;
    expect(renormalizeRun(once).run).toEqual(once);
  });

  it('refuses runs without sessions', () => {
    expect(renormalizeProblem({ run_id: 'sim-1', kind: 'simulated' })).toMatch(/no sessions/);
    expect(renormalizeProblem({ run_id: 'x', kind: 'agent-glm', arms: {} })).toMatch(/arms/);
    expect(() => renormalizeRun({ kind: 'simulated' })).toThrow(/no sessions/);
  });
});

describe('index headline (CCA-08)', () => {
  it('derives the honest fields for an old agent run, keeping recorded fields', () => {
    const idx = buildIndex([oldRun()]);
    expect(idx.runs[0].headline).toMatchObject({
      success_vanilla_pct: 75,
      tokens_saved_pct: 88.2, // recorded value wins over a recomputation
      uncached_saved_pct: 16.7,
      cost_saved_pct: 17,
      uncached_per_pass: { vanilla: 3_600, cc: 2_250 },
    });
  });

  it('passes a CCA-08 headline through unchanged', () => {
    const run = renormalizeRun(oldRun()).run as { headline: unknown };
    expect(buildIndex([run]).runs[0].headline).toEqual(run.headline);
  });

  it('leaves an agent run without sessions as recorded', () => {
    const r = oldRun();
    delete r.arms;
    expect(buildIndex([r]).runs[0].headline).toEqual(oldRun().headline);
  });
});
