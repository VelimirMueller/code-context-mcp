import type { TicketAssignment } from '@/types';
import { MODEL_OPTIONS } from '@/lib/constants';
import { sortLeadFirst } from './AssignmentChips';

interface AssignmentEditorProps {
  /** Available agent roles (from the agents list). */
  roles: string[];
  /** Current assignments — exactly one lead when non-empty. */
  value: TicketAssignment[];
  onChange: (next: TicketAssignment[]) => void;
  disabled?: boolean;
}

/**
 * Multi-agent assignment editor: toggleable role chips, a star to mark the
 * single lead, and a per-assignment model dropdown ("Agent default" = null
 * override). Lead uniqueness is enforced here: assigning the first agent
 * makes it lead, removing the lead promotes the first supporter, and
 * starring a chip un-stars every other one.
 */
export function AssignmentEditor({ roles, value, onChange, disabled = false }: AssignmentEditorProps) {
  // Show every known role plus any assigned role the agents list no longer has.
  const allRoles = [...new Set([...roles, ...value.map((a) => a.role)])];
  const assignedByRole = new Map(value.map((a) => [a.role, a]));

  const toggleRole = (role: string) => {
    const existing = assignedByRole.get(role);
    if (existing) {
      const rest = value.filter((a) => a.role !== role);
      // Removing the lead promotes the first remaining assignment
      if (existing.is_lead && rest.length > 0 && !rest.some((a) => a.is_lead)) {
        const promoted = sortLeadFirst(rest)[0];
        onChange(rest.map((a) => ({ ...a, is_lead: a.role === promoted.role ? 1 : 0 })));
        return;
      }
      onChange(rest);
    } else {
      onChange([...value, { role, model: null, is_lead: value.length === 0 ? 1 : 0 }]);
    }
  };

  const setLead = (role: string) => {
    onChange(value.map((a) => ({ ...a, is_lead: a.role === role ? 1 : 0 })));
  };

  const setModel = (role: string, model: string | null) => {
    onChange(value.map((a) => (a.role === role ? { ...a, model } : a)));
  };

  const innerButtonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Role chips — click to assign/unassign, star to set the lead */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {allRoles.map((role) => {
          const assigned = assignedByRole.get(role);
          return (
            <span
              key={role}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 9px',
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'var(--font)',
                transition: 'all .15s',
                background: assigned ? 'rgba(99,102,241,.12)' : 'var(--bg)',
                border: `1px solid ${assigned ? 'rgba(99,102,241,.4)' : 'var(--border)'}`,
                color: assigned ? 'var(--accent)' : 'var(--text3)',
              }}
            >
              {assigned && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={assigned.is_lead ? `${role} is lead` : `Make ${role} lead`}
                  title={assigned.is_lead ? 'Lead agent' : `Make ${role} lead`}
                  onClick={() => { if (!assigned.is_lead) setLead(role); }}
                  style={{
                    ...innerButtonStyle,
                    color: assigned.is_lead ? 'var(--orange)' : 'var(--text3)',
                    fontSize: 12,
                    lineHeight: 1,
                  }}
                >
                  {assigned.is_lead ? '★' : '☆'}
                </button>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggleRole(role)}
                aria-pressed={Boolean(assigned)}
                aria-label={assigned ? `Unassign ${role}` : `Assign ${role}`}
                style={innerButtonStyle}
              >
                {role}
              </button>
            </span>
          );
        })}
      </div>

      {/* Per-assignment model override (lead first) */}
      {value.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sortLeadFirst(value).map((a) => {
            const knownModel = !a.model || MODEL_OPTIONS.some((m) => m.value === a.model);
            return (
              <div key={a.role} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: a.is_lead ? 'var(--text)' : 'var(--text2)',
                    fontWeight: a.is_lead ? 600 : 400,
                    minWidth: 120,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {a.is_lead ? <span style={{ color: 'var(--orange)' }}>★</span> : null}
                  {a.role}
                </span>
                <select
                  value={a.model ?? ''}
                  disabled={disabled}
                  aria-label={`Model for ${a.role}`}
                  onChange={(e) => setModel(a.role, e.target.value === '' ? null : e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: a.model ? 'var(--text)' : 'var(--text3)',
                    fontSize: 11,
                    padding: '3px 8px',
                    fontFamily: 'var(--font)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    outline: 'none',
                  }}
                >
                  <option value="">Agent default</option>
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                  {!knownModel && a.model && <option value={a.model}>{a.model}</option>}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
