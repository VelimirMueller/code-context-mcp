import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Ticket, TicketAssignment, Milestone, Epic } from '@/types';
import { hideArchived } from '@/lib/utils';
import { get, put } from '@/lib/api';
import { useSprintStore } from '@/stores/sprintStore';
import { useAgentStore } from '@/stores/agentStore';
import { AssignmentEditor } from '@/components/molecules/AssignmentEditor';

interface TicketDetailModalProps {
  ticket: Ticket | null;
  milestones: Milestone[];
  onClose: () => void;
  onMilestoneChange: (ticketId: number, milestoneId: number | null) => Promise<void>;
  onEpicChange: (ticketId: number, epicId: number | null) => Promise<void>;
  onTicketUpdate?: (ticketId: number, updates: Partial<Ticket>) => void;
}

const priorityColor: Record<string, string> = {
  P0: 'var(--red)', P1: 'var(--orange)', P2: 'var(--blue)', P3: '#6b6b84',
};

const statusColor: Record<string, string> = {
  TODO: 'var(--text3)', IN_PROGRESS: 'var(--blue)', DONE: 'var(--green)', BLOCKED: 'var(--red)',
};

// Status transitions allowed from the UI. DONE stays process-controlled
// (QA gate) and is rendered as a disabled option with an explanatory tooltip.
const UI_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED'];
export const DONE_TOOLTIP = 'Completed by the Claude session after QA';

// Display shape of a ticket's assignments, falling back to the legacy
// single-agent field (which mirrors the lead) for tickets predating D2.
export function deriveAssignments(ticket: Ticket): TicketAssignment[] {
  if (ticket.assignments && ticket.assignments.length > 0) return ticket.assignments;
  if (ticket.assigned_to) return [{ role: ticket.assigned_to, model: null, is_lead: 1 }];
  return [];
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  fontSize: 13,
  padding: '6px 10px',
  fontFamily: 'var(--font)',
  outline: 'none',
};

function FieldLabel({ label, field, fieldSaved }: { label: string; field: string; fieldSaved: string | null }) {
  return (
    <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 4, display: 'flex', gap: 6 }}>
      {label}
      {fieldSaved === field && <span style={{ color: 'var(--green)' }}>✓</span>}
    </div>
  );
}

export function TicketDetailModal({ ticket, milestones, onClose, onMilestoneChange, onEpicChange, onTicketUpdate }: TicketDetailModalProps) {
  const updateTicket = useSprintStore((s) => s.updateTicket);
  const agents = useAgentStore((s) => s.agents);
  const fetchAgents = useAgentStore((s) => s.fetchAgents);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);

  const [epics, setEpics] = useState<Epic[]>([]);
  const [epicSaving, setEpicSaving] = useState(false);
  const [epicSaved, setEpicSaved] = useState(false);
  const [epicError, setEpicError] = useState(false);

  // Inline editable fields
  const [editTitle, setEditTitle] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [descEditing, setDescEditing] = useState(false);
  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editPoints, setEditPoints] = useState('');
  const [editAssignments, setEditAssignments] = useState<TicketAssignment[]>([]);
  const [editNotes, setEditNotes] = useState('');
  const [fieldSaving, setFieldSaving] = useState<string | null>(null);
  const [fieldSaved, setFieldSaved] = useState<string | null>(null);

  const syncFromTicket = (t: Ticket) => {
    setEditTitle(t.title);
    setEditDescription(t.description ?? '');
    setEditStatus(t.status ?? 'TODO');
    setEditPriority(t.priority ?? 'P2');
    setEditPoints(String(t.story_points ?? ''));
    setEditAssignments(deriveAssignments(t));
    setEditNotes(t.notes ?? '');
  };

  useEffect(() => {
    if (ticket) {
      syncFromTicket(ticket);
      setTitleEditing(false);
      setDescEditing(false);
      get<Epic[]>('/api/epics').then(setEpics).catch(() => setEpics([]));
      if (agents.length === 0) fetchAgents();
    }
  }, [ticket?.id]);

  // PATCH one field set, optimistic via the store; reconcile the editor from
  // the response ticket (success) or the reverted store ticket (failure —
  // updateTicket already reverted and toasted the server error).
  const commit = async (field: string, payload: Parameters<typeof updateTicket>[1]) => {
    if (!ticket) return;
    setFieldSaving(field);
    const updated = await updateTicket(ticket.id, payload);
    setFieldSaving(null);
    if (updated) {
      syncFromTicket(updated);
      setFieldSaved(field);
      setTimeout(() => setFieldSaved(null), 1500);
      onTicketUpdate?.(ticket.id, updated);
    } else {
      const reverted = useSprintStore.getState().tickets.find((t) => t.id === ticket.id) ?? ticket;
      syncFromTicket(reverted);
      onTicketUpdate?.(ticket.id, reverted);
    }
  };

  const commitAssignments = (next: TicketAssignment[]) => {
    setEditAssignments(next);
    commit('assignments', {
      assignments: next.map((a) => ({ role: a.role, model: a.model, lead: a.is_lead === 1 })),
    });
  };

  // Notes are not part of the PATCH contract — keep the existing PUT path.
  const saveNotes = async () => {
    if (!ticket) return;
    setFieldSaving('notes');
    try {
      await put(`/api/ticket/${ticket.id}`, { notes: editNotes || null });
      setFieldSaved('notes');
      setTimeout(() => setFieldSaved(null), 1500);
      onTicketUpdate?.(ticket.id, { notes: editNotes || null });
    } catch {
      // silent
    } finally {
      setFieldSaving(null);
    }
  };

  const selectableEpics = hideArchived(epics, ticket?.epic_id);
  const filteredEpics = ticket?.milestone_id
    ? selectableEpics.filter((e) => e.milestone_id === ticket.milestone_id || e.milestone_id === null)
    : selectableEpics;

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!ticket) return;
    const val = e.target.value ? Number(e.target.value) : null;
    setSaving(true);
    setSaved(false);
    setError(false);
    try {
      await onMilestoneChange(ticket.id, val);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError(true);
      setTimeout(() => setError(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleEpicChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!ticket) return;
    const val = e.target.value ? Number(e.target.value) : null;
    setEpicSaving(true);
    setEpicSaved(false);
    setEpicError(false);
    try {
      await onEpicChange(ticket.id, val);
      setEpicSaved(true);
      setTimeout(() => setEpicSaved(false), 2000);
    } catch {
      setEpicError(true);
      setTimeout(() => setEpicError(false), 3000);
    } finally {
      setEpicSaving(false);
    }
  };

  const agentRoles = agents.map((a) => a.role);

  return (
    <AnimatePresence>
      {ticket && (
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '24px 28px',
              width: '100%', maxWidth: 520, maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                  {ticket.ticket_ref ?? `#${ticket.id}`}
                </span>
                <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: priorityColor[editPriority] ?? '#6b6b84', color: 'white' }}>
                  {editPriority}
                </span>
                <span style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                  background: `${statusColor[editStatus] ?? 'var(--text3)'}20`,
                  color: statusColor[editStatus] ?? 'var(--text3)',
                  border: `1px solid ${statusColor[editStatus] ?? 'var(--text3)'}40`,
                }}>
                  {editStatus}
                </span>
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>✕</button>
            </div>

            {/* Title (click to edit) */}
            {titleEditing ? (
              <input
                value={editTitle}
                autoFocus
                aria-label="Ticket title"
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={() => {
                  setTitleEditing(false);
                  const next = editTitle.trim();
                  if (next && next !== ticket.title) commit('title', { title: next });
                  else setEditTitle(ticket.title);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') { setEditTitle(ticket.title); setTitleEditing(false); }
                }}
                disabled={fieldSaving === 'title'}
                style={{ ...fieldStyle, fontSize: 16, fontWeight: 700, marginBottom: 16 }}
              />
            ) : (
              <h3
                onClick={() => setTitleEditing(true)}
                title="Click to edit title"
                style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: '0 0 16px', cursor: 'text' }}
              >
                {editTitle}
                {fieldSaved === 'title' && <span style={{ color: 'var(--green)', fontSize: 12, marginLeft: 6 }}>✓</span>}
              </h3>
            )}

            {/* Description (click to edit) */}
            {descEditing ? (
              <textarea
                value={editDescription}
                autoFocus
                aria-label="Ticket description"
                onChange={(e) => setEditDescription(e.target.value)}
                onBlur={() => {
                  setDescEditing(false);
                  const next = editDescription.trim();
                  if (next !== (ticket.description ?? '').trim()) commit('description', { description: next || null });
                }}
                disabled={fieldSaving === 'description'}
                rows={4}
                style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.5, marginBottom: 16 }}
              />
            ) : (
              <div
                onClick={() => setDescEditing(true)}
                title="Click to edit description"
                style={{ padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, borderLeft: '3px solid var(--accent)', fontSize: 13, color: 'var(--text2)', marginBottom: 16, lineHeight: 1.5, cursor: 'text', whiteSpace: 'pre-wrap' as const }}
              >
                {editDescription || <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>Add description…</span>}
                {fieldSaved === 'description' && <span style={{ color: 'var(--green)', fontSize: 12, marginLeft: 6 }}>✓</span>}
              </div>
            )}

            {/* Editable fields grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              {/* Status — DONE is process-controlled and not settable from the UI */}
              <div>
                <FieldLabel label="Status" field="status" fieldSaved={fieldSaved} />
                <select
                  value={editStatus}
                  onChange={(e) => { setEditStatus(e.target.value); commit('status', { status: e.target.value }); }}
                  disabled={fieldSaving === 'status'}
                  aria-label="Ticket status"
                  style={{ ...fieldStyle, cursor: 'pointer', color: statusColor[editStatus] ?? 'var(--text)' }}
                >
                  {UI_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                  <option value="DONE" disabled title={DONE_TOOLTIP}>DONE</option>
                  {![...UI_STATUSES, 'DONE'].includes(editStatus) && (
                    <option value={editStatus} disabled>{editStatus}</option>
                  )}
                </select>
              </div>

              {/* Priority */}
              <div>
                <FieldLabel label="Priority" field="priority" fieldSaved={fieldSaved} />
                <select
                  value={editPriority}
                  onChange={(e) => { setEditPriority(e.target.value); commit('priority', { priority: e.target.value }); }}
                  disabled={fieldSaving === 'priority'}
                  aria-label="Ticket priority"
                  style={{ ...fieldStyle, cursor: 'pointer' }}
                >
                  {['P0', 'P1', 'P2', 'P3'].map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              {/* Story Points */}
              <div>
                <FieldLabel label="Story Points" field="story_points" fieldSaved={fieldSaved} />
                <input
                  type="number"
                  value={editPoints}
                  onChange={(e) => setEditPoints(e.target.value)}
                  onBlur={() => {
                    const next = editPoints === '' ? null : Number(editPoints);
                    if (next !== (ticket.story_points ?? null)) commit('story_points', { story_points: next });
                  }}
                  disabled={fieldSaving === 'story_points'}
                  aria-label="Story points"
                  min={0}
                  style={{ ...fieldStyle, fontFamily: 'var(--mono)' }}
                />
              </div>
            </div>

            {/* Agents — multi-assignment with lead + per-assignment model (D2) */}
            <div style={{ marginBottom: 16 }}>
              <FieldLabel label="Agents" field="assignments" fieldSaved={fieldSaved} />
              <AssignmentEditor
                roles={agentRoles}
                value={editAssignments}
                onChange={commitAssignments}
                disabled={fieldSaving === 'assignments'}
              />
            </div>

            {/* QA status (read-only) */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 12 }}>
              <span style={{ color: ticket.qa_verified ? 'var(--green)' : 'var(--text3)' }}>
                {ticket.qa_verified ? '✓ QA Verified' : '✗ Not QA verified'}
              </span>
              {ticket.verified_by && <span style={{ color: 'var(--text3)' }}>by {ticket.verified_by}</span>}
            </div>

            {/* Milestone selector */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const }}>Milestone</div>
                {saving && (
                  <div style={{ fontSize: 10, color: 'var(--orange)', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                    Saving...
                  </div>
                )}
                {saved && (
                  <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                    Saved
                  </div>
                )}
                {error && (
                  <div style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                    Failed to save
                  </div>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <select
                  value={ticket.milestone_id ?? ''}
                  onChange={handleChange}
                  disabled={saving}
                  style={{
                    width: '100%', background: 'var(--bg)',
                    border: `1px solid ${saving ? 'var(--orange)' : saved ? 'var(--green)' : error ? 'var(--red)' : 'var(--border)'}`,
                    borderRadius: 8, color: saving ? 'var(--text3)' : 'var(--text)', fontSize: 13, padding: '8px 12px',
                    fontFamily: 'var(--font)', cursor: saving ? 'wait' : 'pointer', outline: 'none',
                    opacity: saving ? 0.6 : 1, transition: 'all .2s',
                  }}
                >
                  <option value="">None</option>
                  {hideArchived(milestones, ticket.milestone_id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>

            {/* Epic selector */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const }}>Epic</div>
                {epicSaving && (
                  <div style={{ fontSize: 10, color: 'var(--orange)', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                    Saving...
                  </div>
                )}
                {epicSaved && (
                  <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                    Saved
                  </div>
                )}
                {epicError && (
                  <div style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                    Failed to save
                  </div>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <select
                  value={ticket.epic_id ?? ''}
                  onChange={handleEpicChange}
                  disabled={epicSaving}
                  style={{
                    width: '100%', background: 'var(--bg)',
                    border: `1px solid ${epicSaving ? 'var(--orange)' : epicSaved ? 'var(--green)' : epicError ? 'var(--red)' : 'var(--border)'}`,
                    borderRadius: 8, color: epicSaving ? 'var(--text3)' : 'var(--text)', fontSize: 13, padding: '8px 12px',
                    fontFamily: 'var(--font)', cursor: epicSaving ? 'wait' : 'pointer', outline: 'none',
                    opacity: epicSaving ? 0.6 : 1, transition: 'all .2s',
                  }}
                >
                  <option value="">None</option>
                  {filteredEpics.map(ep => (
                    <option key={ep.id} value={ep.id}>
                      {ep.color ? `${ep.color} ` : ''}{ep.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Acceptance criteria */}
            {ticket.acceptance_criteria && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 6 }}>Acceptance Criteria</div>
                <div style={{ padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' as const }}>
                  {ticket.acceptance_criteria}
                </div>
              </div>
            )}

            {/* Notes (editable) */}
            <div>
              <FieldLabel label="Notes" field="notes" fieldSaved={fieldSaved} />
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                onBlur={saveNotes}
                disabled={fieldSaving === 'notes'}
                placeholder="Add notes for Claude's context…"
                rows={3}
                style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.5, fontSize: 12 }}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
