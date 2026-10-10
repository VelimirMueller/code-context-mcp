'use client';

import { useMemo, useState, useEffect } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { useSprintStore } from '@/stores/sprintStore';
import { usePlanningStore } from '@/stores/planningStore';
import type { Agent, Sprint, Ticket } from '@/types';
import { Skeleton } from '@/components/atoms/Skeleton';
import { get } from '@/lib/api';

interface AgentCapacity {
  agent: Agent;
  activePoints: number;
  assignedTickets: Ticket[];
  utilizationRate: number;
  capacityStatus: 'under' | 'optimal' | 'over';
}

interface CapacityMetric {
  totalCapacity: number;
  allocatedPoints: number;
  availablePoints: number;
  averageUtilization: number;
}

export function CapacityPlanningView() {
  const agents = useAgentStore((s) => s.agents);
  const sprints = useSprintStore((s) => s.sprints);
  const [agentCapacities, setAgentCapacities] = useState<AgentCapacity[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedSprint, setSelectedSprint] = useState<number | null>(null);

  // Get active sprints for filtering
  const activeSprints = useMemo(
    () => sprints.filter(s => s.status === 'active' || s.status === 'planning' || s.status === 'implementation'),
    [sprints]
  );

  useEffect(() => {
    const fetchCapacities = async () => {
      setLoading(true);
      try {
        // Fetch tickets for all active sprints
        const ticketPromises = activeSprints.map(sprint =>
          get<Ticket[]>(`/api/sprint/${sprint.id}/tickets`).catch(() => [])
        );
        const ticketResults = await Promise.all(ticketPromises);
        const allTickets = ticketResults.flat();

        // Group tickets by assigned agent
        const agentMap = new Map<string, Ticket[]>();
        allTickets.forEach(ticket => {
          if (ticket.assigned_to) {
            if (!agentMap.has(ticket.assigned_to)) {
              agentMap.set(ticket.assigned_to, []);
            }
            agentMap.get(ticket.assigned_to)!.push(ticket);
          }
        });

        // Calculate capacity for each agent
        const capacities: AgentCapacity[] = agents.map(agent => {
          const assignedTickets = agentMap.get(agent.role) || [];
          const activePoints = assignedTickets.reduce((sum, t) => sum + (t.story_points || 0), 0);
          const utilizationRate = agent.active_points > 0 ? (activePoints / agent.active_points) * 100 : 0;

          let capacityStatus: 'under' | 'optimal' | 'over' = 'optimal';
          if (utilizationRate < 70) capacityStatus = 'under';
          else if (utilizationRate > 100) capacityStatus = 'over';

          return {
            agent,
            activePoints,
            assignedTickets,
            utilizationRate: Math.round(utilizationRate),
            capacityStatus
          };
        });

        setAgentCapacities(capacities);
      } catch (error) {
        console.error('Failed to fetch capacities:', error);
        setAgentCapacities([]);
      } finally {
        setLoading(false);
      }
    };

    if (agents.length > 0 && activeSprints.length > 0) {
      fetchCapacities();
    } else {
      setLoading(false);
    }
  }, [agents, activeSprints]);

  const metrics = useMemo<CapacityMetric>(() => {
    const totalCapacity = agents.reduce((sum, a) => sum + a.active_points, 0);
    const allocatedPoints = agentCapacities.reduce((sum, ac) => sum + ac.activePoints, 0);
    const availablePoints = totalCapacity - allocatedPoints;
    const averageUtilization = totalCapacity > 0 ? Math.round((allocatedPoints / totalCapacity) * 100) : 0;

    return { totalCapacity, allocatedPoints, availablePoints, averageUtilization };
  }, [agents, agentCapacities]);

  const statusColors = {
    under: { bg: 'rgba(16,185,129,.15)', border: '#10b981', text: '#10b981' },
    optimal: { bg: 'rgba(59,130,246,.15)', border: '#60a5fa', text: '#60a5fa' },
    over: { bg: 'rgba(248,113,113,.15)', border: '#f87171', text: '#f87171' }
  };

  const statusLabels = {
    under: 'Underutilized',
    optimal: 'Optimal',
    over: 'Overloaded'
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
              <Skeleton width={120} height={14} />
              <Skeleton width="100%" height={32} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
              <Skeleton width="100%" height={100} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            Team Capacity Planning
          </h2>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>
            Track agent workload and optimize sprint allocation
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setViewMode('grid')}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              border: '1px solid var(--border)',
              background: viewMode === 'grid' ? 'var(--surface2)' : 'transparent',
              color: 'var(--text)',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'var(--font)'
            }}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode('list')}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              border: '1px solid var(--border)',
              background: viewMode === 'list' ? 'var(--surface2)' : 'transparent',
              color: 'var(--text)',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'var(--font)'
            }}
          >
            List
          </button>
        </div>
      </div>

      {/* Metrics Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard
          label="Total Capacity"
          value={`${metrics.totalCapacity} pts`}
          subtitle={`${agents.length} agents`}
          color="var(--blue)"
          icon={<svg width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>}
        />
        <MetricCard
          label="Allocated"
          value={`${metrics.allocatedPoints} pts`}
          subtitle={`${Math.round(metrics.averageUtilization)}% utilized`}
          color="var(--accent)"
          icon={<svg width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/><polyline points="22 4 12 14.01 9 11.01" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>}
        />
        <MetricCard
          label="Available"
          value={`${metrics.availablePoints} pts`}
          subtitle="for new tickets"
          color="var(--purple)"
          icon={<svg width={16} height={16} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={2} strokeLinecap="round"/><line x1="12" y1="8" x2="12" y2="16" stroke="currentColor" strokeWidth={2} strokeLinecap="round"/><line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth={2} strokeLinecap="round"/></svg>}
        />
        <MetricCard
          label="Health Score"
          value={`${calculateHealthScore(agentCapacities)}/100`}
          subtitle="team balance"
          color={metrics.averageUtilization > 100 ? 'var(--red)' : 'var(--green)'}
          icon={<svg width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>}
        />
      </div>

      {/* Capacity Distribution Bar */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Capacity Distribution</span>
          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            {metrics.allocatedPoints} / {metrics.totalCapacity} pts allocated
          </span>
        </div>
        <div style={{ height: 8, background: 'var(--surface3)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
          {agentCapacities.map((ac, i) => {
            const width = metrics.totalCapacity > 0 ? (ac.activePoints / metrics.totalCapacity) * 100 : 0;
            return (
              <div
                key={ac.agent.role}
                style={{
                  width: `${Math.max(width, 1)}%`,
                  background: statusColors[ac.capacityStatus].border,
                  position: 'relative'
                }}
                title={`${ac.agent.name}: ${ac.activePoints} pts (${ac.utilizationRate}%)`}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: statusColors.under.border }} />
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Underutilized (&lt;70%)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: statusColors.optimal.border }} />
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Optimal (70-100%)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: statusColors.over.border }} />
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Overloaded (&gt;100%)</span>
          </div>
        </div>
      </div>

      {/* Agent Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(320px, 1fr))' : '1fr', gap: 12 }}>
        {agentCapacities.map(capacity => (
          <AgentCapacityCard
            key={capacity.agent.role}
            capacity={capacity}
            colors={statusColors[capacity.capacityStatus]}
            statusLabel={statusLabels[capacity.capacityStatus]}
          />
        ))}
      </div>
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  subtitle: string;
  color: string;
  icon: React.ReactNode;
}

function MetricCard({ label, value, subtitle, color, icon }: MetricCardProps) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '16px 20px',
      borderTop: `3px solid ${color}`
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: `${color}15`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color,
          flexShrink: 0
        }}>
          {icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', lineHeight: 1.2 }}>
            {value}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
        </div>
      </div>
    </div>
  );
}

interface AgentCapacityCardProps {
  capacity: AgentCapacity;
  colors: { bg: string; border: string; text: string };
  statusLabel: string;
}

function AgentCapacityCard({ capacity, colors, statusLabel }: AgentCapacityCardProps) {
  const { agent, activePoints, assignedTickets, utilizationRate, capacityStatus } = capacity;

  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${colors.border}40`,
      borderRadius: 'var(--radius)',
      padding: 16,
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Status indicator bar */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        background: colors.border
      }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: colors.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          flexShrink: 0
        }}>
          {agent.mood_emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
            {agent.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            {agent.role}
          </div>
        </div>
        <div style={{
          padding: '4px 10px',
          borderRadius: 12,
          background: colors.bg,
          border: `1px solid ${colors.border}40`,
          fontSize: 11,
          fontWeight: 600,
          color: colors.text,
          whiteSpace: 'nowrap'
        }}>
          {statusLabel}
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <MetricItem label="Utilization" value={`${utilizationRate}%`} />
        <MetricItem label="Active Points" value={`${activePoints} pts`} />
        <MetricItem label="Assigned" value={`${assignedTickets.length} tickets`} />
        <MetricItem label="Mood" value={agent.mood_emoji} />
      </div>

      {/* Utilization Bar */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Capacity Utilization</span>
          <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: colors.text, fontWeight: 600 }}>
            {utilizationRate}%
          </span>
        </div>
        <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(utilizationRate, 100)}%`,
              height: '100%',
              background: colors.border,
              borderRadius: 3,
              transition: 'width 0.3s ease'
            }}
          />
        </div>
      </div>

      {/* Ticket Preview */}
      {assignedTickets.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
          marginTop: 12
        }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>Active Tickets</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {assignedTickets.slice(0, 3).map(ticket => (
              <div
                key={ticket.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'var(--bg)',
                  fontSize: 11
                }}
              >
                <div style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: ticket.status === 'IN_PROGRESS' ? 'var(--blue)' : 'var(--text3)',
                  flexShrink: 0
                }} />
                <span style={{
                  fontFamily: 'var(--mono)',
                  color: 'var(--text3)',
                  flexShrink: 0,
                  width: 40
                }}>
                  {ticket.ticket_ref}
                </span>
                <span style={{
                  flex: 1,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>
                  {ticket.title}
                </span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--text3)',
                  flexShrink: 0,
                  fontFamily: 'var(--mono)'
                }}>
                  {ticket.story_points || 0}sp
                </span>
              </div>
            ))}
            {assignedTickets.length > 3 && (
              <div style={{
                fontSize: 10,
                color: 'var(--text3)',
                textAlign: 'center',
                padding: '4px 0'
              }}>
                +{assignedTickets.length - 3} more tickets
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
        {value}
      </div>
    </div>
  );
}

function calculateHealthScore(capacities: AgentCapacity[]): number {
  if (capacities.length === 0) return 100;

  const optimalCount = capacities.filter(c => c.capacityStatus === 'optimal').length;
  const underCount = capacities.filter(c => c.capacityStatus === 'under').length;
  const overCount = capacities.filter(c => c.capacityStatus === 'over').length;

  const total = capacities.length;
  const optimalScore = (optimalCount / total) * 100;
  const underPenalty = (underCount / total) * 20;
  const overPenalty = (overCount / total) * 40;

  return Math.max(0, Math.min(100, Math.round(optimalScore - underPenalty - overPenalty)));
}
