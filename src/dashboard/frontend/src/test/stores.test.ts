import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── uiStore ───────────────────────────────────────────────────────────

describe('uiStore', () => {
  let useUIStore: typeof import('@/stores/uiStore').useUIStore;

  beforeEach(async () => {
    const mod = await import('@/stores/uiStore');
    useUIStore = mod.useUIStore;
    useUIStore.setState({
      activePage: 'dashboard',
      activeTab: 'board',
      activeSubTab: null,
      sidebarCollapsed: false,
      searchQuery: '',
      quickFilter: 'all',
      userRole: 'developer',
    });
  });

  it('setPage updates page and default tab', () => {
    useUIStore.getState().setPage('code');
    expect(useUIStore.getState().activePage).toBe('code');
    expect(useUIStore.getState().activeTab).toBe('files');
  });

  it('setPage resets sub-tab', () => {
    useUIStore.setState({ activeSubTab: 'something' });
    useUIStore.getState().setPage('team');
    expect(useUIStore.getState().activeSubTab).toBeNull();
  });

  it('setTab updates tab and breadcrumb', () => {
    useUIStore.getState().setTab('overview');
    expect(useUIStore.getState().activeTab).toBe('overview');
    const trail = useUIStore.getState().breadcrumbTrail;
    expect(trail.length).toBeGreaterThanOrEqual(2);
    expect(trail[1].label).toBe('Overview');
  });

  it('toggleSidebar flips state', () => {
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleFolder adds and removes paths', () => {
    useUIStore.getState().toggleFolder('src/lib');
    expect(useUIStore.getState().expandedFolders.has('src/lib')).toBe(true);
    useUIStore.getState().toggleFolder('src/lib');
    expect(useUIStore.getState().expandedFolders.has('src/lib')).toBe(false);
  });

  it('expandFolderPath expands all ancestors', () => {
    useUIStore.getState().expandFolderPath('src/lib/utils.ts');
    const folders = useUIStore.getState().expandedFolders;
    expect(folders.has('src')).toBe(true);
    expect(folders.has('src/lib')).toBe(true);
  });

  it('getDefaultPageForRole returns correct defaults', () => {
    expect(useUIStore.getState().getDefaultPageForRole('developer')).toBe('dashboard');
    expect(useUIStore.getState().getDefaultPageForRole('tech-lead')).toBe('planning');
    expect(useUIStore.getState().getDefaultPageForRole('designer')).toBe('team');
  });

  it('setQuickFilter updates filter', () => {
    useUIStore.getState().setQuickFilter('blocked');
    expect(useUIStore.getState().quickFilter).toBe('blocked');
  });
});

// ─── sprintStore selectors ─────────────────────────────────────────────

describe('sprintStore', () => {
  let useSprintStore: typeof import('@/stores/sprintStore').useSprintStore;
  let useToastStore: typeof import('@/stores/toastStore').useToastStore;

  beforeEach(async () => {
    const mod = await import('@/stores/sprintStore');
    useSprintStore = mod.useSprintStore;
    const toastMod = await import('@/stores/toastStore');
    useToastStore = toastMod.useToastStore;
    useToastStore.setState({ toasts: [] });
    useSprintStore.setState({ selectedSprintId: null, sprintDetail: null });
    mockFetch.mockReset();
  });

  // Route mocked fetch responses by "METHOD path". Falls back to {} for any
  // refetch URL (grouped/sprints/detail/tickets/retro) we don't care to assert.
  const routeFetch = (routes: Record<string, unknown>) => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = routes[`${method} ${path}`] ?? routes[path] ?? {};
      return Promise.resolve({ ok: true, json: async () => body });
    });
  };

  it('initial state has empty arrays', () => {
    expect(useSprintStore.getState().sprints).toEqual([]);
    expect(useSprintStore.getState().tickets).toEqual([]);
  });

  it('setTicketFilter updates filter', () => {
    useSprintStore.getState().setTicketFilter('blocked');
    expect(useSprintStore.getState().ticketFilter).toBe('blocked');
  });

  it('getFilteredTickets returns all when filter is all', () => {
    useSprintStore.setState({
      tickets: [
        {
          id: 1,
          ticket_ref: 'T-1',
          title: 'A',
          description: null,
          priority: 'P1',
          status: 'TODO',
          assigned_to: null,
          story_points: 3,
          milestone: null,
          qa_verified: 0,
          verified_by: null,
          acceptance_criteria: null,
          notes: null,
        },
      ] as any[],
      ticketFilter: 'all',
    });
    expect(useSprintStore.getState().getFilteredTickets()).toHaveLength(1);
  });

  it('getFilteredTickets filters blocked tickets', () => {
    useSprintStore.setState({
      tickets: [
        { id: 1, status: 'BLOCKED', assigned_to: 'dev' },
        { id: 2, status: 'TODO', assigned_to: 'dev' },
      ] as any[],
      ticketFilter: 'blocked',
    });
    const filtered = useSprintStore.getState().getFilteredTickets();
    expect(filtered.every((t) => t.status === 'BLOCKED')).toBe(true);
  });

  // ─── archive actions (T-220) ─────────────────────────────────────────

  it('archiveSprint posts to the archive endpoint and refetches grouped + sprints', async () => {
    routeFetch({ 'POST /api/sprint/7/archive': { ok: true, archived_at: '2026-06-10 09:24:24' } });
    await useSprintStore.getState().archiveSprint(7);

    const calls = mockFetch.mock.calls;
    expect(calls.some(([p, i]) => p === '/api/sprint/7/archive' && i?.method === 'POST')).toBe(
      true,
    );
    expect(calls.some(([p]) => p === '/api/sprints/grouped')).toBe(true);
    expect(calls.some(([p]) => p === '/api/sprints')).toBe(true);
  });

  it('archiveSprint shows a success toast', async () => {
    routeFetch({ 'POST /api/sprint/7/archive': { ok: true, archived_at: '2026-06-10 09:24:24' } });
    await useSprintStore.getState().archiveSprint(7);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].message).toBe('Sprint archived');
  });

  it('archiveSprint shows an error toast when the post fails', async () => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/sprint/7/archive' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    await useSprintStore.getState().archiveSprint(7);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
  });

  it('unarchiveSprint posts to the unarchive endpoint and toasts on success', async () => {
    routeFetch({ 'POST /api/sprint/7/unarchive': { ok: true, archived_at: null } });
    await useSprintStore.getState().unarchiveSprint(7);

    const calls = mockFetch.mock.calls;
    expect(calls.some(([p, i]) => p === '/api/sprint/7/unarchive' && i?.method === 'POST')).toBe(
      true,
    );
    expect(calls.some(([p]) => p === '/api/sprints/grouped')).toBe(true);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].message).toBe('Sprint restored');
  });

  it('unarchiveSprint shows an error toast when the post fails', async () => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/sprint/7/unarchive' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    await useSprintStore.getState().unarchiveSprint(7);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
  });

  it('archiveAllCompleted posts to the bulk endpoint and toasts with the returned count', async () => {
    routeFetch({ 'POST /api/sprints/archive-completed': { archived: 3 } });
    await useSprintStore.getState().archiveAllCompleted();

    const calls = mockFetch.mock.calls;
    expect(
      calls.some(([p, i]) => p === '/api/sprints/archive-completed' && i?.method === 'POST'),
    ).toBe(true);
    expect(calls.some(([p]) => p === '/api/sprints/grouped')).toBe(true);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].message).toBe('Archived 3 sprints');
  });

  it('archiveAllCompleted shows an error toast when the post fails', async () => {
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/sprints/archive-completed' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Server Error',
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    await useSprintStore.getState().archiveAllCompleted();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
  });

  it('archiveSprint refreshes detail when the archived sprint is selected', async () => {
    useSprintStore.setState({ selectedSprintId: 7 });
    routeFetch({
      'POST /api/sprint/7/archive': { ok: true, archived_at: '2026-06-10 09:24:24' },
      '/api/sprint/7': { id: 7, name: 'S7', status: 'closed', archived_at: '2026-06-10 09:24:24' },
    });
    await useSprintStore.getState().archiveSprint(7);
    // selectSprint re-fetches detail for the selected id
    expect(mockFetch.mock.calls.some(([p]) => p === '/api/sprint/7')).toBe(true);
    expect(useSprintStore.getState().sprintDetail?.archived_at).toBe('2026-06-10 09:24:24');
  });
});

// ─── agentStore ────────────────────────────────────────────────────────

describe('agentStore', () => {
  let useAgentStore: typeof import('@/stores/agentStore').useAgentStore;

  beforeEach(async () => {
    const mod = await import('@/stores/agentStore');
    useAgentStore = mod.useAgentStore;
    useAgentStore.setState({ agents: [], loading: false });
    mockFetch.mockReset();
  });

  it('initial state is empty', () => {
    expect(useAgentStore.getState().agents).toEqual([]);
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it('fetchAgents sets loading and populates agents', async () => {
    const agents = [{ role: 'dev', name: 'Dev', description: 'Backend', model: 'claude' }];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => agents });

    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().agents).toEqual(agents);
    expect(useAgentStore.getState().loading).toBe(false);
  });
});

// ─── planningStore ─────────────────────────────────────────────────────

describe('planningStore', () => {
  let usePlanningStore: typeof import('@/stores/planningStore').usePlanningStore;

  beforeEach(async () => {
    const mod = await import('@/stores/planningStore');
    usePlanningStore = mod.usePlanningStore;
    usePlanningStore.setState({
      milestones: [],
      vision: null,
      ganttData: [],
      backlog: [],
      loading: { milestones: false, vision: false, gantt: false, backlog: false },
    });
    mockFetch.mockReset();
  });

  it('initial state has empty arrays', () => {
    expect(usePlanningStore.getState().milestones).toEqual([]);
    expect(usePlanningStore.getState().vision).toBeNull();
  });

  it('fetchMilestones populates milestones', async () => {
    const milestones = [
      {
        id: 1,
        name: 'M1',
        description: 'Milestone 1',
        status: 'active',
        target_date: null,
        progress: 50,
        ticket_count: 10,
        done_count: 5,
      },
    ];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => milestones });

    await usePlanningStore.getState().fetchMilestones();
    expect(usePlanningStore.getState().milestones).toEqual(milestones);
    expect(usePlanningStore.getState().loading.milestones).toBe(false);
  });

  it('fetchVision sets vision string', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: '# Vision\nBe great.' }),
    });

    await usePlanningStore.getState().fetchVision();
    expect(usePlanningStore.getState().vision).toBe('# Vision\nBe great.');
  });

  // ─── milestone archive actions (v2.6.0) ──────────────────────────────

  it('archiveMilestone posts to the archive endpoint, refetches milestones and toasts', async () => {
    const { useToastStore } = await import('@/stores/toastStore');
    useToastStore.setState({ toasts: [] });
    const archived = [
      {
        id: 4,
        name: 'M4',
        description: null,
        status: 'completed',
        target_date: null,
        progress: 100,
        ticket_count: 0,
        done_count: 0,
        archived_at: '2026-10-09 10:00:00',
      },
    ];
    mockFetch.mockImplementation((path: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          path === '/api/milestones' ? archived : init?.method === 'POST' ? { ok: true } : {},
      }),
    );
    await usePlanningStore.getState().archiveMilestone(4);
    expect(
      mockFetch.mock.calls.some(
        ([p, i]) => p === '/api/milestone/4/archive' && i?.method === 'POST',
      ),
    ).toBe(true);
    expect(usePlanningStore.getState().milestones).toEqual(archived);
    expect(useToastStore.getState().toasts.map((t) => [t.type, t.message])).toEqual([
      ['success', 'Milestone archived'],
    ]);
  });

  it('unarchiveMilestone posts to the unarchive endpoint', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [] }));
    await usePlanningStore.getState().unarchiveMilestone(4);
    expect(
      mockFetch.mock.calls.some(
        ([p, i]) => p === '/api/milestone/4/unarchive' && i?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('archiveMilestone surfaces the server error (e.g. not completed) as an error toast', async () => {
    const { useToastStore } = await import('@/stores/toastStore');
    useToastStore.setState({ toasts: [] });
    mockFetch.mockImplementation((path: string, init?: RequestInit) =>
      path === '/api/milestone/4/archive' && init?.method === 'POST'
        ? Promise.resolve({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ ok: false, error: 'only completed milestones can be archived' }),
          })
        : Promise.resolve({ ok: true, json: async () => [] }),
    );
    await usePlanningStore.getState().archiveMilestone(4);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toMatch(/only completed milestones/);
  });
});

// ─── benchmarkStore (real bench runs) ─────────────────────────────────

describe('benchmarkStore bench runs', () => {
  let useBenchmarkStore: typeof import('@/stores/benchmarkStore').useBenchmarkStore;
  let latestPerKind: typeof import('@/stores/benchmarkStore').latestPerKind;

  const entry = (run_id: string, kind: string, date: string) => ({
    run_id,
    kind,
    date,
    ts: `${date}T00:00:00Z`,
    model: null,
    trigger: 'manual',
    headline: null,
  });
  const runs = [
    entry('glm-2', 'agent-glm', '2026-10-11'),
    entry('opus-1', 'agent-opus', '2026-10-10'),
    entry('glm-1', 'agent-glm', '2026-10-09'),
  ];

  beforeEach(async () => {
    const mod = await import('@/stores/benchmarkStore');
    useBenchmarkStore = mod.useBenchmarkStore;
    latestPerKind = mod.latestPerKind;
    useBenchmarkStore.setState({
      benchRuns: [],
      runDetails: {},
      runErrors: {},
      selectedRunId: null,
      benchMessage: null,
    });
    mockFetch.mockReset();
  });

  it('latestPerKind keeps the newest run of each kind', () => {
    expect(latestPerKind(runs as never).map((r) => r.run_id)).toEqual(['glm-2', 'opus-1']);
  });

  it('fetchBenchIndex selects the newest run and loads the latest run file per kind', async () => {
    mockFetch.mockImplementation((path: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          path === '/api/bench/index'
            ? {
                source: { type: 'dir', label: 'env' },
                index: { schema: 'ccc-bench-index/1', runs },
              }
            : { run: { run_id: path.split('/').pop(), notes: ['n'] } },
      }),
    );
    await useBenchmarkStore.getState().fetchBenchIndex();
    const s = useBenchmarkStore.getState();
    expect(s.selectedRunId).toBe('glm-2');
    expect(Object.keys(s.runDetails).sort()).toEqual(['glm-2', 'opus-1']);
  });

  it('keeps an explicit empty state with the server message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        source: { type: 'none', label: 'none' },
        index: null,
        message: 'No benchmark runs found.',
      }),
    });
    await useBenchmarkStore.getState().fetchBenchIndex();
    const s = useBenchmarkStore.getState();
    expect(s.benchRuns).toEqual([]);
    expect(s.selectedRunId).toBeNull();
    expect(s.benchMessage).toBe('No benchmark runs found.');
  });
});
