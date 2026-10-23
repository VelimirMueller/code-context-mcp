import { create } from 'zustand';
import { get } from '@/lib/api';
import type { File, Directory, Stats } from '@/types';

export interface FileDetail {
  id: number;
  path: string;
  language: string;
  extension: string;
  size_bytes: number;
  line_count: number;
  summary: string;
  description: string | null;
  external_imports: string | null;
  content: string;
  created_at: string;
  modified_at: string;
  indexed_at: string;
  exports: Array<{ name: string; kind: string; description: string | null }>;
  imports: Array<{ id: number; path: string; summary: string; symbols: string }>;
  importedBy: Array<{ id: number; path: string; summary: string; symbols: string }>;
}

export interface Change {
  id: number;
  file_path: string;
  event: string;
  timestamp: string;
  old_summary: string;
  new_summary: string;
  old_line_count: number;
  new_line_count: number;
  old_size_bytes: number;
  new_size_bytes: number;
  old_exports: string;
  new_exports: string;
  diff_text: string;
  reason: string | null;
}

export interface GraphNode {
  id: number;
  label: string;
}

export interface GraphEdge {
  source: number;
  target: number;
  symbols: string;
}

export interface FileStore {
  files: File[];
  directories: Directory[];
  selectedFileId: number | null;
  fileDetail: FileDetail | null;
  fileChanges: Change[];
  graphData: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  stats: Stats | null;
  loading: { files: boolean; detail: boolean; changes: boolean; graph: boolean };
  error: { files: string | null; detail: string | null };

  clearError: () => void;
  fetchFiles: () => Promise<void>;
  fetchDirectories: () => Promise<void>;
  selectFile: (id: number) => Promise<void>;
  fetchGraph: () => Promise<void>;
  fetchStats: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useFileStore = create<FileStore>((set, getState) => ({
  files: [],
  directories: [],
  selectedFileId: null,
  fileDetail: null,
  fileChanges: [],
  graphData: null,
  stats: null,
  loading: { files: false, detail: false, changes: false, graph: false },
  error: { files: null, detail: null },

  clearError: () => set({ error: { files: null, detail: null } }),

  fetchFiles: async () => {
    set((s) => ({ loading: { ...s.loading, files: true }, error: { ...s.error, files: null } }));
    try {
      const files = await get<File[]>('/api/files');
      set({ files: files ?? [] });
    } catch (e) {
      set((s) => ({ error: { ...s.error, files: (e as Error).message } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, files: false } }));
    }
  },

  fetchDirectories: async () => {
    try {
      const directories = await get<Directory[]>('/api/directories');
      set({ directories: directories ?? [] });
    } catch {
      // Silently fail — directories are optional enhancement
    }
  },

  selectFile: async (id: number) => {
    set((s) => ({
      selectedFileId: id,
      loading: { ...s.loading, detail: true, changes: true },
      error: { ...s.error, detail: null },
    }));
    try {
      const [detail, changes] = await Promise.all([
        get<FileDetail>(`/api/file/${id}`),
        get<Change[]>(`/api/file/${id}/changes?limit=50`),
      ]);
      set((s) => ({
        fileDetail: detail ?? null,
        fileChanges: Array.isArray(changes) ? changes : [],
        loading: { ...s.loading, detail: false, changes: false },
      }));
    } catch (e) {
      set((s) => ({
        error: { ...s.error, detail: (e as Error).message },
        loading: { ...s.loading, detail: false, changes: false },
      }));
    }
  },

  fetchGraph: async () => {
    set((s) => ({ loading: { ...s.loading, graph: true } }));
    try {
      const graphData = await get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/api/graph');
      set({ graphData: graphData ?? null });
    } catch {
      // Silently fail
    } finally {
      set((s) => ({ loading: { ...s.loading, graph: false } }));
    }
  },

  fetchStats: async () => {
    try {
      const stats = await get<Stats>('/api/stats');
      set({ stats: stats ?? null });
    } catch {
      // Silently fail
    }
  },

  refresh: async () => {
    const { fetchFiles, fetchDirectories, fetchStats, selectedFileId, selectFile } = getState();
    await Promise.all([fetchFiles(), fetchDirectories(), fetchStats()]);
    if (selectedFileId !== null) await selectFile(selectedFileId);
  },
}));
