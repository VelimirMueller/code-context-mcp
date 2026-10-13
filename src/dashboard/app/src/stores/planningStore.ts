import { create } from 'zustand';
import { get, post, put } from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { parseMilestoneMarkdown } from '@/lib/utils';
import type {
  Sprint,
  Ticket,
  Milestone,
  Discovery,
  DiscoveryCoverage,
  DiscoverySprint,
} from '@/types';

/** Body of POST /api/milestones: the field names the route parses (#199). */
export interface CreateMilestoneInput {
  name: string;
  description?: string;
  target_date?: string;
}

export interface UpdateMilestoneInput {
  title?: string;
  description?: string;
  targetDate?: string;
  status?: 'planned' | 'in_progress' | 'completed';
}

export interface PlanSprintInput {
  name: string;
  startDate: string;
  endDate: string;
  targetVelocity: number;
  ticketIds: number[];
  goal?: string;
}

export interface PlanningStore {
  milestones: Milestone[];
  vision: string | null;
  visionUpdatedAt: string | null;
  ganttData: Sprint[];
  backlog: Ticket[];
  loading: { milestones: boolean; vision: boolean; gantt: boolean; backlog: boolean };
  error: string | null;

  fetchMilestones: () => Promise<void>;
  createMilestone: (data: CreateMilestoneInput) => Promise<{ id: number; name: string }>;
  updateMilestone: (id: number, data: UpdateMilestoneInput) => Promise<void>;
  archiveMilestone: (id: number) => Promise<void>;
  unarchiveMilestone: (id: number) => Promise<void>;
  fetchVision: () => Promise<void>;
  updateVision: (content: string) => Promise<void>;
  fetchGantt: () => Promise<void>;
  fetchBacklog: () => Promise<void>;
  planSprint: (data: PlanSprintInput) => Promise<{ id: number }>;

  discoveries: Discovery[];
  discoveryCoverage: DiscoveryCoverage | null;
  discoverySprints: DiscoverySprint[];
  discoveryFilters: { sprintId?: number; status?: string; category?: string };
  fetchDiscoveries: () => Promise<void>;
  fetchDiscoveryCoverage: (sprintId?: number) => Promise<void>;
  fetchDiscoverySprints: () => Promise<void>;
  setDiscoveryFilter: (filters: Partial<PlanningStore['discoveryFilters']>) => void;
  linkDiscoveryToTicket: (discoveryId: number, ticketId: number) => Promise<void>;
  clearError: () => void;
}

export const usePlanningStore = create<PlanningStore>((set, getState) => ({
  milestones: [],
  vision: null,
  visionUpdatedAt: null,
  ganttData: [],
  backlog: [],
  loading: { milestones: false, vision: false, gantt: false, backlog: false },
  error: null,

  clearError: () => set({ error: null }),

  fetchMilestones: async () => {
    set((s) => ({ loading: { ...s.loading, milestones: true } }));
    try {
      // Try DB milestones first
      let milestones = await get<Milestone[]>('/api/milestones');

      // If empty, fall back to skill content and parse
      if (!milestones || !Array.isArray(milestones) || milestones.length === 0) {
        try {
          const skill = await get<{ content: string }>('/api/skill/MILESTONES');
          if (skill?.content) {
            milestones = parseMilestoneMarkdown(skill.content);
          }
        } catch {
          // Skill endpoint also failed — keep empty
        }
      }

      set({ milestones: Array.isArray(milestones) ? milestones : [] });
    } catch (e) {
      console.warn('[planningStore] fetchMilestones failed:', e);
      set({ milestones: [], error: (e as Error).message });
    } finally {
      set((s) => ({ loading: { ...s.loading, milestones: false } }));
    }
  },

  createMilestone: async (data: CreateMilestoneInput) => {
    const created = await post<{ id: number; name: string }>('/api/milestones', data);
    // Refetch: the list rows carry computed fields (ticket_count, sprints).
    await getState().fetchMilestones();
    return created;
  },

  updateMilestone: async (id: number, data: UpdateMilestoneInput) => {
    // Optimistic update
    set((s) => ({
      milestones: s.milestones.map((m) => (m.id === id ? { ...m, ...data } : m)),
    }));
    try {
      // Server uses PUT on /api/milestone/{id} (singular)
      const updated = await put<Milestone>(`/api/milestone/${id}`, data);
      if (updated) {
        set((s) => ({ milestones: s.milestones.map((m) => (m.id === id ? updated : m)) }));
      }
    } catch (e) {
      // Rollback on error -- re-fetch authoritative state
      getState().fetchMilestones();
      throw e;
    }
  },

  archiveMilestone: async (id: number) => {
    try {
      await post(`/api/milestone/${id}/archive`, {});
      await getState().fetchMilestones();
      useToastStore.getState().addToast('Milestone archived', 'success');
    } catch (e) {
      useToastStore.getState().addToast((e as Error).message, 'error');
    }
  },

  unarchiveMilestone: async (id: number) => {
    try {
      await post(`/api/milestone/${id}/unarchive`, {});
      await getState().fetchMilestones();
      useToastStore.getState().addToast('Milestone restored', 'success');
    } catch (e) {
      useToastStore.getState().addToast((e as Error).message, 'error');
    }
  },

  fetchVision: async () => {
    set((s) => ({ loading: { ...s.loading, vision: true } }));
    try {
      const skill = await get<{ content: string; updated_at: string }>('/api/skill/PRODUCT_VISION');
      set({ vision: skill?.content ?? null, visionUpdatedAt: skill?.updated_at ?? null });
    } catch {
      set({ vision: null, visionUpdatedAt: null });
    } finally {
      set((s) => ({ loading: { ...s.loading, vision: false } }));
    }
  },

  updateVision: async (content: string) => {
    // Optimistic
    const now = new Date().toISOString();
    set({ vision: content, visionUpdatedAt: now });
    await put('/api/vision', { content });
  },

  fetchGantt: async () => {
    // Gantt data reuses sprint list — /api/gantt does not exist
    set((s) => ({ loading: { ...s.loading, gantt: true } }));
    try {
      const ganttData = await get<Sprint[]>('/api/sprints');
      set({ ganttData: Array.isArray(ganttData) ? ganttData : [] });
    } catch {
      // Silently fail
    } finally {
      set((s) => ({ loading: { ...s.loading, gantt: false } }));
    }
  },

  fetchBacklog: async () => {
    set((s) => ({ loading: { ...s.loading, backlog: true } }));
    try {
      const backlog = await get<Ticket[]>('/api/backlog');
      set({ backlog: Array.isArray(backlog) ? backlog : [] });
    } catch {
      // Silently fail
    } finally {
      set((s) => ({ loading: { ...s.loading, backlog: false } }));
    }
  },

  planSprint: async (data: PlanSprintInput) => {
    const result = await post<{ id: number }>('/api/sprints/plan', data);
    // Refresh gantt and backlog after planning
    await Promise.all([getState().fetchGantt(), getState().fetchBacklog()]);
    return result;
  },

  discoveries: [],
  discoveryCoverage: null,
  discoverySprints: [],
  discoveryFilters: { status: 'active' },

  fetchDiscoveries: async () => {
    const filters = getState().discoveryFilters;
    const params = new URLSearchParams();
    if (filters.sprintId) params.set('sprint_id', String(filters.sprintId));
    if (filters.status && filters.status !== 'active') params.set('status', filters.status);
    if (filters.status === 'active') params.set('exclude_status', 'dropped,implemented');
    if (filters.category) params.set('category', filters.category);
    const qs = params.toString();
    const discoveries = await get<Discovery[]>(`/api/discoveries${qs ? `?${qs}` : ''}`);
    set({ discoveries: discoveries || [] });
  },

  fetchDiscoveryCoverage: async (sprintId?: number) => {
    const qs = sprintId ? `?sprint_id=${sprintId}` : '';
    const coverage = await get<DiscoveryCoverage>(`/api/discoveries/coverage${qs}`);
    set({ discoveryCoverage: coverage });
  },

  fetchDiscoverySprints: async () => {
    const sprints = await get<DiscoverySprint[]>('/api/discoveries/sprints');
    set({ discoverySprints: sprints || [] });
  },

  setDiscoveryFilter: (filters) => {
    set((s) => ({ discoveryFilters: { ...s.discoveryFilters, ...filters } }));
    getState().fetchDiscoveries();
    const sprintId = filters.sprintId ?? getState().discoveryFilters.sprintId;
    getState().fetchDiscoveryCoverage(sprintId);
  },

  linkDiscoveryToTicket: async (discoveryId, ticketId) => {
    await post(`/api/discovery/${discoveryId}/link`, { ticket_id: ticketId });
    getState().fetchDiscoveries();
    getState().fetchDiscoveryCoverage(getState().discoveryFilters.sprintId);
  },
}));
