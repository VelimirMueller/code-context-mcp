'use client';

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
    <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--text)' }}>Active Tickets per Agent</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {agents.map((a) => {
          const active = a.active_tickets || 0;
          const blocked = a.blocked_tickets || 0;
          const pct = (active / maxActive) * 100;
          const barColor = active > 3 ? '#f87171' : active >= 1 ? 'var(--green)' : 'var(--text3)';
          return (
            <div key={a.role} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 140, fontSize: 12, fontWeight: 600, color: 'var(--text2)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 4, transition: 'width .3s' }} />
              </div>
              <div style={{ width: 60, fontSize: 11, fontWeight: 600, color: 'var(--text3)', fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {active}{blocked > 0 ? ` (${blocked}B)` : ''}
              </div>
            </div>
          );
        })}
      </div>
      {agents.some((a) => (a.active_tickets || 0) > 3) && (
        <div style={{ marginTop: 16, padding: 12, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 8, fontSize: 12, color: '#f87171', fontWeight: 600 }}>
          Overloaded — {agents.filter((a) => (a.active_tickets || 0) > 3).length} agent(s) with more than 3 active tickets.
        </div>
      )}
    </div>
  );
}

function MoodView() {
  const agents = useAgentStore((s) => s.agents);

  return (
    <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--text)' }}>Team Mood</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {agents.map((a) => {
          const moodColor = a.mood >= 60 ? '#10b981' : a.mood >= 40 ? '#fbbf24' : '#f87171';
          return (
            <div key={a.role} style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 24 }}>{a.mood_emoji || '😐'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{a.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{a.mood_label || a.role}</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: moodColor, fontFamily: 'var(--mono)' }}>{a.mood}</div>
            </div>
          );
        })}
      </div>
      {agents.some((a) => a.mood < 40) && (
        <div style={{ marginTop: 16, padding: 12, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 8, fontSize: 12, color: '#f87171', fontWeight: 600 }}>
          Burnout risk detected — {agents.filter((a) => a.mood < 40).length} agent(s) with low mood. Reduce workload next sprint.
        </div>
      )}
    </div>
  );
}

export function Team() {
  useAgents();

  const agents = useAgentStore((s) => s.agents);
  const activeTab = useUIStore((s) => s.activeTab);
  const avgMood = agents.length > 0
    ? Math.round(agents.reduce((sum, a) => sum + a.mood, 0) / agents.length)
    : 0;
  const totalActive = agents.reduce((sum, a) => sum + (a.active_tickets || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SubTabBar tabs={TEAM_TABS} />
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          variants={tabVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={tabTransition}
          style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
          <HeroText>
            <AnimatedNumber value={agents.length} />
            {' agents — '}
            <AnimatedNumber value={totalActive} />
            {' active tickets — mood '}
            <AnimatedNumber value={avgMood} />
          </HeroText>
          {agents.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
              No agents configured. Use <code style={{ fontFamily: 'var(--mono)', background: 'var(--surface)', padding: '2px 6px', borderRadius: 4 }}>reset_agents</code> to seed the factory team, or add members with the form above.
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
