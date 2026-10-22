import { motion } from 'framer-motion';
import { cardHover, listItemVariants } from '@/lib/motion';
import { getPhaseStyle, getPhaseLabel, mapLegacyPhase } from '@/lib/phases';
import { useBridgeStore } from '@/stores/bridgeStore';
import type { Sprint } from '@/types';
import { StatusBadge, RetroDoneBadge, QaVerifiedBadge, QaPendingBadge, VelocityMetBadge, VelocityLowBadge } from '@/components/atoms';

interface SprintCardProps {
  sprint: Sprint;
  selected: boolean;
  onClick: (id: number) => void;
  showStatusBadges?: boolean;
}

export function SprintCard({ sprint, selected, onClick, showStatusBadges = true }: SprintCardProps) {
  const queueAction = useBridgeStore((s) => s.queueAction);
  const pct =
    sprint.ticket_count > 0
      ? Math.round((sprint.done_count / sprint.ticket_count) * 100)
      : 0;

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

  return (
    <motion.div
      variants={listItemVariants}
      whileHover={cardHover}
      layout
      onClick={() => onClick(sprint.id)}
      style={{
        padding: '12px 14px',
        background: selected ? 'var(--surface2)' : 'var(--surface)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        cursor: 'pointer',
        marginBottom: 6,
        transition: 'all .2s',
        borderLeft: selected ? '3px solid var(--accent)' : '3px solid transparent',
      }}
    >
      {/* Status badges row */}
      {showStatusBadges && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 6,
            flexWrap: 'wrap',
          }}
        >
          {hasRetroFindings && <RetroDoneBadge variant="solid" />}
          {qaVerified && <QaVerifiedBadge variant="solid" />}
          {qaPartial && <QaPendingBadge variant="solid" />}
          {velocityMet && <VelocityMetBadge variant="solid" />}
          {velocityLow && sprint.status !== 'planned' && <VelocityLowBadge variant="solid" />}
        </div>
      )}

      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text)',
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {sprint.name}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          fontSize: 11,
          color: 'var(--text3)',
          marginBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color, fontWeight: 700, textTransform: 'uppercase' }}>
          {getPhaseLabel(sprint.status)}
        </span>
        <span>
          {sprint.done_count}/{sprint.ticket_count} tickets
        </span>
        <span>
          {sprint.velocity_completed ?? 0}/{sprint.velocity_committed ?? 0} pts
        </span>
        {sprint.velocity_committed > 0 && (
          <span style={{
            color: velocityPct >= 80 ? 'var(--green)' : velocityPct >= 50 ? 'var(--orange)' : 'var(--red)',
            fontWeight: 600,
          }}>
            {velocityPct}%
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 3,
          background: 'var(--border)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: 'var(--accent)',
            transition: 'width .3s',
          }}
        />
      </div>

      {/* Bridge action buttons */}
      {!['done', 'rest'].includes(mapLegacyPhase(sprint.status)) && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <button
            onClick={(e) => { e.stopPropagation(); queueAction('advance_sprint', 'sprint', sprint.id, { current_phase: sprint.status }); }}
            style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--blue)', cursor: 'pointer' }}
          >
            Advance
          </button>
          {sprint.status === 'retro' && (
            <button
              onClick={(e) => { e.stopPropagation(); queueAction('run_retro', 'sprint', sprint.id); }}
              style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', cursor: 'pointer' }}
            >
              Run Retro
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}
