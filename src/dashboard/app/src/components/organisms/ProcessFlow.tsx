'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSprintStore } from '@/stores/sprintStore';
import { usePlanningStore } from '@/stores/planningStore';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type StepStatus = 'completed' | 'active' | 'pending' | 'blocked';

interface FlowStep {
  id: string;
  label: string;
  description: string;
  icon: string;
  status: StepStatus;
}

interface ProcessFlowStepConfig {
  id: string;
  label: string;
  description: string;
  icon: string;
}

/* ------------------------------------------------------------------ */
/*  Step definitions                                                   */
/* ------------------------------------------------------------------ */

const STEP_CONFIGS: ProcessFlowStepConfig[] = [
  {
    id: 'vision',
    label: 'Vision',
    description: 'Define the product vision, goals, and strategic direction for the team.',
    icon: 'vision',
  },
  {
    id: 'discovery',
    label: 'Discovery',
    description: 'Explore architecture, UX, performance, and integration findings before committing work.',
    icon: 'discovery',
  },
  {
    id: 'milestone',
    label: 'Milestone',
    description: 'Set milestones with target dates to structure delivery checkpoints.',
    icon: 'milestone',
  },
  {
    id: 'epics',
    label: 'Epics',
    description: 'Break milestones into epics -- large feature groupings with clear scope.',
    icon: 'epics',
  },
  {
    id: 'tickets',
    label: 'Tickets',
    description: 'Decompose epics into concrete, assignable tickets with story points.',
    icon: 'tickets',
  },
  {
    id: 'sprint',
    label: 'Sprint',
    description: 'Plan and launch a sprint by selecting tickets and committing velocity.',
    icon: 'sprint',
  },
  {
    id: 'implementation',
    label: 'Implementation',
    description: 'Execute sprint work: build features, fix bugs, daily standups, QA verification.',
    icon: 'implementation',
  },
  {
    id: 'retro',
    label: 'Retro',
    description: 'Reflect on what went well, what went wrong, and what to try next sprint.',
    icon: 'retro',
  },
  {
    id: 'archive',
    label: 'Archive',
    description: 'Close the sprint, archive decisions, and prepare the team for rest or the next cycle.',
    icon: 'archive',
  },
];

/* ------------------------------------------------------------------ */
/*  Status detection                                                   */
/* ------------------------------------------------------------------ */

function deriveStepStatus(
  stepId: string,
  hasVision: boolean,
  hasDiscoveries: boolean,
  hasMilestones: boolean,
  hasEpics: boolean,
  hasBacklogTickets: boolean,
  hasActiveSprint: boolean,
  sprintStatus: string | null,
  sprintHasBlockers: boolean,
): StepStatus {
  // Map sprint status to which flow step is "active"
  // Order: vision -> discovery -> milestone -> epics -> tickets -> sprint -> implementation -> retro -> archive

  const activeSprintPhase = sprintStatus?.toLowerCase() ?? '';

  // Determine the "highest" completed step
  const completedUpTo = (() => {
    if (!hasVision) return -1;                  // nothing done yet
    if (!hasDiscoveries) return 0;              // vision done
    if (!hasMilestones) return 1;               // discovery done
    if (!hasEpics) return 2;                    // milestone done
    if (!hasBacklogTickets) return 3;           // epics done
    if (!hasActiveSprint) return 4;             // tickets done
    if (activeSprintPhase === 'preparation' || activeSprintPhase === 'kickoff' || activeSprintPhase === 'planning') return 5; // sprint created
    if (activeSprintPhase === 'implementation' || activeSprintPhase === 'qa' || activeSprintPhase === 'refactoring') return 6; // implementation
    if (activeSprintPhase === 'retro' || activeSprintPhase === 'review') return 7; // retro
    if (activeSprintPhase === 'closed' || activeSprintPhase === 'done' || activeSprintPhase === 'rest') return 8; // archived
    return 4; // default: tickets created, no active sprint
  })();

  const stepIndex = STEP_CONFIGS.findIndex((s) => s.id === stepId);

  if (stepIndex < completedUpTo) {
    return 'completed';
  }
  if (stepIndex === completedUpTo) {
    // This is the current active step
    if (stepId === 'implementation' && sprintHasBlockers) {
      return 'blocked';
    }
    return 'active';
  }
  return 'pending';
}

/* ------------------------------------------------------------------ */
/*  SVG Icons                                                          */
/* ------------------------------------------------------------------ */

function StepIcon({ type, status }: { type: string; status: StepStatus }) {
  const color =
    status === 'completed'
      ? '#10b981'
      : status === 'active'
        ? '#60a5fa'
        : status === 'blocked'
          ? '#f87171'
          : 'var(--text3)';

  const icons: Record<string, React.ReactNode> = {
    vision: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      </svg>
    ),
    discovery: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    milestone: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    ),
    epics: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
    tickets: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    sprint: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    implementation: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    retro: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
    archive: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="21 8 21 21 3 21 3 8" />
        <rect x="1" y="3" width="22" height="5" rx="1" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    ),
  };

  return <>{icons[type] ?? icons.sprint}</>;
}

/* ------------------------------------------------------------------ */
/*  Status indicator                                                   */
/* ------------------------------------------------------------------ */

function StatusIndicator({ status }: { status: StepStatus }) {
  if (status === 'completed') {
    return (
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#10b981',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }

  if (status === 'active') {
    return (
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: '2px solid #60a5fa',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        />
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#60a5fa',
            animation: 'pf-active-pulse 1.5s ease-in-out infinite',
          }}
        />
      </div>
    );
  }

  if (status === 'blocked') {
    return (
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#f87171',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
          <line x1="3" y1="3" x2="9" y2="9" stroke="white" strokeWidth="2" strokeLinecap="round" />
          <line x1="9" y1="3" x2="3" y2="9" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    );
  }

  // pending
  return (
    <div
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        border: '2px solid var(--border2)',
        flexShrink: 0,
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Animated connector line                                            */
/* ------------------------------------------------------------------ */

function FlowConnector({ status }: { status: StepStatus }) {
  const color =
    status === 'completed'
      ? '#10b981'
      : status === 'active'
        ? '#60a5fa'
        : status === 'blocked'
          ? '#f87171'
          : 'var(--border2)';

  return (
    <div
      style={{
        flex: 1,
        minWidth: 24,
        height: 2,
        background: status === 'active'
          ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 8px)`
          : color,
        alignSelf: 'center',
        position: 'relative',
        ...(status === 'active' ? { animation: 'pf-connector-march 0.6s linear infinite' } : {}),
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Vertical connector (mobile)                                        */
/* ------------------------------------------------------------------ */

function FlowConnectorVertical({ status }: { status: StepStatus }) {
  const color =
    status === 'completed'
      ? '#10b981'
      : status === 'active'
        ? '#60a5fa'
        : status === 'blocked'
          ? '#f87171'
          : 'var(--border2)';

  return (
    <div
      style={{
        width: 2,
        height: 20,
        minHeight: 20,
        flexShrink: 0,
        background: status === 'active'
          ? `repeating-linear-gradient(180deg, ${color} 0 4px, transparent 4px 8px)`
          : color,
        alignSelf: 'center',
        ...(status === 'active' ? { animation: 'pf-connector-march-v 0.6s linear infinite' } : {}),
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Tooltip                                                            */
/* ------------------------------------------------------------------ */

function Tooltip({ children, text }: { children: React.ReactNode; text: string }) {
  const [show, setShow] = useState(false);

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 10px)',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--surface3)',
              border: '1px solid var(--border2)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 11,
              color: 'var(--text2)',
              fontFamily: 'var(--font)',
              lineHeight: 1.5,
              whiteSpace: 'nowrap',
              maxWidth: 240,
              zIndex: 50,
              pointerEvents: 'none',
              boxShadow: '0 4px 16px rgba(0,0,0,.3)',
            }}
          >
            {text}
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '5px solid transparent',
                borderRight: '5px solid transparent',
                borderTop: '5px solid var(--border2)',
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step card (horizontal mode)                                        */
/* ------------------------------------------------------------------ */

function FlowStepHorizontal({
  step,
  index,
  onStepClick,
}: {
  step: FlowStep;
  index: number;
  onStepClick?: (stepId: string) => void;
}) {
  const borderColor =
    step.status === 'completed'
      ? '#10b981'
      : step.status === 'active'
        ? '#60a5fa'
        : step.status === 'blocked'
          ? '#f87171'
          : 'var(--border)';

  const bgColor =
    step.status === 'active'
      ? 'rgba(59,130,246,.08)'
      : step.status === 'blocked'
        ? 'rgba(248,113,113,.08)'
        : 'var(--surface)';

  const labelColor =
    step.status === 'completed'
      ? '#10b981'
      : step.status === 'active'
        ? '#60a5fa'
        : step.status === 'blocked'
          ? '#f87171'
          : 'var(--text3)';

  const isClickable = onStepClick && (step.status === 'completed' || step.status === 'active');

  return (
    <Tooltip text={step.description}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={isClickable ? { scale: 1.06 } : undefined}
        whileTap={isClickable ? { scale: 0.97 } : undefined}
        transition={{ delay: index * 0.05, duration: 0.25 }}
        onClick={isClickable ? () => onStepClick(step.id) : undefined}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          width: 100,
          flexShrink: 0,
          cursor: isClickable ? 'pointer' : 'default',
        }}
      >
        {/* Icon circle */}
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: bgColor,
            border: `2px solid ${borderColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.3s ease',
            ...(step.status === 'active'
              ? { boxShadow: `0 0 16px rgba(59,130,246,.25)` }
              : step.status === 'blocked'
                ? { boxShadow: `0 0 16px rgba(248,113,113,.2)` }
                : {}),
          }}
        >
          <StepIcon type={step.icon} status={step.status} />
        </div>

        {/* Status dot */}
        <StatusIndicator status={step.status} />

        {/* Label */}
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            fontFamily: 'var(--font)',
            color: labelColor,
            textAlign: 'center',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            lineHeight: 1.3,
          }}
        >
          {step.label}
        </span>
      </motion.div>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/*  Step card (vertical / mobile mode)                                 */
/* ------------------------------------------------------------------ */

function FlowStepVertical({
  step,
  index,
  onStepClick,
}: {
  step: FlowStep;
  index: number;
  onStepClick?: (stepId: string) => void;
}) {
  const borderColor =
    step.status === 'completed'
      ? '#10b981'
      : step.status === 'active'
        ? '#60a5fa'
        : step.status === 'blocked'
          ? '#f87171'
          : 'var(--border)';

  const bgColor =
    step.status === 'active'
      ? 'rgba(59,130,246,.08)'
      : step.status === 'blocked'
        ? 'rgba(248,113,113,.08)'
        : 'var(--surface)';

  const labelColor =
    step.status === 'completed'
      ? '#10b981'
      : step.status === 'active'
        ? '#60a5fa'
        : step.status === 'blocked'
          ? '#f87171'
          : 'var(--text3)';

  const isClickable = onStepClick && (step.status === 'completed' || step.status === 'active');

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={isClickable ? { scale: 1.02 } : undefined}
      whileTap={isClickable ? { scale: 0.98 } : undefined}
      transition={{ delay: index * 0.04, duration: 0.25 }}
      onClick={isClickable ? () => onStepClick(step.id) : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 16px',
        background: bgColor,
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--radius)',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'all 0.3s ease',
        ...(step.status === 'active'
          ? { boxShadow: '0 0 16px rgba(59,130,246,.15)' }
          : step.status === 'blocked'
            ? { boxShadow: '0 0 16px rgba(248,113,113,.12)' }
            : {}),
      }}
    >
      {/* Icon circle */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: bgColor,
          border: `2px solid ${borderColor}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <StepIcon type={step.icon} status={step.status} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'var(--font)',
            color: labelColor,
            letterSpacing: '-0.01em',
          }}
        >
          {step.label}
        </div>
        <div
          style={{
            fontSize: 10.5,
            fontFamily: 'var(--font)',
            color: 'var(--text3)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {step.description}
        </div>
      </div>

      {/* Status indicator */}
      <StatusIndicator status={step.status} />
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Keyframes (injected once)                                          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'process-flow-lifecycle-keyframes';

function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes pf-active-pulse {
      0%, 100% { opacity: 0.5; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1); }
    }
    @keyframes pf-connector-march {
      to { background-position: 8px 0; }
    }
    @keyframes pf-connector-march-v {
      to { background-position: 0 8px; }
    }
  `;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

interface ProcessFlowProps {
  onStepClick?: (stepId: string) => void;
}

export function ProcessFlow({ onStepClick }: ProcessFlowProps) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    ensureKeyframes();
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Gather data from stores
  const vision = usePlanningStore((s) => s.vision);
  const milestones = usePlanningStore((s) => s.milestones);
  const backlog = usePlanningStore((s) => s.backlog);
  const discoveries = usePlanningStore((s) => s.discoveries);
  const sprints = useSprintStore((s) => s.sprints);
  const sprintDetail = useSprintStore((s) => s.sprintDetail);
  const blockers = useSprintStore((s) => s.blockers);

  // Fetch vision if we don't have it
  useEffect(() => {
    if (vision === null) {
      usePlanningStore.getState().fetchVision();
    }
  }, [vision]);

  // Derived booleans
  const hasVision = useMemo(() => !!vision && vision.trim().length > 0, [vision]);
  const hasDiscoveries = useMemo(() => discoveries.length > 0, [discoveries]);
  const hasMilestones = useMemo(() => milestones.length > 0, [milestones]);

  // Check for epics via backlog having epic_id set, or use a heuristic
  // Since we don't have a dedicated epics store fetch here, check backlog for epic linkage
  const hasEpics = useMemo(() => {
    // If any backlog ticket has an epic_id, or if sprints have tickets with epics
    return backlog.some((t) => t.epic_id != null);
  }, [backlog]);

  const hasBacklogTickets = useMemo(() => backlog.length > 0, [backlog]);

  // Active sprint detection
  const activeSprint = useMemo(() => {
    if (sprintDetail && sprintDetail.status !== 'closed' && sprintDetail.status !== 'rest' && sprintDetail.status !== 'done') {
      return sprintDetail;
    }
    return sprints.find(
      (s) => s.status !== 'closed' && s.status !== 'rest' && s.status !== 'done',
    ) ?? null;
  }, [sprints, sprintDetail]);

  const hasActiveSprint = activeSprint !== null;
  const sprintStatus = activeSprint?.status ?? null;
  const sprintHasBlockers = blockers.length > 0;

  // Build steps with status
  const steps: FlowStep[] = useMemo(
    () =>
      STEP_CONFIGS.map((config) => ({
        ...config,
        status: deriveStepStatus(
          config.id,
          hasVision,
          hasDiscoveries,
          hasMilestones,
          hasEpics,
          hasBacklogTickets,
          hasActiveSprint,
          sprintStatus,
          sprintHasBlockers,
        ),
      })),
    [hasVision, hasDiscoveries, hasMilestones, hasEpics, hasBacklogTickets, hasActiveSprint, sprintStatus, sprintHasBlockers],
  );

  // Connector status between step i and step i+1
  const getConnectorStatus = useCallback(
    (index: number): StepStatus => {
      const current = steps[index];
      const next = steps[index + 1];
      if (!next) return 'pending';
      if (current.status === 'completed' && next.status !== 'pending') return 'completed';
      if (current.status === 'completed' && next.status === 'pending') return 'completed';
      if (current.status === 'active') return 'active';
      if (current.status === 'blocked') return 'blocked';
      return 'pending';
    },
    [steps],
  );

  // Count stats for the summary bar
  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const activeStep = steps.find((s) => s.status === 'active' || s.status === 'blocked');

  // Show kickoff button when lifecycle hasn't started yet (vision is the active/first step or no steps completed)
  const showKickoffButton = onStepClick && (completedCount === 0 || (activeStep?.id === 'vision'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font)',
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text)',
              letterSpacing: '-0.02em',
            }}
          >
            Process Flow
          </h2>
          <p
            style={{
              margin: '4px 0 0',
              fontFamily: 'var(--font)',
              fontSize: 13,
              color: 'var(--text3)',
            }}
          >
            Sprint lifecycle from vision to archive. {completedCount}/{steps.length} steps completed.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Current step badge */}
          {activeStep && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 14px',
                background: activeStep.status === 'blocked' ? 'rgba(248,113,113,.1)' : 'rgba(59,130,246,.1)',
                border: `1px solid ${activeStep.status === 'blocked' ? '#f87171' : '#60a5fa'}`,
                borderRadius: 20,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'var(--font)',
                color: activeStep.status === 'blocked' ? '#f87171' : '#60a5fa',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: activeStep.status === 'blocked' ? '#f87171' : '#60a5fa',
                  animation: activeStep.status === 'blocked' ? undefined : 'pf-active-pulse 1.5s ease-in-out infinite',
                }}
              />
              {activeStep.status === 'blocked' ? 'Blocked' : 'Current'}: {activeStep.label}
            </div>
          )}

          {/* Start Kickoff CTA */}
          {showKickoffButton && (
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => onStepClick('kickoff')}
              style={{
                background: 'var(--pill-bg)',
                color: 'var(--pill-fg)',
                border: 'none',
                borderRadius: 'var(--radius-pill)',
                padding: '8px 18px',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                letterSpacing: '-0.01em',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Start Kickoff
            </motion.button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 4,
          background: 'var(--surface2)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${(completedCount / steps.length) * 100}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          style={{
            height: '100%',
            background: 'linear-gradient(90deg, #10b981, #60a5fa)',
            borderRadius: 2,
          }}
        />
      </div>

      {/* Flow visualization */}
      {isMobile ? (
        // Vertical layout for mobile
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, padding: '8px 0' }}>
          {steps.map((step, i) => (
            <React.Fragment key={step.id}>
              <div style={{ width: '100%', maxWidth: 400 }}>
                <FlowStepVertical step={step} index={i} onStepClick={onStepClick} />
              </div>
              {i < steps.length - 1 && (
                <FlowConnectorVertical status={getConnectorStatus(i)} />
              )}
            </React.Fragment>
          ))}
        </div>
      ) : (
        // Horizontal layout for desktop
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 0,
            overflowX: 'auto',
            padding: '16px 0 8px',
          }}
        >
          {steps.map((step, i) => (
            <React.Fragment key={step.id}>
              <FlowStepHorizontal step={step} index={i} onStepClick={onStepClick} />
              {i < steps.length - 1 && (
                <FlowConnector status={getConnectorStatus(i)} />
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          padding: '10px 0 0',
          borderTop: '1px solid var(--border)',
        }}
      >
        <LegendItem color="#10b981" label="Completed" />
        <LegendItem color="#60a5fa" label="Active" />
        <LegendItem color="var(--border2)" label="Pending" />
        <LegendItem color="#f87171" label="Blocked" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Legend item                                                        */
/* ------------------------------------------------------------------ */

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 10,
          fontFamily: 'var(--mono)',
          color: 'var(--text3)',
        }}
      >
        {label}
      </span>
    </div>
  );
}
