import { create } from 'zustand';
import { get, post, patch } from '@/lib/api';
import type { WizardStep } from '@/components/molecules/WizardModal';
import type { ClaudeOutputLine } from '@/components/atoms/ClaudeOutputStream';
import { makeLineId } from '@/components/atoms/ClaudeOutputStream';
import type { ClaudeOutputChunk } from '@/hooks/useEventSource';

export interface PendingAction {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  payload: string | null;
  status: string;
  source: string;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: string | null;
  error: string | null;
}

export interface BridgeStatus {
  pending: number;
  claimed: number;
  completed: number;
  failed: number;
}

export interface StepProgress {
  step: string;
  title: string;
  description: string;
  current: number;
  total: number;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  error?: string;
}

export interface ClaudeStreamState {
  lines: ClaudeOutputLine[];
  isActive: boolean;
  /** Map of step names to their status for the step tracker */
  steps: Record<string, { name: string; status: 'pending' | 'in_progress' | 'completed' | 'error'; title?: string; description?: string }>;
  /** Current step progress from SSE step_progress events */
  currentStepProgress: StepProgress | null;
}

export interface BridgeStore {
  status: BridgeStatus | null;
  actions: PendingAction[];
  wizardSteps: WizardStep[];
  wizardOpen: boolean;
  stepProgress: StepProgress | null;
  loading: boolean;
  error: string | null;
  claudeStream: ClaudeStreamState;

  fetchStatus: () => Promise<void>;
  fetchActions: (status?: string) => Promise<void>;
  queueAction: (action: string, entityType?: string, entityId?: number, payload?: Record<string, unknown>) => Promise<void>;
  handleInputRequested: (action: PendingAction) => void;
  handleStepProgress: (progress: StepProgress) => void;
  dismissWizard: () => void;
  completeWizard: () => void;
  clearError: () => void;
  /** Append a claude_output SSE chunk to the stream */
  handleClaudeOutput: (chunk: ClaudeOutputChunk) => void;
  /** Update a step's status from a claude_step SSE event */
  handleClaudeStep: (step: { name: string; status: 'pending' | 'in_progress' | 'completed' | 'error'; title?: string; description?: string }) => void;
  /** Clear all claude output (e.g. when wizard resets) */
  clearClaudeStream: () => void;
}

export const useBridgeStore = create<BridgeStore>((set, getState) => ({
  status: null,
  actions: [],
  wizardSteps: [],
  wizardOpen: false,
  stepProgress: null,
  loading: false,
  error: null,
  claudeStream: { lines: [], isActive: false, steps: {}, currentStepProgress: null },

  fetchStatus: async () => {
    try {
      const status = await get<BridgeStatus>('/api/bridge/status');
      set({ status: status ?? null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  fetchActions: async (status = 'pending') => {
    try {
      const actions = await get<PendingAction[]>(`/api/bridge/actions?status=${status}`);
      set({ actions: Array.isArray(actions) ? actions : [] });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  queueAction: async (action, entityType, entityId, payload) => {
    set({ loading: true, error: null });
    try {
      await post('/api/bridge/actions', {
        action,
        entity_type: entityType,
        entity_id: entityId,
        payload,
      });
      const state = getState();
      await state.fetchStatus();
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  handleInputRequested: (action: PendingAction) => {
    try {
      const payload = action.payload ? JSON.parse(action.payload) : null;
      if (!payload) return;
      const step: WizardStep = {
        actionId: action.id,
        step: payload.step ?? 'unknown',
        title: payload.title ?? 'Input Required',
        description: payload.description ?? '',
        fields: payload.fields ?? [],
        hints: payload.hints,
      };
      set(state => ({
        wizardSteps: [...state.wizardSteps, step],
        wizardOpen: true,
      }));
    } catch { /* ignore parse errors */ }
  },

  handleStepProgress: (progress: StepProgress) => {
    set(state => ({
      stepProgress: progress,
      claudeStream: {
        ...state.claudeStream,
        currentStepProgress: progress,
        isActive: progress.status === 'in_progress',
      },
    }));
  },

  dismissWizard: () => set({ wizardOpen: false, wizardSteps: [], stepProgress: null, claudeStream: { lines: [], isActive: false, steps: {}, currentStepProgress: null } }),

  completeWizard: () => set({ wizardOpen: false, wizardSteps: [], stepProgress: null, claudeStream: { lines: [], isActive: false, steps: {}, currentStepProgress: null } }),

  clearError: () => set({ error: null }),

  handleClaudeOutput: (chunk: ClaudeOutputChunk) => {
    const line: ClaudeOutputLine = {
      id: makeLineId(),
      text: chunk.text,
      timestamp: Date.now(),
      type: chunk.type,
    };
    set(state => ({
      claudeStream: {
        ...state.claudeStream,
        isActive: true,
        lines: [...state.claudeStream.lines, line],
      },
    }));
  },

  handleClaudeStep: (step) => {
    set(state => ({
      claudeStream: {
        ...state.claudeStream,
        isActive: step.status === 'in_progress',
        steps: {
          ...state.claudeStream.steps,
          [step.name]: step,
        },
      },
    }));
    // Also add a line to the output for visibility
    const statusIcon = step.status === 'completed' ? '\u2713' : step.status === 'error' ? '\u2717' : step.status === 'in_progress' ? '\u25B6' : '\u25CB';
    const line: ClaudeOutputLine = {
      id: makeLineId(),
      text: `${statusIcon} ${step.title || step.name}${step.description ? ': ' + step.description : ''}`,
      timestamp: Date.now(),
      type: 'step',
    };
    set(state => ({
      claudeStream: {
        ...state.claudeStream,
        lines: [...state.claudeStream.lines, line],
      },
    }));
  },

  clearClaudeStream: () => set({ claudeStream: { lines: [], isActive: false, steps: {}, currentStepProgress: null } }),
}));
