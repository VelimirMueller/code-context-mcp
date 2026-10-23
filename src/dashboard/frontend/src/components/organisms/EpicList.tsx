'use client';

import React, { useState, useEffect, useMemo, useCallback, type CSSProperties } from 'react';
import type { Epic, Milestone } from '@/types';
import { get, post } from '@/lib/api';
import { usePlanningStore } from '@/stores/planningStore';
import { useToastStore } from '@/stores/toastStore';
import { cx } from '@/lib/utils';

const statusColors: Record<string, { classes: string; label: string }> = {
  active: {
    classes: 'bg-[rgba(16,185,129,.10)] text-green border-[rgba(16,185,129,.20)]',
    label: 'Active',
  },
  planned: {
    classes: 'bg-[rgba(167,139,250,.10)] text-accent-2 border-[rgba(167,139,250,.20)]',
    label: 'Planned',
  },
  completed: {
    classes: 'bg-[rgba(59,130,246,.10)] text-blue border-[rgba(59,130,246,.20)]',
    label: 'Completed',
  },
  archived: {
    classes: 'bg-[rgba(107,114,128,.10)] text-fg-3 border-[rgba(107,114,128,.20)]',
    label: 'Archived',
  },
};

function StatusBadge({ status }: { status: string }) {
  const s = statusColors[status] ?? statusColors.planned;
  return (
    <span
      className={cx(
        'rounded-[6px] border px-[9px] py-0.5 font-code text-11 font-semibold tracking-[0.04em] uppercase',
        s.classes,
      )}
    >
      {s.label}
    </span>
  );
}

function ArchiveButton({
  archived,
  busy,
  onClick,
}: {
  archived: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={cx(
        'ml-auto shrink-0 rounded-[6px] border border-line-2 bg-transparent px-2.5 py-0.5 font-body text-11 font-semibold',
        busy ? 'cursor-not-allowed text-fg-3' : 'cursor-pointer text-fg-2',
      )}
    >
      {busy ? '…' : archived ? 'Unarchive' : 'Archive'}
    </button>
  );
}

export function EpicList() {
  const [epics, setEpics] = useState<Epic[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchive, setShowArchive] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const milestones = usePlanningStore((s) => s.milestones);
  const fetchMilestones = usePlanningStore((s) => s.fetchMilestones);

  const fetchEpics = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<Epic[]>('/api/epics');
      setEpics(Array.isArray(data) ? data : []);
    } catch {
      setEpics([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Archive / unarchive (POST /api/epic/:id/{archive,unarchive}); the server enforces
  // that only completed epics can be archived.
  const toggleArchive = useCallback(
    async (epic: Epic) => {
      const verb = epic.archived_at ? 'unarchive' : 'archive';
      setBusyId(epic.id);
      try {
        await post(`/api/epic/${epic.id}/${verb}`, {});
        await fetchEpics();
        useToastStore
          .getState()
          .addToast(verb === 'archive' ? 'Epic archived' : 'Epic restored', 'success');
      } catch (e) {
        useToastStore.getState().addToast((e as Error).message, 'error');
      } finally {
        setBusyId(null);
      }
    },
    [fetchEpics],
  );

  useEffect(() => {
    fetchEpics();
    if (milestones.length === 0) fetchMilestones();
  }, [fetchEpics, milestones.length, fetchMilestones]);

  const milestoneLookup = useMemo(() => {
    const map = new Map<number, Milestone>();
    milestones.forEach((m) => map.set(m.id, m));
    return map;
  }, [milestones]);

  // Archive state is orthogonal to status (same model as sprints): every non-archived
  // epic stays visible, grouped by milestone; archived epics live behind the toggle.
  const { activeGroups, archivedGroups } = useMemo(() => {
    const group = (list: Epic[]) => {
      const byMilestone = new Map<number | null, Epic[]>();
      for (const epic of list) {
        const key = epic.milestone_id ?? null;
        if (!byMilestone.has(key)) byMilestone.set(key, []);
        byMilestone.get(key)!.push(epic);
      }
      const groups: { milestone: Milestone | null; epics: Epic[] }[] = [];
      // Milestone order follows the milestones list; unknown/archived milestones fall
      // through to the generic lookup below so no epic is ever dropped.
      for (const m of milestones) {
        const g = byMilestone.get(m.id);
        if (g) {
          groups.push({ milestone: m, epics: g });
          byMilestone.delete(m.id);
        }
      }
      for (const [key, g] of byMilestone) {
        if (key !== null) groups.push({ milestone: milestoneLookup.get(key) ?? null, epics: g });
      }
      const none = byMilestone.get(null);
      if (none) groups.push({ milestone: null, epics: none });
      return groups;
    };
    return {
      activeGroups: group(epics.filter((e) => !e.archived_at)),
      archivedGroups: group(epics.filter((e) => !!e.archived_at)),
    };
  }, [epics, milestones, milestoneLookup]);

  if (loading) {
    return <div className="p-10 text-center text-13 text-fg-3">Loading epics...</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      <h2 className="m-0 text-18 font-bold text-fg">
        Epics
        <span className="ml-2 text-12 font-medium text-fg-3">
          {epics.filter((e) => !e.archived_at && e.status !== 'completed').length} active
        </span>
      </h2>

      {activeGroups.length === 0 && (
        <div className="p-10 text-center text-13 text-fg-3">
          No epics outside the archive. Run <code className="font-code text-12">/kickoff</code> to
          create epics.
        </div>
      )}

      {activeGroups.map((group, gi) => (
        <div key={group.milestone?.id ?? `none-${gi}`} className="flex flex-col gap-2.5">
          <div
            className={cx(
              'border-b border-b-line pb-1.5 text-13 font-bold text-fg-2',
              gi > 0 ? 'mt-2' : 'mt-0',
            )}
          >
            {group.milestone ? group.milestone.name : 'No Milestone'}
          </div>

          {group.epics.map((epic) => {
            const progress =
              epic.ticket_count > 0 ? Math.round((epic.done_count / epic.ticket_count) * 100) : 0;
            const progressWidth = `${progress}%`;
            const ms = epic.milestone_id ? milestoneLookup.get(epic.milestone_id) : null;

            return (
              <div
                key={epic.id}
                className="flex overflow-hidden rounded-card border border-line bg-surface"
                style={{ '--c': epic.color } as CSSProperties}
              >
                <div className="w-1.25 shrink-0 bg-(--c)" />
                <div className="flex flex-1 flex-col gap-2 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className="text-14 font-bold text-fg">{epic.name}</span>
                    <StatusBadge status={epic.status} />
                    <span className="rounded-[10px] border border-line bg-surface-2 px-[9px] py-px font-code text-11 font-semibold text-fg-3">
                      {epic.done_count}/{epic.ticket_count} tickets
                    </span>
                    {epic.status === 'completed' && (
                      <ArchiveButton
                        archived={false}
                        busy={busyId === epic.id}
                        onClick={() => toggleArchive(epic)}
                      />
                    )}
                  </div>

                  {epic.description && (
                    <div className="text-[12.5px] leading-[1.5] text-fg-2">{epic.description}</div>
                  )}

                  <div className="mt-0.5 flex items-center gap-2.5">
                    {ms && <span className="shrink-0 font-code text-11 text-fg-3">{ms.name}</span>}
                    <div className="flex flex-1 items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-[4px] bg-surface-3">
                        <div
                          className="h-full rounded-[4px] bg-(--c) [transition:width_.3s_ease]"
                          style={{ width: progressWidth }}
                        />
                      </div>
                      <span className="shrink-0 font-code text-11 font-semibold text-fg-2">
                        {progress}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {archivedGroups.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowArchive(!showArchive)}
            className="w-full cursor-pointer rounded-[8px] border border-line-2 bg-transparent px-4 py-2 text-center font-body text-13 font-medium text-fg-3"
          >
            {showArchive ? 'Hide' : 'Show'} Archive (
            {archivedGroups.reduce((a, g) => a + g.epics.length, 0)} archived epics)
          </button>
          {showArchive && (
            <div className="mt-3 opacity-70">
              {archivedGroups.map((group, gi) => (
                <div key={group.milestone?.id ?? `none-${gi}`} className="flex flex-col gap-2.5">
                  <div
                    className={cx(
                      'border-b border-b-line pb-1.5 text-13 font-bold text-fg-3',
                      gi > 0 ? 'mt-2' : 'mt-0',
                    )}
                  >
                    {group.milestone ? group.milestone.name : 'No Milestone'}
                  </div>
                  {group.epics.map((epic) => {
                    const progress =
                      epic.ticket_count > 0
                        ? Math.round((epic.done_count / epic.ticket_count) * 100)
                        : 0;
                    const progressWidth = `${progress}%`;
                    return (
                      <div
                        key={epic.id}
                        className="flex overflow-hidden rounded-card border border-line bg-surface"
                        style={{ '--c': epic.color } as CSSProperties}
                      >
                        <div className="w-1.25 shrink-0 bg-(--c)" />
                        <div className="flex-1 px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-14 font-semibold text-fg-3">{epic.name}</span>
                            <StatusBadge status={epic.status} />
                            <span className="font-code text-11 text-fg-3">
                              {epic.done_count}/{epic.ticket_count} tickets
                            </span>
                            <ArchiveButton
                              archived
                              busy={busyId === epic.id}
                              onClick={() => toggleArchive(epic)}
                            />
                          </div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-[2px] bg-surface-3">
                              <div
                                className="h-full rounded-[2px] bg-blue"
                                style={{ width: progressWidth }}
                              />
                            </div>
                            <span className="font-code text-11 text-fg-3">{progress}%</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
