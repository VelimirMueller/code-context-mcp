import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { cardHover, listItemVariants } from '@/lib/motion';
import { cx } from '@/lib/utils';
import { getPhaseStyle, getPhaseLabel, mapLegacyPhase } from '@/lib/phases';
import { useBridgeStore } from '@/stores/bridgeStore';
import type { Sprint } from '@/types';
import {
  StatusBadge,
  RetroDoneBadge,
  QaVerifiedBadge,
  QaPendingBadge,
  VelocityMetBadge,
  VelocityLowBadge,
} from '@/components/atoms';

interface SprintCardProps {
  sprint: Sprint;
  selected: boolean;
  onClick: (id: number) => void;
  showStatusBadges?: boolean;
}

export function SprintCard({
  sprint,
  selected,
  onClick,
  showStatusBadges = true,
}: SprintCardProps) {
  const queueAction = useBridgeStore((s) => s.queueAction);
  const pct =
    sprint.ticket_count > 0 ? Math.round((sprint.done_count / sprint.ticket_count) * 100) : 0;

  const velocityPct =
    sprint.velocity_committed > 0
      ? Math.round((sprint.velocity_completed / sprint.velocity_committed) * 100)
      : 0;

  const color = getPhaseStyle(sprint.status).bg;

  // Determine status badges (defensive: qa_count/retro_count may be undefined from API)
  const qaCount = sprint.qa_count ?? 0;
  const ticketCount = sprint.ticket_count ?? 0;
  const retroCount = sprint.retro_count ?? 0;
  const hasRetroFindings = retroCount > 0;
  const qaVerified = ticketCount > 0 && qaCount >= ticketCount * 0.9;
  const qaPartial = ticketCount > 0 && qaCount >= ticketCount * 0.7 && !qaVerified;
  const velocityMet = velocityPct >= 100;
  const velocityLow = velocityPct < 70 && sprint.velocity_committed > 0;

  const actionBtnClass =
    'text-9 py-0.5 px-1.5 rounded-[4px] border border-line bg-surface cursor-pointer';

  return (
    <motion.div
      variants={listItemVariants}
      whileHover={cardHover}
      layout
      onClick={() => onClick(sprint.id)}
      className={cx(
        'py-3 px-3.5 border rounded-card cursor-pointer mb-1.5 transition-all border-l-[3px]',
        selected
          ? 'bg-surface-2 border-accent border-l-accent'
          : 'bg-surface border-line border-l-transparent',
      )}
    >
      {/* Status badges row */}
      {showStatusBadges && (
        <div className="flex gap-1 mb-1.5 flex-wrap">
          {hasRetroFindings && <RetroDoneBadge variant="solid" />}
          {qaVerified && <QaVerifiedBadge variant="solid" />}
          {qaPartial && <QaPendingBadge variant="solid" />}
          {velocityMet && <VelocityMetBadge variant="solid" />}
          {velocityLow && sprint.status !== 'planned' && <VelocityLowBadge variant="solid" />}
        </div>
      )}

      <div className="text-13 font-semibold text-fg mb-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {sprint.name}
      </div>

      <div className="flex gap-2 text-11 text-fg-3 mb-1.5 flex-wrap">
        <span style={{ '--c': color } as CSSProperties} className="text-(--c) font-bold uppercase">
          {getPhaseLabel(sprint.status)}
        </span>
        <span>
          {sprint.done_count}/{sprint.ticket_count} tickets
        </span>
        <span>
          {sprint.velocity_completed ?? 0}/{sprint.velocity_committed ?? 0} pts
        </span>
        {sprint.velocity_committed > 0 && (
          <span
            className={cx(
              'font-semibold',
              velocityPct >= 80 ? 'text-green' : velocityPct >= 50 ? 'text-orange' : 'text-red',
            )}
          >
            {velocityPct}%
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-[3px] bg-line rounded-[2px] overflow-hidden">
        <div
          style={{ width: `${pct}%` } as CSSProperties}
          className="h-full bg-accent [transition:width_.3s]"
        />
      </div>

      {/* Bridge action buttons */}
      {!['done', 'rest'].includes(mapLegacyPhase(sprint.status)) && (
        <div className="flex gap-1 mt-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              queueAction('advance_sprint', 'sprint', sprint.id, { current_phase: sprint.status });
            }}
            className={cx(actionBtnClass, 'text-blue')}
          >
            Advance
          </button>
          {sprint.status === 'retro' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                queueAction('run_retro', 'sprint', sprint.id);
              }}
              className={cx(actionBtnClass, 'text-fg-3')}
            >
              Run Retro
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}
