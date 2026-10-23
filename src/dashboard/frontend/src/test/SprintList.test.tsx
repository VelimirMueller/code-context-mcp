import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MilestoneSprintGroup, Sprint } from '@/types';

// SprintCard pulls in framer-motion + the atoms barrel; stub it to a plain
// node so these tests stay focused on SprintList's grouping / archive logic.
vi.mock('@/components/molecules/SprintCard', () => ({
  SprintCard: ({ sprint }: { sprint: Sprint }) => (
    <div data-testid={`sprint-${sprint.id}`}>{sprint.name}</div>
  ),
}));

// Controllable store state, swapped per test before render.
let storeState: any;
const selectSprintMock = vi.fn();
const fetchGroupedMock = vi.fn();
const archiveAllCompletedMock = vi.fn();

vi.mock('@/stores/sprintStore', () => ({
  useSprintStore: (sel: any) => sel(storeState),
}));

function makeSprint(over: Partial<Sprint> & { id: number }): Sprint {
  return {
    name: `Sprint ${over.id}`,
    goal: null,
    start_date: null,
    end_date: null,
    status: 'implementation',
    archived_at: null,
    velocity_committed: 0,
    velocity_completed: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ticket_count: 0,
    done_count: 0,
    qa_count: 0,
    retro_count: 0,
    open_blockers: 0,
    ...over,
  };
}

function baseState(groups: MilestoneSprintGroup[]) {
  return {
    milestoneGroups: groups,
    sprints: groups.flatMap((g) => g.sprints),
    selectedSprintId: null,
    selectSprint: selectSprintMock,
    fetchGroupedSprints: fetchGroupedMock,
    archiveAllCompleted: archiveAllCompletedMock,
    loading: { sprints: false, detail: false, grouped: false },
  };
}

describe('SprintList archive sections (T-221)', () => {
  beforeEach(() => {
    selectSprintMock.mockReset();
    fetchGroupedMock.mockReset();
    archiveAllCompletedMock.mockReset();
  });

  it('renders only non-archived sprints in the active section', async () => {
    const groups: MilestoneSprintGroup[] = [
      {
        milestone: {
          id: 1,
          name: 'M1',
          description: null,
          status: 'active',
          target_date: null,
          progress: 0,
          ticket_count: 0,
          done_count: 0,
        },
        sprints: [
          makeSprint({ id: 1, status: 'implementation', archived_at: null }),
          makeSprint({ id: 2, status: 'closed', archived_at: '2026-06-10 09:00:00' }),
        ],
      },
    ];
    storeState = baseState(groups);
    const { SprintList } = await import('@/components/organisms/SprintList');
    render(<SprintList />);

    // Active sprint visible, archived one not rendered in active section.
    expect(screen.queryByTestId('sprint-1')).not.toBeNull();
    // Sprint 2 is archived → only appears inside the archive once toggle is opened.
    expect(screen.queryByTestId('sprint-2')).toBeNull();
  });

  it('shows archived sprints only inside the archive section after toggling it open', async () => {
    const groups: MilestoneSprintGroup[] = [
      {
        milestone: {
          id: 1,
          name: 'M1',
          description: null,
          status: 'active',
          target_date: null,
          progress: 0,
          ticket_count: 0,
          done_count: 0,
        },
        sprints: [
          makeSprint({ id: 1, status: 'implementation', archived_at: null }),
          makeSprint({ id: 2, status: 'closed', archived_at: '2026-06-10 09:00:00' }),
        ],
      },
    ];
    storeState = baseState(groups);
    const { SprintList } = await import('@/components/organisms/SprintList');
    render(<SprintList />);

    // Archive toggle shows the count of archived sprints (1).
    const toggle = screen.getByText(/Show Archive \(1 sprints\)/);
    expect(toggle).not.toBeNull();
    // Before opening, archived sprint is not in the DOM.
    expect(screen.queryByTestId('sprint-2')).toBeNull();

    fireEvent.click(toggle);
    // After opening, archived sprint appears.
    expect(screen.queryByTestId('sprint-2')).not.toBeNull();
    expect(screen.getByText(/Hide Archive \(1 sprints\)/)).not.toBeNull();
  });

  it('hides the bulk archive button when no sprint is eligible', async () => {
    const groups: MilestoneSprintGroup[] = [
      {
        milestone: {
          id: 1,
          name: 'M1',
          description: null,
          status: 'active',
          target_date: null,
          progress: 0,
          ticket_count: 0,
          done_count: 0,
        },
        sprints: [
          // implementation is not an eligible status
          makeSprint({ id: 1, status: 'implementation', archived_at: null }),
          // closed but already archived → not eligible
          makeSprint({ id: 2, status: 'closed', archived_at: '2026-06-10 09:00:00' }),
        ],
      },
    ];
    storeState = baseState(groups);
    const { SprintList } = await import('@/components/organisms/SprintList');
    render(<SprintList />);

    expect(screen.queryByText(/Archive all completed/)).toBeNull();
  });

  it('shows the bulk archive button with the correct eligible count', async () => {
    const groups: MilestoneSprintGroup[] = [
      {
        milestone: {
          id: 1,
          name: 'M1',
          description: null,
          status: 'active',
          target_date: null,
          progress: 0,
          ticket_count: 0,
          done_count: 0,
        },
        sprints: [
          makeSprint({ id: 1, status: 'closed', archived_at: null }), // eligible
          makeSprint({ id: 2, status: 'rest', archived_at: null }), // eligible
          makeSprint({ id: 3, status: 'done', archived_at: null }), // eligible
          makeSprint({ id: 4, status: 'implementation', archived_at: null }), // not eligible (status)
          makeSprint({ id: 5, status: 'closed', archived_at: '2026-06-10 09:00:00' }), // not eligible (archived)
        ],
      },
    ];
    storeState = baseState(groups);
    const { SprintList } = await import('@/components/organisms/SprintList');
    render(<SprintList />);

    expect(screen.getByText(/Archive all completed \(3\)/)).not.toBeNull();
  });

  it('opens the confirmation dialog and calls archiveAllCompleted on confirm', async () => {
    const groups: MilestoneSprintGroup[] = [
      {
        milestone: {
          id: 1,
          name: 'M1',
          description: null,
          status: 'active',
          target_date: null,
          progress: 0,
          ticket_count: 0,
          done_count: 0,
        },
        sprints: [
          makeSprint({ id: 1, status: 'closed', archived_at: null }),
          makeSprint({ id: 2, status: 'done', archived_at: null }),
        ],
      },
    ];
    storeState = baseState(groups);
    const { SprintList } = await import('@/components/organisms/SprintList');
    render(<SprintList />);

    fireEvent.click(screen.getByText(/Archive all completed \(2\)/));
    // AlertDialog renders the confirmation message with the count.
    expect(screen.getByText(/Archive 2 completed sprints\?/)).not.toBeNull();

    fireEvent.click(screen.getByText('Archive'));
    expect(archiveAllCompletedMock).toHaveBeenCalledTimes(1);
  });
});

describe('SprintList milestone colour (#211)', () => {
  const milestone = (id: number, status: string) => ({
    id,
    name: `M${id}`,
    description: null,
    status,
    target_date: null,
    progress: 0,
    ticket_count: 4,
    done_count: 1,
  });

  it.each([
    ['planned', 'var(--color-accent-2)'],
    ['active', 'var(--color-accent)'],
    ['completed', 'var(--color-fg-3)'],
  ])('colours a %s milestone with %s', async (status, colour) => {
    storeState = baseState([
      { milestone: milestone(7, status), sprints: [makeSprint({ id: 70 })] },
    ]);
    const { SprintList, milestoneStatusColor } = await import('@/components/organisms/SprintList');
    render(<SprintList />);

    expect(milestoneStatusColor(status)).toBe(colour);
    expect(screen.getByTestId('milestone-pct-7').style.getPropertyValue('--c')).toBe(colour);
    // A completed milestone starts collapsed, so only open ones show the bar.
    if (status !== 'completed') {
      expect(screen.getByTestId('milestone-bar-7').style.getPropertyValue('--c')).toBe(colour);
    }
  });

  it('does not use the active colour for the old in_progress value', async () => {
    const { milestoneStatusColor } = await import('@/components/organisms/SprintList');
    expect(milestoneStatusColor('in_progress')).toBe('var(--color-accent-2)');
    expect(milestoneStatusColor(undefined)).toBe('var(--color-accent-2)');
  });
});
