'use client';

import React, { useEffect, useState, type CSSProperties } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePlanningStore, type MilestoneStatus } from '@/stores/planningStore';
import { put } from '@/lib/api';
import { cx } from '@/lib/utils';
import type { Milestone } from '@/types';
import { EpicList } from '@/components/organisms/EpicList';

const smallButtonBase =
  'bg-transparent border border-line-2 rounded-[6px] py-[3px] px-[10px] text-11 font-semibold font-body';

const smallButton = (busy: boolean) =>
  cx(smallButtonBase, busy ? 'text-fg-3 cursor-not-allowed' : 'text-fg-2 cursor-pointer');

function ProgressBar({ value, color = 'var(--color-accent)' }: { value: number; color?: string }) {
  return (
    <div
      style={{ '--c': color } as CSSProperties}
      className="h-1 bg-surface-2 rounded-[2px] overflow-hidden"
    >
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, value)}%` }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="h-full bg-(--c) rounded-[2px]"
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
      style={{ '--c': color, '--cb': `${color}18` } as CSSProperties}
      className="bg-surface border border-line border-l-[3px] border-l-(--c) rounded-[12px] py-4 px-5 flex flex-col gap-[10px]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-14 font-bold text-fg mb-0.5">{milestone.name}</div>
          {milestone.description && (
            <div className="text-12 text-fg-3 leading-[1.5]">{milestone.description}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-10 font-bold uppercase tracking-[0.06em] py-0.5 px-2 rounded-[4px] bg-(--cb) text-(--c)">
            {milestone.status}
          </span>
          {!isArchived && !editing && (
            <button
              onClick={() => setEditing(true)}
              aria-label={`Edit ${milestone.name}`}
              className={smallButton(false)}
            >
              Edit
            </button>
          )}
          {isActive && !isArchived && (
            <button onClick={handleClose} disabled={closing} className={smallButton(closing)}>
              {closing ? '…' : 'Close'}
            </button>
          )}
          {/* Archive is offered once completed (server enforces the same rule);
              Unarchive is always available on an archived milestone. */}
          {((!isActive && !isArchived && onArchive) || (isArchived && onUnarchive)) && (
            <button
              onClick={handleArchiveToggle}
              disabled={archiving}
              className={smallButton(archiving)}
            >
              {archiving ? '…' : isArchived ? 'Unarchive' : 'Archive'}
            </button>
          )}
        </div>
      </div>

      {editing && <EditMilestoneForm milestone={milestone} onDone={() => setEditing(false)} />}

      <ProgressBar value={pct} color={color} />

      <div className="flex gap-5 text-11 text-fg-3">
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

const fieldClass =
  'bg-bg border border-line-2 rounded-[6px] py-[6px] px-[10px] text-12 text-fg font-body';

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
    <form onSubmit={submit} className="flex gap-2 items-center flex-wrap mb-[14px]">
      <input
        aria-label="Milestone name"
        placeholder="Milestone name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        className={cx(fieldClass, 'flex-[1_1_200px]')}
      />
      <input
        aria-label="Milestone target date"
        type="date"
        value={targetDate}
        onChange={(e) => setTargetDate(e.target.value)}
        className={fieldClass}
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className={smallButton(busy || !name.trim())}
      >
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" onClick={onDone} disabled={busy} className={smallButton(busy)}>
        Cancel
      </button>
      {error && (
        <div role="alert" className="w-full text-12 text-red">
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
    <form onSubmit={submit} className="flex gap-2 items-center flex-wrap">
      <select
        aria-label={`Status of ${milestone.name}`}
        value={status}
        onChange={(e) => setStatus(e.target.value as MilestoneStatus)}
        className={fieldClass}
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
        className={fieldClass}
      />
      <button type="submit" disabled={busy} className={smallButton(busy)}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={onDone} disabled={busy} className={smallButton(busy)}>
        Cancel
      </button>
      {error && (
        <div role="alert" className="w-full text-12 text-red">
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
    <div className="py-6 px-7 overflow-y-auto h-full">
      {/* Active milestones */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-[14px]">
          <div className="text-11 font-bold uppercase tracking-[0.08em] text-fg-3">
            Active Milestones
          </div>
          {!showCreate && (
            <button onClick={() => setShowCreate(true)} className={smallButton(false)}>
              New milestone
            </button>
          )}
        </div>
        {showCreate && <NewMilestoneForm onDone={() => setShowCreate(false)} />}
        {active.length === 0 ? (
          <div className="text-13 text-fg-3 py-5">
            No active milestones. Run{' '}
            <code className="font-code text-12 bg-surface-2 py-px px-1.5 rounded-[4px]">
              /kickoff
            </code>{' '}
            to create one.
          </div>
        ) : (
          <div className="flex flex-col gap-[10px]">
            {active.map((m) => (
              <MilestoneCard key={m.id} milestone={m} onClose={handleClose} />
            ))}
          </div>
        )}
      </div>

      {/* Completed, not yet archived */}
      {completed.length > 0 && (
        <div className="mb-8">
          <div className="text-11 font-bold uppercase tracking-[0.08em] text-fg-3 mb-[14px]">
            Completed ({completed.length})
          </div>
          <div className="flex flex-col gap-[10px]">
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
            className="bg-transparent border-none cursor-pointer text-11 font-bold uppercase tracking-[0.08em] text-fg-3 flex items-center gap-1.5 p-0 pb-[14px] font-body"
          >
            <motion.span
              animate={{ rotate: showArchived ? 90 : 0 }}
              transition={{ duration: 0.15 }}
              className="inline-block"
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
                className="overflow-hidden"
              >
                <div className="flex flex-col gap-[10px]">
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
      <div className="mt-8">
        <EpicList />
      </div>
    </div>
  );
}
