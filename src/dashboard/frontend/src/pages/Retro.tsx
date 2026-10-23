'use client';

import { useEffect, type CSSProperties } from 'react';
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
    { key: 'went_well', label: 'Went Well', color: 'var(--color-green)' },
    { key: 'went_wrong', label: 'Went Wrong', color: 'var(--color-red)' },
    { key: 'try_next', label: 'Try Next', color: 'var(--color-accent)' },
  ];

  if (allFindings.length === 0) {
    return <div className="p-10 text-center text-13 text-fg-3">No retro findings yet.</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-5">
      {categories.map(({ key, label, color }) => {
        const items = byCategory(key);
        if (items.length === 0) return null;
        return (
          <div key={key} className="mb-5">
            <div
              className="mb-2 flex items-center gap-1.5 text-13 font-bold text-(--c)"
              style={{ '--c': color } as CSSProperties}
            >
              <span className="h-2 w-2 rounded-[50%] bg-(--c)" />
              {label} ({items.length})
            </div>
            <div className="flex flex-col gap-1.5">
              {items.slice(0, 20).map((f) => (
                <div
                  key={f.id}
                  className="rounded-[6px] border border-line border-l-[3px] border-l-(--c) bg-surface px-3 py-2 text-12 leading-[1.5] text-fg-2"
                  style={{ '--c': color } as CSSProperties}
                >
                  {f.finding}
                  {f.sprint_name && (
                    <span className="ml-2 font-code text-10 text-fg-3">— {f.sprint_name}</span>
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
      <div className="p-10 text-center text-13 text-fg-3">
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
    went_well: 'var(--color-green)',
    went_wrong: 'var(--color-red)',
    try_next: 'var(--color-accent)',
  };
  const catLabel: Record<string, string> = {
    went_well: 'Went Well',
    went_wrong: 'Went Wrong',
    try_next: 'Try Next',
  };

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
      {/* Health bar */}
      <div className="rounded-[10px] border border-line bg-surface px-[18px] py-3.5">
        <div className="mb-2.5 text-12 font-bold tracking-[0.06em] text-fg-3 uppercase">
          Cumulative Health — {bySprint.size} sprint{bySprint.size !== 1 ? 's' : ''}, {total}{' '}
          findings
        </div>
        <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px]">
          {totalWell > 0 && (
            <div
              className="rounded-[5px] bg-green"
              style={{ flex: totalWell }}
              title={`${totalWell} went well`}
            />
          )}
          {totalTry > 0 && (
            <div
              className="rounded-[5px] bg-accent"
              style={{ flex: totalTry }}
              title={`${totalTry} try next`}
            />
          )}
          {totalWrong > 0 && (
            <div
              className="rounded-[5px] bg-red"
              style={{ flex: totalWrong }}
              title={`${totalWrong} went wrong`}
            />
          )}
        </div>
        <div className="mt-2 flex gap-4">
          {[
            ['went_well', totalWell],
            ['try_next', totalTry],
            ['went_wrong', totalWrong],
          ].map(([cat, count]) => (
            <span
              key={cat as string}
              className="font-code text-11 text-(--c)"
              style={{ '--c': catColor[cat as string] } as CSSProperties}
            >
              {count} {catLabel[cat as string]}
            </span>
          ))}
        </div>
      </div>

      {/* Recurring keywords */}
      {recurring.length > 0 && (
        <div className="rounded-[10px] border border-line bg-surface px-[18px] py-3.5">
          <div className="mb-2.5 text-12 font-bold tracking-[0.06em] text-fg-3 uppercase">
            Recurring Themes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recurring.map(([word, sprints]) => (
              <span
                key={word}
                className="rounded-[20px] border border-[rgba(99,102,241,.25)] bg-[rgba(99,102,241,.12)] px-2.5 py-[3px] font-code text-11 text-accent"
              >
                {word} <span className="opacity-60">×{sprints.size}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Sprint-by-sprint breakdown */}
      <div className="rounded-[10px] border border-line bg-surface px-[18px] py-3.5">
        <div className="mb-3 text-12 font-bold tracking-[0.06em] text-fg-3 uppercase">
          Sprint Breakdown
        </div>
        <div className="flex flex-col gap-3">
          {[...bySprint.entries()].map(([sprintName, findings]) => {
            const well = findings.filter((f) => f.category === 'went_well').length;
            const wrong = findings.filter((f) => f.category === 'went_wrong').length;
            const tryN = findings.filter((f) => f.category === 'try_next').length;
            return (
              <div key={sprintName}>
                <div className="mb-[5px] text-12 font-semibold text-fg-2">{sprintName}</div>
                <div className="flex flex-col gap-1">
                  {findings
                    .filter((f) => f.category !== 'auto_analysis')
                    .map((f) => (
                      <div
                        key={f.id}
                        className="rounded-[6px] border-l-[3px] border-l-(--c) bg-surface-2 px-2.5 py-1.5 text-12 leading-[1.4] text-fg-2"
                        style={{ '--c': catColor[f.category] ?? '#888' } as CSSProperties}
                      >
                        {f.finding}
                      </div>
                    ))}
                  <div className="mt-0.5 flex gap-2.5">
                    {well > 0 && (
                      <span className="font-code text-10 text-green">✓ {well} well</span>
                    )}
                    {wrong > 0 && (
                      <span className="font-code text-10 text-red">✗ {wrong} wrong</span>
                    )}
                    {tryN > 0 && (
                      <span className="font-code text-10 text-accent">→ {tryN} try</span>
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
    <div className="flex h-full flex-col overflow-hidden">
      <SubTabBar tabs={RETRO_TABS} />
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
