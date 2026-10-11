import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = join(__dirname, '..', 'site');
const FIX = join(__dirname, 'fixtures', 'site');

function loadData(): any {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://x/',
    runScripts: 'outside-only',
  });
  const w = dom.window as any;
  w.eval(readFileSync(join(SITE, 'config.js'), 'utf8'));
  w.eval(readFileSync(join(SITE, 'data.js'), 'utf8'));
  return w.BenchData;
}

const fx = (f: string): any => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
const D = loadData();

describe('site/data normalizeRun', () => {
  it('maps a legacy overdrive-bench/2 run to kind agent-claude with an NV headline', () => {
    const raw = fx('agent-claude.run.json');
    const n = D.normalizeRun(raw);
    expect(n).not.toBeNull();
    expect(n.kind).toBe('agent-claude');
    expect(n.id).toBe('20261009-101417');
    expect(n.date).toBe('2026-10-09');
    expect(n.model).toBe('opus');
    expect(n.headline).toMatchObject({ nv_mean: raw.nv.mean, nv_lo: raw.nv.lo, nv_hi: raw.nv.hi });
  });
  it('detects legacy via the prereg+nv fallback when schema is absent', () => {
    const n = D.normalizeRun({
      run_id: 'x',
      date: '2026-01-01',
      prereg: { version: 'v1' },
      nv: { mean: 0, lo: -1, hi: 1 },
    });
    expect(n.kind).toBe('agent-claude');
    expect(D.isLegacy({ prereg: {}, nv: {} })).toBe(true);
    expect(D.isLegacy({ schema: 'ccc-bench/1', kind: 'simulated', prereg: {}, nv: {} })).toBe(
      false,
    );
  });
  it('passes the new kinds through untouched', () => {
    for (const f of ['simulated.run.json', 'agent-glm.run.json', 'agent-deepseek.run.json']) {
      const raw = fx(f);
      const n = D.normalizeRun(raw);
      expect(n.kind).toBe(raw.kind);
      expect(n.id).toBe(raw.run_id);
      expect(n.ts).toBe(raw.ts);
      expect(n.headline).toEqual(raw.headline);
    }
  });
  it('accepts ccc-bench-index summary entries (legacy headline passthrough)', () => {
    const idx = fx('index.json');
    const entries = idx.runs.map(D.normalizeRun);
    expect(entries).toHaveLength(idx.runs.length);
    expect(entries.every((e: any) => e !== null)).toBe(true);
    const claude = entries.find((e: any) => e.kind === 'agent-claude');
    expect(claude.headline.nv_mean).toBeTypeOf('number');
  });
  it('filters invalid entries, never throws', () => {
    for (const bad of [
      null,
      42,
      'x',
      {},
      [],
      { kind: 'simulated' },
      { run_id: 'a', kind: 'simulated', date: 'yesterday' },
      { run_id: '', kind: 'agent-glm', date: '2026-01-01' },
    ]) {
      expect(D.normalizeRun(bad)).toBeNull();
    }
    expect(
      D.sortRunsDesc([null, 42, { run_id: 'a', kind: 'simulated', date: '2026-01-01' }]),
    ).toHaveLength(1);
  });
});

describe('site/data sortRunsDesc', () => {
  it('sorts mixed kinds newest first (ts, then run_id)', () => {
    const raws = [
      fx('agent-claude.run.json'),
      fx('agent-deepseek.run.json'),
      fx('simulated.run.json'),
      fx('agent-glm.run.json'),
    ];
    const sorted = D.sortRunsDesc(raws);
    expect(sorted.map((r: any) => r.id)).toEqual([
      'glm-20261010-153000',
      'sim-20261010-140322',
      'dsk-20261009-180000',
      '20261009-101417',
    ]);
  });
  it('tie-breaks equal ts by run_id, descending', () => {
    const mk = (id: string) => ({
      run_id: id,
      kind: 'simulated',
      date: '2026-01-01',
      ts: '2026-01-01T00:00:00+0000',
    });
    expect(D.sortRunsDesc([mk('b'), mk('a'), mk('c')]).map((r: any) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });
  it('falls back to date when ts is missing', () => {
    const a = { run_id: 'a', kind: 'simulated', date: '2026-01-02' };
    const b = { run_id: 'b', kind: 'simulated', date: '2026-01-03' };
    expect(D.sortRunsDesc([a, b]).map((r: any) => r.id)).toEqual(['b', 'a']);
  });
});

describe('site/data verdict and validity', () => {
  it('recomputes the verdict from the CI bounds', () => {
    expect(D.verdictOf({ lo: 0.1, hi: 0.2 })).toBe('KEEP');
    expect(D.verdictOf({ lo: -0.2, hi: -0.1 })).toBe('DROP');
    expect(D.verdictOf({ lo: -0.1, hi: 0.1 })).toBe('INCONCLUSIVE');
    expect(D.verdictOf(null)).toBeNull();
    expect(D.verdictOf({ lo: 'x', hi: 1 })).toBeNull();
  });
  it('gates legacy runs on valid flag, treatment rate and prereg version', () => {
    const base = { prereg: { version: 'v2' }, valid: true, treatment_received_rate: 0.9 };
    expect(D.isInvalid(base)).toBe(false);
    expect(D.legacyUsable(base)).toBe(true);
    expect(D.legacyUsable({ ...base, valid: false })).toBe(false);
    expect(D.legacyUsable({ ...base, treatment_received_rate: 0.3 })).toBe(false);
    expect(D.legacyUsable({ ...base, prereg: { version: 'v1' } })).toBe(false);
    const legacy = fx('agent-claude.run.json'); // v1, no valid flag
    expect(D.isInvalid(legacy)).toBe(true);
    expect(D.legacyUsable(legacy)).toBe(false);
    expect(D.treatmentRate({ treatment: { rate: 0.5 } })).toBe(0.5);
  });
});

describe('site/data kind accessors', () => {
  it('simulatedOf exposes headline numbers and embedded blocks', () => {
    const s = D.simulatedOf(fx('simulated.run.json'));
    expect(s.tokensSavedPct).toBe(44.9);
    expect(s.callsSavedPct).toBe(27.9);
    expect(s.mcpWinsPct).toBe(90.5);
    expect(s.effectSizeR).toBe(0.953);
    expect(s.tasks.length).toBeGreaterThan(0);
    expect(s.summary.totalVanillaTokens).toBeTypeOf('number');
    expect(s.stochastic.statistics.wilcoxon.n).toBe(200);
    expect(D.simulatedOf(fx('agent-glm.run.json'))).toBeNull();
  });
  it('agentOf exposes arms, aggregates and auth key NAME only', () => {
    const a = D.agentOf(fx('agent-glm.run.json'));
    expect(a.model).toBe('zai-coding-plan/glm-5.3');
    expect(a.successVanillaPct).toBe(50);
    expect(a.successCcPct).toBe(100);
    expect(a.tokensSavedPct).toBe(38.4);
    expect(a.indexMs).toBe(130);
    expect(a.perTask).toHaveLength(2);
    expect(a.keyEnv).toBe('ZAI_API_KEY');
    expect(D.agentOf(fx('simulated.run.json'))).toBeNull();
  });
  it('agentOf derives the honest metrics from sessions for a pre-CCA-08 run', () => {
    const a = D.agentOf(fx('agent-glm.run.json'));
    // uncached = input + output + cache_write: vanilla 91,550 (1 PASS), cc 55,400 (2 PASS)
    expect(a.uncached).toEqual({ vanilla: 91_550, cc: 55_400, cc_guided: null });
    expect(a.uncachedSavedPct).toBe(39.5);
    expect(a.uncachedPerPass).toEqual({ vanilla: 91_550, cc: 27_700, cc_guided: null });
    expect(a.costSavedPct).toBeNull(); // no session reports a cost
    expect(a.uncachedSpread).toBeNull(); // one repeat
    const row = a.perTask[0];
    const h = D.taskHonestOf(fx('agent-glm.run.json'), row, 'cc');
    expect(h.uncached).toBeTypeOf('number');
    expect(h.delta.pairs).toBe(1);
  });
  it('agentOf prefers the stored CCA-08 headline fields', () => {
    const raw = fx('agent-glm.run.json');
    raw.headline = {
      ...raw.headline,
      uncached_saved_pct: 1.5,
      cost_saved_pct: -2,
      uncached_per_pass: { vanilla: 10, cc: 9 },
    };
    const a = D.agentOf(raw);
    expect(a.uncachedSavedPct).toBe(1.5);
    expect(a.costSavedPct).toBe(-2);
    expect(a.uncachedPerPass).toEqual({ vanilla: 10, cc: 9, cc_guided: null });
  });
  it('legacyOf exposes the pre-registration story fields', () => {
    const L = D.legacyOf(fx('agent-claude.run.json'));
    expect(L.preregVersion).toBe('v1');
    expect(L.cadence).toBe('weekly');
    expect(L.criteria.length).toBeGreaterThan(0);
    expect(L.storedVerdict).toBe('INCONCLUSIVE');
    expect(L.verdict).toBe('INCONCLUSIVE');
    expect(L.usable).toBe(false);
  });
});
