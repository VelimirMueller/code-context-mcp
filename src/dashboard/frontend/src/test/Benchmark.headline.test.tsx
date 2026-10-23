import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

// Benchmark headline (CCA-08): the agent headline leads with success, uncached
// tokens saved (with the min–max spread over repeats), cost saved and uncached
// tokens per PASS. The all-tokens figure (mostly cache reads) moves to the run
// detail. Per-task rows show the paired delta vs vanilla with min … max.

let entries: Array<Record<string, unknown>> = [];
let runs: Record<string, unknown> = {};
vi.mock('@/lib/api', () => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/bench/index') {
      return {
        source: { type: 'dir', label: 'test' },
        index: { schema: 'ccc-bench-index/1', runs: entries },
      };
    }
    const m = path.match(/^\/api\/bench\/run\/(.+)$/);
    if (m) return { source: { type: 'dir', label: 'test' }, run: runs[decodeURIComponent(m[1])] };
    throw new Error('not found');
  }),
  post: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}));

const ID = 'glm-20261011-090620';
const headline = {
  success_vanilla_pct: 66.7,
  success_cc_pct: 93.3,
  success_cc_guided_pct: 93.3,
  uncached_saved_pct: 9.3,
  guided_uncached_saved_pct: 29.7,
  uncached_saved_spread: { min: -4.2, max: 28.2, repeats: 3 },
  guided_uncached_saved_spread: { min: 9.5, max: 41.3, repeats: 3 },
  cost_saved_pct: null,
  guided_cost_saved_pct: null,
  uncached_per_pass: { vanilla: 47056, cc: 30495, cc_guided: 23622 },
  tokens_saved_pct: -25.7,
  tool_calls_saved_pct: -31.9,
  guided_tokens_saved_pct: 12.8,
};

function arm(over: Record<string, unknown> = {}) {
  return {
    success_rate: 1,
    tokens: { total: 90000 },
    uncached_tokens: 21000,
    tool_calls: 9,
    mcp_tool_calls: 0,
    wall_ms_mean: 8000,
    ...over,
  };
}

function run(perTask: unknown[]) {
  return {
    run_id: ID,
    schema: 'ccc-bench/1',
    kind: 'agent-glm',
    date: '2026-10-11',
    ts: '2026-10-11T09:06:20Z',
    notes: [],
    aggregate: { per_task: perTask },
  };
}

async function renderPage() {
  vi.resetModules();
  const { Benchmark } = await import('@/pages/Benchmark');
  render(<Benchmark />);
  await waitFor(() =>
    expect(screen.getByText(/^Per task \(success · uncached tokens/)).toBeTruthy(),
  );
}

describe('Benchmark headline: honest metrics (CCA-08)', () => {
  beforeEach(() => {
    entries = [
      {
        run_id: ID,
        kind: 'agent-glm',
        date: '2026-10-11',
        ts: '2026-10-11T09:06:20Z',
        model: 'glm-5.3',
        trigger: 'manual',
        headline,
      },
    ];
    runs = {
      [ID]: run([
        {
          task_id: 'L6',
          vanilla: arm({ success_rate: 2 / 3 }),
          cc: arm({ uncached_tokens: 18000 }),
          cc_guided: arm({ uncached_tokens: 15000 }),
          delta: {
            cc: { pairs: 3, saved_pct: 14.3, min: -12.5, max: 40.1 },
            cc_guided: { pairs: 3, saved_pct: -3, min: -3, max: -3 },
          },
        },
      ]),
    };
  });

  it('leads with success, uncached saved with spread, cost saved and uncached per PASS', async () => {
    await renderPage();
    const card = screen.getAllByRole('button', { pressed: true })[0];
    const c = within(card);
    expect(c.getByText('Uncached saved cc')).toBeTruthy();
    expect(c.getByText('+9.3%')).toBeTruthy();
    expect(c.getByText(/\[-4\.2% … \+28\.2%\]/)).toBeTruthy();
    expect(c.getByText('+29.7%')).toBeTruthy();
    expect(c.getByText('Cost saved cc')).toBeTruthy();
    expect(c.getByText('Uncached / PASS vanilla')).toBeTruthy();
    expect(c.getByText('47,056')).toBeTruthy();
    expect(c.getByText('30,495')).toBeTruthy();
    expect(c.getByText('23,622')).toBeTruthy();
    // The all-tokens figure is no headline row any more.
    expect(c.queryByText('Tokens saved')).toBeNull();
    // Order: success rows come before the uncached and cost rows.
    const text = card.textContent ?? '';
    expect(text.indexOf('Success vanilla')).toBeLessThan(text.indexOf('Uncached saved cc'));
    expect(text.indexOf('Uncached saved cc')).toBeLessThan(text.indexOf('Cost saved cc'));
    expect(text.indexOf('Cost saved cc')).toBeLessThan(text.indexOf('Uncached / PASS vanilla'));
  });

  it('shows unknown cost as a dash, not 0 %', async () => {
    await renderPage();
    const card = screen.getAllByRole('button', { pressed: true })[0];
    const label = within(card).getByText('Cost saved cc');
    expect(label.nextElementSibling?.textContent).toBe('—');
  });

  it('per-task rows show uncached tokens and the paired delta with min … max', async () => {
    await renderPage();
    const table = screen.getByRole('table', { name: 'Per task' });
    const t = within(table);
    expect(t.getByRole('columnheader', { name: 'Δ unc cc' })).toBeTruthy();
    expect(t.getByRole('columnheader', { name: 'Δ unc cc-guided' })).toBeTruthy();
    expect(t.getByText('67% · 21,000 unc · 9 calls')).toBeTruthy();
    expect(t.getByText('+14.3%')).toBeTruthy();
    expect(t.getByText(/\[-12\.5% … \+40\.1%\]/)).toBeTruthy();
    expect(t.getByText('-3%')).toBeTruthy();
  });

  it('moves the all-tokens figure to the run detail', async () => {
    await renderPage();
    const line = screen.getByText(/^All tokens incl\. cache reads/);
    expect(line.textContent).toContain('-25.7%');
    expect(line.textContent).toContain('+12.8%');
  });

  it('shows dashes for an index entry built before CCA-08', async () => {
    entries[0].headline = {
      success_vanilla_pct: 93.3,
      success_cc_pct: 93.3,
      tokens_saved_pct: 6.7,
      tool_calls_saved_pct: -18.3,
    };
    runs[ID] = run([
      {
        task_id: 'L1',
        vanilla: {
          success_rate: 1,
          tokens: { total: 31277 },
          tool_calls: 8,
          mcp_tool_calls: 0,
          wall_ms_mean: 7900,
        },
      },
    ]);
    await renderPage();
    const card = screen.getAllByRole('button', { pressed: true })[0];
    const label = within(card).getByText('Uncached saved cc');
    expect(label.nextElementSibling?.textContent).toBe('—');
    // Old per-task rows fall back to all tokens, marked as such.
    expect(screen.getByText('100% · 31,277 tok (all) · 8 calls')).toBeTruthy();
  });
});
