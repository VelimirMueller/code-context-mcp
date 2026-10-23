import { cx } from '@/lib/utils';
import type { TicketAssignment } from '@/types';

interface AssignmentChipsProps {
  assignments: TicketAssignment[];
}

// Strip the vendor prefix for compact display: claude-haiku-4-5 → haiku-4-5
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

// Lead assignment first, supporters after (stable order within each group).
export function sortLeadFirst(assignments: TicketAssignment[]): TicketAssignment[] {
  return [...assignments].sort((a, b) => (b.is_lead ? 1 : 0) - (a.is_lead ? 1 : 0));
}

/**
 * Compact, read-only assignment chips for board cards and ticket rows.
 * Lead renders first with a star; a model override is only shown when set.
 */
export function AssignmentChips({ assignments }: AssignmentChipsProps) {
  if (assignments.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap gap-[3px] items-center">
      {sortLeadFirst(assignments).map((a) => (
        <span
          key={a.role}
          title={a.is_lead ? `${a.role} (lead)` : a.role}
          className={cx(
            'inline-flex items-center gap-[3px] py-px px-1.5 rounded-[8px] text-10 leading-[1.6] border whitespace-nowrap',
            a.is_lead
              ? 'bg-[rgba(99,102,241,.12)] border-[rgba(99,102,241,.35)] text-accent'
              : 'bg-bg border-line text-fg-3',
          )}
        >
          {a.is_lead ? <span aria-label="lead">★</span> : null}
          {a.role}
          {a.model && <span className="font-code text-9 text-fg-3">· {shortModel(a.model)}</span>}
        </span>
      ))}
    </span>
  );
}
