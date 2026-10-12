import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

// Verdict (CCA-20): a one-line chip on the latest-per-kind card and a
// "Verdict" section with the ASD-STE100 sentences at the top of the run
// detail. A stored verdict is rendered as is; older entries get it computed
// with the same rule (scripts/bench/lib/verdict.mts).

let entries: Array<Record<string, unknown>> = [];
let runs: Record<string, unknown> = {};
vi.mock('@/lib/api', () => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/bench/index') {
      return { source: { type: 'dir', label: 'test' }, index: { schema: 'ccc-bench-index/1', runs: entries } };
    }
    const m = path.match(/^\/api\/bench\/run\/(.+)$/);
    if (m) return { source: { type: 'dir', label: 'test' }, run: runs[decodeURIComponent(m[1])] };
    throw new Error('not found');
  }),
  post: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}));

const ID = 'glm-20261011-090620';
const stored = {
  code: 'BENEFICIAL',
  indicative: true,
  repeats: 1,
  arm: 'cc_guided',
  arms: {},
  sentences: [
    'Result: code-context helps when the agent gets the instruction to use it.',
    'With guidance, code-context decreases the token use by 28 %.',
    'The tasks complete 25 % faster.',
    'This result is indicative only: the run has 1 repeat.',
  ],
};
const base = {
  success_vanilla_pct: 66.7,
  success_cc_pct: 93.3,
  uncached_saved_pct: 9.3,
  uncached_saved_spread: { min: -4.2, max: 28.2, repeats: 3 },
  cost_saved_pct: null,
  tokens_saved_pct: -25.7,
  tool_calls_saved_pct: -31.9,
};

function runFile(over: Record<string, unknown> = {}) {
  return {
    run_id: ID, schema: 'ccc-bench/1', kind: 'agent-glm', date: '2026-10-11', ts: '2026-10-11T09:06:20Z', notes: [],
    aggregate: { per_task: [], wall_ms: { vanilla_mean: 10000, cc_mean: 14000 } },
    ...over,
  };
}

async function renderPage() {
  vi.resetModules();
  const { Benchmark } = await import('@/pages/Benchmark');
  render(<Benchmark />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Verdict' })).toBeTruthy());
}

describe('Benchmark verdict (CCA-20)', () => {
  beforeEach(() => {
    entries = [{ run_id: ID, kind: 'agent-glm', date: '2026-10-11', ts: '2026-10-11T09:06:20Z', model: 'glm-5.3', trigger: 'manual', headline: { ...base, verdict: stored } }];
    runs = { [ID]: runFile() };
  });

  it('shows a one-line chip with the code and the indicative marker on the latest card', async () => {
    await renderPage();
    const card = screen.getAllByRole('button', { pressed: true })[0];
    const chip = within(card).getByTestId('verdict-chip');
    expect(chip.textContent).toBe('BENEFICIALindicative');
    expect(within(chip).getByText('BENEFICIAL').getAttribute('style')).toContain('var(--green)');
    // The chip comes before the headline numbers.
    const text = card.textContent ?? '';
    expect(text.indexOf('BENEFICIAL')).toBeLessThan(text.indexOf('Success vanilla'));
  });

  it('puts a Verdict section with the STE sentences at the top of the run detail', async () => {
    await renderPage();
    const section = screen.getByRole('region', { name: 'Verdict' });
    const s = within(section);
    expect(s.getByText(stored.sentences[0])).toBeTruthy();
    expect(s.getAllByRole('listitem').map((li) => li.textContent)).toEqual(stored.sentences.slice(1));
    // Before the headline / notes grid of the detail.
    const detail = section.parentElement as HTMLElement;
    expect((detail.textContent ?? '').indexOf('Verdict')).toBeLessThan((detail.textContent ?? '').indexOf('Headline'));
  });

  it('computes the verdict for an entry without one (red when the tasks are much slower)', async () => {
    entries[0].headline = { ...base, uncached_saved_spread: { min: 2, max: 9, repeats: 3 }, uncached_saved_pct: 5 };
    await renderPage();
    const section = screen.getByRole('region', { name: 'Verdict' });
    await waitFor(() => expect(within(section).getByText('HARMFUL')).toBeTruthy());
    expect(within(section).getByText('HARMFUL').getAttribute('style')).toContain('var(--red)');
    expect(within(section).getByText('The tasks are more than 25 % slower.')).toBeTruthy();
    expect(within(section).queryByText('indicative')).toBeNull();
  });

  it('shows no chip for a simulated run', async () => {
    entries = [{ run_id: 'sim-1', kind: 'simulated', date: '2026-10-10', ts: '2026-10-10T00:00:00Z', model: null, trigger: 'manual', headline: { tokensSavedPct: 10, callsSavedPct: 5, mcpWinsPct: 80, wilcoxonP: 0.01, effectSizeR: 0.5 } }];
    runs = { 'sim-1': { run_id: 'sim-1', schema: 'ccc-bench/1', kind: 'simulated', date: '2026-10-10', ts: '2026-10-10T00:00:00Z' } };
    vi.resetModules();
    const { Benchmark } = await import('@/pages/Benchmark');
    render(<Benchmark />);
    await waitFor(() => expect(screen.getAllByText('Tokens saved').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('verdict-chip')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Verdict' })).toBeNull();
  });
});
