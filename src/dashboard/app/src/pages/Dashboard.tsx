'use client';

import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSprints } from '@/hooks/useSprints';
import { useAgents } from '@/hooks/useAgents';
import { useSprintStore } from '@/stores/sprintStore';
import { useUIStore } from '@/stores/uiStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { SprintList } from '@/components/organisms/SprintList';
import { SprintDetail } from '@/components/organisms/SprintDetail';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { pageVariants, pageTransition } from '@/lib/motion';

const DASHBOARD_TABS = [
  { key: 'board', label: 'Board' },
  { key: 'overview', label: 'Overview' },
];

function ActivityFeed() {
  const events = useSprintStore((s) => s.activities);
  const fetchActivities = useSprintStore((s) => s.fetchActivities);
  const loading = events.length === 0;

  useEffect(() => { fetchActivities(); }, [fetchActivities]);

  const sprints = useSprintStore((s) => s.sprints);
  const closedCount = sprints.filter((s) => s.status === 'closed' || s.status === 'rest').length;
  const activeCount = sprints.filter((s) => s.status !== 'closed' && s.status !== 'rest').length;
  const totalTickets = sprints.reduce((s, sp) => s + (sp.ticket_count || 0), 0);
  const doneTickets = sprints.reduce((s, sp) => s + (sp.done_count || 0), 0);

  const actionIcon = (action: string) => {
    switch (action) {
      case 'created': return '➕';
      case 'status_changed': return '🔄';
      case 'updated': return '✏️';
      case 'deleted': return '🗑️';
      default: return '•';
    }
  };

  const actionColor = (action: string) => {
    switch (action) {
      case 'created': return '#10b981';
      case 'status_changed': return '#60a5fa';
      case 'updated': return '#fbbf24';
      case 'deleted': return '#f87171';
      default: return 'var(--text3)';
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 20 }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ height: 48, background: 'var(--surface2)', borderRadius: 8, marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Sprints Closed', value: closedCount, color: '#10b981' },
          { label: 'Active Sprints', value: activeCount, color: '#60a5fa' },
          { label: 'Total Tickets', value: totalTickets, color: 'var(--text)' },
          { label: 'Done Tickets', value: doneTickets, color: '#10b981' },
        ].map((card) => (
          <div key={card.label} style={{ padding: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 6 }}>{card.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)', color: card.color }}><AnimatedNumber value={card.value} /></div>
          </div>
        ))}
      </div>

      {/* Activity feed */}
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>Recent Activity</div>
      {events.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          No activity recorded yet. Events are logged when tickets, sprints, and milestones change state.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {events.map((e) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 2 }}>{actionIcon(e.action)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text)' }}>
                  <span style={{ fontWeight: 600, color: actionColor(e.action) }}>{e.action}</span>
                  {' '}{e.entity_type} #{e.entity_id}
                  {e.field_name && <span style={{ color: 'var(--text3)' }}> — {e.field_name}</span>}
                </div>
                {(e.old_value || e.new_value) && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                    {e.old_value && <span>{e.old_value}</span>}
                    {e.old_value && e.new_value && <span> → </span>}
                    {e.new_value && <span style={{ color: 'var(--text2)' }}>{e.new_value}</span>}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', flexShrink: 0 }}>
                {e.created_at?.slice(5, 16)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const activeTab = useUIStore((s) => s.activeTab);

  useSprints();
  useAgents();

  const sprints = useSprintStore((s) => s.sprints);
  const selectedSprintId = useSprintStore((s) => s.selectedSprintId);
  const selectSprint = useSprintStore((s) => s.selectSprint);

  useEffect(() => {
    setMounted(true);
    if (!selectedSprintId && sprints.length > 0) {
      const activeSprint = sprints.find((s) => s.status === 'active' || s.status === 'implementation' || s.status === 'planning');
      if (activeSprint) selectSprint(activeSprint.id);
    }
  }, [sprints, selectedSprintId, selectSprint]);

  const dashTab = ['board', 'overview'].includes(activeTab) ? activeTab : 'board';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SubTabBar tabs={DASHBOARD_TABS} />

      {dashTab === 'board' && (
        <motion.div
          variants={pageVariants}
          initial="initial"
          animate={mounted ? "animate" : "initial"}
          transition={pageTransition}
          style={{ display: 'flex', flex: 1, overflow: 'hidden' }}
        >
          <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>
              Sprints
            </div>
            <SprintList />
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <SprintDetail />
          </div>
        </motion.div>
      )}

      {dashTab === 'overview' && <ActivityFeed />}
    </div>
  );
}
