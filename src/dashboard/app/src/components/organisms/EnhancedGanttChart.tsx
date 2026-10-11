'use client';

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Sprint, Ticket, Milestone } from '@/types';
import { usePlanningStore } from '@/stores/planningStore';
import { useSprintStore } from '@/stores/sprintStore';
import { get as apiGet } from '@/lib/api';
import { PHASE_COLORS, getPhaseStyle, mapLegacyPhase } from '@/lib/phases';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';

/* ─── Constants ───────────────────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  TODO: '#6b6b84',
  IN_PROGRESS: '#60a5fa',
  DONE: '#10b981',
  BLOCKED: '#f87171',
  PARTIAL: '#fbbf24',
};

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 50;
const LABEL_WIDTH = 220;
const MILESTONE_ROW_HEIGHT = 28;
const MIN_DAY_WIDTH = 16;
const MAX_DAY_WIDTH = 60;

type ZoomLevel = 'sprint' | 'week' | 'month';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface DayInfo {
  date: Date;
  isWeekend: boolean;
  isToday: boolean;
  isMonthStart: boolean;
  label: string;
  dayOfWeek: number;
}

interface GanttSprint extends Sprint {
  milestoneName?: string;
  milestoneColor?: string;
}

/* ─── Date Utilities ──────────────────────────────────────────────────────── */

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (86400000));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDayInfo(date: Date): DayInfo {
  const dayOfWeek = date.getDay();
  return {
    date: new Date(date),
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    isToday: formatDate(date) === formatDate(new Date()),
    isMonthStart: date.getDate() <= 3 && dayOfWeek === 1,
    label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    dayOfWeek,
  };
}

/* ─── Zoom Presets ─────────────────────────────────────────────────────────── */

const ZOOM_PRESETS: Record<ZoomLevel, number> = {
  sprint: 40,
  week: 28,
  month: 16,
};

/* ─── Main Component ──────────────────────────────────────────────────────── */

export function EnhancedGanttChart() {
  const ganttData = usePlanningStore((s) => s.ganttData);
  const loading = usePlanningStore((s) => s.loading.gantt);
  const milestones = usePlanningStore((s) => s.milestones);
  const [zoom, setZoom] = useState<ZoomLevel>('week');
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [expandedSprints, setExpandedSprints] = useState<Set<number>>(new Set());
  const [ticketCache, setTicketCache] = useState<Map<number, Ticket[]>>(new Map());
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);

  const dayWidth = ZOOM_PRESETS[zoom];

  // Enrich sprints with milestone data
  const enrichedSprints = useMemo<GanttSprint[]>(() => {
    return ganttData.map((s) => {
      const ms = milestones.find((m) => m.id === s.milestone_id);
      return {
        ...s,
        milestoneName: ms?.name,
        milestoneColor: ms?.status === 'completed' ? '#10b981' : ms?.status === 'in_progress' ? '#60a5fa' : '#818cf8',
      };
    });
  }, [ganttData, milestones]);

  // Sort: active first (by start_date), then closed (by end_date desc)
  const sortedSprints = useMemo(() => {
    return [...enrichedSprints].sort((a, b) => {
      const aPhase = mapLegacyPhase(a.status);
      const bPhase = mapLegacyPhase(b.status);
      const phaseOrder: Record<string, number> = { planning: 0, implementation: 1, done: 2, rest: 3 };
      if (phaseOrder[aPhase] !== phaseOrder[bPhase]) return (phaseOrder[aPhase] ?? 2) - (phaseOrder[bPhase] ?? 2);
      return (a.created_at || '').localeCompare(b.created_at || '');
    });
  }, [enrichedSprints]);

  // Compute date range
  const dateRange = useMemo(() => {
    const dates = sortedSprints
      .filter(s => s.start_date && s.end_date)
      .flatMap(s => [new Date(s.start_date!), new Date(s.end_date!)]);
    if (dates.length === 0) {
      const now = new Date();
      return { start: addDays(now, -14), end: addDays(now, 30) };
    }
    const start = new Date(Math.min(...dates.map(d => d.getTime())));
    const end = new Date(Math.max(...dates.map(d => d.getTime())));
    return { start: addDays(start, -3), end: addDays(end, 5) };
  }, [sortedSprints]);

  // Build day columns
  const days = useMemo(() => {
    const result: DayInfo[] = [];
    let current = dateRange.start;
    while (current <= dateRange.end) {
      result.push(getDayInfo(current));
      current = addDays(current, 1);
    }
    return result;
  }, [dateRange]);

  const totalDays = days.length;
  const timelineWidth = totalDays * dayWidth;

  // Toggle sprint expansion
  const toggleSprint = useCallback(async (sprintId: number) => {
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
  }, [expandedSprints, ticketCache]);

  if (loading && ganttData.length === 0) {
    return <GanttSkeleton />;
  }

  if (!loading && ganttData.length === 0) {
    return <EmptyState />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
            Sprint Timeline
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            {sortedSprints.length} sprints, {totalDays} days
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Zoom Controls */}
          <div style={{
            display: 'flex',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'hidden',
          }}>
            {(['sprint', 'week', 'month'] as ZoomLevel[]).map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                style={{
                  padding: '5px 12px',
                  fontSize: 11,
                  fontWeight: 600,
                  border: 'none',
                  background: zoom === z ? 'var(--accent)' : 'transparent',
                  color: zoom === z ? '#000' : 'var(--text3)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font)',
                  textTransform: 'capitalize',
                }}
              >
                {z}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {['planning', 'implementation', 'done', 'rest'].map(status => {
          const s = PHASE_COLORS[status];
          if (!s) return null;
          return (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: s.bg, border: `2px solid ${s.border}` }} />
              <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 500 }}>{s.label}</span>
            </div>
          );
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 12, height: 2, background: 'var(--red)', opacity: 0.6 }} />
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 500 }}>Today</span>
        </div>
      </div>

      {/* Gantt Chart Container */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}>
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 600 }}>
          <div style={{ minWidth: LABEL_WIDTH + timelineWidth, position: 'relative' }}>
            {/* Header Row - Dates */}
            <div style={{
              position: 'sticky',
              top: 0,
              zIndex: 10,
              background: 'var(--surface)',
              borderBottom: '2px solid var(--border)',
              height: HEADER_HEIGHT,
              display: 'flex',
            }}>
              {/* Label column header */}
              <div style={{
                width: LABEL_WIDTH,
                flexShrink: 0,
                padding: '8px 16px',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text3)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                display: 'flex',
                alignItems: 'flex-end',
                position: 'sticky',
                left: 0,
                background: 'var(--surface)',
                zIndex: 11,
                borderRight: '1px solid var(--border)',
              }}>
                Sprint
              </div>
              {/* Date columns */}
              <div style={{ position: 'relative', height: HEADER_HEIGHT }}>
                {days.map((day, i) => (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: i * dayWidth,
                      width: dayWidth,
                      height: HEADER_HEIGHT,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      paddingBottom: 6,
                      background: day.isToday ? 'var(--accent)08' : day.isWeekend ? 'var(--surface3)40' : 'transparent',
                      borderLeft: day.dayOfWeek === 1 ? '1px solid var(--border)' : 'none',
                    }}
                    onMouseEnter={() => setHoveredDate(formatDate(day.date))}
                    onMouseLeave={() => setHoveredDate(null)}
                  >
                    {zoom !== 'month' && (
                      <span style={{
                        fontSize: day.isToday ? 10 : 9,
                        color: day.isToday ? 'var(--accent)' : day.isWeekend ? 'var(--text3)' : 'var(--text3)',
                        fontWeight: day.isToday ? 700 : 400,
                        fontFamily: 'var(--mono)',
                      }}>
                        {day.date.getDate()}
                      </span>
                    )}
                    {day.isMonthStart && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--text2)',
                      }}>
                        {day.date.toLocaleDateString('en-US', { month: 'short' })}
                      </span>
                    )}
                  </div>
                ))}
                {/* Today line marker */}
                {(() => {
                  const today = new Date();
                  const todayIdx = daysBetween(dateRange.start, today);
                  if (todayIdx >= 0 && todayIdx < totalDays) {
                    return (
                      <div style={{
                        position: 'absolute',
                        left: todayIdx * dayWidth + dayWidth / 2,
                        top: 0,
                        width: 2,
                        height: HEADER_HEIGHT,
                        background: 'var(--red)',
                        opacity: 0.7,
                        zIndex: 2,
                      }} />
                    );
                  }
                  return null;
                })()}
              </div>
            </div>

            {/* Sprint Rows */}
            {sortedSprints.map((sprint, sprintIdx) => (
              <GanttSprintRow
                key={sprint.id}
                sprint={sprint}
                days={days}
                dateRange={dateRange}
                dayWidth={dayWidth}
                expanded={expandedSprints.has(sprint.id)}
                selected={selectedSprintId === sprint.id}
                tickets={ticketCache.get(sprint.id) ?? []}
                onToggle={() => toggleSprint(sprint.id)}
                onSelect={() => setSelectedSprintId(selectedSprintId === sprint.id ? null : sprint.id)}
                isLast={sprintIdx === sortedSprints.length - 1}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Stats Footer */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MiniStat
          label="Total Sprints"
          value={sortedSprints.length}
          color="var(--blue)"
        />
        <MiniStat
          label="Active"
          value={sortedSprints.filter(s => { const p = mapLegacyPhase(s.status); return p === 'planning' || p === 'implementation'; }).length}
          color="var(--accent)"
        />
        <MiniStat
          label="Completed"
          value={sortedSprints.filter(s => mapLegacyPhase(s.status) === 'done').length}
          color="var(--accent)"
        />
        <MiniStat
          label="Total Velocity"
          value={sortedSprints.reduce((s, sp) => s + (sp.velocity_completed || 0), 0)}
          color="var(--purple)"
          suffix=" pts"
        />
      </div>
    </div>
  );
}

/* ─── Sprint Row ───────────────────────────────────────────────────────────── */

interface GanttSprintRowProps {
  sprint: GanttSprint;
  days: DayInfo[];
  dateRange: { start: Date; end: Date };
  dayWidth: number;
  expanded: boolean;
  selected: boolean;
  tickets: Ticket[];
  onToggle: () => void;
  onSelect: () => void;
  isLast: boolean;
}

function GanttSprintRow({
  sprint, days, dateRange, dayWidth, expanded, selected, tickets, onToggle, onSelect, isLast,
}: GanttSprintRowProps) {
  const phase = getPhaseStyle(sprint.status);
  const totalDays = days.length;
  const timelineWidth = totalDays * dayWidth;

  // Calculate bar position
  const bar = useMemo(() => {
    if (!sprint.start_date || !sprint.end_date) {
      // Fallback: use created_at as approximate start, 14 days duration
      const created = sprint.created_at ? new Date(sprint.created_at) : new Date();
      const startOff = daysBetween(dateRange.start, created);
      const endOff = startOff + 14;
      return {
        left: Math.max(0, startOff) * dayWidth,
        width: 14 * dayWidth,
        startIdx: startOff,
        endIdx: endOff,
      };
    }
    const startOff = daysBetween(dateRange.start, new Date(sprint.start_date));
    const endOff = daysBetween(dateRange.start, new Date(sprint.end_date));
    const left = Math.max(0, startOff) * dayWidth;
    const width = Math.max(dayWidth * 3, (endOff - startOff) * dayWidth);
    return { left, width, startIdx: startOff, endIdx: endOff };
  }, [sprint, dateRange, dayWidth]);

  // Group tickets by assignee
  const lanes = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const t of tickets) {
      const key = t.assigned_to || 'unassigned';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tickets]);

  const velocityPct = sprint.velocity_committed > 0
    ? Math.round(((sprint.velocity_completed || 0) / sprint.velocity_committed) * 100)
    : 0;

  return (
    <div style={{ borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
      {/* Main sprint row */}
      <div
        style={{
          display: 'flex',
          height: ROW_HEIGHT,
          cursor: 'pointer',
          background: selected ? 'var(--surface2)' : 'transparent',
          transition: 'background .15s',
        }}
        onClick={() => { onSelect(); onToggle(); }}
        onMouseEnter={(e) => {
          if (!selected) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface2)';
        }}
        onMouseLeave={(e) => {
          if (!selected) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
        }}
      >
        {/* Label */}
        <div style={{
          width: LABEL_WIDTH,
          flexShrink: 0,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          position: 'sticky',
          left: 0,
          background: 'inherit',
          zIndex: 5,
          borderRight: '1px solid var(--border)',
          overflow: 'hidden',
        }}>
          <span style={{
            fontSize: 10,
            transition: 'transform .2s',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            color: 'var(--text3)',
            flexShrink: 0,
          }}>▶</span>
          {sprint.milestoneName && (
            <span style={{
              width: 4,
              height: 16,
              borderRadius: 2,
              background: sprint.milestoneColor || 'var(--purple)',
              flexShrink: 0,
            }} />
          )}
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {sprint.name}
          </span>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <span style={{
              background: phase.bg,
              borderRadius: 4,
              fontSize: 9,
              fontFamily: 'var(--mono)',
              fontWeight: 600,
              padding: '1px 6px',
              color: 'white',
            }}>
              {phase.label}
            </span>
          </div>
        </div>

        {/* Timeline area */}
        <div style={{ position: 'relative', width: timelineWidth, height: ROW_HEIGHT }}>
          {/* Weekend shading */}
          {days.map((day, i) => day.isWeekend ? (
            <div key={i} style={{
              position: 'absolute',
              left: i * dayWidth,
              width: dayWidth,
              top: 0,
              bottom: 0,
              background: 'var(--surface3)30',
            }} />
          ) : null)}

          {/* Today line */}
          {(() => {
            const today = new Date();
            const todayIdx = daysBetween(dateRange.start, today);
            if (todayIdx >= 0 && todayIdx < totalDays) {
              return (
                <div style={{
                  position: 'absolute',
                  left: todayIdx * dayWidth + dayWidth / 2 - 1,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--red)',
                  opacity: 0.5,
                  zIndex: 3,
                  pointerEvents: 'none',
                }} />
              );
            }
            return null;
          })()}

          {/* Sprint bar */}
          <div style={{
            position: 'absolute',
            top: 8,
            bottom: 8,
            left: bar.left,
            width: bar.width,
            borderRadius: 5,
            background: `${phase.bg}30`,
            border: `2px solid ${phase.bg}`,
            overflow: 'hidden',
            zIndex: 1,
            transition: 'left .3s ease, width .3s ease',
          }}>
            {/* Velocity progress fill */}
            {sprint.velocity_committed > 0 && (
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${Math.min(100, velocityPct)}%`,
                background: `${phase.bg}50`,
                borderRadius: 'inherit',
                transition: 'width .4s ease',
              }} />
            )}
            {/* Bar label */}
            {bar.width > 60 && (
              <div style={{
                position: 'relative',
                zIndex: 1,
                padding: '0 8px',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10,
                fontFamily: 'var(--mono)',
                fontWeight: 600,
                color: phase.bg,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}>
                <span>{sprint.velocity_completed || 0}/{sprint.velocity_committed || 0}pt</span>
                {sprint.ticket_count > 0 && <span style={{ opacity: 0.7 }}>{sprint.done_count}/{sprint.ticket_count}t</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expanded: ticket swimlanes */}
      <AnimatePresence>
        {expanded && lanes.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ paddingLeft: LABEL_WIDTH, position: 'relative' }}>
              {/* Ticket lane rows */}
              {lanes.map(([member, memberTickets]) => (
                <div
                  key={member}
                  style={{
                    display: 'flex',
                    height: 26,
                    alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    position: 'relative',
                  }}
                >
                  {/* Member label (overlaid on left) */}
                  <div style={{
                    position: 'absolute',
                    left: -LABEL_WIDTH,
                    width: LABEL_WIDTH,
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    paddingLeft: 32,
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'var(--text2)',
                    zIndex: 5,
                    background: 'var(--bg)',
                  }}>
                    {member}
                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>({memberTickets.length})</span>
                  </div>

                  {/* Ticket bars in timeline */}
                  {memberTickets.map((t, ti) => {
                    const color = STATUS_COLORS[t.status] || '#6b6b84';
                    return (
                      <div
                        key={t.id}
                        title={`${t.ticket_ref}: ${t.title} (${t.status})`}
                        style={{
                          position: 'relative',
                          display: 'inline-flex',
                          alignItems: 'center',
                          height: 18,
                          minWidth: 24,
                          maxWidth: 100,
                          marginLeft: ti === 0 ? 8 : 3,
                          padding: '0 6px',
                          borderRadius: 3,
                          fontSize: 9,
                          fontFamily: 'var(--mono)',
                          fontWeight: 600,
                          background: `${color}20`,
                          color,
                          border: `1px solid ${color}40`,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          cursor: 'default',
                        }}
                      >
                        {t.ticket_ref || `#${t.id}`}
                        {t.story_points ? ` ${t.story_points}sp` : ''}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Mini Stat ────────────────────────────────────────────────────────────── */

function MiniStat({ label, value, color, suffix = '' }: { label: string; value: number; color: string; suffix?: string }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '10px 14px',
      borderTop: `2px solid ${color}`,
    }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
        <AnimatedNumber value={value} />{suffix}
      </div>
    </div>
  );
}

/* ─── Skeleton / Empty ─────────────────────────────────────────────────────── */

function GanttSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 16 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ height: 14, width: 80, background: 'var(--surface3)', borderRadius: 4 }} />
        ))}
      </div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
            <div style={{ width: LABEL_WIDTH, height: ROW_HEIGHT - 8, background: 'var(--surface3)', borderRadius: 4 }} />
            <div style={{ flex: 1, height: ROW_HEIGHT - 8, background: 'var(--surface3)', borderRadius: 4 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{
      padding: 60,
      textAlign: 'center',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
    }}>
      <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}></div>
      <div style={{ fontSize: 14, color: 'var(--text3)', marginBottom: 4 }}>No sprint data available</div>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Create sprints to see them on the timeline</div>
    </div>
  );
}
