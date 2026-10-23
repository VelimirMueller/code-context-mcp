import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

// Mock framer-motion
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

// ─── ErrorBoundary ────────────────────────────────────────────────────

describe('ErrorBoundary', () => {
  // Suppress React error boundary console.error noise in test output
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('renders children when no error occurs', async () => {
    const { ErrorBoundary } = await import('@/components/atoms/ErrorBoundary');
    render(
      <ErrorBoundary>
        <div>All good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('All good')).toBeDefined();
  });

  it('renders fallback UI when child throws', async () => {
    const { ErrorBoundary } = await import('@/components/atoms/ErrorBoundary');

    function BrokenComponent(): React.ReactElement {
      throw new Error('Boom');
    }

    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('shows retry button in default fallback', async () => {
    const { ErrorBoundary } = await import('@/components/atoms/ErrorBoundary');

    function BrokenComponent(): React.ReactElement {
      throw new Error('Fail');
    }

    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    const btn = screen.getByText('Retry');
    expect(btn).toBeDefined();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('renders custom fallback when provided', async () => {
    const { ErrorBoundary } = await import('@/components/atoms/ErrorBoundary');

    function BrokenComponent(): React.ReactElement {
      throw new Error('Custom');
    }

    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <BrokenComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Custom fallback')).toBeDefined();
  });
});

// ─── Toast ────────────────────────────────────────────────────────────

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders message and has alert role', async () => {
    const { Toast } = await import('@/components/atoms/Toast');
    render(<Toast message="Saved!" type="success" onClose={() => {}} />);
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('Saved!')).toBeDefined();
  });

  it('renders error type with error indicator', async () => {
    const { Toast } = await import('@/components/atoms/Toast');
    render(<Toast message="Failed" type="error" onClose={() => {}} />);
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders warning type', async () => {
    const { Toast } = await import('@/components/atoms/Toast');
    render(<Toast message="Watch out" type="warning" onClose={() => {}} />);
    expect(screen.getByText('Watch out')).toBeDefined();
  });

  it('auto-dismisses after timeout', async () => {
    const { Toast } = await import('@/components/atoms/Toast');
    const onClose = vi.fn();
    render(<Toast message="Bye" type="success" onClose={onClose} />);

    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── ToastStore ───────────────────────────────────────────────────────

describe('toastStore', () => {
  it('addToast creates a toast and removeToast removes it', async () => {
    const { useToastStore } = await import('@/stores/toastStore');
    useToastStore.setState({ toasts: [] });

    useToastStore.getState().addToast('Hello', 'success');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe('Hello');

    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('supports warning type', async () => {
    const { useToastStore } = await import('@/stores/toastStore');
    useToastStore.setState({ toasts: [] });

    useToastStore.getState().addToast('Careful', 'warning');
    expect(useToastStore.getState().toasts[0].type).toBe('warning');
  });
});

// ─── Store error states ───────────────────────────────────────────────

describe('Store error handling', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it('agentStore sets error on fetch failure', async () => {
    const { useAgentStore } = await import('@/stores/agentStore');
    useAgentStore.setState({ agents: [], loading: false, error: null });
    mockFetch.mockRejectedValueOnce(new Error('Network fail'));

    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().error).toBe('Network fail');
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it('agentStore clearError resets error', async () => {
    const { useAgentStore } = await import('@/stores/agentStore');
    useAgentStore.setState({ error: 'old error' } as any);

    useAgentStore.getState().clearError();
    expect(useAgentStore.getState().error).toBeNull();
  });
});
