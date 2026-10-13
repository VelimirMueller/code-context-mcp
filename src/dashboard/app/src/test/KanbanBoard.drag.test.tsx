import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Ticket } from '@/types';

// #198: a drop on a Kanban column sends PATCH /api/ticket/:id with the new status.

vi.mock('framer-motion', () => ({
  motion: {
    div: (p: Record<string, unknown>) => <div {...filterDom(p)} />,
    span: (p: Record<string, unknown>) => <span {...filterDom(p)} />,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => true,
}));

function filterDom(props: Record<string, unknown>) {
  const skip = ['whileHover', 'layout', 'variants', 'initial', 'animate', 'exit', 'transition'];
  return Object.fromEntries(Object.entries(props).filter(([k]) => !skip.includes(k)));
}

const mockFetch = vi.fn();
global.fetch = mockFetch;

const ticket = (id: number, status: string): Ticket => ({
  id,
  ticket_ref: `T-${id}`,
  title: `Ticket ${id}`,
  description: null,
  priority: 'P2',
  status,
  assigned_to: null,
  story_points: 2,
  milestone: null,
  qa_verified: 0,
  verified_by: null,
  acceptance_criteria: null,
  notes: null,
});

const nonGetCalls = () =>
  mockFetch.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

/** Drop ticket `id` on the column whose header text is `label`. */
const dropOn = async (label: string, id: number) => {
  const column = screen.getByText(label, { selector: 'span' }).closest('[style*="min-height"]')!;
  const dataTransfer = { getData: () => String(id), setData: vi.fn(), effectAllowed: '' };
  await act(async () => {
    fireEvent.dragOver(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });
  });
};

describe('KanbanBoard drag and drop (#198)', () => {
  let useSprintStore: typeof import('@/stores/sprintStore').useSprintStore;

  beforeEach(async () => {
    useSprintStore = (await import('@/stores/sprintStore')).useSprintStore;
    useSprintStore.setState({ tickets: [ticket(1, 'TODO')], selectedSprintId: null });
    mockFetch.mockReset();
  });

  it('sends PATCH /api/ticket/:id with the target status and keeps the card there', async () => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          init?.method === 'PATCH' ? { ok: true, ticket: ticket(1, 'IN_PROGRESS') } : [],
      }),
    );
    const { KanbanBoard } = await import('@/components/organisms/KanbanBoard');
    render(<KanbanBoard tickets={[ticket(1, 'TODO')]} />);

    await dropOn('In Progress', 1);

    const calls = nonGetCalls();
    expect(calls).toHaveLength(1);
    const [path, init] = calls[0];
    expect(path).toBe('/api/ticket/1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'IN_PROGRESS' });
    expect(useSprintStore.getState().tickets[0].status).toBe('IN_PROGRESS');
    expect(screen.getByText('1 · 2sp')).toBeDefined();
  });

  it('moves the card back when the server refuses the status', async () => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? Promise.resolve({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: "invalid status 'DONE'" }),
          })
        : Promise.resolve({ ok: true, json: async () => [] }),
    );
    const { KanbanBoard } = await import('@/components/organisms/KanbanBoard');
    const { container } = render(<KanbanBoard tickets={[ticket(1, 'TODO')]} />);

    await dropOn('Not Done', 1);

    expect(nonGetCalls()).toHaveLength(1);
    // The card is back in "To Do": the first column holds it.
    const firstColumn = container.querySelector('[style*="min-height"]')!;
    expect(firstColumn.textContent).toContain('Ticket 1');
  });

  it('sends nothing when the card is dropped on its own column', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    const { KanbanBoard } = await import('@/components/organisms/KanbanBoard');
    render(<KanbanBoard tickets={[ticket(1, 'TODO')]} />);

    await dropOn('To Do', 1);

    expect(nonGetCalls()).toHaveLength(0);
  });
});
