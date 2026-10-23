import { useState, useEffect, type CSSProperties } from 'react';
import { useSprintStore } from '@/stores/sprintStore';
import { SprintCard } from '@/components/molecules/SprintCard';
import { AlertDialog } from '@/components/molecules/AlertDialog';
import { cx } from '@/lib/utils';
import type { MilestoneSprintGroup, Sprint } from '@/types';

const ARCHIVABLE_STATUSES = ['closed', 'rest', 'done'];
const isArchiveEligible = (s: Sprint) =>
  ARCHIVABLE_STATUSES.includes(s.status) && s.archived_at === null;

/**
 * Colour of a milestone header and progress bar, by the status the database
 * stores (`planned`, `active`, `completed`; #211). Any other value, and no
 * milestone, gets the planned colour.
 */
export function milestoneStatusColor(status: string | undefined): string {
  if (status === 'active') return 'var(--color-accent)';
  if (status === 'completed') return 'var(--color-fg-3)';
  return 'var(--color-accent-2)';
}

export function SprintList() {
  const milestoneGroups = useSprintStore((s) => s.milestoneGroups);
  const sprints = useSprintStore((s) => s.sprints);
  const selectedSprintId = useSprintStore((s) => s.selectedSprintId);
  const selectSprint = useSprintStore((s) => s.selectSprint);
  const fetchGrouped = useSprintStore((s) => s.fetchGroupedSprints);
  const archiveAllCompleted = useSprintStore((s) => s.archiveAllCompleted);
  const loadingSprints = useSprintStore((s) => s.loading.sprints);
  const loadingGrouped = useSprintStore((s) => s.loading.grouped);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showArchive, setShowArchive] = useState(false);
  const [showBulkDialog, setShowBulkDialog] = useState(false);

  useEffect(() => {
    fetchGrouped();
  }, [sprints.length]);

  // Auto-collapse completed milestones
  // Auto-collapse completed milestones and unassigned group
  useEffect(() => {
    if (milestoneGroups.length === 0) return;
    const autoCollapseKeys = milestoneGroups
      .filter((g) => g.milestone?.status === 'completed' || g.milestone === null)
      .map((g) => (g.milestone ? `m-${g.milestone.id}` : 'unassigned'));
    if (autoCollapseKeys.length > 0) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        autoCollapseKeys.forEach((k) => next.add(k));
        return next;
      });
    }
  }, [milestoneGroups.length]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const loading = loadingSprints || loadingGrouped;

  if (loading && milestoneGroups.length === 0 && sprints.length === 0) {
    return (
      <div className="p-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="mb-1.5 h-18 rounded-card bg-surface-2 [animation:pulse_1.5s_ease-in-out_infinite]"
          />
        ))}
      </div>
    );
  }

  // Fallback: if grouped API hasn't loaded yet, show flat list
  if (milestoneGroups.length === 0 && sprints.length > 0) {
    const statusOrder: Record<string, number> = {
      implementation: 0,
      planning: 1,
      qa: 2,
      retro: 3,
      closed: 4,
      rest: 5,
    };
    const sorted = [...sprints].sort((a, b) => {
      const ao = statusOrder[a.status] ?? 3;
      const bo = statusOrder[b.status] ?? 3;
      if (ao !== bo) return ao - bo;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    return (
      <div className="flex-1 overflow-y-auto p-3">
        {sorted.map((sprint) => (
          <SprintCard
            key={sprint.id}
            sprint={sprint}
            selected={sprint.id === selectedSprintId}
            onClick={selectSprint}
          />
        ))}
      </div>
    );
  }

  if (milestoneGroups.length === 0) {
    return <div className="p-10 text-center text-13 text-fg-3">No sprints found</div>;
  }

  // Archive state is orthogonal to status: filter each group by archived_at.
  // Active = sprints not archived; Archive = sprints with archived_at set.
  // Groups that become empty after filtering are dropped from their section.
  const activeGroups = milestoneGroups
    .map((g) => ({ ...g, sprints: g.sprints.filter((s) => s.archived_at === null) }))
    .filter((g) => g.sprints.length > 0);
  const archivedGroups = milestoneGroups
    .map((g) => ({ ...g, sprints: g.sprints.filter((s) => s.archived_at !== null) }))
    .filter((g) => g.sprints.length > 0);

  // Bulk-eligible count, computed the same way the server enforces eligibility.
  const bulkEligibleCount = sprints.filter(isArchiveEligible).length;

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mb-1 px-1 pb-2 text-10 font-semibold tracking-[0.05em] text-fg-3 uppercase">
        Sprints
      </div>

      {activeGroups.map((group) => {
        const key = group.milestone ? `m-${group.milestone.id}` : 'unassigned';
        const isCollapsed = collapsed.has(key);
        const ms = group.milestone;
        const pct =
          ms && ms.ticket_count > 0 ? Math.round((ms.done_count / ms.ticket_count) * 100) : 0;
        const statusColor = milestoneStatusColor(ms?.status);
        const isCompleted = ms?.status === 'completed';

        return (
          <div key={key} className="mb-2">
            {/* Milestone header */}
            <button
              onClick={() => toggleCollapse(key)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] border-none bg-transparent px-2 py-1.5 font-body [transition:background_0.15s] hover:bg-surface-2"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                className={cx(
                  'shrink-0 text-fg-3 [transition:transform_0.2s]',
                  isCollapsed ? '[transform:rotate(0deg)]' : '[transform:rotate(90deg)]',
                )}
              >
                <path d="M6 3l5 5-5 5z" />
              </svg>

              {ms ? (
                <>
                  <span
                    className={cx(
                      'flex-1 truncate text-left text-11 font-bold',
                      isCompleted ? 'text-fg-3' : 'text-fg',
                    )}
                  >
                    {ms.name}
                  </span>
                  <span
                    data-testid={`milestone-pct-${ms.id}`}
                    className="shrink-0 font-code text-9 font-semibold text-(--c) uppercase"
                    style={{ '--c': statusColor } as CSSProperties}
                  >
                    {pct}%
                  </span>
                  <span className="shrink-0 font-code text-9 text-fg-3">
                    {group.sprints.length}
                  </span>
                </>
              ) : (
                <>
                  <span className="flex-1 text-left text-11 font-semibold text-fg-3 italic">
                    Unassigned
                  </span>
                  <span className="shrink-0 font-code text-9 text-fg-3">
                    {group.sprints.length}
                  </span>
                </>
              )}
            </button>

            {/* Progress bar for milestone */}
            {ms && !isCollapsed && (
              <div className="mx-2 mt-0.5 mb-1.5 h-0.5 overflow-hidden rounded-[1px] bg-surface-3">
                <div
                  data-testid={`milestone-bar-${ms.id}`}
                  className="h-full rounded-[1px] bg-(--c) [transition:width_0.4s_ease]"
                  style={{ width: `${pct}%`, '--c': statusColor } as CSSProperties}
                />
              </div>
            )}

            {/* Sprint cards */}
            {!isCollapsed && (
              <div className="ml-2">
                {group.sprints.map((sprint) => (
                  <SprintCard
                    key={sprint.id}
                    sprint={sprint}
                    selected={sprint.id === selectedSprintId}
                    onClick={selectSprint}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Bulk archive + archive section */}
      {(bulkEligibleCount > 0 || archivedGroups.length > 0) && (
        <div className="mt-2">
          {/* Archive all completed: same button style as the archive toggle */}
          {bulkEligibleCount > 0 && (
            <button
              onClick={() => setShowBulkDialog(true)}
              className="w-full cursor-pointer rounded-[6px] border border-line-2 bg-transparent px-2.5 py-1.5 text-center font-body text-11 text-fg-3 mb-1.5"
            >
              Archive all completed ({bulkEligibleCount})
            </button>
          )}

          {archivedGroups.length > 0 && (
            <button
              onClick={() => setShowArchive(!showArchive)}
              className="w-full cursor-pointer rounded-[6px] border border-line-2 bg-transparent px-2.5 py-1.5 text-center font-body text-11 text-fg-3"
            >
              {showArchive ? 'Hide' : 'Show'} Archive (
              {archivedGroups.reduce((a, g) => a + g.sprints.length, 0)} sprints)
            </button>
          )}
          {showArchive &&
            archivedGroups.map((group) => {
              const key = group.milestone ? `m-${group.milestone.id}` : 'unassigned';
              const isCollapsed = collapsed.has(key);
              const ms = group.milestone;
              return (
                <div key={key} className="mt-1.5 opacity-60">
                  <button
                    onClick={() => toggleCollapse(key)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] border-none bg-transparent px-2 py-1.5 font-body"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={cx(
                        'shrink-0 text-fg-3',
                        isCollapsed ? '[transform:rotate(0deg)]' : '[transform:rotate(90deg)]',
                      )}
                    >
                      <path d="M6 3l5 5-5 5z" />
                    </svg>
                    <span className="flex-1 truncate text-left text-11 font-semibold text-fg-3">
                      {ms?.name ?? 'Unassigned'}
                    </span>
                    <span className="font-code text-9 text-fg-3">{group.sprints.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="ml-2">
                      {group.sprints.map((sprint) => (
                        <SprintCard
                          key={sprint.id}
                          sprint={sprint}
                          selected={sprint.id === selectedSprintId}
                          onClick={selectSprint}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

          <AlertDialog
            open={showBulkDialog}
            title="Archive completed sprints"
            message={`Archive ${bulkEligibleCount} completed sprints? They stay in all metrics and can be unarchived anytime.`}
            confirmLabel="Archive"
            variant="warning"
            onCancel={() => setShowBulkDialog(false)}
            onConfirm={() => {
              setShowBulkDialog(false);
              archiveAllCompleted();
            }}
          />
        </div>
      )}
    </div>
  );
}
