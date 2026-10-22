import { useState, useEffect } from 'react';
import { useSprintStore } from '@/stores/sprintStore';
import { SprintCard } from '@/components/molecules/SprintCard';
import { AlertDialog } from '@/components/molecules/AlertDialog';
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
  if (status === 'active') return 'var(--accent)';
  if (status === 'completed') return 'var(--text3)';
  return 'var(--purple)';
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
      <div style={{ padding: 16 }}>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 72,
              background: 'var(--surface2)',
              borderRadius: 'var(--radius)',
              marginBottom: 6,
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
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
      <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
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
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
        No sprints found
      </div>
    );
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
    <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text3)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          padding: '0 4px 8px',
          marginBottom: 4,
        }}
      >
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
          <div key={key} style={{ marginBottom: 8 }}>
            {/* Milestone header */}
            <button
              onClick={() => toggleCollapse(key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 8px',
                background: 'none',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={{
                  color: 'var(--text3)',
                  transition: 'transform 0.2s',
                  transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                  flexShrink: 0,
                }}
              >
                <path d="M6 3l5 5-5 5z" />
              </svg>

              {ms ? (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: isCompleted ? 'var(--text3)' : 'var(--text)',
                      flex: 1,
                      textAlign: 'left',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {ms.name}
                  </span>
                  <span
                    data-testid={`milestone-pct-${ms.id}`}
                    style={{
                      fontSize: 9,
                      fontFamily: 'var(--mono)',
                      fontWeight: 600,
                      color: statusColor,
                      textTransform: 'uppercase',
                      flexShrink: 0,
                    }}
                  >
                    {pct}%
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: 'var(--mono)',
                      color: 'var(--text3)',
                      flexShrink: 0,
                    }}
                  >
                    {group.sprints.length}
                  </span>
                </>
              ) : (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--text3)',
                      fontStyle: 'italic',
                      flex: 1,
                      textAlign: 'left',
                    }}
                  >
                    Unassigned
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: 'var(--mono)',
                      color: 'var(--text3)',
                      flexShrink: 0,
                    }}
                  >
                    {group.sprints.length}
                  </span>
                </>
              )}
            </button>

            {/* Progress bar for milestone */}
            {ms && !isCollapsed && (
              <div
                style={{
                  margin: '2px 8px 6px',
                  height: 2,
                  background: 'var(--surface3)',
                  borderRadius: 1,
                  overflow: 'hidden',
                }}
              >
                <div
                  data-testid={`milestone-bar-${ms.id}`}
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: statusColor,
                    borderRadius: 1,
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
            )}

            {/* Sprint cards */}
            {!isCollapsed && (
              <div style={{ marginLeft: 8 }}>
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
        <div style={{ marginTop: 8 }}>
          {/* Archive all completed: same button style as the archive toggle */}
          {bulkEligibleCount > 0 && (
            <button
              onClick={() => setShowBulkDialog(true)}
              style={{
                width: '100%',
                background: 'none',
                border: '1px solid var(--border2)',
                borderRadius: 6,
                color: 'var(--text3)',
                fontSize: 11,
                padding: '6px 10px',
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                textAlign: 'center',
                marginBottom: 6,
              }}
            >
              Archive all completed ({bulkEligibleCount})
            </button>
          )}

          {archivedGroups.length > 0 && (
            <button
              onClick={() => setShowArchive(!showArchive)}
              style={{
                width: '100%',
                background: 'none',
                border: '1px solid var(--border2)',
                borderRadius: 6,
                color: 'var(--text3)',
                fontSize: 11,
                padding: '6px 10px',
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                textAlign: 'center',
              }}
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
                <div key={key} style={{ marginTop: 6, opacity: 0.6 }}>
                  <button
                    onClick={() => toggleCollapse(key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 8px',
                      background: 'none',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontFamily: 'var(--font)',
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      style={{
                        color: 'var(--text3)',
                        transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                        flexShrink: 0,
                      }}
                    >
                      <path d="M6 3l5 5-5 5z" />
                    </svg>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text3)',
                        flex: 1,
                        textAlign: 'left',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {ms?.name ?? 'Unassigned'}
                    </span>
                    <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
                      {group.sprints.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div style={{ marginLeft: 8 }}>
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
