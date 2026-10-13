import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// #199: the New milestone form sends POST /api/milestones with `name`, the
// field the route parses, and the list shows the saved milestone.

const mockFetch = vi.fn();
global.fetch = mockFetch;

const saved = {
  id: 7,
  name: 'Beta launch',
  description: null,
  status: 'planned',
  target_date: '2026-12-01',
  progress: 0,
  ticket_count: 0,
  done_count: 0,
  archived_at: null,
  sprints: [],
};

const postCalls = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('Planning page: New milestone (#199)', () => {
  let created = false;

  beforeEach(async () => {
    created = false;
    mockFetch.mockReset();
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/milestones' && init?.method === 'POST') {
        created = true;
        return Promise.resolve({ ok: true, json: async () => saved });
      }
      const body = path === '/api/milestones' ? (created ? [saved] : []) : [];
      return Promise.resolve({ ok: true, json: async () => body });
    });
    const { usePlanningStore } = await import('@/stores/planningStore');
    usePlanningStore.setState({ milestones: [] });
  });

  it('sends name and target_date, then lists the saved milestone', async () => {
    const { ProjectManagement } = await import('@/pages/ProjectManagement');
    render(<ProjectManagement />);

    fireEvent.click(screen.getByText('New milestone'));
    fireEvent.change(screen.getByLabelText('Milestone name'), {
      target: { value: ' Beta launch ' },
    });
    fireEvent.change(screen.getByLabelText('Milestone target date'), {
      target: { value: '2026-12-01' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Create'));
    });

    const calls = postCalls();
    expect(calls).toHaveLength(1);
    const [path, init] = calls[0];
    expect(path).toBe('/api/milestones');
    expect(JSON.parse(init.body)).toEqual({ name: 'Beta launch', target_date: '2026-12-01' });
    expect(await screen.findByText('Beta launch')).toBeDefined();
    expect(screen.queryByLabelText('Milestone name')).toBeNull();
  });

  it('keeps the form open and shows the server error on 400', async () => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: 'name is required' }),
          })
        : Promise.resolve({ ok: true, json: async () => [] }),
    );
    const { ProjectManagement } = await import('@/pages/ProjectManagement');
    render(<ProjectManagement />);

    fireEvent.click(screen.getByText('New milestone'));
    fireEvent.change(screen.getByLabelText('Milestone name'), { target: { value: 'X' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Create'));
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('name is required'),
    );
    expect(screen.getByLabelText('Milestone name')).toBeDefined();
  });
});
