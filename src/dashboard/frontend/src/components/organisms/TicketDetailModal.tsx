import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Ticket, TicketAssignment, Milestone, Epic } from '@/types';
import { cx, hideArchived } from '@/lib/utils';
import { get } from '@/lib/api';
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

const priorityBg: Record<string, string> = {
  P0: 'bg-red',
  P1: 'bg-orange',
  P2: 'bg-blue',
  P3: 'bg-[#6b6b84]',
};

const statusText: Record<string, string> = {
  TODO: 'text-fg-3',
  IN_PROGRESS: 'text-blue',
  DONE: 'text-green',
  BLOCKED: 'text-red',
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

// Shared look of every editable field; size, colour and font come from each use.
const fieldBase = 'w-full rounded-[6px] border border-line bg-bg px-[10px] py-1.5 outline-none';
const fieldText = 'font-body text-13 text-fg';

// Border, text colour, cursor and opacity of a milestone or epic select by save state.
const saveSelectClass = (saving: boolean, saved: boolean, error: boolean) =>
  cx(
    'w-full rounded-[8px] border bg-bg px-3 py-2 font-body text-13 outline-none transition-all',
    saving ? 'border-orange' : saved ? 'border-green' : error ? 'border-red' : 'border-line',
    saving ? 'text-fg-3' : 'text-fg',
    saving ? 'cursor-wait' : 'cursor-pointer',
    saving ? 'opacity-60' : 'opacity-100',
  );

const sectionLabel = 'text-10 font-semibold uppercase text-fg-3';
const saveNote = 'font-code text-10 font-semibold';

function FieldLabel({
  label,
  field,
  fieldSaved,
}: {
  label: string;
  field: string;
  fieldSaved: string | null;
}) {
  return (
    <div className={cx(sectionLabel, 'mb-1 flex gap-1.5')}>
      {label}
      {fieldSaved === field && <span className="text-green">✓</span>}
    </div>
  );
}

export function TicketDetailModal({
  ticket,
  milestones,
  onClose,
  onMilestoneChange,
  onEpicChange,
  onTicketUpdate,
}: TicketDetailModalProps) {
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
      get<Epic[]>('/api/epics')
        .then(setEpics)
        .catch(() => setEpics([]));
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

  // Notes go through the same PATCH contract as the other fields (#197).
  const saveNotes = () => {
    if (!ticket) return;
    const next = editNotes || null;
    if (next === (ticket.notes ?? null)) return;
    commit('notes', { notes: next });
  };

  const selectableEpics = hideArchived(epics, ticket?.epic_id);
  const filteredEpics = ticket?.milestone_id
    ? selectableEpics.filter(
        (e) => e.milestone_id === ticket.milestone_id || e.milestone_id === null,
      )
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
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(0,0,0,.6)] p-5"
        >
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] w-full max-w-[520px] overflow-y-auto rounded-card border border-line bg-surface px-7 py-6"
          >
            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-code text-12 font-bold text-fg-3">
                  {ticket.ticket_ref ?? `#${ticket.id}`}
                </span>
                <span
                  className={cx(
                    'rounded-[4px] px-1.5 py-0.5 text-10 font-bold text-[white]',
                    priorityBg[editPriority] ?? 'bg-[#6b6b84]',
                  )}
                >
                  {editPriority}
                </span>
                {/* The old inline background and border (`var(--x)20`) were invalid CSS and never rendered (border computes to style none); only the text colour did. */}
                <span
                  className={cx(
                    'rounded-[4px] border-none px-2 py-0.5 text-10 font-semibold',
                    statusText[editStatus] ?? 'text-fg-3',
                  )}
                >
                  {editStatus}
                </span>
              </div>
              <button
                onClick={onClose}
                className="cursor-pointer border-none bg-transparent px-1 text-18 leading-none text-fg-3"
              >
                ✕
              </button>
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
                  if (e.key === 'Escape') {
                    setEditTitle(ticket.title);
                    setTitleEditing(false);
                  }
                }}
                disabled={fieldSaving === 'title'}
                className={cx(fieldBase, 'mb-4 font-body text-16 font-bold text-fg')}
              />
            ) : (
              <h3
                onClick={() => setTitleEditing(true)}
                title="Click to edit title"
                className="mb-4 cursor-text text-16 font-bold text-fg"
              >
                {editTitle}
                {fieldSaved === 'title' && <span className="ml-1.5 text-12 text-green">✓</span>}
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
                  if (next !== (ticket.description ?? '').trim())
                    commit('description', { description: next || null });
                }}
                disabled={fieldSaving === 'description'}
                rows={4}
                className={cx(fieldBase, fieldText, 'mb-4 resize-y leading-[1.5]')}
              />
            ) : (
              <div
                onClick={() => setDescEditing(true)}
                title="Click to edit description"
                className="mb-4 cursor-text whitespace-pre-wrap rounded-[8px] border-l-3 border-l-accent bg-bg px-[14px] py-[10px] text-13 leading-[1.5] text-fg-2"
              >
                {editDescription || <span className="italic text-fg-3">Add description…</span>}
                {fieldSaved === 'description' && (
                  <span className="ml-1.5 text-12 text-green">✓</span>
                )}
              </div>
            )}

            {/* Editable fields grid */}
            <div className="mb-4 grid grid-cols-[1fr_1fr] gap-3">
              {/* Status — DONE is process-controlled and not settable from the UI */}
              <div>
                <FieldLabel label="Status" field="status" fieldSaved={fieldSaved} />
                <select
                  value={editStatus}
                  onChange={(e) => {
                    setEditStatus(e.target.value);
                    commit('status', { status: e.target.value });
                  }}
                  disabled={fieldSaving === 'status'}
                  aria-label="Ticket status"
                  className={cx(
                    fieldBase,
                    'cursor-pointer font-body text-13',
                    statusText[editStatus] ?? 'text-fg',
                  )}
                >
                  {UI_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  <option value="DONE" disabled title={DONE_TOOLTIP}>
                    DONE
                  </option>
                  {![...UI_STATUSES, 'DONE'].includes(editStatus) && (
                    <option value={editStatus} disabled>
                      {editStatus}
                    </option>
                  )}
                </select>
              </div>

              {/* Priority */}
              <div>
                <FieldLabel label="Priority" field="priority" fieldSaved={fieldSaved} />
                <select
                  value={editPriority}
                  onChange={(e) => {
                    setEditPriority(e.target.value);
                    commit('priority', { priority: e.target.value });
                  }}
                  disabled={fieldSaving === 'priority'}
                  aria-label="Ticket priority"
                  className={cx(fieldBase, fieldText, 'cursor-pointer')}
                >
                  {['P0', 'P1', 'P2', 'P3'].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
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
                    if (next !== (ticket.story_points ?? null))
                      commit('story_points', { story_points: next });
                  }}
                  disabled={fieldSaving === 'story_points'}
                  aria-label="Story points"
                  min={0}
                  className={cx(fieldBase, 'font-code text-13 text-fg')}
                />
              </div>
            </div>

            {/* Agents — multi-assignment with lead + per-assignment model (D2) */}
            <div className="mb-4">
              <FieldLabel label="Agents" field="assignments" fieldSaved={fieldSaved} />
              <AssignmentEditor
                roles={agentRoles}
                value={editAssignments}
                onChange={commitAssignments}
                disabled={fieldSaving === 'assignments'}
              />
            </div>

            {/* QA status (read-only) */}
            <div className="mb-4 flex gap-4 text-12">
              <span className={ticket.qa_verified ? 'text-green' : 'text-fg-3'}>
                {ticket.qa_verified ? '✓ QA Verified' : '✗ Not QA verified'}
              </span>
              {ticket.verified_by && <span className="text-fg-3">by {ticket.verified_by}</span>}
            </div>

            {/* Milestone selector */}
            <div className="mb-4">
              <div className="mb-1.5 flex items-center gap-2">
                <div className={sectionLabel}>Milestone</div>
                {saving && <div className={cx(saveNote, 'text-orange')}>Saving...</div>}
                {saved && <div className={cx(saveNote, 'text-accent')}>Saved</div>}
                {error && <div className={cx(saveNote, 'text-red')}>Failed to save</div>}
              </div>
              <div className="relative">
                <select
                  value={ticket.milestone_id ?? ''}
                  onChange={handleChange}
                  disabled={saving}
                  className={saveSelectClass(saving, saved, error)}
                >
                  <option value="">None</option>
                  {hideArchived(milestones, ticket.milestone_id).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Epic selector */}
            <div className="mb-4">
              <div className="mb-1.5 flex items-center gap-2">
                <div className={sectionLabel}>Epic</div>
                {epicSaving && <div className={cx(saveNote, 'text-orange')}>Saving...</div>}
                {epicSaved && <div className={cx(saveNote, 'text-accent')}>Saved</div>}
                {epicError && <div className={cx(saveNote, 'text-red')}>Failed to save</div>}
              </div>
              <div className="relative">
                <select
                  value={ticket.epic_id ?? ''}
                  onChange={handleEpicChange}
                  disabled={epicSaving}
                  className={saveSelectClass(epicSaving, epicSaved, epicError)}
                >
                  <option value="">None</option>
                  {filteredEpics.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.color ? `${ep.color} ` : ''}
                      {ep.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Acceptance criteria */}
            {ticket.acceptance_criteria && (
              <div className="mb-4">
                <div className={cx(sectionLabel, 'mb-1.5')}>Acceptance Criteria</div>
                <div className="whitespace-pre-wrap rounded-[8px] bg-bg px-[14px] py-[10px] text-12 leading-[1.6] text-fg-2">
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
                aria-label="Ticket notes"
                disabled={fieldSaving === 'notes'}
                placeholder="Add notes for Claude's context…"
                rows={3}
                className={cx(fieldBase, 'resize-y font-body text-12 leading-[1.5] text-fg')}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
