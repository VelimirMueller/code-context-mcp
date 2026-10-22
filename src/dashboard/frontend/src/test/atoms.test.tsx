import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: { div: (p: any) => <div {...filterDom(p)} />, span: (p: any) => <span {...filterDom(p)} /> },
  useReducedMotion: () => true,
  useMotionValue: () => ({ get: () => 0, set: () => {} }),
  useSpring: () => ({ get: () => 0, set: () => {} }),
  animate: (_mv: any, target: number, opts: any) => { opts?.onUpdate?.(target); return { stop: () => {} }; },
}));

function filterDom(props: Record<string, any>) {
  const skip = ['whileHover', 'layout', 'variants', 'initial', 'animate', 'exit', 'transition'];
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) { if (!skip.includes(k)) clean[k] = v; }
  return clean;
}

// ─── Badge ─────────────────────────────────────────────────────────────

describe('Badge', () => {
  it('renders text content', async () => {
    const { Badge } = await import('@/components/atoms/Badge');
    render(<Badge text="function" variant="fn" />);
    expect(screen.getByText('function')).toBeDefined();
  });

  it('applies variant class', async () => {
    const { Badge } = await import('@/components/atoms/Badge');
    const { container } = render(<Badge text="test" variant="type" />);
    expect(container.querySelector('.badge-type')).toBeTruthy();
  });

  it('defaults to default variant', async () => {
    const { Badge } = await import('@/components/atoms/Badge');
    const { container } = render(<Badge text="x" />);
    expect(container.querySelector('.badge-default')).toBeTruthy();
  });
});

// ─── Skeleton ──────────────────────────────────────────────────────────

describe('Skeleton', () => {
  it('renders correct number of bars', async () => {
    const { Skeleton } = await import('@/components/atoms/Skeleton');
    const { container } = render(<Skeleton count={3} />);
    expect(container.querySelectorAll('.skeleton-bar')).toHaveLength(3);
  });

  it('defaults to 1 bar', async () => {
    const { Skeleton } = await import('@/components/atoms/Skeleton');
    const { container } = render(<Skeleton />);
    expect(container.querySelectorAll('.skeleton-bar')).toHaveLength(1);
  });
});

// ─── StatusBadge ───────────────────────────────────────────────────────

describe('StatusBadge', () => {
  it('renders icon and label', async () => {
    const { StatusBadge } = await import('@/components/atoms/StatusBadge');
    render(<StatusBadge icon="✓" label="Done" />);
    expect(screen.getByText('✓')).toBeDefined();
    expect(screen.getByText('Done')).toBeDefined();
  });

  it('has role=status and aria-label', async () => {
    const { StatusBadge } = await import('@/components/atoms/StatusBadge');
    render(<StatusBadge icon="⚠" label="Warning" />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.getAttribute('aria-label')).toBe('Warning status');
  });

  it('renders preset QaPendingBadge', async () => {
    const { QaPendingBadge } = await import('@/components/atoms/StatusBadge');
    render(<QaPendingBadge />);
    expect(screen.getByText('QA Pending')).toBeDefined();
  });
});

// ─── AnimatedNumber ────────────────────────────────────────────────────

describe('AnimatedNumber', () => {
  it('renders with reduced motion (shows value directly)', async () => {
    const { AnimatedNumber } = await import('@/components/atoms/AnimatedNumber');
    render(<AnimatedNumber value={42} />);
    // With reduced motion mock, should show the value
    const span = screen.getByText('42');
    expect(span).toBeDefined();
  });
});
