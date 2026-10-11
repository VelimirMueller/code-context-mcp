import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

// Benchmark run detail, cold vs warm (CCA-11): the "Cold vs warm" table shows only
// when the run file carries aggregate.by_phase (`--cache-mode cold-warm` runs).
// Runs without by_phase render the detail as before.

let runs: Record<string, unknown> = {};
vi.mock('@/lib/api', () => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/bench/index') {
      return {
        source: { type: 'dir', label: 'test' },
        index: {
          schema: 'ccc-bench-index/1',
          runs: Object.keys(runs).map((id) => ({
            run_id: id, kind: 'agent-deepseek', date: '2026-10-11', ts: '2026-10-11T09:06:22Z',
            model: 'deepseek-v4-pro', trigger: 'manual', headline: null,
          })),
        },
      };
    }
    const m = path.match(/^\/api\/bench\/run\/(.+)$/);
    if (m) return { source: { type: 'dir', label: 'test' }, run: runs[decodeURIComponent(m[1])] };
    throw new Error('not found');
  }),
  post: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}));

function arm(over: Record<string, unknown> = {}) {
  return {
    sessions: 5, success_rate: 0.8, tokens: { input: 1000, cache_read: 500, output: 200, total: 1700 },
    uncached_tokens: 1200, tool_calls: 31, mcp_tool_calls: 0, wall_ms_mean: 49768, index_ms_mean: 0, cost_usd: 0.105016,
    ...over,
  };
}

const perTask = [{
  task_id: 'L1',
  vanilla: { success_rate: 1, tokens: { total: 31277 }, tool_calls: 8, mcp_tool_calls: 0, wall_ms_mean: 7900 },
  cc: { success_rate: 1, tokens: { total: 41000 }, tool_calls: 9, mcp_tool_calls: 3, wall_ms_mean: 8100 },
}];

function baseRun(id: string, aggregate: Record<string, unknown>) {
  return { run_id: id, schema: 'ccc-bench/1', kind: 'agent-deepseek', date: '2026-10-11', ts: '2026-10-11T09:06:22Z', notes: [], aggregate };
}

async function renderPage() {
  vi.resetModules();
  const { Benchmark } = await import('@/pages/Benchmark');
  render(<Benchmark />);
  await waitFor(() => expect(screen.getByText(/^Per task \(success · uncached tokens/)).toBeTruthy());
}

describe('Benchmark run detail: cold vs warm', () => {
  beforeEach(() => { runs = {}; });

  it('renders arm × phase rows when the run has aggregate.by_phase', async () => {
    runs = {
      'dsk-20261011-090622': baseRun('dsk-20261011-090622', {
        per_task: perTask,
        by_phase: {
          cold: { vanilla: arm(), cc: arm({ mcp_tool_calls: 11, uncached_tokens: 211729 }), cc_guided: arm({ cost_usd: null }) },
          warm: { vanilla: arm({ sessions: 10 }), cc: arm({ sessions: 10, wall_ms_mean: 61932 }), cc_guided: arm({ sessions: 10 }) },
        },
      }),
    };
    await renderPage();
    const table = await screen.findByRole('table', { name: 'Cold vs warm' });
    const t = within(table);
    for (const h of ['Arm', 'Phase', 'Success', 'Tokens', 'Uncached', 'Calls', 'MCP calls', 'Wall s', 'Cost']) {
      expect(t.getByRole('columnheader', { name: h })).toBeTruthy();
    }
    const rows = t.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.textContent?.slice(0, 14))).toEqual([
      expect.stringMatching(/^vanillacold/), expect.stringMatching(/^vanillawarm/),
      expect.stringMatching(/^cccold/), expect.stringMatching(/^ccwarm/),
      expect.stringMatching(/^cc-guidedcold/), expect.stringMatching(/^cc-guidedwarm/),
    ]);
    const ccCold = within(rows[2]);
    expect(ccCold.getByText('211,729')).toBeTruthy();
    expect(ccCold.getByText('11')).toBeTruthy();
    expect(ccCold.getByText('80%')).toBeTruthy();
    expect(ccCold.getByText('49.8')).toBeTruthy();
    expect(ccCold.getByText('$0.1050')).toBeTruthy();
    expect(within(rows[3]).getByText('61.9')).toBeTruthy();
    // A null cost (provider without prices) shows a dash, not $0.
    expect(within(rows[4]).getByText('—')).toBeTruthy();
  });

  it('hides the cost column when no phase row has a cost', async () => {
    runs = {
      'glm-20261011-090620': baseRun('glm-20261011-090620', {
        per_task: perTask,
        by_phase: { cold: { vanilla: arm({ cost_usd: null }), cc: arm({ cost_usd: null }) }, warm: { vanilla: arm({ cost_usd: null }), cc: arm({ cost_usd: null }) } },
      }),
    };
    await renderPage();
    const table = await screen.findByRole('table', { name: 'Cold vs warm' });
    expect(within(table).queryByRole('columnheader', { name: 'Cost' })).toBeNull();
    expect(within(table).getAllByRole('row')).toHaveLength(5);
  });

  it('renders the run detail unchanged when by_phase is absent', async () => {
    runs = { 'dsk-20261009-120000': baseRun('dsk-20261009-120000', { per_task: perTask }) };
    await renderPage();
    expect(screen.getByText('L1')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Cold vs warm' })).toBeNull();
    expect(screen.queryByText(/Cold vs warm/)).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });
});
