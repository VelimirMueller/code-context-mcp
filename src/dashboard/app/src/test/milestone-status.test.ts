import { describe, it, expect, vi } from 'vitest';
import { parseMilestoneMarkdown } from '@/lib/utils';

// #221: the dashboard uses only the stored milestone statuses
// (planned, active, completed). No view maps a milestone to in_progress.

vi.mock('@/stores/planningStore', () => ({ usePlanningStore: () => undefined }));
vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));

const md = [
  '## Milestone 1: Foundation — COMPLETE',
  '**Goal:** ship the base',
  '',
  '## Milestone 2: Platform — ACTIVE',
  '**Goal:** build the platform',
  '',
  '## Milestone 3: Growth — IN PROGRESS',
  '',
  '## Milestone 4: Later',
].join('\n');

describe('parseMilestoneMarkdown status mapping', () => {
  it('maps headings to planned, active and completed only', () => {
    const byId = Object.fromEntries(parseMilestoneMarkdown(md).map((m) => [m.id, m]));
    expect(byId[1].status).toBe('completed');
    expect(byId[2].status).toBe('active');
    expect(byId[3].status).toBe('active');
    expect(byId[4].status).toBe('planned');
    expect(Object.values(byId).map((m) => m.status)).not.toContain('in_progress');
  });

  it('gives an active milestone half progress', () => {
    const [, active] = parseMilestoneMarkdown(md);
    expect(active.progress).toBe(50);
  });
});

describe('milestoneCardColor', () => {
  it('colours each stored status and treats in_progress as unknown', async () => {
    const { milestoneCardColor } = await import('@/pages/ProjectManagement');
    expect(milestoneCardColor('active')).toBe('#10b981');
    expect(milestoneCardColor('completed')).toBe('#6b6b84');
    expect(milestoneCardColor('planned')).toBe('#6366f1');
    expect(milestoneCardColor('in_progress')).toBe(milestoneCardColor('planned'));
  });
});
