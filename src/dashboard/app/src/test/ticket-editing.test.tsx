import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Ticket, TicketAssignment } from '@/types';

// Mock framer-motion (same approach as molecules.test.tsx)
vi.mock('framer-motion', () => ({
  motion: {
    div: (p: any) => <div {...filterDom(p)} />,
    span: (p: any) => <span {...filterDom(p)} />,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  useReducedMotion: () => true,
}));

function filterDom(props: Record<string, any>) {
  const skip = ['whileHover', 'layout', 'variants', 'initial', 'animate', 'exit', 'transition'];
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!skip.includes(k)) clean[k] = v;
  }
  return clean;
}

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Route mocked fetch responses by "METHOD path"; unrouted paths resolve {}.
const routeFetch = (routes: Record<string, unknown>) => {
  mockFetch.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = routes[`${method} ${path}`] ?? routes[path] ?? {};
    return Promise.resolve({ ok: true, json: async () => body });
  });
};

const failPatchWith = (status: number, error: string) => {
  mockFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return Promise.resolve({
        ok: false,
        status,
        statusText: 'Bad Request',
        json: async () => ({ error }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => (path === '/api/epics' ? [] : {}) });
  });
};

const patchCalls = () =>
  mockFetch.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'PATCH');

const baseTicket: Ticket = {
  id: 1,
  ticket_ref: 'T-250',
  title: 'Original title',
  description: 'Original description',
  priority: 'P2',
  status: 'TODO',
  assigned_to: 'fe-engineer',
  story_points: 3,
  milestone: null,
  qa_verified: 0,
  verified_by: null,
  acceptance_criteria: null,
  notes: null,
  assignments: [{ role: 'fe-engineer', model: null, is_lead: 1 }],
};

// ─── sprintStore.updateTicket ──────────────────────────────────────────

describe('sprintStore.updateTicket', () => {
  let useSprintStore: typeof import('@/stores/sprintStore').useSprintStore;
  let useToastStore: typeof import('@/stores/toastStore').useToastStore;

  beforeEach(async () => {
    useSprintStore = (await import('@/stores/sprintStore')).useSprintStore;
    useToastStore = (await import('@/stores/toastStore')).useToastStore;
    useSprintStore.setState({ tickets: [{ ...baseTicket }] });
    useToastStore.setState({ toasts: [] });
    mockFetch.mockReset();
  });

  it('sends PATCH /api/ticket/:id and reconciles from the response ticket', async () => {
    routeFetch({
      'PATCH /api/ticket/1': {
        ok: true,
        ticket: { ...baseTicket, title: 'Server title', change_seq: 4, pending_change: 1 },
      },
    });

    const updated = await useSprintStore.getState().updateTicket(1, { title: 'Client title' });

    const [path, init] = patchCalls()[0];
    expect(path).toBe('/api/ticket/1');
    expect(JSON.parse(init.body)).toEqual({ title: 'Client title' });
    // Reconciled from the response, not the optimistic value
    expect(updated?.title).toBe('Server title');
    expect(updated?.change_seq).toBe(4);
    expect(useSprintStore.getState().tickets[0].title).toBe('Server title');
  });

  it('applies the optimistic update immediately', async () => {
    let resolveFetch: (v: unknown) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFetch = r;
        }),
    );

    const promise = useSprintStore.getState().updateTicket(1, { status: 'IN_PROGRESS' });
    expect(useSprintStore.getState().tickets[0].status).toBe('IN_PROGRESS');

    resolveFetch!({
      ok: true,
      json: async () => ({ ok: true, ticket: { ...baseTicket, status: 'IN_PROGRESS' } }),
    });
    await promise;
    expect(useSprintStore.getState().tickets[0].status).toBe('IN_PROGRESS');
  });

  it('reverts the optimistic update and toasts the server error on 400', async () => {
    failPatchWith(400, 'status DONE is process-controlled');

    const result = await useSprintStore.getState().updateTicket(1, { status: 'BLOCKED' });

    expect(result).toBeNull();
    expect(useSprintStore.getState().tickets[0].status).toBe('TODO');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toBe('status DONE is process-controlled');
  });

  it('optimistically maps assignments to display shape and mirrors the lead', async () => {
    let resolveFetch: (v: unknown) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFetch = r;
        }),
    );

    const promise = useSprintStore.getState().updateTicket(1, {
      assignments: [
        { role: 'security', model: 'claude-haiku-4-5', lead: false },
        { role: 'be-engineer', model: null, lead: true },
      ],
    });

    const optimistic = useSprintStore.getState().tickets[0];
    expect(optimistic.assignments).toEqual([
      { role: 'security', model: 'claude-haiku-4-5', is_lead: 0 },
      { role: 'be-engineer', model: null, is_lead: 1 },
    ]);
    expect(optimistic.assigned_to).toBe('be-engineer');

    resolveFetch!({ ok: true, json: async () => ({ ok: true, ticket: optimistic }) });
    await promise;
  });
});

// ─── TicketDetailModal ─────────────────────────────────────────────────

describe('TicketDetailModal', () => {
  let useSprintStore: typeof import('@/stores/sprintStore').useSprintStore;
  let useAgentStore: typeof import('@/stores/agentStore').useAgentStore;
  let useToastStore: typeof import('@/stores/toastStore').useToastStore;

  const agents = [
    { role: 'fe-engineer', name: 'FE', description: '', model: 'claude-sonnet-5' },
    { role: 'security', name: 'Sec', description: '', model: 'claude-sonnet-5' },
  ];

  const renderModal = async (ticket: Ticket = { ...baseTicket }) => {
    const { TicketDetailModal } = await import('@/components/organisms/TicketDetailModal');
    return render(
      <TicketDetailModal
        ticket={ticket}
        milestones={[]}
        onClose={() => {}}
        onMilestoneChange={async () => {}}
        onEpicChange={async () => {}}
      />,
    );
  };

  beforeEach(async () => {
    useSprintStore = (await import('@/stores/sprintStore')).useSprintStore;
    useAgentStore = (await import('@/stores/agentStore')).useAgentStore;
    useToastStore = (await import('@/stores/toastStore')).useToastStore;
    useSprintStore.setState({ tickets: [{ ...baseTicket }] });
    useAgentStore.setState({ agents: agents as any, loading: false });
    useToastStore.setState({ toasts: [] });
    mockFetch.mockReset();
    routeFetch({ 'GET /api/epics': [] });
  });

  it('renders the editor with status limited to UI transitions and DONE disabled with tooltip', async () => {
    await renderModal();

    const statusSelect = screen.getByLabelText('Ticket status') as HTMLSelectElement;
    const options = [...statusSelect.options];
    const enabled = options.filter((o) => !o.disabled).map((o) => o.value);
    expect(enabled).toEqual(['TODO', 'IN_PROGRESS', 'BLOCKED']);

    const done = options.find((o) => o.value === 'DONE')!;
    expect(done.disabled).toBe(true);
    expect(done.title).toBe('Completed by the Claude session after QA');
  });

  it('round-trips a title edit through PATCH and shows the reconciled value', async () => {
    routeFetch({
      'GET /api/epics': [],
      'PATCH /api/ticket/1': {
        ok: true,
        ticket: { ...baseTicket, title: 'Server-reconciled title', change_seq: 2 },
      },
    });
    await renderModal();

    fireEvent.click(screen.getByText('Original title'));
    const input = screen.getByLabelText('Ticket title');
    fireEvent.change(input, { target: { value: 'Renamed title' } });
    await act(async () => {
      fireEvent.blur(input);
    });

    const [path, init] = patchCalls()[0];
    expect(path).toBe('/api/ticket/1');
    expect(JSON.parse(init.body)).toEqual({ title: 'Renamed title' });
    expect(await screen.findByText('Server-reconciled title')).toBeDefined();
    expect(useSprintStore.getState().tickets[0].title).toBe('Server-reconciled title');
  });

  it('saves notes via PATCH /api/ticket/:id on blur (#197)', async () => {
    routeFetch({
      'GET /api/epics': [],
      'PATCH /api/ticket/1': { ok: true, ticket: { ...baseTicket, notes: 'Check the retry path' } },
    });
    await renderModal();

    const notes = screen.getByLabelText('Ticket notes');
    fireEvent.change(notes, { target: { value: 'Check the retry path' } });
    await act(async () => {
      fireEvent.blur(notes);
    });

    const calls = mockFetch.mock.calls.filter(([, i]) => i?.method && i.method !== 'GET');
    expect(calls).toHaveLength(1);
    const [path, init] = calls[0];
    expect(path).toBe('/api/ticket/1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ notes: 'Check the retry path' });
    expect(useSprintStore.getState().tickets[0].notes).toBe('Check the retry path');
  });

  it('does not send a request when the notes are unchanged', async () => {
    await renderModal();
    await act(async () => {
      fireEvent.blur(screen.getByLabelText('Ticket notes'));
    });
    expect(patchCalls()).toHaveLength(0);
  });

  it('clears the description with null via PATCH on blur (#206)', async () => {
    routeFetch({
      'GET /api/epics': [],
      'PATCH /api/ticket/1': { ok: true, ticket: { ...baseTicket, description: null } },
    });
    await renderModal();

    fireEvent.click(screen.getByText('Original description'));
    const textarea = screen.getByLabelText('Ticket description');
    fireEvent.change(textarea, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.blur(textarea);
    });

    const calls = patchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/ticket/1');
    expect(JSON.parse(calls[0][1].body)).toEqual({ description: null });
    expect(useSprintStore.getState().tickets[0].description).toBeNull();
    expect(await screen.findByText('Add description…')).toBeDefined();
  });

  it('saves story points via PATCH on blur', async () => {
    routeFetch({
      'GET /api/epics': [],
      'PATCH /api/ticket/1': { ok: true, ticket: { ...baseTicket, story_points: 8 } },
    });
    await renderModal();

    const points = screen.getByLabelText('Story points');
    fireEvent.change(points, { target: { value: '8' } });
    await act(async () => {
      fireEvent.blur(points);
    });

    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ story_points: 8 });
  });

  it('reverts the optimistic status change and surfaces the error on 400', async () => {
    failPatchWith(400, 'invalid transition');
    await renderModal();

    const statusSelect = screen.getByLabelText('Ticket status') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(statusSelect, { target: { value: 'BLOCKED' } });
    });

    await waitFor(() => expect(statusSelect.value).toBe('TODO'));
    expect(useSprintStore.getState().tickets[0].status).toBe('TODO');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toBe('invalid transition');
  });

  it('commits assignment changes through PATCH with the lead flag', async () => {
    routeFetch({
      'GET /api/epics': [],
      'PATCH /api/ticket/1': {
        ok: true,
        ticket: {
          ...baseTicket,
          assigned_to: 'fe-engineer',
          assignments: [
            { role: 'fe-engineer', model: null, is_lead: 1 },
            { role: 'security', model: null, is_lead: 0 },
          ],
        },
      },
    });
    await renderModal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assign security' }));
    });

    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({
      assignments: [
        { role: 'fe-engineer', model: null, lead: true },
        { role: 'security', model: null, lead: false },
      ],
    });
  });
});

// ─── AssignmentEditor ──────────────────────────────────────────────────

describe('AssignmentEditor', () => {
  const roles = ['fe-engineer', 'security', 'qa'];
  const twoAssigned: TicketAssignment[] = [
    { role: 'fe-engineer', model: null, is_lead: 1 },
    { role: 'security', model: null, is_lead: 0 },
  ];

  const renderEditor = async (value: TicketAssignment[], onChange = vi.fn()) => {
    const { AssignmentEditor } = await import('@/components/molecules/AssignmentEditor');
    render(<AssignmentEditor roles={roles} value={value} onChange={onChange} />);
    return onChange;
  };

  it('starring a supporter makes it the only lead', async () => {
    const onChange = await renderEditor(twoAssigned);
    fireEvent.click(screen.getByRole('button', { name: 'Make security lead' }));

    expect(onChange).toHaveBeenCalledWith([
      { role: 'fe-engineer', model: null, is_lead: 0 },
      { role: 'security', model: null, is_lead: 1 },
    ]);
    const next = onChange.mock.calls[0][0] as TicketAssignment[];
    expect(next.filter((a) => a.is_lead === 1)).toHaveLength(1);
  });

  it('assigning the first agent marks it as lead', async () => {
    const onChange = await renderEditor([]);
    fireEvent.click(screen.getByRole('button', { name: 'Assign qa' }));
    expect(onChange).toHaveBeenCalledWith([{ role: 'qa', model: null, is_lead: 1 }]);
  });

  it('removing the lead promotes the remaining assignment', async () => {
    const onChange = await renderEditor(twoAssigned);
    fireEvent.click(screen.getByRole('button', { name: 'Unassign fe-engineer' }));
    expect(onChange).toHaveBeenCalledWith([{ role: 'security', model: null, is_lead: 1 }]);
  });

  it('model dropdown sets a per-assignment override', async () => {
    const onChange = await renderEditor(twoAssigned);
    fireEvent.change(screen.getByLabelText('Model for security'), {
      target: { value: 'claude-haiku-4-5' },
    });
    expect(onChange).toHaveBeenCalledWith([
      { role: 'fe-engineer', model: null, is_lead: 1 },
      { role: 'security', model: 'claude-haiku-4-5', is_lead: 0 },
    ]);
  });

  it('selecting "Agent default" clears the override to null', async () => {
    const onChange = await renderEditor([
      { role: 'fe-engineer', model: 'claude-opus-4-8', is_lead: 1 },
    ]);
    fireEvent.change(screen.getByLabelText('Model for fe-engineer'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith([{ role: 'fe-engineer', model: null, is_lead: 1 }]);
  });
});

// ─── AssignmentChips ───────────────────────────────────────────────────

describe('AssignmentChips', () => {
  it('renders the lead first, then supporters', async () => {
    const { AssignmentChips } = await import('@/components/molecules/AssignmentChips');
    const { container } = render(
      <AssignmentChips
        assignments={[
          { role: 'security', model: null, is_lead: 0 },
          { role: 'fe-engineer', model: null, is_lead: 1 },
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('fe-engineer')).toBeLessThan(text.indexOf('security'));
    expect(screen.getByLabelText('lead')).toBeDefined();
    expect(screen.getByTitle('fe-engineer (lead)')).toBeDefined();
  });

  it('shows the model override only when set', async () => {
    const { AssignmentChips } = await import('@/components/molecules/AssignmentChips');
    const { container } = render(
      <AssignmentChips
        assignments={[
          { role: 'fe-engineer', model: null, is_lead: 1 },
          { role: 'security', model: 'claude-haiku-4-5', is_lead: 0 },
        ]}
      />,
    );
    expect(container.textContent).toContain('haiku-4-5');
    expect(container.textContent).not.toContain('claude-haiku-4-5');
    // Only one chip carries a model suffix
    expect(container.textContent?.match(/·/g) ?? []).toHaveLength(1);
  });
});

// ─── TicketCard quick-edit ─────────────────────────────────────────────

vi.mock('@/stores/bridgeStore', () => ({
  useBridgeStore: (sel: any) => sel({ queueAction: vi.fn() }),
}));

describe('TicketCard', () => {
  it('renders a quick-edit affordance that opens the editor without triggering card click', async () => {
    const { TicketCard } = await import('@/components/molecules/TicketCard');
    const onEdit = vi.fn();
    const onClick = vi.fn();
    render(<TicketCard ticket={{ ...baseTicket }} onClick={onClick} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit ticket' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders assignment chips on the card (lead first, model override shown)', async () => {
    const { TicketCard } = await import('@/components/molecules/TicketCard');
    const { container } = render(
      <TicketCard
        ticket={{
          ...baseTicket,
          assignments: [
            { role: 'security', model: 'claude-haiku-4-5', is_lead: 0 },
            { role: 'fe-engineer', model: null, is_lead: 1 },
          ],
        }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('fe-engineer')).toBeLessThan(text.indexOf('security'));
    expect(text).toContain('haiku-4-5');
  });
});
