'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { usePlanningStore } from '@/stores/planningStore';
import { useSprintStore } from '@/stores/sprintStore';
import { useAgentStore } from '@/stores/agentStore';
import { EnhancedGanttChart } from './EnhancedGanttChart';
import { SprintBurndownView } from './SprintBurndownView';
import { EnhancedCapacityView } from './EnhancedCapacityView';
import { SprintTableView } from './SprintTableView';
import { KanbanBoard } from './KanbanBoard';
import type { Ticket } from '@/types';
import { get } from '@/lib/api';
import { Stat } from '@/components/atoms/Stat';
import { StatusBadge } from '@/components/atoms/StatusBadge';
import { Skeleton } from '@/components/atoms/Skeleton';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { getPhaseStyle, mapLegacyPhase } from '@/lib/phases';

type ViewMode = 'overview' | 'gantt' | 'burndown' | 'capacity' | 'table' | 'kanban';

const viewModes: { id: ViewMode; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '\u229e' },
  { id: 'kanban', label: 'Kanban', icon: '\u25a5' },
  { id: 'gantt', label: 'Timeline', icon: '\u25e7' },
  { id: 'burndown', label: 'Burndown', icon: '\u25e2' },
  { id: 'capacity', label: 'Capacity', icon: '\u25d0' },
  { id: 'table', label: 'Data Explorer', icon: '\u2630' },
];

export function PlanningDashboard() {
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [kanbanTickets, setKanbanTickets] = useState<Ticket[]>([]);
  const [loadingKanban, setLoadingKanban] = useState(false);

  const milestones = usePlanningStore((s) => s.milestones);
  const ganttData = usePlanningStore((s) => s.ganttData);
  const backlog = usePlanningStore((s) => s.backlog);
  const loading = usePlanningStore((s) => s.loading);

  const sprints = useSprintStore((s) => s.sprints);
  const selectedSprintId = useSprintStore(s => s.selectedSprintId);
  const agents = useAgentStore((s) => s.agents);

  // Compute planning metrics
  const metrics = useMemo(() => {
    const activeSprints = sprints.filter(s => {
      const phase = mapLegacyPhase(s.status);
      return phase === 'planning' || phase === 'implementation';
    });

    const totalVelocity = activeSprints.reduce((sum, s) => sum + (s.velocity_committed || 0), 0);
    const completedVelocity = activeSprints.reduce((sum, s) => sum + (s.velocity_completed || 0), 0);
    const totalTickets = activeSprints.reduce((sum, s) => sum + (s.ticket_count || 0), 0);
    const doneTickets = activeSprints.reduce((sum, s) => sum + (s.done_count || 0), 0);
    const openBlockers = activeSprints.reduce((sum, s) => sum + (s.open_blockers || 0), 0);

    // Agent capacity
    const availableAgents = agents.filter(a => a.active_tickets < 3);
    const totalCapacity = agents.length * 19;
    const utilizedCapacity = agents.reduce((sum, a) => sum + a.active_points, 0);

    // Backlog metrics
    const backlogPoints = backlog.reduce((sum, t) => sum + (t.story_points || 0), 0);
    const unassignedTickets = backlog.filter(t => !t.assigned_to).length;

    // Milestone progress
    const activeMilestones = milestones.filter(m => m.status === 'in_progress');
    const avgMilestoneProgress = activeMilestones.length > 0
      ? Math.round(activeMilestones.reduce((sum, m) => sum + (m.progress || 0), 0) / activeMilestones.length)
      : 0;

    // Sprint health
    const healthScore = activeSprints.length > 0
      ? Math.round(activeSprints.reduce((sum, s) => {
          const pct = s.velocity_committed > 0 ? (s.velocity_completed || 0) / s.velocity_committed : 0;
          return sum + Math.min(100, pct * 100);
        }, 0) / activeSprints.length)
      : 100;

    return {
      activeSprints: activeSprints.length,
      totalVelocity,
      completedVelocity,
      velocityProgress: totalVelocity > 0 ? Math.round((completedVelocity / totalVelocity) * 100) : 0,
      totalTickets,
      doneTickets,
      ticketProgress: totalTickets > 0 ? Math.round((doneTickets / totalTickets) * 100) : 0,
      openBlockers,
      availableAgents: availableAgents.length,
      totalAgents: agents.length,
      totalCapacity,
      utilizedCapacity,
      capacityUtilization: totalCapacity > 0 ? Math.round((utilizedCapacity / totalCapacity) * 100) : 0,
      backlogCount: backlog.length,
      backlogPoints,
      unassignedTickets,
      activeMilestones: activeMilestones.length,
      avgMilestoneProgress,
      healthScore,
    };
  }, [sprints, agents, backlog, milestones]);

  useEffect(() => {
    if (viewMode !== 'kanban' || !selectedSprintId) return;
    setLoadingKanban(true);
    get<Ticket[]>(`/api/sprint/${selectedSprintId}/tickets`)
      .then(data => setKanbanTickets(Array.isArray(data) ? data : []))
      .catch(() => setKanbanTickets([]))
      .finally(() => setLoadingKanban(false));
  }, [viewMode, selectedSprintId]);

  if (loading.milestones && sprints.length === 0) {
    return <LoadingState />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, height: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: 0, marginBottom: 4 }}>
            Planning Dashboard
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Enterprise sprint planning and capacity management
          </p>
        </div>

        {/* View Mode Selector */}
        <div style={{
          display: 'flex',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 3,
          gap: 2,
        }}>
          {viewModes.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setViewMode(mode.id)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                color: viewMode === mode.id ? '#000' : 'var(--text3)',
                background: viewMode === mode.id ? 'var(--accent)' : 'transparent',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: 'all .15s',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                if (viewMode !== mode.id) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface2)';
                }
              }}
              onMouseLeave={(e) => {
                if (viewMode !== mode.id) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }
              }}
            >
              <span style={{ fontSize: 14 }}>{mode.icon}</span>
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      {/* Overview View */}
      {viewMode === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* KPI Cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 10,
          }}>
            <KPICard
              title="Health Score"
              value={metrics.healthScore}
              suffix="/100"
              subtitle="sprint performance"
              color={metrics.healthScore >= 80 ? '#10b981' : metrics.healthScore >= 50 ? '#fbbf24' : '#f87171'}
              trend={metrics.healthScore >= 80 ? 'on-track' : metrics.healthScore >= 50 ? 'at-risk' : 'off-track'}
            />
            <KPICard
              title="Active Sprints"
              value={metrics.activeSprints}
              subtitle={`${metrics.totalTickets} tickets`}
              color="#60a5fa"
              trend={metrics.activeSprints > 0 ? 'on-track' : 'attention'}
            />
            <KPICard
              title="Velocity"
              value={`${metrics.completedVelocity}/${metrics.totalVelocity}`}
              subtitle={`${metrics.velocityProgress}% complete`}
              color="#10b981"
              trend={metrics.velocityProgress >= 75 ? 'on-track' : metrics.velocityProgress >= 50 ? 'at-risk' : 'off-track'}
            />
            <KPICard
              title="Capacity"
              value={`${metrics.utilizedCapacity}/${metrics.totalCapacity}`}
              subtitle={`${metrics.capacityUtilization}% utilized`}
              color="#fbbf24"
              trend={metrics.capacityUtilization >= 80 ? 'at-risk' : metrics.capacityUtilization >= 50 ? 'on-track' : 'underutilized'}
            />
            <KPICard
              title="Backlog"
              value={metrics.backlogCount}
              subtitle={`${metrics.backlogPoints} points`}
              color="#818cf8"
              trend={metrics.unassignedTickets > 0 ? 'attention' : 'on-track'}
            />
            <KPICard
              title="Blockers"
              value={metrics.openBlockers}
              subtitle="open blockers"
              color={metrics.openBlockers > 0 ? '#f87171' : '#6b6b84'}
              trend={metrics.openBlockers === 0 ? 'on-track' : 'critical'}
            />
            <KPICard
              title="Milestones"
              value={metrics.activeMilestones}
              subtitle={`${metrics.avgMilestoneProgress}% avg progress`}
              color="#ec4899"
              trend={metrics.avgMilestoneProgress >= 50 ? 'on-track' : 'at-risk'}
            />
            <KPICard
              title="Tickets"
              value={`${metrics.doneTickets}/${metrics.totalTickets}`}
              subtitle={`${metrics.ticketProgress}% done`}
              color="#06b6d4"
              trend={metrics.ticketProgress >= 75 ? 'on-track' : metrics.ticketProgress >= 50 ? 'at-risk' : 'off-track'}
            />
          </div>

          {/* Quick navigation cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <NavCard
              title="Sprint Timeline"
              description="Interactive Gantt chart with zoom, swimlanes, and ticket detail"
              icon="\u25e7"
              color="#60a5fa"
              onClick={() => setViewMode('gantt')}
            />
            <NavCard
              title="Burndown Analytics"
              description="Track velocity, predict completion dates, compare sprints"
              icon="\u25e2"
              color="#10b981"
              onClick={() => setViewMode('burndown')}
            />
            <NavCard
              title="Capacity Planning"
              description="Agent workload cards, heatmap matrix, velocity history"
              icon="\u25d0"
              color="#fbbf24"
              onClick={() => setViewMode('capacity')}
            />
            <NavCard
              title="Data Explorer"
              description="Enterprise data tables with sort, filter, and pagination"
              icon="\u2630"
              color="#818cf8"
              onClick={() => setViewMode('table')}
            />
          </div>

          {/* Quick preview row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Mini velocity chart */}
            <div style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 16,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                  Recent Velocity
                </h3>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                  Last {Math.min(8, sprints.filter(s => mapLegacyPhase(s.status) === 'done').length)} sprints
                </span>
              </div>
              {(() => {
                const doneSprints = sprints
                  .filter(s => mapLegacyPhase(s.status) === 'done')
                  .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
                  .slice(-8);
                if (doneSprints.length === 0) return <div style={{ color: 'var(--text3)', fontSize: 12, textAlign: 'center', padding: 20 }}>No completed sprints</div>;
                const maxV = Math.max(...doneSprints.map(s => s.velocity_committed || 0), 1);
                return (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 100 }}>
                    {doneSprints.map(s => {
                      const pct = ((s.velocity_completed || 0) / maxV) * 100;
                      const committed = ((s.velocity_committed || 0) / maxV) * 100;
                      return (
                        <div key={s.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
                            {s.velocity_completed || 0}
                          </span>
                          <div style={{ width: '100%', position: 'relative', height: 70 }}>
                            <div style={{
                              position: 'absolute', bottom: 0, left: 0, right: 0,
                              height: `${committed}%`,
                              background: 'var(--surface3)',
                              borderRadius: 3,
                            }} />
                            <div style={{
                              position: 'absolute', bottom: 0, left: 0, right: 0,
                              height: `${pct}%`,
                              background: pct >= committed * 0.8 ? 'var(--green)' : '#fbbf24',
                              borderRadius: 3,
                              transition: 'height .3s',
                            }} />
                          </div>
                          <span style={{ fontSize: 8, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                            {s.name.slice(0, 8)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Mini agent capacity */}
            <div style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 16,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                  Agent Utilization
                </h3>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {agents.length} agents
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {agents.slice(0, 6).map(agent => {
                  const pct = Math.round((agent.active_points / 19) * 100);
                  const color = pct > 100 ? '#f87171' : pct > 70 ? '#60a5fa' : '#10b981';
                  return (
                    <div key={agent.role} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14 }}>{agent.mood_emoji}</span>
                      <span style={{ fontSize: 11, color: 'var(--text)', width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {agent.name}
                      </span>
                      <div style={{ flex: 1, height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .3s' }} />
                      </div>
                      <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color, fontWeight: 600, width: 36, textAlign: 'right' }}>
                        {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Kanban View */}
      {viewMode === 'kanban' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {loadingKanban ? (
            <div style={{ color: 'var(--text3)', padding: 32, fontSize: 13 }}>Loading…</div>
          ) : (
            <KanbanBoard tickets={kanbanTickets} />
          )}
        </div>
      )}

      {/* Gantt View */}
      {viewMode === 'gantt' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <EnhancedGanttChart />
        </div>
      )}

      {/* Burndown View */}
      {viewMode === 'burndown' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SprintBurndownView />
        </div>
      )}

      {/* Capacity View */}
      {viewMode === 'capacity' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <EnhancedCapacityView />
        </div>
      )}

      {/* Table View */}
      {viewMode === 'table' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SprintTableView />
        </div>
      )}
    </div>
  );
}

/* ─── Subcomponents ─────────────────────────────────────────────────────────── */

interface KPICardProps {
  title: string;
  value: number | string;
  suffix?: string;
  subtitle: string;
  color: string;
  trend: 'on-track' | 'at-risk' | 'off-track' | 'critical' | 'underutilized' | 'attention';
}

function KPICard({ title, value, suffix, subtitle, color, trend }: KPICardProps) {
  const trendConfig = {
    'on-track': { bg: '#10b98120', color: '#10b981', label: 'On Track' },
    'at-risk': { bg: '#fbbf2420', color: '#fbbf24', label: 'At Risk' },
    'off-track': { bg: '#f8717120', color: '#f87171', label: 'Off Track' },
    'critical': { bg: '#dc262620', color: '#dc2626', label: 'Critical' },
    'underutilized': { bg: '#6b6b8420', color: '#6b6b84', label: 'Low' },
    'attention': { bg: '#fbbf2420', color: '#fbbf24', label: 'Attention' },
  }[trend];

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: 14,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {title}
          </span>
          <span style={{
            fontSize: 8,
            fontWeight: 600,
            padding: '2px 5px',
            borderRadius: 4,
            background: trendConfig.bg,
            color: trendConfig.color,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
          }}>
            {trendConfig.label}
          </span>
        </div>
        <span style={{
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--text)',
          fontFamily: 'var(--mono)',
          lineHeight: 1,
        }}>
          {typeof value === 'number' ? <AnimatedNumber value={value} /> : value}
          {suffix && <span style={{ fontSize: 12, opacity: 0.6 }}>{suffix}</span>}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{subtitle}</span>
      </div>
    </div>
  );
}

interface NavCardProps {
  title: string;
  description: string;
  icon: string;
  color: string;
  onClick: () => void;
}

function NavCard({ title, description, icon, color, onClick }: NavCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '16px 20px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        transition: 'all .15s',
        borderLeft: `3px solid ${color}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'var(--surface2)';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'var(--surface)';
        (e.currentTarget as HTMLDivElement).style.transform = 'none';
      }}
    >
      <div style={{
        width: 44,
        height: 44,
        borderRadius: 10,
        background: `${color}15`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 20,
        flexShrink: 0,
        color,
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>{description}</div>
      </div>
      <div style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 16, flexShrink: 0 }}>→</div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Skeleton width={200} height={24} />
        <Skeleton width={400} height={32} />
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 10,
      }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 16,
            height: 90,
          }} />
        ))}
      </div>
    </div>
  );
}
