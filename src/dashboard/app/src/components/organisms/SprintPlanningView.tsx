'use client';

import { useEffect, useState, useRef } from 'react';
import { useSprintStore } from '@/stores/sprintStore';
import { usePlanningStore } from '@/stores/planningStore';
import { get as apiGet, post as apiPost, put as apiPut } from '@/lib/api';
import { getPhaseStyle } from '@/lib/phases';
import { PlanningWizard } from './PlanningWizard';
import type { Ticket } from '@/types';

interface EditingTicket {
  id: number | null; // null = new ticket
  title: string;
  story_points: string;
  assigned_to: string;
  priority: string;
  status: string;
  epic_id: string;
}

const EMPTY_TICKET: EditingTicket = {
  id: null,
  title: '',
  story_points: '',
  assigned_to: '',
  priority: 'P2',
  status: 'TODO',
  epic_id: '',
};

const STATUS_OPTIONS = ['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED'];
const PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3'];

const statusDot: Record<string, string> = {
  TODO: 'var(--text3)',
  IN_PROGRESS: '#60a5fa',
  DONE: 'var(--green)',
  BLOCKED: '#f87171',
  PARTIAL: '#fbbf24',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border2)',
  borderRadius: 6,
  color: 'var(--text)',
  fontSize: 12,
  padding: '6px 8px',
  fontFamily: 'var(--font)',
  outline: 'none',
  width: '100%',
};

export function SprintPlanningView() {
  const sprints = useSprintStore((s) => s.sprints);
  const fetchSprints = useSprintStore((s) => s.fetchSprints);

  const milestones = usePlanningStore((s) => s.milestones);
  const fetchMilestones = usePlanningStore((s) => s.fetchMilestones);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<EditingTicket | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCreateSprint, setShowCreateSprint] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', goal: '', milestone_id: '' });
  const [createBusy, setCreateBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Find active sprint (non-rest, non-closed)
  const activeSprint = sprints.find((s) => s.status !== 'rest' && s.status !== 'closed') ?? null;
  const latestSprint = sprints[0] ?? null;
  const displaySprint = activeSprint ?? latestSprint;

  // Load epics for the dropdown
  const [epics, setEpics] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    apiGet<{ id: number; name: string }[]>('/api/epics').then((e) => setEpics(e ?? [])).catch(() => {});
  }, []);

  useEffect(() => { fetchSprints(); }, []);
  useEffect(() => { if (milestones.length === 0) fetchMilestones(); }, [milestones.length]);

  // Load tickets for the displayed sprint
  useEffect(() => {
    if (!displaySprint) return;
    setLoading(true);
    apiGet<Ticket[]>(`/api/sprint/${displaySprint.id}/tickets`)
      .then((t) => setTickets(t ?? []))
      .catch(() => setTickets([]))
      .finally(() => setLoading(false));
  }, [displaySprint?.id, sprints]);

  const totalPoints = tickets.reduce((sum, t) => sum + (t.story_points ?? 0), 0);
  const doneCount = tickets.filter((t) => t.status === 'DONE').length;

  const startEditing = (ticket: Ticket) => {
    setEditing({
      id: ticket.id,
      title: ticket.title,
      story_points: String(ticket.story_points ?? ''),
      assigned_to: ticket.assigned_to ?? '',
      priority: ticket.priority ?? 'P2',
      status: ticket.status,
      epic_id: String(ticket.epic_id ?? ''),
    });
  };

  const startNew = () => {
    setEditing({ ...EMPTY_TICKET });
    setTimeout(() => titleRef.current?.focus(), 50);
  };

  const cancelEdit = () => setEditing(null);

  const saveTicket = async () => {
    if (!editing || !editing.title.trim()) return;
    setSaving(true);
    try {
      if (editing.id) {
        // Update existing
        await apiPut(`/api/ticket/${editing.id}`, {
          title: editing.title.trim(),
          story_points: editing.story_points ? Number(editing.story_points) : null,
          assigned_to: editing.assigned_to || null,
          priority: editing.priority,
          status: editing.status,
          epic_id: editing.epic_id ? Number(editing.epic_id) : null,
        });
      } else {
        // Create new
        await apiPost('/api/tickets', {
          title: editing.title.trim(),
          story_points: editing.story_points ? Number(editing.story_points) : null,
          assigned_to: editing.assigned_to || null,
          priority: editing.priority,
          sprint_id: displaySprint?.id,
          epic_id: editing.epic_id ? Number(editing.epic_id) : null,
        });
      }
      // Refresh tickets
      if (displaySprint) {
        const t = await apiGet<Ticket[]>(`/api/sprint/${displaySprint.id}/tickets`);
        setTickets(t ?? []);
      }
      setEditing(null);
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTicket(); }
    if (e.key === 'Escape') cancelEdit();
  };

  const handleCreateSprint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.name.trim()) return;
    setCreateBusy(true);
    try {
      await apiPost('/api/sprints/plan', {
        name: createForm.name.trim(),
        goal: createForm.goal.trim() || undefined,
        milestone_id: createForm.milestone_id ? Number(createForm.milestone_id) : undefined,
        ticketIds: [],
      });
      setCreateForm({ name: '', goal: '', milestone_id: '' });
      setShowCreateSprint(false);
      fetchSprints();
    } catch {
      // silent
    } finally {
      setCreateBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Wizard at top */}
      <PlanningWizard onStartSprint={() => setShowCreateSprint(true)} />

      {/* Sprint creation form */}
      {showCreateSprint && (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 16,
        }}>
          <form onSubmit={handleCreateSprint} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>New Sprint</div>
            <input
              style={{ ...inputStyle, fontSize: 13, padding: '8px 12px' }}
              placeholder="Sprint name *"
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              required
              disabled={createBusy}
            />
            <input
              style={{ ...inputStyle, fontSize: 13, padding: '8px 12px' }}
              placeholder="Sprint goal (optional)"
              value={createForm.goal}
              onChange={(e) => setCreateForm((f) => ({ ...f, goal: e.target.value }))}
              disabled={createBusy}
            />
            <select
              style={{ ...inputStyle, fontSize: 13, padding: '8px 12px' }}
              value={createForm.milestone_id}
              onChange={(e) => setCreateForm((f) => ({ ...f, milestone_id: e.target.value }))}
              disabled={createBusy}
            >
              <option value="">No milestone</option>
              {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" disabled={createBusy} style={{
                background: createBusy ? 'var(--surface3)' : 'var(--accent)',
                color: createBusy ? 'var(--text3)' : '#000',
                border: 'none', borderRadius: 8, padding: '8px 20px',
                fontSize: 13, fontWeight: 600, cursor: createBusy ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font)',
              }}>
                {createBusy ? 'Creating...' : 'Create Sprint'}
              </button>
              <button type="button" onClick={() => setShowCreateSprint(false)} style={{
                background: 'none', border: '1px solid var(--border2)', borderRadius: 8,
                padding: '8px 16px', fontSize: 13, color: 'var(--text2)', cursor: 'pointer',
                fontFamily: 'var(--font)',
              }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Ticket list */}
      {displaySprint && (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                {displaySprint.name}
              </span>
              <span style={{
                fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600,
                padding: '2px 7px', borderRadius: 5,
                background: `${getPhaseStyle(displaySprint.status).bg}20`,
                color: getPhaseStyle(displaySprint.status).bg,
                textTransform: 'uppercase',
              }}>
                {displaySprint.status}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text3)' }}>
              <span>{doneCount}/{tickets.length} done</span>
              <span>{totalPoints} pts</span>
            </div>
          </div>

          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '32px 1fr 60px 90px 60px 60px 100px',
            gap: 8, padding: '6px 16px',
            fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface2)',
          }}>
            <span></span>
            <span>Title</span>
            <span>Points</span>
            <span>Assignee</span>
            <span>Priority</span>
            <span>Status</span>
            <span>Epic</span>
          </div>

          {/* Ticket rows */}
          {loading && tickets.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
              Loading tickets...
            </div>
          )}

          {tickets.map((ticket) => {
            const isEditing = editing?.id === ticket.id;

            if (isEditing && editing) {
              return (
                <div key={ticket.id} style={{
                  display: 'grid',
                  gridTemplateColumns: '32px 1fr 60px 90px 60px 60px 100px',
                  gap: 8, padding: '8px 16px',
                  alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  background: 'var(--surface2)',
                }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={saveTicket} disabled={saving} style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--accent)', padding: 0,
                    }}>
                      {saving ? '...' : '✓'}
                    </button>
                    <button onClick={cancelEdit} style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--text3)', padding: 0,
                    }}>
                      ✕
                    </button>
                  </div>
                  <input ref={titleRef} style={inputStyle} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} onKeyDown={handleKeyDown} />
                  <input style={inputStyle} type="number" value={editing.story_points} onChange={(e) => setEditing({ ...editing, story_points: e.target.value })} onKeyDown={handleKeyDown} />
                  <input style={inputStyle} value={editing.assigned_to} onChange={(e) => setEditing({ ...editing, assigned_to: e.target.value })} onKeyDown={handleKeyDown} placeholder="agent" />
                  <select style={inputStyle} value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: e.target.value })}>
                    {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select style={inputStyle} value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                    {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select style={inputStyle} value={editing.epic_id} onChange={(e) => setEditing({ ...editing, epic_id: e.target.value })}>
                    <option value="">—</option>
                    {epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
                  </select>
                </div>
              );
            }

            return (
              <div
                key={ticket.id}
                onClick={() => startEditing(ticket)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '32px 1fr 60px 90px 60px 60px 100px',
                  gap: 8, padding: '8px 16px',
                  alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  fontSize: 12,
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: statusDot[ticket.status] ?? 'var(--text3)',
                  justifySelf: 'center',
                }} />
                <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', marginRight: 6 }}>{ticket.ticket_ref}</span>
                  {ticket.title}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
                  {ticket.story_points ?? '—'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ticket.assigned_to ?? '—'}
                </span>
                <span style={{
                  fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600,
                  color: ticket.priority === 'P0' ? '#f87171' : ticket.priority === 'P1' ? '#fbbf24' : 'var(--text3)',
                }}>
                  {ticket.priority}
                </span>
                <span style={{
                  fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600,
                  color: statusDot[ticket.status] ?? 'var(--text3)',
                }}>
                  {ticket.status}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ticket.epic_name ?? '—'}
                </span>
              </div>
            );
          })}

          {/* New ticket row */}
          {editing?.id === null && editing && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: '32px 1fr 60px 90px 60px 60px 100px',
              gap: 8, padding: '8px 16px',
              alignItems: 'center',
              background: 'var(--surface2)',
              borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={saveTicket} disabled={saving} style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--accent)', padding: 0,
                }}>
                  {saving ? '...' : '✓'}
                </button>
                <button onClick={cancelEdit} style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--text3)', padding: 0,
                }}>
                  ✕
                </button>
              </div>
              <input ref={titleRef} style={inputStyle} placeholder="Ticket title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} onKeyDown={handleKeyDown} />
              <input style={inputStyle} type="number" placeholder="pts" value={editing.story_points} onChange={(e) => setEditing({ ...editing, story_points: e.target.value })} onKeyDown={handleKeyDown} />
              <input style={inputStyle} placeholder="agent" value={editing.assigned_to} onChange={(e) => setEditing({ ...editing, assigned_to: e.target.value })} onKeyDown={handleKeyDown} />
              <select style={inputStyle} value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: e.target.value })}>
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select style={inputStyle} value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select style={inputStyle} value={editing.epic_id} onChange={(e) => setEditing({ ...editing, epic_id: e.target.value })}>
                <option value="">—</option>
                {epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {!displaySprint && !showCreateSprint && (
        <div style={{
          textAlign: 'center', padding: 40, color: 'var(--text3)', fontSize: 13,
        }}>
          No sprints yet. Click "Start Sprint" in the wizard above to create one.
        </div>
      )}
    </div>
  );
}
