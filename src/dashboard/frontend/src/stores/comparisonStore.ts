import { create } from 'zustand';
import { get } from '@/lib/api';

export interface TaskMetrics {
  status: string;
  ticket_id: number;
  duration_min: number | null;
  tokens_used: number | null;
  tool_calls: number | null;
  files_modified: number | null;
  lines_changed: number | null;
  tests_added: number | null;
  context_lookups: number | null;
}

export interface ComparisonTask {
  id: string;
  label: string;
  description: string;
  points: number;
  reasoning: string | null;
  mcp: TaskMetrics;
  vanilla: TaskMetrics;
}

export interface ComparisonData {
  meta: {
    project: string;
    sprint: string;
    created_at: string;
    updated_at: string;
  };
  tasks: ComparisonTask[];
}

interface ComparisonStore {
  data: ComparisonData | null;
  loading: boolean;
  error: string | null;
  fetchComparison: () => Promise<void>;
}

export const useComparisonStore = create<ComparisonStore>((set) => ({
  data: null,
  loading: false,
  error: null,

  fetchComparison: async () => {
    set({ loading: true, error: null });
    try {
      const data = await get<ComparisonData>('/api/comparison');
      set({ data: data ?? null });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },
}));
