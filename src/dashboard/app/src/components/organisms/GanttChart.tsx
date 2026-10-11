'use client';

import React, { useMemo, useState, useEffect } from 'react';
import type { Sprint, Ticket } from '@/types';
import { usePlanningStore } from '@/stores/planningStore';
import { get as apiGet } from '@/lib/api';
import { PHASE_COLORS, PHASE_ORDER, getPhaseStyle, mapLegacyPhase } from '@/lib/phases';

/* ─── Status Styles ────────────────────────────────────────────────────────── */

const ticketStatusColor: Record<string, string> = {
  TODO: '#6b6b84',
  IN_PROGRESS: '#60a5fa',
  DONE: '#10b981',
  BLOCKED: '#f87171',
};

/* ─── Sprint Bar ───────────────────────────────────────────────────────────── */

interface SprintRowProps {
  sprint: Sprint;
  leftPct: number;
  widthPct: number;
  isLast: boolean;
  tickets: Ticket[];
  expanded: boolean;
  onToggle: () => void;
}

function SprintRow({ sprint, leftPct, widthPct, isLast, tickets, expanded, onToggle }: SprintRowProps) {
  const s = getPhaseStyle(sprint.status);
  const done = sprint.velocity_completed ?? 0;
  const committed = sprint.velocity_committed ?? 0;

  // Group tickets by assigned_to for parallel lanes
  const lanes = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const t of tickets) {
      const key = t.assigned_to || 'unassigned';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tickets]);

  const inProgressCount = tickets.filter(t => t.status === 'IN_PROGRESS').length;
  const doneCount = tickets.filter(t => t.status === 'DONE').length;

  return (
    <div style={{ borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
      {/* Sprint header row */}
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '200px 1fr',
          alignItems: 'center',
          gap: 14,
          padding: '8px 0',
          cursor: 'pointer',
        }}
      >
        {/* Label */}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text3)', transition: 'transform .2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sprint.name}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, paddingLeft: 17 }}>
            <span style={{ background: s.bg, border: 'none', borderRadius: 5, fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 7px', color: 'white' }}>
              {s.label}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>
              {done}/{committed}pt
            </span>
            {inProgressCount > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)' }}>
                {inProgressCount} parallel
              </span>
            )}
          </div>
        </div>

        {/* Bar */}
        <div style={{ position: 'relative', height: 28 }}>
          <div style={{ position: 'absolute', inset: '6px 0', background: 'var(--surface3)', borderRadius: 4 }} />
          <div style={{
            position: 'absolute', top: 6, bottom: 6,
            left: `${leftPct}%`, width: `${widthPct}%`,
            background: s.bg, borderRadius: 4, border: `2px solid ${s.border}`,
            transition: 'left .4s ease, width .4s ease',
          }} />
        </div>
      </div>

      {/* Expanded: ticket lanes showing parallel/sequential work */}
      {expanded && lanes.length > 0 && (
        <div style={{ paddingLeft: 17, paddingBottom: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {lanes.length} parallel lanes — {doneCount}/{tickets.length} done
          </div>
          {lanes.map(([member, memberTickets]) => (
            <div key={member} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text2)', width: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {member}
              </span>
              <div style={{ display: 'flex', gap: 3, flex: 1, flexWrap: 'wrap' }}>
                {memberTickets.map((t) => (
                  <div
                    key={t.id}
                    title={`${t.ticket_ref}: ${t.title} (${t.status})`}
                    style={{
                      height: 16, minWidth: 40, maxWidth: 120,
                      borderRadius: 3, fontSize: 9, fontFamily: 'var(--mono)', fontWeight: 600,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 6px',
                      background: `${ticketStatusColor[t.status] ?? '#6b6b84'}20`,
                      color: ticketStatusColor[t.status] ?? 'var(--text3)',
                      border: `1px solid ${ticketStatusColor[t.status] ?? '#6b6b84'}40`,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {t.ticket_ref ?? `#${t.id}`}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Date Axis ────────────────────────────────────────────────────────────── */

function DateAxis({ dateRange }: { dateRange: { start: Date; end: Date } }) {
  const weeks = useMemo(() => {
    const result: Date[] = [];
    const current = new Date(dateRange.start);
    current.setDate(current.getDate() - current.getDay());
    while (current <= dateRange.end) {
      result.push(new Date(current));
      current.setDate(current.getDate() + 7);
    }
    return result;
  }, [dateRange]);

  const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 14, marginBottom: 8 }}>
      <div />
      <div style={{ position: 'relative', height: 28 }}>
        {weeks.map((week, i) => {
          const dayOffset = (week.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
          const leftPct = (dayOffset / totalDays) * 100;
          const isMonthStart = week.getDate() <= 7;
          return (
            <div key={i} style={{ position: 'absolute', left: `${leftPct}%`, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              {isMonthStart && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase' }}>{week.toLocaleDateString('en-US', { month: 'short' })}</span>}
              <div style={{ width: isMonthStart ? 2 : 1, height: isMonthStart ? 8 : 6, background: isMonthStart ? 'var(--text3)' : 'var(--border)', borderRadius: 1 }} />
              {!isMonthStart && <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{week.getDate()}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Current Week Indicator ───────────────────────────────────────────────── */

function CurrentWeekIndicator({ dateRange }: { dateRange: { start: Date; end: Date } }) {
  const now = new Date();
  const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
  const dayOffset = (now.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
  const leftPct = (dayOffset / totalDays) * 100;
  if (leftPct < 0 || leftPct > 100) return null;

  return (
    <div style={{ position: 'absolute', left: `${leftPct}%`, top: 0, bottom: 0, width: 2, background: 'var(--red)', opacity: 0.6, pointerEvents: 'none', zIndex: 2 }}>
      <div style={{ position: 'absolute', top: -8, left: '50%', transform: 'translateX(-50%)', fontSize: 10, fontWeight: 600, color: 'var(--red)', whiteSpace: 'nowrap' }}>
        ● Today
      </div>
    </div>
  );
}

/* ─── Layout Computation ───────────────────────────────────────────────────── */

function computeLayout(sprints: Sprint[]) {
  const hasDates = sprints.some(s => s.start_date && s.end_date);

  if (hasDates) {
    const times = sprints.map(s => ({
      start: s.start_date ? new Date(s.start_date).getTime() : null,
      end: s.end_date ? new Date(s.end_date).getTime() : null,
    }));
    const validStarts = times.map(t => t.start).filter((t): t is number => t !== null);
    const validEnds = times.map(t => t.end).filter((t): t is number => t !== null);
    const minTime = Math.min(...validStarts);
    const maxTime = Math.max(...validEnds);
    const range = maxTime - minTime || 1;
    const dateRange = { start: new Date(minTime), end: new Date(maxTime) };

    const bars = sprints.map((_, i) => {
      const start = times[i].start ?? minTime;
      const end = times[i].end ?? maxTime;
      return { leftPct: ((start - minTime) / range) * 100, widthPct: Math.max(4, ((end - start) / range) * 100) };
    });

    return { bars, dateRange };
  }

  const count = sprints.length || 1;
  const barWidth = Math.min(90 / count, 30);
  const gap = count > 1 ? (100 - barWidth * count) / (count - 1) : 0;
  return {
    bars: sprints.map((_, i) => ({ leftPct: i * (barWidth + gap), widthPct: barWidth })),
    dateRange: { start: new Date(), end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  };
}

/* ─── Sprint Section (reusable for current + archive) ──────────────────────── */

function SprintSection({ title, sprints, defaultExpanded }: { title: string; sprints: Sprint[]; defaultExpanded?: boolean }) {
  const [expandedSprints, setExpandedSprints] = useState<Set<number>>(new Set());
  const [ticketCache, setTicketCache] = useState<Map<number, Ticket[]>>(new Map());

  const layout = useMemo(() => computeLayout(sprints), [sprints]);

  const toggleSprint = async (sprintId: number) => {
    const next = new Set(expandedSprints);
    if (next.has(sprintId)) {
      next.delete(sprintId);
    } else {
      next.add(sprintId);
      if (!ticketCache.has(sprintId)) {
        try {
          const tickets = await apiGet<Ticket[]>(`/api/sprint/${sprintId}/tickets`);
          setTicketCache(prev => new Map(prev).set(sprintId, tickets));
        } catch {
          setTicketCache(prev => new Map(prev).set(sprintId, []));
        }
      }
    }
    setExpandedSprints(next);
  };

  if (sprints.length === 0) return null;

  const statCounts = sprints.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {Object.entries(statCounts).map(([status, count]) => {
            const s = getPhaseStyle(status);
            return (
              <span key={status} style={{ background: s.bg, borderRadius: 6, fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600, padding: '3px 8px', color: 'white' }}>
                {s.label}: {count}
              </span>
            );
          })}
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px', position: 'relative' }}>
        <DateAxis dateRange={layout.dateRange} />
        <div style={{ position: 'relative' }}>
          <CurrentWeekIndicator dateRange={layout.dateRange} />
          {sprints.map((sprint, i) => (
            <SprintRow
              key={sprint.id}
              sprint={sprint}
              leftPct={layout.bars[i]?.leftPct ?? 0}
              widthPct={layout.bars[i]?.widthPct ?? 100}
              isLast={i === sprints.length - 1}
              tickets={ticketCache.get(sprint.id) ?? []}
              expanded={expandedSprints.has(sprint.id)}
              onToggle={() => toggleSprint(sprint.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Main Gantt Chart ─────────────────────────────────────────────────────── */

export function GanttChart() {
  const ganttData = usePlanningStore((s) => s.ganttData);
  const loading = usePlanningStore((s) => s.loading.gantt);
  const [showArchive, setShowArchive] = useState(false);

  const currentSprints = useMemo(
    () => [...ganttData]
      .filter(s => { const p = mapLegacyPhase(s.status); return p === 'planning' || p === 'implementation'; })
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')),
    [ganttData],
  );

  const archivedSprints = useMemo(
    () => [...ganttData]
      .filter(s => { const p = mapLegacyPhase(s.status); return p === 'done' || p === 'rest'; })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 20),
    [ganttData],
  );

  if (loading && ganttData.length === 0) {
    return <div style={{ color: 'var(--text3)', textAlign: 'center', padding: 40, fontSize: 14 }}>Loading Gantt data...</div>;
  }

  if (!loading && ganttData.length === 0) {
    return <div style={{ color: 'var(--text3)', textAlign: 'center', padding: 40, fontSize: 14 }}>No sprint data available.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Sprint Timeline</h2>

      {/* Current sprints */}
      <SprintSection title="Current Sprints" sprints={currentSprints} defaultExpanded />

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {PHASE_ORDER.map(status => {
          const s = getPhaseStyle(status);
          return (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: s.bg, border: `2px solid ${s.border}` }} />
              <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500 }}>{s.label}</span>
            </div>
          );
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: '#60a5fa20', border: '1px solid #60a5fa40' }} />
          <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500 }}>IN_PROGRESS (parallel)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: '#6b6b8420', border: '1px solid #6b6b8440' }} />
          <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500 }}>TODO (sequential/queued)</span>
        </div>
      </div>

      {/* Archive toggle */}
      {archivedSprints.length > 0 && (
        <div>
          <button
            onClick={() => setShowArchive(!showArchive)}
            style={{
              background: 'none', border: '1px solid var(--border2)', borderRadius: 8,
              color: 'var(--text3)', fontSize: 13, padding: '8px 16px', cursor: 'pointer',
              fontFamily: 'var(--font)', fontWeight: 500, width: '100%', textAlign: 'center',
            }}
          >
            {showArchive ? 'Hide' : 'Show'} Archive ({archivedSprints.length} closed sprints)
          </button>

          {showArchive && (
            <div style={{ marginTop: 12, opacity: 0.7 }}>
              <SprintSection title="Archived Sprints" sprints={archivedSprints} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
