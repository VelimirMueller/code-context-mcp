'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { useSprintStore } from '@/stores/sprintStore';
import { usePlanningStore } from '@/stores/planningStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import type { Agent, Sprint, Ticket } from '@/types';
import { get } from '@/lib/api';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface AgentWorkload {
  agent: Agent;
  activePoints: number;
  maxCapacity: number;
  assignedTickets: Ticket[];
  utilizationRate: number;
  status: 'under' | 'optimal' | 'over';
  trend: 'up' | 'down' | 'stable';
}

interface HeatmapCell {
  agent: string;
  sprint: string;
  points: number;
  maxPoints: number;
  status: string;
}

/* ─── Constants ───────────────────────────────────────────────────────────── */

const STATUS_COLORS = {
  under: { bg: 'rgba(16,185,129,.15)', border: '#10b981', text: '#10b981' },
  optimal: { bg: 'rgba(59,130,246,.15)', border: '#60a5fa', text: '#60a5fa' },
  over: { bg: 'rgba(248,113,113,.15)', border: '#f87171', text: '#f87171' },
};

const STATUS_LABELS = {
  under: 'Underutilized',
  optimal: 'Optimal',
  over: 'Overloaded',
};

const HEATMAP_COLORS = [
  '#10b981', // low
  '#60a5fa', // medium
  '#fbbf24', // high
  '#f87171', // overloaded
];

/* ─── Main Component ──────────────────────────────────────────────────────── */

export function EnhancedCapacityView() {
  const agents = useAgentStore((s) => s.agents);
  const sprints = useSprintStore((s) => s.sprints);
  const [agentWorkloads, setAgentWorkloads] = useState<AgentWorkload[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'cards' | 'heatmap' | 'velocity'>('cards');
  const [heatmapData, setHeatmapData] = useState<HeatmapCell[]>([]);

  // Get recent closed sprints for velocity comparison
  const recentSprints = useMemo(
    () => sprints
      .filter(s => s.status === 'closed' || s.status === 'done' || s.status === 'rest')
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 6),
    [sprints]
  );

  // Get active sprints
  const activeSprints = useMemo(
    () => sprints.filter(s => s.status === 'active' || s.status === 'implementation' || s.status === 'planning'),
    [sprints]
  );

  // Fetch workloads and heatmap data
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        // Fetch tickets for active sprints
        const ticketPromises = activeSprints.map(sprint =>
          get<Ticket[]>(`/api/sprint/${sprint.id}/tickets`).catch(() => [])
        );
        const ticketResults = await Promise.all(ticketPromises);
        const allTickets = ticketResults.flat();

        // Build agent workloads
        const agentMap = new Map<string, Ticket[]>();
        allTickets.forEach(ticket => {
          if (ticket.assigned_to) {
            if (!agentMap.has(ticket.assigned_to)) agentMap.set(ticket.assigned_to, []);
            agentMap.get(ticket.assigned_to)!.push(ticket);
          }
        });

        const maxCapacity = 19; // Standard sprint velocity per agent
        const workloads: AgentWorkload[] = agents.map(agent => {
          const assignedTickets = agentMap.get(agent.role) || [];
          const activePoints = assignedTickets.reduce((sum, t) => sum + (t.story_points || 0), 0);
          const utilizationRate = maxCapacity > 0 ? Math.round((activePoints / maxCapacity) * 100) : 0;
          let status: 'under' | 'optimal' | 'over' = 'optimal';
          if (utilizationRate < 60) status = 'under';
          else if (utilizationRate > 100) status = 'over';

          return { agent, activePoints, maxCapacity, assignedTickets, utilizationRate, status, trend: 'stable' };
        });
        setAgentWorkloads(workloads);

        // Build heatmap data from recent + active sprints
        const allSprintsForHeatmap = [...recentSprints.slice(0, 4), ...activeSprints.slice(0, 2)];
        const heatCells: HeatmapCell[] = [];

        for (const sprint of allSprintsForHeatmap) {
          try {
            const tickets = await get<Ticket[]>(`/api/sprint/${sprint.id}/tickets`).catch(() => []);
            agents.forEach(agent => {
              const agentTickets = tickets.filter(t => t.assigned_to === agent.role);
              const points = agentTickets.reduce((sum, t) => sum + (t.story_points || 0), 0);
              heatCells.push({
                agent: agent.name,
                sprint: sprint.name.slice(0, 18),
                points,
                maxPoints: maxCapacity,
                status: sprint.status,
              });
            });
          } catch { /* ignore */ }
        }
        setHeatmapData(heatCells);
      } catch (error) {
        console.error('Failed to fetch capacity data:', error);
      } finally {
        setLoading(false);
      }
    };

    if (agents.length > 0) {
      fetchData();
    } else {
      setLoading(false);
    }
  }, [agents, activeSprints, recentSprints]);

  // Compute summary metrics
  const metrics = useMemo(() => {
    const totalCapacity = agentWorkloads.reduce((sum, w) => sum + w.maxCapacity, 0);
    const allocated = agentWorkloads.reduce((sum, w) => sum + w.activePoints, 0);
    const avgUtil = totalCapacity > 0 ? Math.round((allocated / totalCapacity) * 100) : 0;
    const overCount = agentWorkloads.filter(w => w.status === 'over').length;
    const underCount = agentWorkloads.filter(w => w.status === 'under').length;
    const optimalCount = agentWorkloads.filter(w => w.status === 'optimal').length;
    return { totalCapacity, allocated, avgUtil, overCount, underCount, optimalCount };
  }, [agentWorkloads]);

  // Health score
  const healthScore = useMemo(() => {
    if (agentWorkloads.length === 0) return 100;
    const { optimalCount, underCount, overCount } = metrics;
    const total = agentWorkloads.length;
    return Math.max(0, Math.min(100, Math.round(
      (optimalCount / total) * 100 - (underCount / total) * 15 - (overCount / total) * 35
    )));
  }, [metrics, agentWorkloads]);

  if (loading) {
    return <CapacitySkeleton />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            Capacity Planning
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            {agents.length} agents, {activeSprints.length} active sprints
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['cards', 'heatmap', 'velocity'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid var(--border)',
                background: viewMode === mode ? 'var(--accent)' : 'var(--surface)',
                color: viewMode === mode ? '#000' : 'var(--text3)',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                textTransform: 'capitalize',
              }}
            >
              {mode === 'heatmap' ? 'Workload Matrix' : mode === 'velocity' ? 'Velocity History' : 'Agent Cards'}
            </button>
          ))}
        </div>
      </div>

      {/* Summary KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KPICard label="Total Capacity" value={`${metrics.totalCapacity} pts`} color="var(--blue)" />
        <KPICard label="Allocated" value={`${metrics.allocated} pts`} color="var(--accent)" />
        <KPICard label="Avg Utilization" value={`${metrics.avgUtil}%`} color={metrics.avgUtil > 100 ? '#f87171' : metrics.avgUtil > 80 ? '#fbbf24' : 'var(--green)'} />
        <KPICard label="Health Score" value={`${healthScore}/100`} color={healthScore >= 80 ? 'var(--green)' : healthScore >= 50 ? '#fbbf24' : '#f87171'} />
        <div style={{ display: 'flex', gap: 8 }}>
          <KPICard label="Optimal" value={metrics.optimalCount} color="#60a5fa" compact />
          <KPICard label="Overloaded" value={metrics.overCount} color="#f87171" compact />
          <KPICard label="Under" value={metrics.underCount} color="#10b981" compact />
        </div>
      </div>

      {/* Capacity distribution bar */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '12px 16px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Team Allocation</span>
          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            {metrics.allocated}/{metrics.totalCapacity} pts ({metrics.avgUtil}%)
          </span>
        </div>
        <div style={{ height: 12, background: 'var(--surface3)', borderRadius: 6, overflow: 'hidden', display: 'flex' }}>
          {agentWorkloads.map((w) => {
            const width = metrics.totalCapacity > 0 ? (w.activePoints / metrics.totalCapacity) * 100 : 0;
            const color = STATUS_COLORS[w.status].border;
            return (
              <div
                key={w.agent.role}
                style={{ width: `${Math.max(width, 0.5)}%`, background: color, position: 'relative' }}
                title={`${w.agent.name}: ${w.activePoints}/${w.maxCapacity} pts (${w.utilizationRate}%)`}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
          {Object.entries(STATUS_COLORS).map(([key, val]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: val.border }} />
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>{STATUS_LABELS[key as keyof typeof STATUS_LABELS]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* View content */}
      {viewMode === 'cards' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {agentWorkloads.map((workload) => (
            <AgentWorkloadCard key={workload.agent.role} workload={workload} />
          ))}
        </div>
      )}

      {viewMode === 'heatmap' && (
        <WorkloadHeatmap agents={agents} data={heatmapData} />
      )}

      {viewMode === 'velocity' && (
        <VelocityHistory sprints={recentSprints} agents={agents} />
      )}
    </div>
  );
}

/* ─── Agent Workload Card ──────────────────────────────────────────────────── */

function AgentWorkloadCard({ workload }: { workload: AgentWorkload }) {
  const { agent, activePoints, maxCapacity, assignedTickets, utilizationRate, status } = workload;
  const colors = STATUS_COLORS[status];

  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${colors.border}30`,
      borderRadius: 10,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Top accent */}
      <div style={{ height: 3, background: colors.border }} />

      <div style={{ padding: 16 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: colors.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            flexShrink: 0,
          }}>
            {agent.mood_emoji}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{agent.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{agent.role}</div>
          </div>
          <span style={{
            padding: '3px 10px',
            borderRadius: 12,
            background: colors.bg,
            border: `1px solid ${colors.border}30`,
            fontSize: 10,
            fontWeight: 600,
            color: colors.text,
            whiteSpace: 'nowrap',
          }}>
            {STATUS_LABELS[status]}
          </span>
        </div>

        {/* Utilization bar */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Capacity</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, color: colors.text }}>
              {activePoints}/{maxCapacity} pts ({utilizationRate}%)
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(utilizationRate, 100)}%`,
              height: '100%',
              background: colors.border,
              borderRadius: 3,
              transition: 'width .3s ease',
            }} />
          </div>
          {/* Overload indicator */}
          {utilizationRate > 100 && (
            <div style={{
              marginTop: 4,
              fontSize: 10,
              color: '#f87171',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f87171' }} />
              Overloaded by {activePoints - maxCapacity} pts
            </div>
          )}
        </div>

        {/* Ticket list */}
        {assignedTickets.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Tickets ({assignedTickets.length})
            </div>
            {assignedTickets.slice(0, 4).map(ticket => (
              <div key={ticket.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                borderRadius: 4,
                marginBottom: 3,
                fontSize: 11,
                background: 'var(--bg)',
              }}>
                <span style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: ticket.status === 'IN_PROGRESS' ? '#60a5fa' : ticket.status === 'DONE' ? '#10b981' : ticket.status === 'BLOCKED' ? '#f87171' : '#6b6b84',
                  flexShrink: 0,
                }} />
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 10, width: 40, flexShrink: 0 }}>
                  {ticket.ticket_ref || `#${ticket.id}`}
                </span>
                <span style={{ flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ticket.title}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
                  {ticket.story_points || 0}sp
                </span>
              </div>
            ))}
            {assignedTickets.length > 4 && (
              <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', padding: '2px 0' }}>
                +{assignedTickets.length - 4} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Workload Heatmap ─────────────────────────────────────────────────────── */

function WorkloadHeatmap({ agents, data }: { agents: Agent[]; data: HeatmapCell[] }) {
  // Get unique sprint names from data
  const sprintNames = [...new Set(data.map(d => d.sprint))].slice(0, 6);
  const agentNames = agents.map(a => a.name);

  if (data.length === 0) {
    return (
      <div style={{
        padding: 40,
        textAlign: 'center',
        color: 'var(--text3)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}>
        No heatmap data available. Close some sprints to see workload history.
      </div>
    );
  }

  const getHeatColor = (points: number, maxPoints: number): string => {
    if (points === 0) return 'var(--surface3)';
    const ratio = points / maxPoints;
    if (ratio <= 0.5) return '#10b98140';
    if (ratio <= 0.8) return '#60a5fa40';
    if (ratio <= 1.0) return '#fbbf2440';
    return '#f8717140';
  };

  const getHeatTextColor = (points: number, maxPoints: number): string => {
    if (points === 0) return 'var(--text3)';
    const ratio = points / maxPoints;
    if (ratio <= 0.5) return '#10b981';
    if (ratio <= 0.8) return '#60a5fa';
    if (ratio <= 1.0) return '#fbbf24';
    return '#f87171';
  };

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Workload Matrix</span>
        <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 12 }}>Agent allocation across recent sprints</span>
      </div>
      <div style={{ overflowX: 'auto', padding: 16 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: 'var(--text3)', fontWeight: 600, borderBottom: '1px solid var(--border)', width: 140 }}>Agent</th>
              {sprintNames.map(name => (
                <th key={name} style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, color: 'var(--text3)', fontWeight: 600, borderBottom: '1px solid var(--border)', minWidth: 80, fontFamily: 'var(--mono)' }}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agentNames.map(agentName => (
              <tr key={agentName}>
                <td style={{ padding: '6px 12px', fontSize: 12, fontWeight: 500, color: 'var(--text)', borderBottom: '1px solid var(--border)' }}>
                  {agentName}
                </td>
                {sprintNames.map(sprintName => {
                  const cell = data.find(d => d.agent === agentName && d.sprint === sprintName);
                  const pts = cell?.points || 0;
                  const max = cell?.maxPoints || 19;
                  return (
                    <td key={sprintName} style={{ padding: '4px', textAlign: 'center', borderBottom: '1px solid var(--border)' }}>
                      <div
                        style={{
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: getHeatColor(pts, max),
                          color: getHeatTextColor(pts, max),
                          fontFamily: 'var(--mono)',
                          fontSize: 12,
                          fontWeight: 600,
                          minWidth: 44,
                        }}
                      >
                        {pts > 0 ? `${pts}` : '-'}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, padding: '8px 16px 12px', borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: 10, color: 'var(--text3)', marginRight: 4 }}>Load:</span>
        {[
          { color: '#10b981', label: '<50%' },
          { color: '#60a5fa', label: '50-80%' },
          { color: '#fbbf24', label: '80-100%' },
          { color: '#f87171', label: '>100%' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: color, opacity: 0.5 }} />
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Velocity History ─────────────────────────────────────────────────────── */

function VelocityHistory({ sprints, agents }: { sprints: Sprint[]; agents: Agent[] }) {
  if (sprints.length === 0) {
    return (
      <div style={{
        padding: 40,
        textAlign: 'center',
        color: 'var(--text3)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}>
        No closed sprints available for velocity history
      </div>
    );
  }

  const maxVelocity = Math.max(...sprints.map(s => s.velocity_committed || 0), 1);

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Sprint Velocity History</span>
        <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 12 }}>Committed vs Completed across recent sprints</span>
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sprints.map(sprint => {
            const committedPct = maxVelocity > 0 ? ((sprint.velocity_committed || 0) / maxVelocity) * 100 : 0;
            const completedPct = maxVelocity > 0 ? ((sprint.velocity_completed || 0) / maxVelocity) * 100 : 0;
            const completionRate = (sprint.velocity_committed || 0) > 0
              ? Math.round(((sprint.velocity_completed || 0) / sprint.velocity_committed) * 100)
              : 0;
            const barColor = completionRate >= 80 ? '#10b981' : completionRate >= 50 ? '#fbbf24' : '#f87171';

            return (
              <div key={sprint.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', width: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sprint.name}
                  </span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                      {sprint.velocity_completed || 0}/{sprint.velocity_committed || 0} pts
                    </span>
                    <span style={{
                      fontSize: 11,
                      fontFamily: 'var(--mono)',
                      fontWeight: 600,
                      color: barColor,
                    }}>
                      {completionRate}%
                    </span>
                  </div>
                </div>
                <div style={{ position: 'relative', height: 10, background: 'var(--surface3)', borderRadius: 5, overflow: 'hidden' }}>
                  {/* Committed bar (background) */}
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: `${committedPct}%`,
                    background: 'var(--border)',
                    borderRadius: 5,
                    opacity: 0.3,
                  }} />
                  {/* Completed bar */}
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: `${completedPct}%`,
                    background: barColor,
                    borderRadius: 5,
                    transition: 'width .3s ease',
                  }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Summary */}
        <div style={{ display: 'flex', gap: 20, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>Avg Velocity</span>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--blue)' }}>
              <AnimatedNumber value={sprints.length > 0 ? Math.round(sprints.reduce((s, sp) => s + (sp.velocity_completed || 0), 0) / sprints.length) : 0} />
            </div>
          </div>
          <div>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>Best Sprint</span>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
              <AnimatedNumber value={Math.max(...sprints.map(s => s.velocity_completed || 0))} />
            </div>
          </div>
          <div>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>Avg Completion</span>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--purple)' }}>
              {sprints.length > 0
                ? Math.round(sprints.reduce((sum, s) => sum + ((s.velocity_committed || 0) > 0 ? ((s.velocity_completed || 0) / s.velocity_committed) * 100 : 0), 0) / sprints.length)
                : 0}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Helper Components ────────────────────────────────────────────────────── */

function KPICard({ label, value, color, compact }: { label: string; value: string | number; color: string; compact?: boolean }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: compact ? '8px 12px' : '12px 16px',
      borderTop: `2px solid ${color}`,
      flex: compact ? 1 : undefined,
    }}>
      <div style={{ fontSize: compact ? 9 : 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: compact ? 14 : 18, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
        {value}
      </div>
    </div>
  );
}

function CapacitySkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, height: 80 }} />
        ))}
      </div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, height: 200 }} />
    </div>
  );
}
