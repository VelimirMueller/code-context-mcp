/**
 * CCA-20: rule-based verdict + ASD-STE100 sentences (scripts/bench/lib/verdict.mts),
 * its port in site/data.js, and the index builder that fills it in for older runs.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VERDICT_RULE,
  armCode,
  computeVerdict,
  isRunVerdict,
  normalizeVerdict,
  verdictFromHeadline,
  verdictInputFromBlock,
  wallFasterPct,
  repeatsOf,
  verdictSummary,
  type VerdictArmInput,
  type VerdictInput,
} from '../scripts/bench/lib/verdict.mts';
import { buildIndex } from '../scripts/bench/lib/index-builder.mts';

const SITE = join(__dirname, '..', 'site');

function siteData(): any {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://x/',
    runScripts: 'outside-only',
  });
  const w = dom.window as any;
  w.eval(readFileSync(join(SITE, 'config.js'), 'utf8'));
  w.eval(readFileSync(join(SITE, 'data.js'), 'utf8'));
  return w.BenchData;
}
const D = siteData();

/** A clearly beneficial arm at 3 repeats; each case changes one field. */
const good = (over: Partial<VerdictArmInput> = {}): VerdictArmInput => ({
  success_vanilla_pct: 60,
  success_arm_pct: 60,
  uncached_saved_pct: 20,
  spread: { min: 5, max: 30, repeats: 3 },
  cost_saved_pct: 10,
  wall_faster_pct: 0,
  ...over,
});
const noSpread = { spread: null };

describe('verdict rule constants', () => {
  it('keeps every threshold in one frozen object', () => {
    expect(VERDICT_RULE).toEqual({
      minRepeats: 3,
      maxSuccessDropPp: 5,
      maxSlowerPct: 25,
      minSavedPctFewRepeats: 10,
      minIncreasePctFewRepeats: 10,
      smallEffectPct: 10,
    });
    expect(Object.isFrozen(VERDICT_RULE)).toBe(true);
    // The site port carries the same numbers.
    expect(JSON.parse(JSON.stringify(D.VERDICT_RULE))).toEqual({ ...VERDICT_RULE });
  });
});

describe('verdict rule table (one arm vs vanilla)', () => {
  const cases: Array<[string, Partial<VerdictArmInput>, number, string]> = [
    ['clear win at 3 repeats', {}, 3, 'BENEFICIAL'],
    // success: "drops by more than 5 pp" is strict
    ['success drop of exactly 5 pp', { success_arm_pct: 55 }, 3, 'BENEFICIAL'],
    ['success drop of 5.1 pp', { success_arm_pct: 54.9 }, 3, 'SUBOPTIMAL'],
    [
      'success drop 66.7 → 61.7 (float noise stays at 5 pp)',
      { success_vanilla_pct: 66.7, success_arm_pct: 61.7 },
      3,
      'BENEFICIAL',
    ],
    ['success increase', { success_arm_pct: 80 }, 3, 'BENEFICIAL'],
    // wall time: "more than 25 % slower" is strict
    ['exactly 25 % slower', { wall_faster_pct: -25 }, 3, 'BENEFICIAL'],
    ['25.1 % slower', { wall_faster_pct: -25.1 }, 3, 'SUBOPTIMAL'],
    [
      '5 % better but 26 % slower (the owner rule)',
      { uncached_saved_pct: 5, spread: { min: 1, max: 9, repeats: 3 }, wall_faster_pct: -26 },
      3,
      'SUBOPTIMAL',
    ],
    ['wall time unknown', { wall_faster_pct: null }, 3, 'BENEFICIAL'],
    // spread: BENEFICIAL needs min > 0, SUBOPTIMAL needs max < 0
    ['spread min exactly 0', { spread: { min: 0, max: 30, repeats: 3 } }, 3, 'NO_CLEAR_EFFECT'],
    ['spread min 0.1', { spread: { min: 0.1, max: 30, repeats: 3 } }, 3, 'BENEFICIAL'],
    ['spread crosses 0', { spread: { min: -4.2, max: 28.2, repeats: 3 } }, 3, 'NO_CLEAR_EFFECT'],
    [
      'spread max exactly 0',
      { uncached_saved_pct: -5, spread: { min: -9, max: 0, repeats: 3 } },
      3,
      'NO_CLEAR_EFFECT',
    ],
    [
      'spread max -0.1 (always worse)',
      { uncached_saved_pct: -5, spread: { min: -9, max: -0.1, repeats: 3 } },
      3,
      'SUBOPTIMAL',
    ],
    // fewer than 3 repeats: the point estimate needs >= 10 %
    ['1 repeat, saved exactly 10 %', { ...noSpread, uncached_saved_pct: 10 }, 1, 'BENEFICIAL'],
    ['1 repeat, saved 9.9 %', { ...noSpread, uncached_saved_pct: 9.9 }, 1, 'NO_CLEAR_EFFECT'],
    [
      '2 repeats, spread crosses 0, saved 12 %',
      { uncached_saved_pct: 12, spread: { min: -5, max: 30, repeats: 2 } },
      2,
      'BENEFICIAL',
    ],
    [
      '3 repeats, same spread crosses 0',
      { uncached_saved_pct: 12, spread: { min: -5, max: 30, repeats: 3 } },
      3,
      'NO_CLEAR_EFFECT',
    ],
    [
      '2 repeats, always worse',
      { uncached_saved_pct: -12, spread: { min: -20, max: -5, repeats: 2 } },
      2,
      'SUBOPTIMAL',
    ],
    // fewer than 3 repeats: a token increase of >= 10 % is SUBOPTIMAL (mirror rule)
    ['1 repeat, saved -9.9 %', { ...noSpread, uncached_saved_pct: -9.9 }, 1, 'NO_CLEAR_EFFECT'],
    ['1 repeat, saved exactly -10 %', { ...noSpread, uncached_saved_pct: -10 }, 1, 'SUBOPTIMAL'],
    ['1 repeat, saved -10.1 %', { ...noSpread, uncached_saved_pct: -10.1 }, 1, 'SUBOPTIMAL'],
    [
      '2 repeats, spread crosses 0, saved -12 %',
      { uncached_saved_pct: -12, spread: { min: -30, max: 5, repeats: 2 } },
      2,
      'SUBOPTIMAL',
    ],
    [
      '3 repeats, same spread crosses 0 (the spread decides)',
      { uncached_saved_pct: -12, spread: { min: -30, max: 5, repeats: 3 } },
      3,
      'NO_CLEAR_EFFECT',
    ],
    ['1 repeat, tokens unknown', { ...noSpread, uncached_saved_pct: null }, 1, 'NO_CLEAR_EFFECT'],
    // cost: unknown or >= 0
    ['cost unknown', { cost_saved_pct: null }, 3, 'BENEFICIAL'],
    ['cost unchanged', { cost_saved_pct: 0 }, 3, 'BENEFICIAL'],
    ['cost increases by 0.1 %', { cost_saved_pct: -0.1 }, 3, 'NO_CLEAR_EFFECT'],
    // SUBOPTIMAL wins over every other signal
    [
      'big saving but success drops 10 pp',
      { uncached_saved_pct: 60, success_arm_pct: 50 },
      3,
      'SUBOPTIMAL',
    ],
  ];
  for (const [name, over, repeats, want] of cases) {
    it(`${name} → ${want}`, () => {
      const a = good(over);
      expect(armCode(a, repeats)).toBe(want);
      // The site port agrees.
      expect(D.computeVerdict({ repeats, cc: a }).code).toBe(want);
    });
  }

  it('marks fewer than 3 repeats as indicative, 3 and more not', () => {
    for (const [repeats, ind] of [
      [1, true],
      [2, true],
      [3, false],
      [5, false],
    ] as const)
      expect(computeVerdict({ repeats, cc: good() })?.indicative).toBe(ind);
  });

  it('takes the best arm; on a tie cc_guided wins', () => {
    const flat = good({ spread: { min: -1, max: 2, repeats: 3 } });
    expect(computeVerdict({ repeats: 3, cc: flat, cc_guided: flat })?.arm).toBe('cc_guided');
    const v = computeVerdict({ repeats: 3, cc: good(), cc_guided: flat });
    expect(v?.arm).toBe('cc');
    expect(v?.code).toBe('BENEFICIAL');
    expect(v?.arms.cc_guided?.code).toBe('NO_CLEAR_EFFECT');
    const bad = good({ wall_faster_pct: -40 });
    expect(computeVerdict({ repeats: 3, cc: bad, cc_guided: flat })?.code).toBe('NO_CLEAR_EFFECT');
  });

  it('returns null without any arm', () => {
    expect(computeVerdict({ repeats: 3, cc: null })).toBeNull();
    expect(D.computeVerdict({ repeats: 3, cc: null })).toBeNull();
  });
});

// ─── sentences ────────────────────────────────────────────────────────────────

/** The three realistic cases of the issue (also used in the docs). */
const EXAMPLES: Record<string, VerdictInput> = {
  'guided helps, 1 repeat': {
    repeats: 1,
    cc: {
      success_vanilla_pct: 66.7,
      success_arm_pct: 66.7,
      uncached_saved_pct: 4.2,
      spread: null,
      cost_saved_pct: null,
      wall_faster_pct: -3,
    },
    cc_guided: {
      success_vanilla_pct: 66.7,
      success_arm_pct: 75,
      uncached_saved_pct: 28.4,
      spread: null,
      cost_saved_pct: 26.1,
      wall_faster_pct: 25.3,
    },
  },
  'unstable over 3 repeats': {
    repeats: 3,
    cc: {
      success_vanilla_pct: 66.7,
      success_arm_pct: 93.3,
      uncached_saved_pct: 9.3,
      spread: { min: -4.2, max: 28.2, repeats: 3 },
      cost_saved_pct: null,
      wall_faster_pct: 12,
    },
    cc_guided: {
      success_vanilla_pct: 66.7,
      success_arm_pct: 93.3,
      uncached_saved_pct: 29.7,
      spread: { min: -2, max: 41.3, repeats: 3 },
      cost_saved_pct: null,
      wall_faster_pct: 8,
    },
  },
  '5 % better but much slower': {
    repeats: 3,
    cc: {
      success_vanilla_pct: 80,
      success_arm_pct: 80,
      uncached_saved_pct: 5,
      spread: { min: 2, max: 8, repeats: 3 },
      cost_saved_pct: 4,
      wall_faster_pct: -31,
    },
    cc_guided: {
      success_vanilla_pct: 80,
      success_arm_pct: 70,
      uncached_saved_pct: 6,
      spread: { min: 1, max: 9, repeats: 3 },
      cost_saved_pct: 5,
      wall_faster_pct: -40,
    },
  },
};

describe('ASD-STE100 sentences', () => {
  it('matches the example of the issue word for word', () => {
    const v = computeVerdict(EXAMPLES['guided helps, 1 repeat']);
    expect(v?.code).toBe('BENEFICIAL');
    expect(v?.arm).toBe('cc_guided');
    expect(v?.sentences).toEqual([
      'Result: code-context helps when the agent gets the instruction to use it.',
      'With guidance, code-context decreases the token use by 28 %.',
      'It decreases the cost by 26 %.',
      'The tasks complete 25 % faster.',
      'The success rate increases from 67 % to 75 %.',
      'Without guidance, the effect is small.',
      'This result is indicative only: the run has 1 repeat.',
    ]);
  });

  it('snapshots: no clear effect (spread crosses 0) and suboptimal (slower, success drop)', () => {
    expect(computeVerdict(EXAMPLES['unstable over 3 repeats'])).toMatchInlineSnapshot(`
      {
        "arm": "cc_guided",
        "arms": {
          "cc": {
            "code": "NO_CLEAR_EFFECT",
            "sentences": [
              "Without guidance, code-context decreases the token use by 9 %.",
              "The tasks complete 12 % faster.",
              "The success rate increases from 67 % to 93 %.",
              "The result is not stable across repeats.",
            ],
          },
          "cc_guided": {
            "code": "NO_CLEAR_EFFECT",
            "sentences": [
              "With guidance, code-context decreases the token use by 30 %.",
              "The tasks complete 8 % faster.",
              "The success rate increases from 67 % to 93 %.",
              "The result is not stable across repeats.",
            ],
          },
        },
        "code": "NO_CLEAR_EFFECT",
        "indicative": false,
        "repeats": 3,
        "sentences": [
          "Result: code-context shows no clear effect.",
          "With guidance, code-context decreases the token use by 30 %.",
          "The tasks complete 8 % faster.",
          "The success rate increases from 67 % to 93 %.",
          "The result is not stable across repeats.",
          "Without guidance, the effect is small.",
        ],
      }
    `);
    expect(computeVerdict(EXAMPLES['5 % better but much slower'])?.sentences)
      .toMatchInlineSnapshot(`
      [
        "Result: code-context is suboptimal for these tasks.",
        "With guidance, code-context decreases the token use by 6 %.",
        "It decreases the cost by 5 %.",
        "The tasks complete 40 % slower.",
        "The success rate decreases from 80 % to 70 %.",
        "The success rate decreases by more than 5 percentage points.",
        "The tasks are more than 25 % slower.",
        "Without guidance, code-context is also suboptimal.",
        "The tasks are more than 25 % slower.",
      ]
    `);
  });

  it('covers the other templates: two-arm runs, increases, no change, unknown wall time', () => {
    const v = computeVerdict({
      repeats: 2,
      cc: {
        success_vanilla_pct: 50,
        success_arm_pct: 50,
        uncached_saved_pct: -0.4,
        spread: { min: -3, max: 2, repeats: 2 },
        cost_saved_pct: -12.6,
        wall_faster_pct: null,
      },
    });
    expect(v?.sentences).toEqual([
      'Result: code-context shows no clear effect.',
      'Code-context does not change the token use.',
      'It increases the cost by 13 %.',
      'The wall time is not known.',
      'The success rate is 50 % with and without code-context.',
      'The result is not stable across repeats.',
      'This result is indicative only: the run has 2 repeats.',
    ]);
    const both = computeVerdict({ repeats: 3, cc: good(), cc_guided: good() });
    expect(both?.sentences[0]).toBe(
      'Result: code-context helps with and without the instruction to use it.',
    );
    expect(both?.sentences).toContain('Without guidance, code-context also helps.');
    const ccOnly = computeVerdict({
      repeats: 3,
      cc: good(),
      cc_guided: good({ cost_saved_pct: -5 }),
    });
    expect(ccOnly?.sentences[0]).toBe(
      'Result: code-context helps when the agent gets no instruction to use it.',
    );
  });

  it('gives the reason for the few-repeats token rule', () => {
    const worse = { ...good(), spread: null, uncached_saved_pct: -12.4 };
    expect(computeVerdict({ repeats: 1, cc: worse })?.sentences).toEqual([
      'Result: code-context is suboptimal for these tasks.',
      'Code-context increases the token use by 12 %.',
      'It decreases the cost by 10 %.',
      'The tasks complete in the same time.',
      'The success rate is 60 % with and without code-context.',
      'The token use increases by 12 % in 1 repeat.',
      'This result is indicative only: the run has 1 repeat.',
    ]);
    const two = computeVerdict({
      repeats: 2,
      cc: { ...worse, uncached_saved_pct: -10, spread: { min: -25, max: 5, repeats: 2 } },
    });
    expect(two?.sentences).toContain('The token use increases by 10 % in 2 repeats.');
    // The other arm: "is suboptimal", with "also" when the best arm is suboptimal too.
    const flat = good({ spread: { min: -1, max: 2, repeats: 3 } });
    const slow = good({ wall_faster_pct: -40 });
    expect(computeVerdict({ repeats: 3, cc: slow, cc_guided: flat })?.sentences).toContain(
      'Without guidance, code-context is suboptimal.',
    );
    expect(computeVerdict({ repeats: 3, cc: slow, cc_guided: slow })?.sentences).toContain(
      'Without guidance, code-context is also suboptimal.',
    );
  });

  it('is deterministic and follows the STE limits for every generated sentence', () => {
    const banned = /\b(simply|just|easily|seamless|powerful|robust|leverage|significant(ly)?)\b/i;
    const grid: VerdictInput[] = [];
    for (const saved of [-30, -12.4, -10.1, -10, -9.9, -0.4, 0, 9.9, 10, 28.4])
      for (const sp of [
        null,
        { min: -5, max: 20, repeats: 3 },
        { min: 1, max: 40, repeats: 3 },
        { min: -20, max: -1, repeats: 3 },
      ])
        for (const wall of [null, -40, -25, 0, 25.3])
          for (const succ of [50, 60, 54.9])
            for (const cost of [null, -10, 0, 26.1])
              for (const repeats of [1, 2, 3])
                grid.push({
                  repeats,
                  cc: {
                    success_vanilla_pct: 60,
                    success_arm_pct: succ,
                    uncached_saved_pct: saved,
                    spread: sp,
                    cost_saved_pct: cost,
                    wall_faster_pct: wall,
                  },
                  ...(repeats !== 2
                    ? {
                        cc_guided: {
                          success_vanilla_pct: 60,
                          success_arm_pct: 66.7,
                          uncached_saved_pct: saved + 15,
                          spread: sp,
                          cost_saved_pct: cost,
                          wall_faster_pct: wall,
                        },
                      }
                    : {}),
                });
    for (const input of grid) {
      const v = computeVerdict(input)!;
      expect(computeVerdict(input)).toEqual(v);
      // Parity with the site port: same code, same sentences, same everything.
      expect(JSON.parse(JSON.stringify(D.computeVerdict(input)))).toEqual(v);
      for (const s of v.sentences) {
        expect(s.split(/\s+/).length, s).toBeLessThanOrEqual(20);
        expect(s).toMatch(/^[A-Z][A-Za-z0-9 %,:-]*\.$/);
        expect(s, s).not.toMatch(banned);
        expect(s).not.toMatch(/\d\.\d/); // whole % only
        expect(s).not.toMatch(/-\d/); // magnitudes, never signed numbers
      }
    }
    expect(grid.length).toBeGreaterThan(2000);
  });
});

// ─── legacy code HARMFUL (before #158) ────────────────────────────────────────

/** A verdict as stored before #158: code HARMFUL and the old sentences. */
function legacyOf(v: Record<string, any>): Record<string, any> {
  const old = (t: string) =>
    t
      .replace(
        'Result: code-context is suboptimal for these tasks.',
        'Result: code-context makes the result worse.',
      )
      .replace(
        /code-context is (also )?suboptimal\.$/,
        (_m, also) => `code-context ${also ?? ''}makes the result worse.`,
      );
  const code = (c: string) => (c === 'SUBOPTIMAL' ? 'HARMFUL' : c);
  const arms: Record<string, any> = {};
  for (const [k, a] of Object.entries(v.arms as Record<string, any>))
    arms[k] = { ...a, code: code(a.code), sentences: a.sentences.map(old) };
  return { ...v, code: code(v.code), arms, sentences: v.sentences.map(old) };
}

describe('legacy verdict code HARMFUL', () => {
  const current = computeVerdict(EXAMPLES['5 % better but much slower'])!;
  const legacy = legacyOf(current);

  it('the fixture really is the old form', () => {
    expect(legacy.code).toBe('HARMFUL');
    expect(legacy.arms.cc.code).toBe('HARMFUL');
    expect(legacy.sentences[0]).toBe('Result: code-context makes the result worse.');
    expect(legacy.sentences).toContain(
      'Without guidance, code-context also makes the result worse.',
    );
    expect(isRunVerdict(legacy)).toBe(false);
  });

  it('normalizeVerdict reads HARMFUL as SUBOPTIMAL with the current sentences (module and site)', () => {
    expect(normalizeVerdict(legacy)).toEqual(current);
    expect(JSON.parse(JSON.stringify(D.normalizeVerdict(legacy)))).toEqual(current);
  });

  it('returns a current verdict unchanged and null for a non-verdict', () => {
    expect(normalizeVerdict(current)).toBe(current);
    expect(normalizeVerdict({ code: 'HARMFUL' })).toBeNull();
    expect(normalizeVerdict(null)).toBeNull();
    expect(D.normalizeVerdict({ code: 'NOPE' })).toBeNull();
  });

  it('the site reads a stored HARMFUL headline verdict as SUBOPTIMAL', () => {
    const entry = {
      run_id: 'glm-1',
      kind: 'agent-glm',
      date: '2026-10-01',
      ts: '2026-10-01T00:00:00Z',
      headline: {
        success_vanilla_pct: 80,
        success_cc_pct: 80,
        uncached_saved_pct: 5,
        tokens_saved_pct: 5,
        tool_calls_saved_pct: 0,
        verdict: legacy,
      },
    };
    const v = D.agentVerdictOf(D.normalizeRun(entry));
    expect(v.code).toBe('SUBOPTIMAL');
    expect(v.sentences[0]).toBe('Result: code-context is suboptimal for these tasks.');
    expect(JSON.stringify(v)).not.toMatch(/harmful|makes the result worse/i);
  });
});

// ─── adapters ─────────────────────────────────────────────────────────────────

describe('verdict adapters', () => {
  it('wallFasterPct: positive = faster, null when unknown', () => {
    expect(wallFasterPct(40_000, 30_000)).toBe(25);
    expect(wallFasterPct(40_000, 50_000)).toBe(-25);
    expect(wallFasterPct(0, 1)).toBeNull();
    expect(wallFasterPct(undefined, 1)).toBeNull();
  });

  it('repeatsOf: highest session count of any task', () => {
    expect(repeatsOf([{ task_id: 'a' }, { task_id: 'a' }, { task_id: 'b' }])).toBe(2);
    expect(repeatsOf([])).toBe(0);
  });

  it('verdictFromHeadline reads the headline, wall means and repeats (spread repeats as fallback)', () => {
    const h = {
      success_vanilla_pct: 66.7,
      success_cc_pct: 93.3,
      success_cc_guided_pct: 93.3,
      uncached_saved_pct: 9.3,
      guided_uncached_saved_pct: 29.7,
      uncached_saved_spread: { min: -4.2, max: 28.2, repeats: 3 },
      guided_uncached_saved_spread: { min: 9.5, max: 41.3, repeats: 3 },
      cost_saved_pct: null,
      guided_cost_saved_pct: null,
      tokens_saved_pct: -25.7,
      tool_calls_saved_pct: -31.9,
    };
    const v = verdictFromHeadline(h, {
      wall: { vanilla_mean: 10_000, cc_mean: 9_000, cc_guided_mean: 8_000 },
    });
    expect(v?.repeats).toBe(3);
    expect(v?.code).toBe('BENEFICIAL');
    expect(v?.arm).toBe('cc_guided');
    expect(v?.sentences).toContain('The tasks complete 20 % faster.');
    expect(verdictFromHeadline({ tokensSavedPct: 1 })).toBeNull(); // not an agent headline
  });

  it('verdictInputFromBlock reads a private-summary block', () => {
    const arm = (success_pct: number, wall_mean_ms: number) => ({ success_pct, wall_mean_ms });
    const input = verdictInputFromBlock(
      {
        arms: { vanilla: arm(83.3, 30_000), cc: arm(100, 24_000) },
        saved: {
          cc: {
            uncached_saved_pct: 40.4,
            uncached_saved_spread: { min: 35, max: 45, repeats: 2 },
            cost_saved_pct: 40,
          },
        },
      },
      2,
    );
    expect(input).toEqual({
      repeats: 2,
      cc: {
        success_vanilla_pct: 83.3,
        success_arm_pct: 100,
        uncached_saved_pct: 40.4,
        spread: { min: 35, max: 45, repeats: 2 },
        cost_saved_pct: 40,
        wall_faster_pct: 20,
      },
    });
  });
});

describe('index builder: verdict for runs without one', () => {
  const sess = (task: string, rep: number, success: boolean, input: number, wall: number) => ({
    task_id: task,
    success,
    timeout: false,
    tokens: { input, output: 100, cache_read: 0, cache_write: 0 },
    tool_calls: 3,
    mcp_tool_calls: 0,
    wall_ms: wall,
    session_id: `s-${task}-${rep}`,
    events_path: `events/${task}-r${rep}.jsonl`,
  });
  const run = (headline: Record<string, unknown>) => ({
    schema: 'ccc-bench/1',
    run_id: 'glm-20261011-090620',
    kind: 'agent-glm',
    date: '2026-10-11',
    ts: '2026-10-11T09:06:20Z',
    model: 'glm-5.3',
    trigger: 'manual',
    tasks: [{ id: 'L1' }],
    arms: {
      vanilla: { results: [1, 2, 3].map((r) => sess('L1', r, true, 1000, 10_000)) },
      cc: { results: [1, 2, 3].map((r) => sess('L1', r, true, 700 + r * 10, 9_000)) },
    },
    aggregate: { wall_ms: { vanilla_mean: 10_000, cc_mean: 9_000 } },
    headline,
  });

  it('computes it from the recorded headline, wall means and repeats', () => {
    const idx = buildIndex([
      run({
        success_vanilla_pct: 100,
        success_cc_pct: 100,
        tokens_saved_pct: 1,
        tool_calls_saved_pct: 0,
      }),
    ]);
    const h = idx.runs[0].headline as Record<string, any>;
    expect(h.uncached_saved_pct).toBeGreaterThan(0); // derived (CCA-08)
    expect(h.verdict.code).toBe('BENEFICIAL');
    expect(h.verdict.repeats).toBe(3);
    expect(h.verdict.indicative).toBe(false);
    expect(h.verdict.sentences).toContain('The tasks complete 10 % faster.');
  });

  it('never overwrites a recorded verdict', () => {
    const recorded = {
      code: 'SUBOPTIMAL',
      indicative: true,
      repeats: 1,
      arm: 'cc',
      arms: {},
      sentences: ['x.'],
    };
    const idx = buildIndex([
      run({
        success_vanilla_pct: 100,
        success_cc_pct: 100,
        uncached_saved_pct: 5,
        tokens_saved_pct: 1,
        tool_calls_saved_pct: 0,
        verdict: recorded,
      }),
    ]);
    expect((idx.runs[0].headline as Record<string, unknown>).verdict).toEqual(recorded);
  });

  it('computes a recorded HARMFUL verdict again with the current rule', () => {
    const legacyRecorded = {
      code: 'HARMFUL',
      indicative: true,
      repeats: 1,
      arm: 'cc',
      arms: {
        cc: { code: 'HARMFUL', sentences: ['Result: code-context makes the result worse.'] },
      },
      sentences: ['Result: code-context makes the result worse.'],
    };
    const idx = buildIndex([
      run({
        success_vanilla_pct: 100,
        success_cc_pct: 100,
        uncached_saved_pct: 5,
        tokens_saved_pct: 1,
        tool_calls_saved_pct: 0,
        verdict: legacyRecorded,
      }),
    ]);
    const v = (idx.runs[0].headline as Record<string, any>).verdict;
    expect(isRunVerdict(v)).toBe(true);
    expect(v.repeats).toBe(3);
    expect(JSON.stringify(v)).not.toMatch(/HARMFUL|makes the result worse/);
  });

  it('the site computes the same verdict for the same run file', () => {
    const r = run({
      success_vanilla_pct: 100,
      success_cc_pct: 100,
      tokens_saved_pct: 1,
      tool_calls_saved_pct: 0,
    });
    const fromIndex = (buildIndex([r]).runs[0].headline as Record<string, unknown>).verdict;
    expect(JSON.parse(JSON.stringify(D.agentVerdictOf(D.normalizeRun(r))))).toEqual(fromIndex);
  });
});

describe('no verdict without token data', () => {
  it('returns null for a headline without uncached_saved_pct (module and site)', () => {
    const h = {
      success_vanilla_pct: 75,
      success_cc_pct: 100,
      tokens_saved_pct: 88.2,
      tool_calls_saved_pct: 0,
    };
    expect(verdictFromHeadline(h)).toBeNull();
    const entry = {
      run_id: 'glm-1',
      kind: 'agent-glm',
      date: '2026-10-01',
      ts: '2026-10-01T00:00:00Z',
      headline: h,
    };
    expect(D.agentVerdictOf(D.normalizeRun(entry))).toBeNull();
  });
});

describe('verdictSummary (#160): result sentence + main reason, same in the site port', () => {
  const cases: Array<[string, VerdictInput]> = [
    ['suboptimal: first warning', { repeats: 3, cc: good({ success_arm_pct: 50 }) }],
    ['beneficial: token fact', { repeats: 3, cc: good() }],
    [
      'no clear effect: unstable',
      { repeats: 3, cc: good({ spread: { min: -5, max: 10, repeats: 3 } }) },
    ],
    ['no clear effect, no warning: first fact', { repeats: 3, cc: good({ cost_saved_pct: -2 }) }],
    ['few repeats increase', { repeats: 1, cc: good({ uncached_saved_pct: -20, ...noSpread }) }],
  ];
  it.each(cases)('%s', (_name, input) => {
    const v = computeVerdict(input);
    const ts = verdictSummary(v);
    expect(ts[0]).toBe(v!.sentences[0]);
    expect(ts).toHaveLength(2);
    expect(D.verdictSummary(JSON.parse(JSON.stringify(v)))).toEqual(ts);
  });
  it('picks the right reason', () => {
    expect(verdictSummary(computeVerdict(cases[0][1]))[1]).toBe(
      'The success rate decreases by more than 5 percentage points.',
    );
    expect(verdictSummary(computeVerdict(cases[1][1]))[1]).toBe(
      'Code-context decreases the token use by 20 %.',
    );
    expect(verdictSummary(computeVerdict(cases[2][1]))[1]).toBe(
      'The result is not stable across repeats.',
    );
    expect(verdictSummary(computeVerdict(cases[4][1]))[1]).toBe(
      'The token use increases by 20 % in 1 repeat.',
    );
    expect(verdictSummary(null)).toEqual([]);
    expect(D.verdictSummary(null)).toEqual([]);
  });
});
