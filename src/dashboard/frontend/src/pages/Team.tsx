'use client';

import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAgents } from '@/hooks/useAgents';
import { useAgentStore } from '@/stores/agentStore';
import { useUIStore } from '@/stores/uiStore';
import { HeroText } from '@/components/molecules/HeroText';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { TeamGrid } from '@/components/organisms/TeamGrid';
import { tabVariants, tabTransition } from '@/lib/motion';

const TEAM_TABS = [
  { key: 'grid', label: 'Members' },
  { key: 'workload', label: 'Workload' },
  { key: 'mood', label: 'Mood' },
];

function WorkloadView() {
  const agents = useAgentStore((s) => s.agents);
  const maxActive = Math.max(...agents.map((a) => a.active_tickets || 0), 1);

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 text-14 font-bold text-fg">Active Tickets per Agent</div>
      <div className="flex flex-col gap-2">
        {agents.map((a) => {
          const active = a.active_tickets || 0;
          const blocked = a.blocked_tickets || 0;
          const pct = (active / maxActive) * 100;
          const barColor =
            active > 3
              ? 'var(--color-red)'
              : active >= 1
                ? 'var(--color-green)'
                : 'var(--color-fg-3)';
          return (
            <div key={a.role} className="flex items-center gap-3">
              <div className="w-35 overflow-hidden font-code text-12 font-semibold text-ellipsis whitespace-nowrap text-fg-2">
                {a.name}
              </div>
              <div className="h-2 flex-1 overflow-hidden rounded-[4px] bg-line">
                <div
                  className="h-full rounded-[4px] bg-(--c) [transition:width_.3s]"
                  style={{ width: `${pct}%`, '--c': barColor } as CSSProperties}
                />
              </div>
              <div className="w-15 text-right font-code text-11 font-semibold text-fg-3">
                {active}
                {blocked > 0 ? ` (${blocked}B)` : ''}
              </div>
            </div>
          );
        })}
      </div>
      {agents.some((a) => (a.active_tickets || 0) > 3) && (
        <div className="mt-4 rounded-[8px] border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] p-3 text-12 font-semibold text-red">
          Overloaded — {agents.filter((a) => (a.active_tickets || 0) > 3).length} agent(s) with more
          than 3 active tickets.
        </div>
      )}
    </div>
  );
}

function MoodView() {
  const agents = useAgentStore((s) => s.agents);

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 text-14 font-bold text-fg">Team Mood</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
        {agents.map((a) => {
          const moodColor =
            a.mood >= 60
              ? 'var(--color-green)'
              : a.mood >= 40
                ? 'var(--color-orange)'
                : 'var(--color-red)';
          return (
            <div
              key={a.role}
              className="flex items-center gap-2.5 rounded-[8px] border border-line bg-surface p-3"
            >
              <span className="text-[24px]">{a.mood_emoji || '😐'}</span>
              <div className="flex-1">
                <div className="text-12 font-semibold text-fg">{a.name}</div>
                <div className="font-code text-11 text-fg-3">{a.mood_label || a.role}</div>
              </div>
              <div
                className="font-code text-18 font-bold text-(--c)"
                style={{ '--c': moodColor } as CSSProperties}
              >
                {a.mood}
              </div>
            </div>
          );
        })}
      </div>
      {agents.some((a) => a.mood < 40) && (
        <div className="mt-4 rounded-[8px] border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] p-3 text-12 font-semibold text-red">
          Burnout risk detected — {agents.filter((a) => a.mood < 40).length} agent(s) with low mood.
          Reduce workload next sprint.
        </div>
      )}
    </div>
  );
}

export function Team() {
  useAgents();

  const agents = useAgentStore((s) => s.agents);
  const activeTab = useUIStore((s) => s.activeTab);
  const avgMood =
    agents.length > 0 ? Math.round(agents.reduce((sum, a) => sum + a.mood, 0) / agents.length) : 0;
  const totalActive = agents.reduce((sum, a) => sum + (a.active_tickets || 0), 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SubTabBar tabs={TEAM_TABS} />
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          variants={tabVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={tabTransition}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <HeroText>
            <AnimatedNumber value={agents.length} />
            {' agents — '}
            <AnimatedNumber value={totalActive} />
            {' active tickets — mood '}
            <AnimatedNumber value={avgMood} />
          </HeroText>
          {agents.length === 0 ? (
            <div className="p-10 text-center text-14 text-fg-3">
              No agents configured. Use{' '}
              <code className="rounded-[4px] bg-surface px-[6px] py-[2px] font-code">
                reset_agents
              </code>{' '}
              to seed the factory team, or add members with the form above.
            </div>
          ) : (
            <>
              {(activeTab === 'grid' || !['workload', 'mood'].includes(activeTab)) && <TeamGrid />}
              {activeTab === 'workload' && <WorkloadView />}
              {activeTab === 'mood' && <MoodView />}
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
