'use client';

import { useEffect } from 'react';
import { useSprintStore } from '@/stores/sprintStore';
import { cx } from '@/lib/utils';
import { BentoCard } from '@/components/molecules/BentoCard';

export function BentoGrid() {
  const sprints = useSprintStore((s) => s.sprints);
  const allFindings = useSprintStore((s) => s.allRetroFindings);
  const fetchAllRetro = useSprintStore((s) => s.fetchAllRetro);

  // Initial fetch (SSE will keep it updated via App.tsx)
  useEffect(() => {
    fetchAllRetro();
  }, [fetchAllRetro]);

  const loading = allFindings.length === 0 && sprints.length > 0;

  const well = allFindings.filter((f) => f.category === 'went_well');
  const wrong = allFindings.filter((f) => f.category === 'went_wrong');
  const tryNext = allFindings.filter((f) => f.category === 'try_next');

  // Dynamic findings from database - most recent first
  const recentFindings = [...allFindings]
    .sort((a, b) => {
      // Findings come with sprint_id from the database join
      const sprintA = sprints.find((s) => s.id === a.sprint_id);
      const sprintB = sprints.find((s) => s.id === b.sprint_id);
      const dateA = sprintA?.created_at || '';
      const dateB = sprintB?.created_at || '';
      return dateB.localeCompare(dateA);
    })
    .slice(0, 10);

  // Group by finding text to find "patterns" - simple word frequency for demonstration
  const findingPatterns = new Map<string, { count: number; examples: string[] }>();
  allFindings.forEach((f) => {
    const words = f.finding
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);
    words.forEach((word) => {
      const existing = findingPatterns.get(word);
      if (existing) {
        existing.count++;
        if (!existing.examples.includes(f.finding)) {
          existing.examples.push(f.finding);
        }
      } else {
        findingPatterns.set(word, { count: 1, examples: [f.finding] });
      }
    });
  });

  // Top recurring patterns from actual findings
  const recurringPatterns = [...findingPatterns.entries()]
    .filter(([_, data]) => data.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([word, data]) => `${word} (${data.count}x)`);

  return (
    <div className="p-5 overflow-y-auto flex-1">
      {/* Header */}
      <div className="flex items-baseline gap-3 mb-4">
        <span className="text-18 font-bold text-fg">Retro Insights</span>
        <span className="text-12 text-fg-3">
          {loading ? 'Loading…' : `${allFindings.length} findings across ${sprints.length} sprints`}
        </span>
      </div>

      {/* Bento grid: 3 columns */}
      <div className="grid grid-cols-[repeat(3,1fr)] gap-3">
        {/* Recurring Topics — wide (spans 2 cols) */}
        <BentoCard
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M3 9a6 6 0 0110.2-4.3M15 9a6 6 0 01-10.2 4.3"
                stroke="var(--color-accent-2)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M13.5 2.5v2.5H11M4.5 15.5v-2.5H7"
                stroke="var(--color-accent-2)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          title="Recurring Topics"
          subtitle="Patterns across all sprints"
          borderColor="var(--color-accent-2)"
          iconBg="rgba(167,139,250,.15)"
          wide
          items={
            recentFindings.length > 0
              ? recentFindings.map(
                  (f) =>
                    `${f.finding}${f.sprint_id ? ` (${sprints.find((s) => s.id === f.sprint_id)?.name || 'Unknown'})` : ''}`,
                )
              : ['No findings yet — add retros in your sprints to see patterns here']
          }
        />

        {/* Stats card */}
        <div className="bg-surface border border-line rounded-card border-t-[3px] border-t-fg-3 p-4 flex flex-col justify-center items-center text-center gap-1">
          {[
            { v: well.length, c: 'text-accent', l: 'went well' },
            { v: wrong.length, c: 'text-red', l: 'went wrong' },
            { v: tryNext.length, c: 'text-accent-2', l: 'try next' },
          ].map(({ v, c, l }, i) => (
            <div key={i} className={i < 2 ? 'mb-3' : 'mb-0'}>
              <div className={cx('text-32 font-bold leading-[1.1]', c)}>{v}</div>
              <div className="text-11 text-fg-3">{l}</div>
            </div>
          ))}
        </div>

        {/* Recent Went Well */}
        <BentoCard
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7" stroke="var(--color-green)" strokeWidth="1.5" />
              <path
                d="M6 9l2 2 4-4"
                stroke="var(--color-green)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          title="Recent Wins"
          subtitle="What went well"
          borderColor="var(--color-green)"
          iconBg="rgba(16,185,129,.15)"
          items={
            well.length > 0
              ? well.slice(0, 5).map((f) => f.finding)
              : ['No "went well" findings yet — celebrate your wins!']
          }
        />

        {/* Recent Issues */}
        <BentoCard
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M9 2L1.5 15.5h15L9 2z"
                stroke="var(--color-red)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path
                d="M9 7v3.5"
                stroke="var(--color-red)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="9" cy="13" r="0.75" fill="var(--color-red)" />
            </svg>
          }
          title="Recent Issues"
          subtitle="What went wrong"
          borderColor="var(--color-red)"
          iconBg="rgba(248,113,113,.15)"
          items={
            wrong.length > 0
              ? wrong.slice(0, 5).map((f) => f.finding)
              : ['No "went wrong" findings yet — track issues to avoid repeating them']
          }
        />

        {/* Action Items */}
        <BentoCard
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M9 1.5l2.3 4.7 5.2.8-3.8 3.7.9 5.1L9 13.5l-4.6 2.3.9-5.1L1.5 7l5.2-.8L9 1.5z"
                stroke="var(--color-blue)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          }
          title="Action Items"
          subtitle="Try next time"
          borderColor="var(--color-blue)"
          iconBg="rgba(59,130,246,.15)"
          items={
            well.length > 0
              ? [
                  `Most celebrated win: "${well.slice(0, 3).sort((a, b) => b.id - a.id)[0]?.finding || 'Add findings to see your best moments'}"`,
                ]
              : ['Add "went well" findings to highlight your best moments']
          }
        />

        {/* All Recent Findings */}
        <BentoCard
          icon={
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7" stroke="var(--color-orange)" strokeWidth="1.5" />
              <path
                d="M6.5 6.5l5 5M11.5 6.5l-5 5"
                stroke="var(--color-orange)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          }
          title="Worst Moment"
          subtitle="Biggest setback"
          borderColor="var(--color-orange)"
          iconBg="rgba(251,191,36,.15)"
          items={
            wrong.length > 0
              ? [
                  `Biggest setback: "${wrong.slice(0, 3).sort((a, b) => b.id - a.id)[0]?.finding || 'Add findings to track setbacks'}"`,
                ]
              : ['Add "went wrong" findings to learn from setbacks']
          }
        />
      </div>
    </div>
  );
}
