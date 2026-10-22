'use client';

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSprints } from '@/hooks/useSprints';
import { useSprintStore } from '@/stores/sprintStore';
import { useUIStore } from '@/stores/uiStore';
import { HeroText } from '@/components/molecules/HeroText';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { BentoGrid } from '@/components/organisms/BentoGrid';
import { tabVariants, tabTransition } from '@/lib/motion';

const RETRO_TABS = [
  { key: 'insights', label: 'Findings' },
  { key: 'history', label: 'History' },
  { key: 'patterns', label: 'Patterns' },
];

function HistoryView() {
  const allFindings = useSprintStore((s) => s.allRetroFindings);
  const fetchAllRetro = useSprintStore((s) => s.fetchAllRetro);

  useEffect(() => {
    fetchAllRetro();
  }, [fetchAllRetro]);

  const byCategory = (cat: string) => allFindings.filter((f) => f.category === cat);
  const categories = [
    { key: 'went_well', label: 'Went Well', color: '#10b981' },
    { key: 'went_wrong', label: 'Went Wrong', color: '#f87171' },
    { key: 'try_next', label: 'Try Next', color: '#818cf8' },
  ];

  if (allFindings.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
        No retro findings yet.
      </div>
    );
  }

  return (
    <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
      {categories.map(({ key, label, color }) => {
        const items = byCategory(key);
        if (items.length === 0) return null;
        return (
          <div key={key} style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
              {label} ({items.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.slice(0, 20).map((f) => (
                <div
                  key={f.id}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--text2)',
                    lineHeight: 1.5,
                  }}
                >
                  {f.finding}
                  {f.sprint_name && (
                    <span
                      style={{
                        fontSize: 10,
                        color: 'var(--text3)',
                        marginLeft: 8,
                        fontFamily: 'var(--mono)',
                      }}
                    >
                      — {f.sprint_name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PatternsView() {
  const allFindings = useSprintStore((s) => s.allRetroFindings);
  const fetchAllRetro = useSprintStore((s) => s.fetchAllRetro);

  useEffect(() => {
    fetchAllRetro();
  }, [fetchAllRetro]);

  const userFindings = allFindings.filter((f) => f.category !== 'auto_analysis');

  if (userFindings.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
        No retro findings yet. Complete a sprint to see patterns.
      </div>
    );
  }

  // Group by sprint
  const bySprint = new Map<string, typeof userFindings>();
  for (const f of userFindings) {
    const key = f.sprint_name ?? 'Unknown Sprint';
    if (!bySprint.has(key)) bySprint.set(key, []);
    bySprint.get(key)!.push(f);
  }

  // Category counts across all sprints
  const totalWell = userFindings.filter((f) => f.category === 'went_well').length;
  const totalWrong = userFindings.filter((f) => f.category === 'went_wrong').length;
  const totalTry = userFindings.filter((f) => f.category === 'try_next').length;
  const total = userFindings.length;

  // Recurring patterns: findings that share significant keywords across multiple sprints
  const wordFreq = new Map<string, Set<string>>();
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'is',
    'was',
    'are',
    'were',
    'it',
    'this',
    'that',
    'we',
    'not',
    'no',
    'be',
    'have',
    'had',
    'has',
  ]);
  for (const f of userFindings) {
    const sprint = f.sprint_name ?? 'Unknown';
    const words = f.finding
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(' ')
      .filter((w) => w.length > 4 && !stopWords.has(w));
    for (const word of words) {
      if (!wordFreq.has(word)) wordFreq.set(word, new Set());
      wordFreq.get(word)!.add(sprint);
    }
  }
  const recurring = [...wordFreq.entries()]
    .filter(([, sprints]) => sprints.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8);

  const catColor: Record<string, string> = {
    went_well: '#10b981',
    went_wrong: '#f87171',
    try_next: '#818cf8',
  };
  const catLabel: Record<string, string> = {
    went_well: 'Went Well',
    went_wrong: 'Went Wrong',
    try_next: 'Try Next',
  };

  return (
    <div
      style={{
        padding: 20,
        overflowY: 'auto',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {/* Health bar */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '14px 18px',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text3)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 10,
          }}
        >
          Cumulative Health — {bySprint.size} sprint{bySprint.size !== 1 ? 's' : ''}, {total}{' '}
          findings
        </div>
        <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2 }}>
          {totalWell > 0 && (
            <div
              style={{ flex: totalWell, background: '#10b981', borderRadius: 5 }}
              title={`${totalWell} went well`}
            />
          )}
          {totalTry > 0 && (
            <div
              style={{ flex: totalTry, background: '#818cf8', borderRadius: 5 }}
              title={`${totalTry} try next`}
            />
          )}
          {totalWrong > 0 && (
            <div
              style={{ flex: totalWrong, background: '#f87171', borderRadius: 5 }}
              title={`${totalWrong} went wrong`}
            />
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
          {[
            ['went_well', totalWell],
            ['try_next', totalTry],
            ['went_wrong', totalWrong],
          ].map(([cat, count]) => (
            <span
              key={cat as string}
              style={{ fontSize: 11, color: catColor[cat as string], fontFamily: 'var(--mono)' }}
            >
              {count} {catLabel[cat as string]}
            </span>
          ))}
        </div>
      </div>

      {/* Recurring keywords */}
      {recurring.length > 0 && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '14px 18px',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--text3)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 10,
            }}
          >
            Recurring Themes
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {recurring.map(([word, sprints]) => (
              <span
                key={word}
                style={{
                  background: 'rgba(99,102,241,.12)',
                  border: '1px solid rgba(99,102,241,.25)',
                  color: '#818cf8',
                  borderRadius: 20,
                  padding: '3px 10px',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                }}
              >
                {word} <span style={{ opacity: 0.6 }}>×{sprints.size}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Sprint-by-sprint breakdown */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '14px 18px',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text3)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 12,
          }}
        >
          Sprint Breakdown
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[...bySprint.entries()].map(([sprintName, findings]) => {
            const well = findings.filter((f) => f.category === 'went_well').length;
            const wrong = findings.filter((f) => f.category === 'went_wrong').length;
            const tryN = findings.filter((f) => f.category === 'try_next').length;
            return (
              <div key={sprintName}>
                <div
                  style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 5 }}
                >
                  {sprintName}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {findings
                    .filter((f) => f.category !== 'auto_analysis')
                    .map((f) => (
                      <div
                        key={f.id}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--surface2)',
                          borderLeft: `3px solid ${catColor[f.category] ?? '#888'}`,
                          fontSize: 12,
                          color: 'var(--text2)',
                          lineHeight: 1.4,
                        }}
                      >
                        {f.finding}
                      </div>
                    ))}
                  <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                    {well > 0 && (
                      <span style={{ fontSize: 10, color: '#10b981', fontFamily: 'var(--mono)' }}>
                        ✓ {well} well
                      </span>
                    )}
                    {wrong > 0 && (
                      <span style={{ fontSize: 10, color: '#f87171', fontFamily: 'var(--mono)' }}>
                        ✗ {wrong} wrong
                      </span>
                    )}
                    {tryN > 0 && (
                      <span style={{ fontSize: 10, color: '#818cf8', fontFamily: 'var(--mono)' }}>
                        → {tryN} try
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function Retro() {
  useSprints();

  const allRetroFindings = useSprintStore((s) => s.allRetroFindings);
  const sprints = useSprintStore((s) => s.sprints);
  const activeTab = useUIStore((s) => s.activeTab);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SubTabBar tabs={RETRO_TABS} />
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
            <AnimatedNumber value={allRetroFindings.length} />
            {' findings across '}
            <AnimatedNumber value={sprints.length} />
            {" sprints — here's what we learned"}
          </HeroText>

          {(activeTab === 'insights' || !['history', 'patterns'].includes(activeTab)) && (
            <BentoGrid />
          )}
          {activeTab === 'history' && <HistoryView />}
          {activeTab === 'patterns' && <PatternsView />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
