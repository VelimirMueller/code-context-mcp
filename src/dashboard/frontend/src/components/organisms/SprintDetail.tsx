'use client';

import { useState, useEffect } from 'react';
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
import { hideArchived } from '@/lib/utils';

interface GateInfo { gate: string; passed: boolean; detail: string }
interface GateStatus { sprint_id: number; phase: string; next_phase: string | null; gates: GateInfo[]; all_passed: boolean }

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
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text3)',
          fontSize: 14,
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 32 }}>☰</div>
        Select a sprint from the list
      </div>
    );
  }

  if (loading && !sprintDetail) {
    return (
      <div style={{ flex: 1, padding: 20 }}>
        <div
          style={{
            height: 24,
            width: '50%',
            background: 'var(--surface2)',
            borderRadius: 6,
            marginBottom: 12,
          }}
        />
        <div
          style={{
            height: 16,
            width: '80%',
            background: 'var(--surface2)',
            borderRadius: 6,
          }}
        />
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

  const countByStatus = (status: string) => tickets.filter((t) => t.status === status).length;
  const doneRatio =
    tickets.length > 0
      ? tickets.filter((t) => t.status === 'DONE').length / tickets.length
      : 0;

  const phaseStyle = getPhaseStyle(sprintDetail.status);
  const statusColor = phaseStyle.bg;

  const isArchived = sprintDetail.archived_at !== null;
  const canArchive = ['closed', 'rest', 'done'].includes(sprintDetail.status);

  const handleArchiveToggle = async () => {
    if (!sprintDetail) return;
    const wasArchived = sprintDetail.archived_at !== null;
    if (wasArchived) { await unarchiveSprint(sprintDetail.id); } else { await archiveSprint(sprintDetail.id); }
    // Deliberately keep the sprint selected after archiving: the Archived badge +
    // Unarchive button make the action visible and instantly reversible in place.
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
      {/* Sprint header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
            {sprintDetail.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
            {doneCount}/{totalCount} shipped · {donePts}/{totalPts}pt · {velPct}% complete
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isArchived && <Badge text="Archived" variant="default" />}
          {(isArchived || canArchive) && (
            <button
              onClick={handleArchiveToggle}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '3px 10px',
                fontSize: 11,
                color: 'var(--text2)',
                fontFamily: 'var(--font)',
                cursor: 'pointer',
              }}
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
                await patch(`/api/sprint/${sprintDetail.id}/milestone`, { milestone_id: newMilestoneId });
                if (selectedSprintId) await selectSprint(selectedSprintId);
              } finally {
                setMilestoneUpdating(false);
              }
            }}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '3px 8px',
              fontSize: 11,
              color: 'var(--text2)',
              fontFamily: 'var(--font)',
              cursor: 'pointer',
              maxWidth: 160,
              opacity: milestoneUpdating ? 0.5 : 1,
            }}
          >
            <option value="">No milestone</option>
            {hideArchived(milestones, sprintDetail.milestone_id).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <div
            style={{
              padding: '3px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              background: statusColor,
              color: 'white',
            }}
          >
            {getPhaseLabel(sprintDetail.status)}
          </div>
        </div>
      </div>

      {/* Phase Gate Stepper */}
      <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
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
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--bg)',
            borderRadius: 8,
            borderLeft: '3px solid var(--accent)',
            fontSize: 13,
            color: 'var(--text2)',
            marginBottom: 16,
          }}
        >
          {sprintDetail.goal}
        </div>
      )}

      {/* Metrics row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {/* Velocity */}
        <div
          style={{
            padding: 10,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: 'var(--text3)',
              fontWeight: 600,
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Velocity
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {donePts}/{totalPts}
          </div>
          <div
            style={{
              height: 4,
              background: 'var(--border)',
              borderRadius: 2,
              overflow: 'hidden',
              marginTop: 6,
            }}
          >
            <div
              style={{ height: '100%', width: `${velPct}%`, background: 'var(--accent)' }}
            />
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
            TODO: 'var(--text3)',
            IN_PROGRESS: 'var(--blue)',
            DONE: 'var(--green)',
            NOT_DONE: 'var(--red)',
          };
          return (
            <div
              key={status}
              style={{
                padding: 10,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: colors[status],
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                {labels[status]}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{countByStatus(status)}</div>
            </div>
          );
        })}
      </div>

      {/* Burndown chart */}
      <BurndownChart sprintId={sprintDetail.id} />

      {/* Kanban board */}
      <KanbanBoard tickets={tickets} />

      {/* Planning Summary */}
      <div
        style={{
          marginTop: 16,
          padding: '14px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>
          Sprint Planning
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 2 }}>Committed</div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)' }}>{sprintDetail.velocity_committed}sp</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 2 }}>Completed</div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{donePts}sp</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 2 }}>Team</div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)' }}>
              {new Set(tickets.map(t => t.assigned_to).filter(Boolean)).size} members
            </div>
          </div>
        </div>
        {(sprintDetail.start_date || sprintDetail.end_date) && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            {sprintDetail.start_date ?? '?'} → {sprintDetail.end_date ?? '?'}
          </div>
        )}
      </div>

      {/* Sprint Completion Panel */}
      <SprintCompletionPanel
        sprint={sprintDetail}
        tickets={{
          total: tickets.length,
          done: tickets.filter(t => t.status === 'DONE').length,
          qaVerified: tickets.filter(t => !!t.qa_verified).length,
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
    { items: well, label: 'Went Well', color: 'var(--accent)', dot: 'var(--accent)' },
    { items: wrong, label: 'Went Wrong', color: 'var(--red)', dot: 'var(--red)' },
    { items: tryNext, label: 'Try Next', color: 'var(--purple)', dot: 'var(--purple)' },
    { items: auto, label: 'Auto Analysis', color: 'var(--blue)', dot: 'var(--blue)' },
  ];

  return (
    <div style={{ marginTop: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '14px 16px',
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', fontFamily: 'var(--font)',
          transition: 'background .15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}>
          <path d="M5 2.5L9.5 7L5 11.5" stroke="var(--text3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Retro Findings</span>
        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', background: 'var(--bg)', padding: '1px 8px', borderRadius: 10 }}>{findings.length}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {categories.map(({ items, dot, label }) => items.length > 0 && (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text3)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
              {items.length}
            </span>
          ))}
        </div>
      </button>
      {expanded && (
        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
          {categories.map(({ items, label, color }) => items.length > 0 && (
            <div key={label}>
              <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                {label}
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 400, color: 'var(--text3)' }}>({items.length})</span>
              </div>
              {items.map((f: RetroFinding, i: number) => (
                <div key={f.id ?? i} style={{ padding: '8px 12px', background: 'var(--bg)', borderRadius: 6, fontSize: 12, color: 'var(--text2)', marginBottom: 4, borderLeft: `3px solid ${color}`, lineHeight: 1.5 }}>
                  {f.finding}
                  {f.action_owner && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 8, fontFamily: 'var(--mono)' }}>— {f.action_owner}</span>}
                </div>
              ))}
            </div>
          ))}
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
    tickets_assigned: "Tickets Assigned",
    all_tickets_done: "All Tickets Done",
    qa_verified: "QA Verified",
    velocity_set: "Velocity Recorded",
    retro_findings: "Retro Findings",
  };

  return (
    <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Gates for {phase} → {gateStatus.next_phase}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 10,
          background: gateStatus.all_passed ? 'rgba(16,185,129,.15)' : 'rgba(239,68,68,.15)',
          color: gateStatus.all_passed ? 'var(--green)' : 'var(--red)',
        }}>
          {gateStatus.all_passed ? 'READY' : 'BLOCKED'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {gateStatus.gates.map((g) => (
          <div key={g.gate} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 10px', borderRadius: 6, fontSize: 11,
            background: g.passed ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)',
            border: `1px solid ${g.passed ? 'rgba(16,185,129,.2)' : 'rgba(239,68,68,.2)'}`,
            color: g.passed ? 'var(--green)' : 'var(--red)',
          }}>
            <span>{g.passed ? '✓' : '✗'}</span>
            <span style={{ fontWeight: 600 }}>{GATE_LABELS[g.gate] || g.gate}</span>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>({g.detail})</span>
          </div>
        ))}
      </div>
    </div>
  );
}
