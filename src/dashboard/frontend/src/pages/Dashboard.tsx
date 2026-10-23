'use client';

import { useState, useEffect, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSprints } from '@/hooks/useSprints';
import { useAgents } from '@/hooks/useAgents';
import { useSprintStore } from '@/stores/sprintStore';
import { useUIStore } from '@/stores/uiStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { SprintList } from '@/components/organisms/SprintList';
import { SprintDetail } from '@/components/organisms/SprintDetail';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { cx } from '@/lib/utils';
import { pageVariants, pageTransition } from '@/lib/motion';

const DASHBOARD_TABS = [
  { key: 'board', label: 'Board' },
  { key: 'overview', label: 'Overview' },
];

function ActivityFeed() {
  const events = useSprintStore((s) => s.activities);
  const fetchActivities = useSprintStore((s) => s.fetchActivities);
  const loading = events.length === 0;

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  const sprints = useSprintStore((s) => s.sprints);
  const closedCount = sprints.filter((s) => s.status === 'closed' || s.status === 'rest').length;
  const activeCount = sprints.filter((s) => s.status !== 'closed' && s.status !== 'rest').length;
  const totalTickets = sprints.reduce((s, sp) => s + (sp.ticket_count || 0), 0);
  const doneTickets = sprints.reduce((s, sp) => s + (sp.done_count || 0), 0);

  const actionIcon = (action: string) => {
    switch (action) {
      case 'created':
        return '➕';
      case 'status_changed':
        return '🔄';
      case 'updated':
        return '✏️';
      case 'deleted':
        return '🗑️';
      default:
        return '•';
    }
  };

  const actionColor = (action: string) => {
    switch (action) {
      case 'created':
        return '#10b981';
      case 'status_changed':
        return '#60a5fa';
      case 'updated':
        return '#fbbf24';
      case 'deleted':
        return '#f87171';
      default:
        return 'var(--color-fg-3)';
    }
  };

  if (loading) {
    return (
      <div className="p-5">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="mb-2 h-12 rounded-[8px] bg-surface-2 [animation:pulse_1.5s_ease-in-out_infinite]"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-5">
      {/* Summary cards */}
      <div className="mb-5 grid grid-cols-[repeat(4,1fr)] gap-3">
        {[
          { label: 'Sprints Closed', value: closedCount, color: 'text-green' },
          { label: 'Active Sprints', value: activeCount, color: 'text-blue' },
          { label: 'Total Tickets', value: totalTickets, color: 'text-fg' },
          { label: 'Done Tickets', value: doneTickets, color: 'text-green' },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-[8px] border border-line bg-surface p-3.5 text-center"
          >
            <div className="mb-1.5 text-10 font-semibold text-fg-3 uppercase">{card.label}</div>
            <div className={cx('font-code text-[22px] font-bold', card.color)}>
              <AnimatedNumber value={card.value} />
            </div>
          </div>
        ))}
      </div>

      {/* Activity feed */}
      <div className="mb-3 text-14 font-bold text-fg">Recent Activity</div>
      {events.length === 0 ? (
        <div className="p-10 text-center text-13 text-fg-3">
          No activity recorded yet. Events are logged when tickets, sprints, and milestones change
          state.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-start gap-2.5 rounded-[8px] border border-line bg-surface px-3 py-2"
            >
              <span className="mt-0.5 shrink-0 text-14">{actionIcon(e.action)}</span>
              <div className="flex-1">
                <div className="text-12 text-fg">
                  <span
                    className="font-semibold text-(--c)"
                    style={{ '--c': actionColor(e.action) } as CSSProperties}
                  >
                    {e.action}
                  </span>{' '}
                  {e.entity_type} #{e.entity_id}
                  {e.field_name && <span className="text-fg-3"> — {e.field_name}</span>}
                </div>
                {(e.old_value || e.new_value) && (
                  <div className="mt-0.5 font-code text-11 text-fg-3">
                    {e.old_value && <span>{e.old_value}</span>}
                    {e.old_value && e.new_value && <span> → </span>}
                    {e.new_value && <span className="text-fg-2">{e.new_value}</span>}
                  </div>
                )}
              </div>
              <div className="shrink-0 font-code text-10 text-fg-3">
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
      const activeSprint = sprints.find(
        (s) => s.status === 'active' || s.status === 'implementation' || s.status === 'planning',
      );
      if (activeSprint) selectSprint(activeSprint.id);
    }
  }, [sprints, selectedSprintId, selectSprint]);

  const dashTab = ['board', 'overview'].includes(activeTab) ? activeTab : 'board';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SubTabBar tabs={DASHBOARD_TABS} />

      {dashTab === 'board' && (
        <motion.div
          variants={pageVariants}
          initial="initial"
          animate={mounted ? 'animate' : 'initial'}
          transition={pageTransition}
          className="flex flex-1 overflow-hidden"
        >
          <div className="flex w-75 shrink-0 flex-col overflow-hidden border-r border-r-line bg-surface">
            <div className="shrink-0 border-b border-b-line px-4 py-3 text-11 font-semibold tracking-[0.08em] text-fg-3 uppercase">
              Sprints
            </div>
            <SprintList />
          </div>
          <div className="flex flex-1 flex-col overflow-hidden">
            <SprintDetail />
          </div>
        </motion.div>
      )}

      {dashTab === 'overview' && <ActivityFeed />}
    </div>
  );
}
