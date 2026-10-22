import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { cardHover } from '@/lib/motion';
import { cx } from '@/lib/utils';
import { useBridgeStore } from '@/stores/bridgeStore';
import { AssignmentChips } from '@/components/molecules/AssignmentChips';
import type { Ticket } from '@/types';

interface TicketCardProps {
  ticket: Ticket;
  onClick?: () => void;
  /** Quick-edit affordance — opens the inline ticket editor. */
  onEdit?: () => void;
}

const priorityColor: Record<string, string> = {
  P0: 'var(--color-red)',
  P1: 'var(--color-orange)',
  P2: 'var(--color-blue)',
  P3: '#6b6b84',
};

const actionBtnClass =
  'text-9 py-0.5 px-1.5 rounded-[4px] border border-line bg-surface cursor-pointer';

export function TicketCard({ ticket, onClick, onEdit }: TicketCardProps) {
  const queueAction = useBridgeStore((s) => s.queueAction);
  const pColor = priorityColor[ticket.priority] ?? '#6b6b84';
  const assignments = ticket.assignments ?? [];

  return (
    <motion.div
      whileHover={cardHover}
      layout
      onClick={onClick}
      className={cx(
        'py-[10px] px-3 bg-surface border border-line rounded-[10px] mb-1.5',
        onClick ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <div className="flex justify-between items-center mb-1">
        <span className="text-10 font-bold text-fg-3 font-code">
          {ticket.ticket_ref ?? `#${ticket.id}`}
        </span>
        <span
          style={{ '--c': pColor } as CSSProperties}
          className="py-px px-[5px] rounded-[3px] text-9 font-bold bg-(--c) text-[white]"
        >
          {ticket.priority}
        </span>
      </div>

      <div className="text-12 font-medium text-fg mb-1.5 leading-[1.4]">{ticket.title}</div>

      <div className="flex justify-between items-center text-11 text-fg-3">
        {assignments.length > 0 ? (
          <AssignmentChips assignments={assignments} />
        ) : (
          <span>{ticket.assigned_to ?? '—'}</span>
        )}
        <span className="font-code">{ticket.story_points ?? 0}sp</span>
      </div>

      {ticket.epic_name && (
        <span className="inline-block mt-1 text-10 py-px px-1.5 rounded-[4px] bg-[rgba(168,85,247,0.15)] text-[rgb(168,85,247)]">
          {ticket.epic_name}
        </span>
      )}

      {/* Bridge action buttons */}
      <div className="flex gap-1 mt-1.5 border-t border-t-line pt-1.5">
        {onEdit && (
          <button
            aria-label="Edit ticket"
            title="Edit ticket"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className={cx(actionBtnClass, 'text-fg-3')}
          >
            ✎ Edit
          </button>
        )}
        {ticket.status === 'TODO' && !ticket.assigned_to && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              queueAction('assign_ticket', 'ticket', ticket.id, { ticket_ref: ticket.ticket_ref });
            }}
            className={cx(actionBtnClass, 'text-fg-3')}
          >
            Assign
          </button>
        )}
        {ticket.status !== 'DONE' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              queueAction('update_ticket', 'ticket', ticket.id, {
                status: 'DONE',
                ticket_ref: ticket.ticket_ref,
              });
            }}
            className={cx(actionBtnClass, 'text-green')}
          >
            Done
          </button>
        )}
      </div>
    </motion.div>
  );
}
