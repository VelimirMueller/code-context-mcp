'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePlanningStore, type MilestoneStatus } from '@/stores/planningStore';
import { put } from '@/lib/api';
import type { Milestone } from '@/types';
import { EpicList } from '@/components/organisms/EpicList';

const smallButton = (busy: boolean): React.CSSProperties => ({
  background: 'none',
  border: '1px solid var(--border2)',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 11,
  fontWeight: 600,
  color: busy ? 'var(--text3)' : 'var(--text2)',
  cursor: busy ? 'not-allowed' : 'pointer',
  fontFamily: 'var(--font)',
});

function ProgressBar({ value, color = 'var(--accent)' }: { value: number; color?: string }) {
  return (
    <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, value)}%` }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        style={{ height: '100%', background: color, borderRadius: 2 }}
      />
    </div>
  );
}

/** Card colour for a stored milestone status; unknown values get the planned colour. */
export function milestoneCardColor(status: string): string {
  const statusColor: Record<string, string> = {
    active: '#10b981',
    planned: '#6366f1',
    completed: '#6b6b84',
  };
  return statusColor[status] ?? statusColor.planned;
}

interface MilestoneCardProps {
  milestone: Milestone;
  onClose: (id: number) => Promise<void>;
  onArchive?: (id: number) => Promise<void>;
  onUnarchive?: (id: number) => Promise<void>;
}

function MilestoneCard({ milestone, onClose, onArchive, onUnarchive }: MilestoneCardProps) {
  const [closing, setClosing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editing, setEditing] = useState(false);
  const isActive = milestone.status !== 'completed';
  const isArchived = !!milestone.archived_at;
  const pct =
    milestone.ticket_count > 0
      ? Math.round((milestone.done_count / milestone.ticket_count) * 100)
      : (milestone.progress ?? 0);

  const color = milestoneCardColor(milestone.status);

  const handleClose = async () => {
    if (closing) return;
    setClosing(true);
    try {
      await onClose(milestone.id);
    } finally {
      setClosing(false);
    }
  };

  const handleArchiveToggle = async () => {
    const action = isArchived ? onUnarchive : onArchive;
    if (archiving || !action) return;
    setArchiving(true);
    try {
      await action(milestone.id);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
            {milestone.name}
          </div>
          {milestone.description && (
            <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5 }}>
              {milestone.description}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              padding: '2px 8px',
              borderRadius: 4,
              background: `${color}18`,
              color,
            }}
          >
            {milestone.status}
          </span>
          {!isArchived && !editing && (
            <button
              onClick={() => setEditing(true)}
              aria-label={`Edit ${milestone.name}`}
              style={smallButton(false)}
            >
              Edit
            </button>
          )}
          {isActive && !isArchived && (
            <button onClick={handleClose} disabled={closing} style={smallButton(closing)}>
              {closing ? '…' : 'Close'}
            </button>
          )}
          {/* Archive is offered once completed (server enforces the same rule);
              Unarchive is always available on an archived milestone. */}
          {((!isActive && !isArchived && onArchive) || (isArchived && onUnarchive)) && (
            <button
              onClick={handleArchiveToggle}
              disabled={archiving}
              style={smallButton(archiving)}
            >
              {archiving ? '…' : isArchived ? 'Unarchive' : 'Archive'}
            </button>
          )}
        </div>
      </div>

      {editing && <EditMilestoneForm milestone={milestone} onDone={() => setEditing(false)} />}

      <ProgressBar value={pct} color={color} />

      <div style={{ display: 'flex', gap: 20, fontSize: 11, color: 'var(--text3)' }}>
        <span>
          {milestone.done_count ?? 0}/{milestone.ticket_count ?? 0} tickets
        </span>
        <span>{pct}% done</span>
        {milestone.target_date && (
          <span>Target: {new Date(milestone.target_date).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border2)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--text)',
  fontFamily: 'var(--font)',
};

/** Inline form for a new milestone; sends the body POST /api/milestones parses (#199). */
function NewMilestoneForm({ onDone }: { onDone: () => void }) {
  const createMilestone = usePlanningStore((s) => s.createMilestone);
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createMilestone({ name: name.trim(), target_date: targetDate || undefined });
      onDone();
    } catch (err) {
      setError((err as Error).message || 'Failed to create milestone.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}
    >
      <input
        aria-label="Milestone name"
        placeholder="Milestone name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        style={{ ...fieldStyle, flex: '1 1 200px' }}
      />
      <input
        aria-label="Milestone target date"
        type="date"
        value={targetDate}
        onChange={(e) => setTargetDate(e.target.value)}
        style={fieldStyle}
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        style={smallButton(busy || !name.trim())}
      >
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" onClick={onDone} disabled={busy} style={smallButton(busy)}>
        Cancel
      </button>
      {error && (
        <div role="alert" style={{ width: '100%', fontSize: 12, color: 'var(--red)' }}>
          {error}
        </div>
      )}
    </form>
  );
}

const MILESTONE_STATUSES: { value: MilestoneStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
];

/**
 * Inline edit of a milestone's status and target date; sends the body
 * PUT /api/milestone/:id parses (#205). An empty date clears it.
 */
function EditMilestoneForm({ milestone, onDone }: { milestone: Milestone; onDone: () => void }) {
  const updateMilestone = usePlanningStore((s) => s.updateMilestone);
  const [status, setStatus] = useState<MilestoneStatus>(milestone.status as MilestoneStatus);
  const [targetDate, setTargetDate] = useState(milestone.target_date ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const changes: { status?: MilestoneStatus; target_date?: string | null } = {};
    if (status !== milestone.status) changes.status = status;
    if (targetDate !== (milestone.target_date ?? '')) changes.target_date = targetDate || null;
    if (Object.keys(changes).length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateMilestone(milestone.id, changes);
      onDone();
    } catch (err) {
      setError((err as Error).message || 'Failed to update milestone.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <select
        aria-label={`Status of ${milestone.name}`}
        value={status}
        onChange={(e) => setStatus(e.target.value as MilestoneStatus)}
        style={fieldStyle}
      >
        {MILESTONE_STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <input
        aria-label={`Target date of ${milestone.name}`}
        type="date"
        value={targetDate}
        onChange={(e) => setTargetDate(e.target.value)}
        style={fieldStyle}
      />
      <button type="submit" disabled={busy} style={smallButton(busy)}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={onDone} disabled={busy} style={smallButton(busy)}>
        Cancel
      </button>
      {error && (
        <div role="alert" style={{ width: '100%', fontSize: 12, color: 'var(--red)' }}>
          {error}
        </div>
      )}
    </form>
  );
}

export function ProjectManagement() {
  const milestones = usePlanningStore((s) => s.milestones);
  const fetchMilestones = usePlanningStore((s) => s.fetchMilestones);
  const archiveMilestone = usePlanningStore((s) => s.archiveMilestone);
  const unarchiveMilestone = usePlanningStore((s) => s.unarchiveMilestone);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    fetchMilestones();
  }, []);

  // Archive state is orthogonal to status (same model as sprints): completed milestones
  // stay visible until archived; archived ones live behind the toggle.
  const visible = milestones.filter((m) => !m.archived_at);
  const active = visible.filter((m) => m.status !== 'completed');
  const completed = visible.filter((m) => m.status === 'completed');
  const archived = milestones.filter((m) => !!m.archived_at);

  const handleClose = async (id: number) => {
    await put(`/api/milestone/${id}`, { status: 'completed', progress: 100 });
    fetchMilestones();
  };

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', height: '100%' }}>
      {/* Active milestones */}
      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text3)',
            }}
          >
            Active Milestones
          </div>
          {!showCreate && (
            <button onClick={() => setShowCreate(true)} style={smallButton(false)}>
              New milestone
            </button>
          )}
        </div>
        {showCreate && <NewMilestoneForm onDone={() => setShowCreate(false)} />}
        {active.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text3)', padding: '20px 0' }}>
            No active milestones. Run{' '}
            <code
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                background: 'var(--surface2)',
                padding: '1px 6px',
                borderRadius: 4,
              }}
            >
              /kickoff
            </code>{' '}
            to create one.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {active.map((m) => (
              <MilestoneCard key={m.id} milestone={m} onClose={handleClose} />
            ))}
          </div>
        )}
      </div>

      {/* Completed, not yet archived */}
      {completed.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text3)',
              marginBottom: 14,
            }}
          >
            Completed ({completed.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {completed.map((m) => (
              <MilestoneCard
                key={m.id}
                milestone={m}
                onClose={handleClose}
                onArchive={archiveMilestone}
              />
            ))}
          </div>
        </div>
      )}

      {/* Archived milestones */}
      {archived.length > 0 && (
        <div>
          <button
            onClick={() => setShowArchived((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text3)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 0 14px',
              fontFamily: 'var(--font)',
            }}
          >
            <motion.span
              animate={{ rotate: showArchived ? 90 : 0 }}
              transition={{ duration: 0.15 }}
              style={{ display: 'inline-block' }}
            >
              ▶
            </motion.span>
            Archived ({archived.length})
          </button>
          <AnimatePresence>
            {showArchived && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                style={{ overflow: 'hidden' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {archived.map((m) => (
                    <MilestoneCard
                      key={m.id}
                      milestone={m}
                      onClose={handleClose}
                      onUnarchive={unarchiveMilestone}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Epics — same archive model: completed epics archivable, archived behind a toggle */}
      <div style={{ marginTop: 32 }}>
        <EpicList />
      </div>
    </div>
  );
}
