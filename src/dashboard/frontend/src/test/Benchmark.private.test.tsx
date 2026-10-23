import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

// Private suite runs (CCA-19): the index merges them with a `private` flag, the
// suite alias and a source key; the page shows a chip, a filter, and loads the
// run detail through ?suite=<key>. Redacted runs show task ids, never prompts.

const calls: string[] = [];
vi.mock('@/lib/api', () => ({
  get: vi.fn(async (path: string) => {
    calls.push(path);
    if (path === '/api/bench/index') {
      return {
        source: { type: 'dir', label: 'test' },
        index: {
          schema: 'ccc-bench-index/1',
          runs: [
            {
              run_id: 'opus-20261012-092421',
              kind: 'agent-opus',
              date: '2026-10-12',
              ts: '2026-10-12T09:24:21Z',
              model: 'claude-opus-4-1',
              trigger: 'manual',
              headline: null,
              private: true,
              suite: 'Suite A',
              source_key: 'p0',
            },
            {
              run_id: 'opus-20261012-092421',
              kind: 'agent-opus',
              date: '2026-10-11',
              ts: '2026-10-11T09:24:21Z',
              model: 'claude-opus-4-1',
              trigger: 'manual',
              headline: null,
            },
          ],
        },
        private: [{ key: 'p0', alias: 'Suite A', runs: 1 }],
      };
    }
    if (path === '/api/bench/run/opus-20261012-092421?suite=p0') {
      return {
        source: { type: 'dir', label: 'private suite Suite A' },
        run: {
          run_id: 'opus-20261012-092421',
          schema: 'ccc-bench/1',
          kind: 'agent-opus',
          date: '2026-10-12',
          ts: '2026-10-12T09:24:21Z',
          notes: [],
          suite: { id: 's', private: true, redact: true },
          tasks: [{ id: 'S1', size: 'S', prompt_sha256: 'x' }],
          aggregate: {
            per_task: [
              {
                task_id: 'S1',
                vanilla: {
                  success_rate: 1,
                  tokens: { total: 10 },
                  uncached_tokens: 5,
                  tool_calls: 1,
                  mcp_tool_calls: 0,
                  wall_ms_mean: 1000,
                },
              },
            ],
          },
        },
      };
    }
    if (path === '/api/bench/run/opus-20261012-092421') {
      return {
        source: { type: 'dir', label: 'test' },
        run: {
          run_id: 'opus-20261012-092421',
          schema: 'ccc-bench/1',
          kind: 'agent-opus',
          date: '2026-10-11',
          ts: '2026-10-11T09:24:21Z',
          notes: ['public run'],
        },
      };
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
  await waitFor(() => expect(screen.getByRole('group', { name: 'Run filter' })).toBeTruthy());
}

describe('Benchmark: private suite runs', () => {
  it('shows a private chip, a filter and the redacted run detail by task id', async () => {
    await renderPage();
    const filter = screen.getByRole('group', { name: 'Run filter' });
    expect(within(filter).getByRole('button', { name: 'All (2)' })).toBeTruthy();
    expect(within(filter).getByRole('button', { name: 'Public (1)' })).toBeTruthy();
    expect(within(filter).getByRole('button', { name: 'Private (1)' })).toBeTruthy();

    const list = screen.getByRole('listbox', { name: 'Benchmark runs' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(within(options[0]).getByText('private · Suite A')).toBeTruthy();
    expect(within(options[1]).queryByText(/private/)).toBeNull();

    // The newest (private) run is selected: its detail loads via ?suite=p0.
    await waitFor(() => expect(screen.getByText('S1')).toBeTruthy());
    expect(calls).toContain('/api/bench/run/opus-20261012-092421?suite=p0');
    expect(screen.getByText(/Redacted run: tasks by id only/)).toBeTruthy();
  });

  it('filters to public runs and loads the public run with the same id separately', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Public (1)' }));
    const list = screen.getByRole('listbox', { name: 'Benchmark runs' });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await waitFor(() => expect(screen.getByText('public run')).toBeTruthy());
    expect(screen.queryByText(/Redacted run/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Private (1)' }));
    expect(
      within(screen.getByRole('listbox', { name: 'Benchmark runs' })).getByText(
        'private · Suite A',
      ),
    ).toBeTruthy();
  });
});
