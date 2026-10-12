import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { latestPerModel, changeText, changeSign, successText, plainSummary, simpleRow } from '@/lib/latestRun';
import type { BenchIndexEntry } from '@/stores/benchmarkStore';

// #160: the page opens with ONE table for the latest run (one row per model,
// plain words); everything else sits in one collapsed "Show details" block.

const glmHeadline = {
  success_vanilla_pct: 91.7, success_cc_pct: 83.3, success_cc_guided_pct: 86.1,
  uncached_saved_pct: 11.6, guided_uncached_saved_pct: 25,
  uncached_saved_spread: { min: 1.9, max: 23.2, repeats: 3 },
  guided_uncached_saved_spread: { min: 9.2, max: 34.2, repeats: 3 },
  cost_saved_pct: null, guided_cost_saved_pct: null,
  tokens_saved_pct: 28.1, tool_calls_saved_pct: 5,
};
const opusHeadline = {
  success_vanilla_pct: 75, success_cc_pct: 75, success_cc_guided_pct: 87.5,
  uncached_saved_pct: 11.2, guided_uncached_saved_pct: 15.4,
  uncached_saved_spread: null, guided_uncached_saved_spread: null,
  cost_saved_pct: 7.9, guided_cost_saved_pct: 13.5,
  tokens_saved_pct: -19.7, tool_calls_saved_pct: -5.6,
};
const dskHeadline = {
  success_vanilla_pct: 90, success_cc_pct: 90,
  uncached_saved_pct: -8, uncached_saved_spread: { min: -15, max: 3, repeats: 3 },
  cost_saved_pct: -3, tokens_saved_pct: 1, tool_calls_saved_pct: 0,
};

const entries: BenchIndexEntry[] = [
  { run_id: 'sim-1', kind: 'simulated', date: '2026-10-12', ts: '2026-10-12T10:00:00Z', model: null, trigger: 'manual', headline: { tokensSavedPct: 40, callsSavedPct: 20, mcpWinsPct: 90, wilcoxonP: 0, effectSizeR: 0.9 } },
  { run_id: 'glm-2', kind: 'agent-glm', date: '2026-10-12', ts: '2026-10-12T09:24:19Z', model: 'glm-5.3', trigger: 'manual', headline: glmHeadline, private: true, suite: 'Real-world suite A', source_key: 'p0' },
  { run_id: 'opus-2', kind: 'agent-opus', date: '2026-10-11', ts: '2026-10-11T14:54:49Z', model: 'claude-opus-5-5', trigger: 'manual', headline: opusHeadline },
  { run_id: 'dsk-2', kind: 'agent-deepseek', date: '2026-10-11', ts: '2026-10-11T13:00:00Z', model: 'deepseek-v4-pro', trigger: 'manual', headline: dskHeadline },
  { run_id: 'glm-1', kind: 'agent-glm', date: '2026-10-11', ts: '2026-10-11T12:00:00Z', model: 'glm-5.3', trigger: 'manual', headline: dskHeadline },
  { run_id: 'opus-1', kind: 'agent-opus', date: '2026-10-10', ts: '2026-10-10T12:00:00Z', model: 'claude-opus-5-5', trigger: 'manual', headline: glmHeadline, private: true, suite: 'Real-world suite A', source_key: 'p0' },
];

const results = (n: number) => Array.from({ length: n }, () => ({ task_id: 'T1' }));
const runFile = (id: string, kind: string, wall: Record<string, number> | undefined, repeats: number) => ({
  run_id: id, schema: 'ccc-bench/1', kind, date: '2026-10-12', ts: '2026-10-12T00:00:00Z', notes: [],
  aggregate: { per_task: [], ...(wall ? { wall_ms: wall } : {}) },
  arms: { vanilla: { results: results(repeats) } },
});
const runs: Record<string, unknown> = {
  'glm-2?suite=p0': runFile('glm-2', 'agent-glm', { vanilla_mean: 78739, cc_mean: 66091, cc_guided_mean: 60332 }, 3),
  'opus-2': runFile('opus-2', 'agent-opus', undefined, 1),
  'dsk-2': runFile('dsk-2', 'agent-deepseek', { vanilla_mean: 10000, cc_mean: 12000 }, 3),
  'glm-1': runFile('glm-1', 'agent-glm', undefined, 3),
  'opus-1?suite=p0': runFile('opus-1', 'agent-opus', undefined, 3),
  'sim-1': { run_id: 'sim-1', schema: 'ccc-bench/1', kind: 'simulated', date: '2026-10-12', ts: '2026-10-12T10:00:00Z' },
};

vi.mock('@/lib/api', () => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/bench/index') {
      return { source: { type: 'dir', label: 'test' }, index: { schema: 'ccc-bench-index/1', runs: entries } };
    }
    const m = path.match(/^\/api\/bench\/run\/(.+)$/);
    if (m) {
      const run = runs[decodeURIComponent(m[1])];
      if (run) return { source: { type: 'dir', label: 'test' }, run };
    }
    throw new Error('not found');
  }),
  post: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}));

async function renderPage() {
  vi.resetModules();
  const { Benchmark } = await import('@/pages/Benchmark');
  render(<Benchmark />);
  const table = await screen.findByRole('table', { name: 'Latest run per model' });
  // Speed needs the run files (wall times): wait until they are in.
  await waitFor(() => expect(within(table).getByText('23 % faster')).toBeTruthy());
  return table;
}

const rowOf = (table: HTMLElement, kind: string) =>
  table.querySelector(`tbody tr[data-kind="${kind}"]`) as HTMLElement;
const cells = (row: HTMLElement) => [...row.children].map((c) => c.textContent);

describe('latestPerModel (#160)', () => {
  it('takes the newest run per agent model over public and private runs, in GLM, Opus, DeepSeek order', () => {
    expect(latestPerModel(entries).map((e) => e.run_id)).toEqual(['glm-2', 'opus-2', 'dsk-2']);
  });

  it('skips a model without runs and ignores simulated runs', () => {
    expect(latestPerModel(entries.filter((e) => e.kind !== 'agent-opus')).map((e) => e.kind)).toEqual(['agent-glm', 'agent-deepseek']);
    expect(latestPerModel([entries[0]])).toEqual([]);
  });

  it('words a change as less / more / same and unknown as a dash', () => {
    expect(changeText(24.6, 'less', 'more')).toBe('25 % less');
    expect(changeText(-8, 'less', 'more')).toBe('8 % more');
    expect(changeText(0.2, 'less', 'more')).toBe('same');
    expect(changeText(null, 'less', 'more')).toBe('—');
    expect(changeText(-23, 'faster', 'slower')).toBe('23 % slower');
    expect(successText({ successVanillaPct: 91.7, successArmPct: 86.1 })).toBe('92 % → 86 %');
    expect(successText({ successVanillaPct: null, successArmPct: 86.1 })).toBe('—');
  });
});

describe('latest-run helpers: review fixes (#160)', () => {
  it('a value that rounds to 0 is "same" in the text and neutral in the sign', () => {
    for (const x of [0, 0.4, -0.4]) {
      expect(changeText(x, 'less', 'more')).toBe('same');
      expect(changeSign(x)).toBe(0);
    }
    expect(changeSign(-0.6)).toBe(-1);
    expect(changeSign(null)).toBeNull();
  });

  it('plainSummary strips an optional "Result: " and upper-cases the first letter', () => {
    expect(plainSummary(['Result: code-context helps.', 'It is fast.'])).toBe('Code-context helps. It is fast.');
    expect(plainSummary(['Result:   the tasks fail.'])).toBe('The tasks fail.');
    expect(plainSummary(['code-context helps.'])).toBe('Code-context helps.');
    expect(plainSummary([])).toBe('');
  });

  it('simpleRow never takes vanilla numbers: a stored verdict for a missing arm falls back to cc', () => {
    const stored = { code: 'BENEFICIAL', indicative: false, repeats: 3, arm: 'cc_guided', arms: {}, sentences: ['Result: code-context helps.'] };
    const entry = { ...entries[3], headline: { ...dskHeadline, verdict: stored } } as BenchIndexEntry;
    const row = simpleRow(entry, undefined);
    expect([row.successVanillaPct, row.successArmPct, row.tokensSavedPct]).toEqual([90, 90, -8]);
    // An odd stored arm is no verdict: the rule computes one from cc.
    const odd = { ...entry, headline: { ...dskHeadline, verdict: { ...stored, arm: 'vanilla' } } } as unknown as BenchIndexEntry;
    const r2 = simpleRow(odd, undefined);
    expect(r2.verdict?.arm).toBe('cc');
    expect(r2.tokensSavedPct).toBe(-8);
  });
});

describe('Benchmark page: latest run table (#160)', () => {
  it('shows one row per model with plain columns', async () => {
    const table = await renderPage();
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Model', 'Result', 'Success', 'Tokens', 'Cost', 'Speed', 'Repeats']);
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect([...rows].map((r) => r.getAttribute('data-kind'))).toEqual(['agent-glm', 'agent-opus', 'agent-deepseek']);
    // No jargon in the table.
    expect(table.textContent).not.toMatch(/uncached|cc-guided|\[|…/i);
  });

  it('uses the best arm of the verdict: success, tokens, unknown cost as a dash, speed, repeats', async () => {
    const table = await renderPage();
    expect(cells(rowOf(table, 'agent-glm'))).toEqual(['GLM', 'SUBOPTIMAL', '92 % → 86 %', '25 % less', '—', '23 % faster', '3×']);
    await waitFor(() =>
      expect(cells(rowOf(table, 'agent-opus'))).toEqual(['Opus', 'BENEFICIALindicative', '75 % → 88 %', '15 % less', '14 % less', '—', '1×']),
    );
    expect(cells(rowOf(table, 'agent-deepseek'))).toEqual(['DeepSeek', 'NO CLEAR EFFECT', '90 % → 90 %', '8 % more', '3 % more', '20 % slower', '3×']);
  });

  it('colours the result chip: green beneficial, grey no clear effect, red suboptimal', async () => {
    const table = await renderPage();
    const chip = (kind: string) => within(rowOf(table, kind)).getByTestId('result-chip').firstElementChild as HTMLElement;
    expect(chip('agent-glm').getAttribute('style')).toContain('var(--red)');
    expect(chip('agent-opus').getAttribute('style')).toContain('var(--green)');
    expect(chip('agent-deepseek').getAttribute('style')).toContain('var(--text3)');
  });

  it('adds a caption and one plain sentence per model from the verdict', async () => {
    await renderPage();
    const section = screen.getByRole('region', { name: 'Latest run' });
    expect(section.textContent).toContain('2026-10-12 / 2026-10-11 · Real-world suite A / test fixture');
    expect(section.textContent).toContain('Tokens = tokens the model had to process (cache excluded).');
    const items = within(screen.getByRole('list', { name: 'Result per model' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'GLM: Code-context is suboptimal for these tasks. The success rate decreases by more than 5 percentage points.',
      'Opus: Code-context helps with and without the instruction to use it. With guidance, code-context decreases the token use by 15 %.',
      'DeepSeek: Code-context shows no clear effect. The result is not stable across repeats.',
    ]);
  });

  it('keeps every other view in one "Show details" block, collapsed by default', async () => {
    await renderPage();
    const details = screen.getByTestId('bench-details') as HTMLDetailsElement;
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toMatch(/^Show details/);
    const d = within(details);
    expect(d.getByRole('group', { name: 'Run filter' })).toBeTruthy();
    expect(d.getByRole('listbox', { name: 'Benchmark runs' })).toBeTruthy();
    expect(d.getByRole('tab', { name: 'Simulated (2026-06)' })).toBeTruthy();
    // The filter does not change the latest table.
    expect(screen.getByRole('table', { name: 'Latest run per model' }).closest('details')).toBeNull();
  });
});
