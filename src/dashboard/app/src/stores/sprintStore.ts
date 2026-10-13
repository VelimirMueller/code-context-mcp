import { create } from 'zustand';
import { get, post, patch } from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import type {
  Sprint,
  Ticket,
  TicketAssignment,
  RetroFinding,
  MilestoneSprintGroup,
  BurndownData,
  Blocker,
  Bug,
} from '@/types';

export type TicketFilter = 'all' | 'mine' | 'blocked' | 'qaPending' | 'unassigned';

// Request shape of PATCH /api/ticket/:id (all fields optional).
export interface AssignmentInput {
  role: string;
  model?: string | null;
  lead?: boolean;
}

export interface TicketUpdatePayload {
  title?: string;
  description?: string | null;
  story_points?: number | null;
  priority?: string;
  status?: string;
  assignments?: AssignmentInput[];
}

export interface SprintDetail extends Sprint {
  goal: string | null;
}

export interface ActivityEvent {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  actor: string | null;
  created_at: string;
}

export interface SprintStore {
  sprints: Sprint[];
  milestoneGroups: MilestoneSprintGroup[];
  selectedSprintId: number | null;
  sprintDetail: SprintDetail | null;
  tickets: Ticket[];
  retroFindings: RetroFinding[];
  allRetroFindings: (RetroFinding & { sprint_name?: string })[];
  selectedRetroFindings: RetroFinding[];
  burndown: BurndownData | null;
  blockers: Blocker[];
  bugs: Bug[];
  activities: ActivityEvent[];
  loading: { sprints: boolean; detail: boolean; grouped: boolean };
  error: { sprints: string | null; detail: string | null };
  ticketFilter: TicketFilter;
  currentUserName: string;

  fetchSprints: () => Promise<void>;
  fetchGroupedSprints: () => Promise<void>;
  archiveSprint: (id: number) => Promise<void>;
  unarchiveSprint: (id: number) => Promise<void>;
  archiveAllCompleted: () => Promise<void>;
  selectSprint: (id: number) => Promise<void>;
  fetchTickets: (sprintId: number) => Promise<void>;
  updateTicket: (ticketId: number, payload: TicketUpdatePayload) => Promise<Ticket | null>;
  fetchRetro: (sprintId: number) => Promise<void>;
  fetchAllRetro: () => Promise<void>;
  fetchBurndown: (sprintId: number) => Promise<void>;
  fetchBlockers: (sprintId: number) => Promise<void>;
  fetchBugs: (sprintId: number) => Promise<void>;
  fetchActivities: () => Promise<void>;
  clearError: () => void;
  setTicketFilter: (filter: TicketFilter) => void;
  setCurrentUserName: (name: string) => void;
  getFilteredTickets: () => Ticket[];
  getFilterCounts: () => {
    all: number;
    mine: number;
    blocked: number;
    qaPending: number;
  };
}

export const useSprintStore = create<SprintStore>((set, getState) => ({
  sprints: [],
  milestoneGroups: [],
  selectedSprintId: null,
  sprintDetail: null,
  tickets: [],
  retroFindings: [],
  allRetroFindings: [],
  selectedRetroFindings: [],
  burndown: null,
  blockers: [],
  bugs: [],
  activities: [],
  loading: { sprints: false, detail: false, grouped: false },
  error: { sprints: null, detail: null },
  ticketFilter: 'all',
  currentUserName: 'Me',

  fetchGroupedSprints: async () => {
    set((s) => ({ loading: { ...s.loading, grouped: true } }));
    try {
      const groups = await get<MilestoneSprintGroup[]>('/api/sprints/grouped');
      set({ milestoneGroups: groups ?? [] });
    } catch (e) {
      console.warn('[sprintStore] fetchGroupedSprints failed:', e);
      set({ milestoneGroups: [] });
    } finally {
      set((s) => ({ loading: { ...s.loading, grouped: false } }));
    }
  },

  fetchSprints: async () => {
    set((s) => ({
      loading: { ...s.loading, sprints: true },
      error: { ...s.error, sprints: null },
    }));
    try {
      const sprints = await get<Sprint[]>('/api/sprints');
      set({ sprints: sprints ?? [] });
      // Auto-select active sprint if none selected
      const { selectedSprintId } = getState();
      if (selectedSprintId === null) {
        const active = (sprints ?? []).find((s) => s.status === 'active');
        if (active) getState().selectSprint(active.id);
      }
    } catch (e) {
      set((s) => ({ error: { ...s.error, sprints: (e as Error).message } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, sprints: false } }));
    }
  },

  archiveSprint: async (id: number) => {
    try {
      await post(`/api/sprint/${id}/archive`, {});
      await Promise.all([getState().fetchGroupedSprints(), getState().fetchSprints()]);
      if (getState().selectedSprintId === id) await getState().selectSprint(id);
      useToastStore.getState().addToast('Sprint archived', 'success');
    } catch (e) {
      useToastStore.getState().addToast((e as Error).message, 'error');
    }
  },

  unarchiveSprint: async (id: number) => {
    try {
      await post(`/api/sprint/${id}/unarchive`, {});
      await Promise.all([getState().fetchGroupedSprints(), getState().fetchSprints()]);
      if (getState().selectedSprintId === id) await getState().selectSprint(id);
      useToastStore.getState().addToast('Sprint restored', 'success');
    } catch (e) {
      useToastStore.getState().addToast((e as Error).message, 'error');
    }
  },

  archiveAllCompleted: async () => {
    try {
      const res = await post<{ archived: number }>('/api/sprints/archive-completed', {});
      await Promise.all([getState().fetchGroupedSprints(), getState().fetchSprints()]);
      const { selectedSprintId } = getState();
      if (selectedSprintId !== null) await getState().selectSprint(selectedSprintId);
      useToastStore.getState().addToast(`Archived ${res?.archived ?? 0} sprints`, 'success');
    } catch (e) {
      useToastStore.getState().addToast((e as Error).message, 'error');
    }
  },

  selectSprint: async (id: number) => {
    set((s) => ({
      selectedSprintId: id,
      loading: { ...s.loading, detail: true },
      error: { ...s.error, detail: null },
    }));
    try {
      // Fetch sprint detail, tickets, and retro in parallel
      const [detail, tickets, retro] = await Promise.all([
        get<SprintDetail>(`/api/sprint/${id}`),
        get<Ticket[]>(`/api/sprint/${id}/tickets`),
        get<RetroFinding[]>(`/api/sprint/${id}/retro`).catch(() => [] as RetroFinding[]),
      ]);
      set({
        sprintDetail: detail ?? null,
        tickets: Array.isArray(tickets) ? tickets : [],
        selectedRetroFindings: Array.isArray(retro) ? retro : [],
      });
    } catch (e) {
      set((s) => ({ error: { ...s.error, detail: (e as Error).message } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, detail: false } }));
    }
  },

  fetchTickets: async (sprintId: number) => {
    try {
      const tickets = await get<Ticket[]>(`/api/sprint/${sprintId}/tickets`);
      set({ tickets: Array.isArray(tickets) ? tickets : [] });
    } catch (e) {
      console.warn('[sprintStore] fetchTickets failed:', e);
    }
  },

  // PATCH /api/ticket/:id — optimistic update, reconciled from the response
  // ticket (which carries the new change_seq/pending_change/assignments, so no
  // follow-up fetch is needed). On failure the optimistic state is reverted
  // and the server's error message is surfaced as a toast.
  updateTicket: async (ticketId: number, payload: TicketUpdatePayload) => {
    const prevTickets = getState().tickets;
    const toAssignment = (a: AssignmentInput): TicketAssignment => ({
      role: a.role,
      model: a.model ?? null,
      is_lead: a.lead ? 1 : 0,
    });
    set({
      tickets: prevTickets.map((t) => {
        if (t.id !== ticketId) return t;
        const next: Ticket = { ...t };
        if (payload.title !== undefined) next.title = payload.title;
        if (payload.description !== undefined) next.description = payload.description;
        if (payload.story_points !== undefined) next.story_points = payload.story_points;
        if (payload.priority !== undefined) next.priority = payload.priority;
        if (payload.status !== undefined) next.status = payload.status;
        if (payload.assignments !== undefined) {
          next.assignments = payload.assignments.map(toAssignment);
          next.assigned_to = payload.assignments.find((a) => a.lead)?.role ?? null;
        }
        return next;
      }),
    });
    try {
      const res = await patch<{ ok: boolean; ticket: Ticket }>(`/api/ticket/${ticketId}`, payload);
      if (res?.ticket) {
        // Merge so list-only computed fields (epic_name, milestone_name, …)
        // survive if the response row omits them.
        set((s) => ({
          tickets: s.tickets.map((t) => (t.id === ticketId ? { ...t, ...res.ticket } : t)),
        }));
      }
      return getState().tickets.find((t) => t.id === ticketId) ?? null;
    } catch (e) {
      set({ tickets: prevTickets });
      useToastStore.getState().addToast((e as Error).message, 'error');
      return null;
    }
  },

  fetchRetro: async (sprintId: number) => {
    try {
      const retroFindings = await get<RetroFinding[]>(`/api/sprint/${sprintId}/retro`);
      set({ retroFindings: Array.isArray(retroFindings) ? retroFindings : [] });
    } catch {
      // Silently fail
    }
  },

  fetchAllRetro: async () => {
    try {
      const findings = await get<(RetroFinding & { sprint_name?: string })[]>('/api/retro/all');
      set({ allRetroFindings: Array.isArray(findings) ? findings : [] });
    } catch {
      set({ allRetroFindings: [] });
    }
  },

  fetchBurndown: async (sprintId: number) => {
    try {
      const burndown = await get<BurndownData>(`/api/sprint/${sprintId}/burndown`);
      set({ burndown: burndown ?? null });
    } catch {
      set({ burndown: null });
    }
  },

  fetchBlockers: async (sprintId: number) => {
    try {
      const blockers = await get<Blocker[]>(`/api/sprint/${sprintId}/blockers`);
      set({ blockers: Array.isArray(blockers) ? blockers : [] });
    } catch {
      set({ blockers: [] });
    }
  },

  fetchBugs: async (sprintId: number) => {
    try {
      const bugs = await get<Bug[]>(`/api/sprint/${sprintId}/bugs`);
      set({ bugs: Array.isArray(bugs) ? bugs : [] });
    } catch {
      set({ bugs: [] });
    }
  },

  fetchActivities: async () => {
    try {
      const activities = await get<ActivityEvent[]>('/api/activity');
      set({ activities: Array.isArray(activities) ? activities : [] });
    } catch {
      set({ activities: [] });
    }
  },

  clearError: () => set({ error: { sprints: null, detail: null } }),

  setTicketFilter: (filter: TicketFilter) => {
    set({ ticketFilter: filter });
  },

  setCurrentUserName: (name: string) => {
    set({ currentUserName: name });
  },

  getFilteredTickets: () => {
    const { tickets, ticketFilter, currentUserName } = getState();

    switch (ticketFilter) {
      case 'mine':
        return tickets.filter((t) => t.assigned_to === currentUserName);
      case 'blocked':
        return tickets.filter((t) => t.status === 'BLOCKED');
      case 'qaPending':
        return tickets.filter((t) => t.qa_verified === 0 && t.status !== 'TODO');
      case 'unassigned':
        return tickets.filter((t) => !t.assigned_to);
      default:
        return tickets;
    }
  },

  getFilterCounts: () => {
    const { tickets, currentUserName } = getState();

    return {
      all: tickets.length,
      mine: tickets.filter((t) => t.assigned_to === currentUserName).length,
      blocked: tickets.filter((t) => t.status === 'BLOCKED').length,
      qaPending: tickets.filter((t) => t.qa_verified === 0 && t.status !== 'TODO').length,
    };
  },
}));
