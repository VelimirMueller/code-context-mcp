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
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
      {sortLeadFirst(assignments).map((a) => (
        <span
          key={a.role}
          title={a.is_lead ? `${a.role} (lead)` : a.role}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: '1px 6px',
            borderRadius: 8,
            fontSize: 10,
            lineHeight: 1.6,
            background: a.is_lead ? 'rgba(99,102,241,.12)' : 'var(--bg)',
            border: `1px solid ${a.is_lead ? 'rgba(99,102,241,.35)' : 'var(--border)'}`,
            color: a.is_lead ? 'var(--accent)' : 'var(--text3)',
            whiteSpace: 'nowrap',
          }}
        >
          {a.is_lead ? <span aria-label="lead">★</span> : null}
          {a.role}
          {a.model && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>
              · {shortModel(a.model)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
