import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// #205: a milestone edit sends PUT /api/milestone/:id with the fields the route
// parses (`status`, `target_date`) and the status values the database accepts.

const mockFetch = vi.fn();
global.fetch = mockFetch;

const listed = {
  id: 4,
  name: 'Beta launch',
  description: null,
  status: 'planned',
  target_date: '2026-12-01',
  progress: 0,
  ticket_count: 3,
  done_count: 1,
  archived_at: null,
  sprints: [],
};

const putCalls = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT');

/** Answers PUT with the saved row (no computed list fields), GET with the list. */
function serve(putResponse?: () => Promise<unknown>) {
  mockFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (putResponse) return putResponse();
      const body = JSON.parse(String(init.body));
      const { ticket_count: _t, done_count: _d, sprints: _s, ...row } = listed;
      return Promise.resolve({ ok: true, json: async () => ({ ...row, ...body }) });
    }
    const body = path === '/api/milestones' ? [listed] : [];
    return Promise.resolve({ ok: true, json: async () => body });
  });
}

describe('planningStore.updateMilestone (#205)', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    serve();
    const { usePlanningStore } = await import('@/stores/planningStore');
    usePlanningStore.setState({ milestones: [listed] });
  });

  it('sends status and target_date to PUT /api/milestone/:id and keeps the list fields', async () => {
    const { usePlanningStore } = await import('@/stores/planningStore');
    await usePlanningStore
      .getState()
      .updateMilestone(4, { status: 'active', target_date: '2026-12-15' });

    const calls = putCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/milestone/4');
    expect(JSON.parse(calls[0][1].body)).toEqual({ status: 'active', target_date: '2026-12-15' });

    const m = usePlanningStore.getState().milestones[0];
    expect(m.status).toBe('active');
    expect(m.target_date).toBe('2026-12-15');
    expect(m.ticket_count).toBe(3);
    expect(m.done_count).toBe(1);
  });
});

describe('Planning page: Edit milestone (#205)', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    serve();
    const { usePlanningStore } = await import('@/stores/planningStore');
    usePlanningStore.setState({ milestones: [] });
  });

  async function openEditor() {
    const { ProjectManagement } = await import('@/pages/ProjectManagement');
    render(<ProjectManagement />);
    fireEvent.click(await screen.findByLabelText('Edit Beta launch'));
  }

  it('saves a new status and target date', async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText('Status of Beta launch'), {
      target: { value: 'active' },
    });
    fireEvent.change(screen.getByLabelText('Target date of Beta launch'), {
      target: { value: '2026-12-15' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    const calls = putCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/milestone/4');
    expect(JSON.parse(calls[0][1].body)).toEqual({ status: 'active', target_date: '2026-12-15' });
    await waitFor(() => expect(screen.queryByLabelText('Status of Beta launch')).toBeNull());
    expect(screen.getByText('active')).toBeDefined();
  });

  it('clears the target date with null', async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText('Target date of Beta launch'), {
      target: { value: '' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    const calls = putCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ target_date: null });
  });

  it('sends nothing when nothing changed', async () => {
    await openEditor();
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(putCalls()).toHaveLength(0);
    expect(screen.queryByLabelText('Status of Beta launch')).toBeNull();
  });

  it('keeps the form open and shows the server error on 400', async () => {
    serve(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Invalid milestone status: x' }),
      }),
    );
    await openEditor();
    fireEvent.change(screen.getByLabelText('Status of Beta launch'), {
      target: { value: 'completed' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Invalid milestone status'),
    );
    expect(screen.getByLabelText('Status of Beta launch')).toBeDefined();
  });
});
