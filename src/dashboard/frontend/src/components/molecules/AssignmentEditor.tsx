import { cx } from '@/lib/utils';
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
export function AssignmentEditor({
  roles,
  value,
  onChange,
  disabled = false,
}: AssignmentEditorProps) {
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

  const innerButtonClass = cx(
    'bg-transparent border-none p-0 inline-flex items-center',
    disabled ? 'cursor-not-allowed' : 'cursor-pointer',
  );

  return (
    <div className="flex flex-col gap-2">
      {/* Role chips — click to assign/unassign, star to set the lead */}
      <div className="flex flex-wrap gap-[5px]">
        {allRoles.map((role) => {
          const assigned = assignedByRole.get(role);
          return (
            <span
              key={role}
              className={cx(
                'inline-flex items-center gap-1 py-[3px] px-[9px] rounded-[10px] text-11 font-semibold font-body [transition:all_.15s] border',
                assigned
                  ? 'bg-[rgba(99,102,241,.12)] border-[rgba(99,102,241,.4)] text-accent'
                  : 'bg-bg border-line text-fg-3',
              )}
            >
              {assigned && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={assigned.is_lead ? `${role} is lead` : `Make ${role} lead`}
                  title={assigned.is_lead ? 'Lead agent' : `Make ${role} lead`}
                  onClick={() => {
                    if (!assigned.is_lead) setLead(role);
                  }}
                  className={cx(
                    innerButtonClass,
                    assigned.is_lead ? 'text-orange' : 'text-fg-3',
                    'text-12 leading-none',
                  )}
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
                className={innerButtonClass}
              >
                {role}
              </button>
            </span>
          );
        })}
      </div>

      {/* Per-assignment model override (lead first) */}
      {value.length > 0 && (
        <div className="flex flex-col gap-1">
          {sortLeadFirst(value).map((a) => {
            const knownModel = !a.model || MODEL_OPTIONS.some((m) => m.value === a.model);
            return (
              <div key={a.role} className="flex items-center gap-2">
                <span
                  className={cx(
                    'text-11 min-w-[120px] inline-flex items-center gap-1',
                    a.is_lead ? 'text-fg font-semibold' : 'text-fg-2 font-normal',
                  )}
                >
                  {a.is_lead ? <span className="text-orange">★</span> : null}
                  {a.role}
                </span>
                <select
                  value={a.model ?? ''}
                  disabled={disabled}
                  aria-label={`Model for ${a.role}`}
                  onChange={(e) => setModel(a.role, e.target.value === '' ? null : e.target.value)}
                  className={cx(
                    'flex-1 bg-bg border border-line rounded-[6px] text-11 py-[3px] px-2 font-body outline-none',
                    a.model ? 'text-fg' : 'text-fg-3',
                    disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                  )}
                >
                  <option value="">Agent default</option>
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
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
