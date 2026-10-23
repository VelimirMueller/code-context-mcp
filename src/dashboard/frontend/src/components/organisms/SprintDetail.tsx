'use client';

import { useState, useEffect, type CSSProperties } from 'react';
import { useSprintStore } from '@/stores/sprintStore';
import { usePlanningStore } from '@/stores/planningStore';
import { patch, put, get } from '@/lib/api';
import { KanbanBoard } from './KanbanBoard';
import { BurndownChart } from './BurndownChart';
import { SprintCompletionPanel } from './SprintCompletionPanel';
import { PHASE_ORDER, getPhaseStyle, getPhaseLabel } from '@/lib/phases';
import { PhaseGateStepper } from '../molecules/PhaseGateStepper';
import { Badge } from '@/components/atoms/Badge';
import type { RetroFinding } from '@/types';
import { cx, hideArchived } from '@/lib/utils';

interface GateInfo {
  gate: string;
  passed: boolean;
  detail: string;
}
interface GateStatus {
  sprint_id: number;
  phase: string;
  next_phase: string | null;
  gates: GateInfo[];
  all_passed: boolean;
}

interface SprintDetailProps {
  onNavigate?: (tab: string) => void;
}

export function SprintDetail({ onNavigate }: SprintDetailProps = {}) {
  const sprintDetail = useSprintStore((s) => s.sprintDetail);
  const tickets = useSprintStore((s) => s.tickets);
  const retroFindings = useSprintStore((s) => s.selectedRetroFindings);
  const loading = useSprintStore((s) => s.loading.detail);
  const selectedSprintId = useSprintStore((s) => s.selectedSprintId);
  const selectSprint = useSprintStore((s) => s.selectSprint);
  const archiveSprint = useSprintStore((s) => s.archiveSprint);
  const unarchiveSprint = useSprintStore((s) => s.unarchiveSprint);
  const milestones = usePlanningStore((s) => s.milestones);
  const fetchMilestones = usePlanningStore((s) => s.fetchMilestones);
  const [milestoneUpdating, setMilestoneUpdating] = useState(false);

  useEffect(() => {
    if (milestones.length === 0) fetchMilestones();
  }, [milestones.length, fetchMilestones]);

  if (!selectedSprintId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-14 text-fg-3">
        <div className="text-32">☰</div>
        Select a sprint from the list
      </div>
    );
  }

  if (loading && !sprintDetail) {
    return (
      <div className="flex-1 p-5">
        <div className="mb-3 h-6 w-1/2 rounded-[6px] bg-surface-2" />
        <div className="h-4 w-4/5 rounded-[6px] bg-surface-2" />
      </div>
    );
  }

  if (!sprintDetail) return null;

  const doneCount = tickets.filter((t) => t.status === 'DONE').length;
  const totalCount = tickets.length;
  const totalPts = tickets.reduce((s, t) => s + (t.story_points ?? 0), 0);
  const donePts = tickets
    .filter((t) => t.status === 'DONE')
    .reduce((s, t) => s + (t.story_points ?? 0), 0);
  const velPct = totalPts > 0 ? Math.round((donePts / totalPts) * 100) : 0;
  const velWidth = `${velPct}%`;

  const countByStatus = (status: string) => tickets.filter((t) => t.status === status).length;
  const doneRatio =
    tickets.length > 0 ? tickets.filter((t) => t.status === 'DONE').length / tickets.length : 0;

  const phaseStyle = getPhaseStyle(sprintDetail.status);
  const statusColor = phaseStyle.bg;

  const isArchived = sprintDetail.archived_at !== null;
  const canArchive = ['closed', 'rest', 'done'].includes(sprintDetail.status);

  const handleArchiveToggle = async () => {
    if (!sprintDetail) return;
    const wasArchived = sprintDetail.archived_at !== null;
    if (wasArchived) {
      await unarchiveSprint(sprintDetail.id);
    } else {
      await archiveSprint(sprintDetail.id);
    }
    // Deliberately keep the sprint selected after archiving: the Archived badge +
    // Unarchive button make the action visible and instantly reversible in place.
  };

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      {/* Sprint header */}
      <div className="mb-3.5 flex items-center justify-between">
        <div>
          <div className="text-18 font-bold text-fg">{sprintDetail.name}</div>
          <div className="mt-0.5 font-code text-12 text-fg-3">
            {doneCount}/{totalCount} shipped · {donePts}/{totalPts}pt · {velPct}% complete
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isArchived && <Badge text="Archived" variant="default" />}
          {(isArchived || canArchive) && (
            <button
              onClick={handleArchiveToggle}
              className="cursor-pointer rounded-[6px] border border-line bg-surface px-2.5 py-[3px] font-body text-11 text-fg-2"
            >
              {isArchived ? 'Unarchive' : 'Archive'}
            </button>
          )}
          <select
            value={sprintDetail.milestone_id ?? ''}
            disabled={milestoneUpdating}
            onChange={async (e) => {
              const val = e.target.value;
              const newMilestoneId = val === '' ? null : Number(val);
              setMilestoneUpdating(true);
              try {
                await patch(`/api/sprint/${sprintDetail.id}/milestone`, {
                  milestone_id: newMilestoneId,
                });
                if (selectedSprintId) await selectSprint(selectedSprintId);
              } finally {
                setMilestoneUpdating(false);
              }
            }}
            className={cx(
              'max-w-40 cursor-pointer rounded-[6px] border border-line bg-surface px-2 py-[3px] font-body text-11 text-fg-2',
              milestoneUpdating ? 'opacity-50' : 'opacity-100',
            )}
          >
            <option value="">No milestone</option>
            {hideArchived(milestones, sprintDetail.milestone_id).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div
            className="rounded-[6px] bg-(--c) px-2.5 py-[3px] text-11 font-bold text-[white] uppercase"
            style={{ '--c': statusColor } as CSSProperties}
          >
            {getPhaseLabel(sprintDetail.status)}
          </div>
        </div>
      </div>

      {/* Phase Gate Stepper */}
      <div className="mb-3.5 rounded-[8px] border border-line bg-surface px-3.5 py-2.5">
        <PhaseGateStepper
          currentPhase={sprintDetail.status}
          sprintId={sprintDetail.id}
          updatedAt={sprintDetail.updated_at}
        />
      </div>

      {/* Gate Status Indicators */}
      <GateStatusBar sprintId={sprintDetail.id} phase={sprintDetail.status} />

      {/* Sprint goal */}
      {sprintDetail.goal && (
        <div className="mb-4 rounded-[8px] border-l-[3px] border-l-accent bg-bg px-3.5 py-2.5 text-13 text-fg-2">
          {sprintDetail.goal}
        </div>
      )}

      {/* Metrics row */}
      <div className="mb-4 grid grid-cols-[repeat(5,1fr)] gap-2">
        {/* Velocity */}
        <div className="rounded-[8px] border border-line bg-surface p-2.5 text-center">
          <div className="mb-1 text-10 font-semibold text-fg-3 uppercase">Velocity</div>
          <div className="text-18 font-bold">
            {donePts}/{totalPts}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-[2px] bg-line">
            <div className="h-full bg-accent" style={{ width: velWidth }} />
          </div>
        </div>

        {/* Status counts */}
        {(['TODO', 'IN_PROGRESS', 'DONE', 'NOT_DONE'] as const).map((status) => {
          const labels: Record<string, string> = {
            TODO: 'TODO',
            IN_PROGRESS: 'PROGRESS',
            DONE: 'DONE',
            NOT_DONE: 'NOT DONE',
          };
          const colors: Record<string, string> = {
            TODO: 'text-fg-3',
            IN_PROGRESS: 'text-blue',
            DONE: 'text-green',
            NOT_DONE: 'text-red',
          };
          return (
            <div
              key={status}
              className="rounded-[8px] border border-line bg-surface p-2.5 text-center"
            >
              <div className={cx('mb-1 text-10 font-semibold', colors[status])}>
                {labels[status]}
              </div>
              <div className="text-18 font-bold">{countByStatus(status)}</div>
            </div>
          );
        })}
      </div>

      {/* Burndown chart */}
      <BurndownChart sprintId={sprintDetail.id} />

      {/* Kanban board */}
      <KanbanBoard tickets={tickets} />

      {/* Planning Summary */}
      <div className="mt-4 rounded-card border border-line bg-surface px-4 py-3.5">
        <div className="mb-2.5 text-13 font-semibold text-fg">Sprint Planning</div>
        <div className="grid grid-cols-[repeat(3,1fr)] gap-3">
          <div>
            <div className="mb-0.5 text-10 font-semibold text-fg-3 uppercase">Committed</div>
            <div className="font-code text-16 font-bold">{sprintDetail.velocity_committed}sp</div>
          </div>
          <div>
            <div className="mb-0.5 text-10 font-semibold text-fg-3 uppercase">Completed</div>
            <div className="font-code text-16 font-bold text-green">{donePts}sp</div>
          </div>
          <div>
            <div className="mb-0.5 text-10 font-semibold text-fg-3 uppercase">Team</div>
            <div className="font-code text-16 font-bold">
              {new Set(tickets.map((t) => t.assigned_to).filter(Boolean)).size} members
            </div>
          </div>
        </div>
        {(sprintDetail.start_date || sprintDetail.end_date) && (
          <div className="mt-2 font-code text-11 text-fg-3">
            {sprintDetail.start_date ?? '?'} → {sprintDetail.end_date ?? '?'}
          </div>
        )}
      </div>

      {/* Sprint Completion Panel */}
      <SprintCompletionPanel
        sprint={sprintDetail}
        tickets={{
          total: tickets.length,
          done: tickets.filter((t) => t.status === 'DONE').length,
          qaVerified: tickets.filter((t) => !!t.qa_verified).length,
          items: tickets,
        }}
        retroFindings={{ count: retroFindings.length, hasFindings: retroFindings.length > 0 }}
      />

      {/* Retro Findings */}
      <RetroInline />
    </div>
  );
}

function RetroInline() {
  const findings = useSprintStore((s) => s.selectedRetroFindings);
  const [expanded, setExpanded] = useState(false);

  if (findings.length === 0) return null;

  const well = findings.filter((f: RetroFinding) => f.category === 'went_well');
  const wrong = findings.filter((f: RetroFinding) => f.category === 'went_wrong');
  const tryNext = findings.filter((f: RetroFinding) => f.category === 'try_next');
  const auto = findings.filter((f: RetroFinding) => f.category === 'auto_analysis');

  const categories = [
    {
      items: well,
      label: 'Went Well',
      text: 'text-accent',
      dot: 'bg-accent',
      edge: 'border-l-accent',
    },
    { items: wrong, label: 'Went Wrong', text: 'text-red', dot: 'bg-red', edge: 'border-l-red' },
    {
      items: tryNext,
      label: 'Try Next',
      text: 'text-accent-2',
      dot: 'bg-accent-2',
      edge: 'border-l-accent-2',
    },
    {
      items: auto,
      label: 'Auto Analysis',
      text: 'text-blue',
      dot: 'bg-blue',
      edge: 'border-l-blue',
    },
  ];

  return (
    <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center gap-2.5 border-none bg-transparent px-4 py-3.5 font-body [transition:background_.15s] hover:bg-bg"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className={cx(
            'shrink-0 [transition:transform_.2s]',
            expanded ? '[transform:rotate(90deg)]' : '[transform:none]',
          )}
        >
          <path
            d="M5 2.5L9.5 7L5 11.5"
            stroke="var(--text3)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-13 font-semibold text-fg">Retro Findings</span>
        <span className="rounded-[10px] bg-bg px-2 py-px font-code text-11 text-fg-3">
          {findings.length}
        </span>
        <div className="ml-auto flex gap-1.5">
          {categories.map(
            ({ items, dot, label }) =>
              items.length > 0 && (
                <span key={label} className="flex items-center gap-[3px] text-10 text-fg-3">
                  <span className={cx('h-1.5 w-1.5 shrink-0 rounded-[50%]', dot)} />
                  {items.length}
                </span>
              ),
          )}
        </div>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pt-0 pb-3.5">
          {categories.map(
            ({ items, label, text, dot, edge }) =>
              items.length > 0 && (
                <div key={label}>
                  <div className={cx('mb-2 flex items-center gap-1.5 text-11 font-semibold', text)}>
                    <span className={cx('h-2 w-2 shrink-0 rounded-[50%]', dot)} />
                    {label}
                    <span className="font-code font-normal text-fg-3">({items.length})</span>
                  </div>
                  {items.map((f: RetroFinding, i: number) => (
                    <div
                      key={f.id ?? i}
                      className={cx(
                        'mb-1 rounded-[6px] border-l-[3px] bg-bg px-3 py-2 text-12 leading-[1.5] text-fg-2',
                        edge,
                      )}
                    >
                      {f.finding}
                      {f.action_owner && (
                        <span className="ml-2 font-code text-10 text-fg-3">— {f.action_owner}</span>
                      )}
                    </div>
                  ))}
                </div>
              ),
          )}
        </div>
      )}
    </div>
  );
}

function GateStatusBar({ sprintId, phase }: { sprintId: number; phase: string }) {
  const [gateStatus, setGateStatus] = useState<GateStatus | null>(null);

  useEffect(() => {
    get<GateStatus>(`/api/sprint/${sprintId}/gates`)
      .then(setGateStatus)
      .catch(() => setGateStatus(null));
  }, [sprintId, phase]);

  if (!gateStatus || !gateStatus.gates.length) return null;

  const GATE_LABELS: Record<string, string> = {
    tickets_assigned: 'Tickets Assigned',
    all_tickets_done: 'All Tickets Done',
    qa_verified: 'QA Verified',
    velocity_set: 'Velocity Recorded',
    retro_findings: 'Retro Findings',
  };

  return (
    <div className="mb-3.5 rounded-[8px] border border-line bg-surface px-3.5 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-11 font-semibold tracking-[0.05em] text-fg-3 uppercase">
          Gates for {phase} → {gateStatus.next_phase}
        </span>
        <span
          className={cx(
            'rounded-[10px] px-2 py-px text-10 font-bold',
            gateStatus.all_passed
              ? 'bg-[rgba(16,185,129,.15)] text-green'
              : 'bg-[rgba(239,68,68,.15)] text-red',
          )}
        >
          {gateStatus.all_passed ? 'READY' : 'BLOCKED'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {gateStatus.gates.map((g) => (
          <div
            key={g.gate}
            className={cx(
              'flex items-center gap-1 rounded-[6px] border px-2.5 py-[3px] text-11',
              g.passed
                ? 'border-[rgba(16,185,129,.2)] bg-[rgba(16,185,129,.08)] text-green'
                : 'border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] text-red',
            )}
          >
            <span>{g.passed ? '✓' : '✗'}</span>
            <span className="font-semibold">{GATE_LABELS[g.gate] || g.gate}</span>
            <span className="text-10 text-fg-3">({g.detail})</span>
          </div>
        ))}
      </div>
    </div>
  );
}
