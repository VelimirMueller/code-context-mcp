'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { Epic, Milestone } from '@/types';
import { get, post } from '@/lib/api';
import { usePlanningStore } from '@/stores/planningStore';
import { useToastStore } from '@/stores/toastStore';

const statusColors: Record<string, { bg: string; color: string; border: string; label: string }> = {
  active: {
    bg: 'rgba(16,185,129,.10)',
    color: 'var(--green)',
    border: 'rgba(16,185,129,.20)',
    label: 'Active',
  },
  planned: {
    bg: 'rgba(167,139,250,.10)',
    color: 'var(--purple)',
    border: 'rgba(167,139,250,.20)',
    label: 'Planned',
  },
  completed: {
    bg: 'rgba(59,130,246,.10)',
    color: 'var(--blue)',
    border: 'rgba(59,130,246,.20)',
    label: 'Completed',
  },
  archived: {
    bg: 'rgba(107,114,128,.10)',
    color: 'var(--text3)',
    border: 'rgba(107,114,128,.20)',
    label: 'Archived',
  },
};

function StatusBadge({ status }: { status: string }) {
  const s = statusColors[status] ?? statusColors.planned;
  return (
    <span
      style={{
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: 6,
        padding: '2px 9px',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'var(--mono)',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {s.label}
    </span>
  );
}

function ArchiveButton({ archived, busy, onClick }: { archived: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        marginLeft: 'auto',
        background: 'none',
        border: '1px solid var(--border2)',
        borderRadius: 6,
        padding: '2px 10px',
        fontSize: 11,
        fontWeight: 600,
        color: busy ? 'var(--text3)' : 'var(--text2)',
        cursor: busy ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font)',
        flexShrink: 0,
      }}
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
  const toggleArchive = useCallback(async (epic: Epic) => {
    const verb = epic.archived_at ? 'unarchive' : 'archive';
    setBusyId(epic.id);
    try {
      await post(`/api/epic/${epic.id}/${verb}`, {});
      await fetchEpics();
      useToastStore.getState().addToast(verb === 'archive' ? 'Epic archived' : 'Epic restored', 'success');
    } catch (e) {
      useToastStore.getState().addToast((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }, [fetchEpics]);

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
        if (g) { groups.push({ milestone: m, epics: g }); byMilestone.delete(m.id); }
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
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
        Loading epics...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
        Epics
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text3)', marginLeft: 8 }}>
          {epics.filter(e => !e.archived_at && e.status !== 'completed').length} active
        </span>
      </h2>

      {activeGroups.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          No epics outside the archive. Run <code style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>/kickoff</code> to create epics.
        </div>
      )}

      {activeGroups.map((group, gi) => (
        <div key={group.milestone?.id ?? `none-${gi}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--text2)',
              borderBottom: '1px solid var(--border)',
              paddingBottom: 6,
              marginTop: gi > 0 ? 8 : 0,
            }}
          >
            {group.milestone ? group.milestone.name : 'No Milestone'}
          </div>

          {group.epics.map((epic) => {
            const progress = epic.ticket_count > 0 ? Math.round((epic.done_count / epic.ticket_count) * 100) : 0;
            const ms = epic.milestone_id ? milestoneLookup.get(epic.milestone_id) : null;

            return (
              <div
                key={epic.id}
                style={{
                  display: 'flex',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ width: 5, flexShrink: 0, background: epic.color }} />
                <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{epic.name}</span>
                    <StatusBadge status={epic.status} />
                    <span style={{
                      background: 'var(--surface2)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '1px 9px',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'var(--mono)',
                      color: 'var(--text3)',
                    }}>
                      {epic.done_count}/{epic.ticket_count} tickets
                    </span>
                    {epic.status === 'completed' && (
                      <ArchiveButton archived={false} busy={busyId === epic.id} onClick={() => toggleArchive(epic)} />
                    )}
                  </div>

                  {epic.description && (
                    <div style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                      {epic.description}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                    {ms && (
                      <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', flexShrink: 0 }}>
                        {ms.name}
                      </span>
                    )}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--surface3)', overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${progress}%`,
                            height: '100%',
                            borderRadius: 4,
                            background: epic.color,
                            transition: 'width .3s ease',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'var(--mono)', fontWeight: 600, flexShrink: 0 }}>
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
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => setShowArchive(!showArchive)}
            style={{
              width: '100%', background: 'none', border: '1px solid var(--border2)',
              borderRadius: 8, color: 'var(--text3)', fontSize: 13, padding: '8px 16px',
              cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 500, textAlign: 'center',
            }}
          >
            {showArchive ? 'Hide' : 'Show'} Archive ({archivedGroups.reduce((a, g) => a + g.epics.length, 0)} archived epics)
          </button>
          {showArchive && (
            <div style={{ marginTop: 12, opacity: 0.7 }}>
              {archivedGroups.map((group, gi) => (
                <div key={group.milestone?.id ?? `none-${gi}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text3)', borderBottom: '1px solid var(--border)', paddingBottom: 6, marginTop: gi > 0 ? 8 : 0 }}>
                    {group.milestone ? group.milestone.name : 'No Milestone'}
                  </div>
                  {group.epics.map((epic) => {
                    const progress = epic.ticket_count > 0 ? Math.round((epic.done_count / epic.ticket_count) * 100) : 0;
                    return (
                      <div key={epic.id} style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                        <div style={{ width: 5, flexShrink: 0, background: epic.color }} />
                        <div style={{ flex: 1, padding: '12px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text3)' }}>{epic.name}</span>
                            <StatusBadge status={epic.status} />
                            <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{epic.done_count}/{epic.ticket_count} tickets</span>
                            <ArchiveButton archived busy={busyId === epic.id} onClick={() => toggleArchive(epic)} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                            <div style={{ flex: 1, height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${progress}%`, height: '100%', background: 'var(--blue)', borderRadius: 2 }} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{progress}%</span>
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
