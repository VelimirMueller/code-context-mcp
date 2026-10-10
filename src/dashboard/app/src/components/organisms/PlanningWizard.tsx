'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useSprintPhase, type SprintPhase } from '@/hooks/useSprintPhase';
import { useSprintStore } from '@/stores/sprintStore';
import { useBridgeStore } from '@/stores/bridgeStore';
import { post } from '@/lib/api';

interface StepConfig {
  label: string;
  icon: string;
  color: string;
  description: string;
  buttonLabel: string;
  buttonAction: 'advance' | 'start' | 'implement' | null;
  position: 'first' | 'next' | 'last';
}

function getStepConfig(phase: SprintPhase, ticketsDone: number, ticketsTotal: number): StepConfig {
  switch (phase) {
    case 'none':
      return {
        label: 'First Step',
        icon: '◈',
        color: '#818cf8',
        description: 'Add tickets below, then start a sprint.',
        buttonLabel: 'Start Sprint',
        buttonAction: 'start',
        position: 'first',
      };
    case 'rest':
      return {
        label: 'First Step',
        icon: '◈',
        color: '#818cf8',
        description: 'Previous sprint complete. Create tickets and start the next one.',
        buttonLabel: 'Start Sprint',
        buttonAction: 'start',
        position: 'first',
      };
    case 'planning':
      return {
        label: 'Next Step',
        icon: '▶',
        color: '#60a5fa',
        description: 'Review tickets, adjust points and assignees. Begin when ready.',
        buttonLabel: 'Start Implementation',
        buttonAction: 'advance',
        position: 'next',
      };
    case 'implementation': {
      const allDone = ticketsTotal > 0 && ticketsDone === ticketsTotal;
      return {
        label: allDone ? 'Last Step' : 'Next Step',
        icon: allDone ? '✓' : '▶',
        color: allDone ? '#10b981' : '#10b981',
        description: allDone
          ? `All ${ticketsTotal} tickets done. Finish the sprint.`
          : `${ticketsDone}/${ticketsTotal} tickets done. Implement remaining tickets.`,
        buttonLabel: allDone ? 'Finish Sprint' : 'Implement Next Ticket',
        buttonAction: allDone ? 'advance' : 'implement',
        position: allDone ? 'last' : 'next',
      };
    }
    case 'qa':
      return {
        label: 'Next Step',
        icon: '✓',
        color: '#fbbf24',
        description: 'Verify completed work passes QA.',
        buttonLabel: 'Advance',
        buttonAction: 'advance',
        position: 'next',
      };
    case 'done':
      return {
        label: 'Last Step',
        icon: '◁',
        color: '#ec4899',
        description: 'Sprint work complete. Close it out.',
        buttonLabel: 'Close Sprint',
        buttonAction: 'advance',
        position: 'last',
      };
  }
}

interface PlanningWizardProps {
  onStartSprint?: () => void;
}

const WIZARD_STEP_COLORS: Record<string, string> = {
  vision: '#818cf8',
  discovery: '#60a5fa',
  milestone: '#10b981',
  epics: '#fbbf24',
  tickets: '#ec4899',
  sprint_launch: '#06b6d4',
  retro: '#f87171',
  dashboard_check: '#6366f1',
};

export function PlanningWizard({ onStartSprint }: PlanningWizardProps) {
  const { phase, sprint } = useSprintPhase();
  const fetchSprints = useSprintStore((s) => s.fetchSprints);
  const queueAction = useBridgeStore((s) => s.queueAction);
  const wizardOpen = useBridgeStore((s) => s.wizardOpen);
  const wizardSteps = useBridgeStore((s) => s.wizardSteps);
  const stepProgress = useBridgeStore((s) => s.stepProgress);
  const claudeStream = useBridgeStore((s) => s.claudeStream);
  const prefersReducedMotion = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  // Current wizard step: last in the queue is the most recently requested
  const currentWizardStep = wizardSteps[wizardSteps.length - 1] ?? null;
  const wizardStepColor = WIZARD_STEP_COLORS[currentWizardStep?.step ?? ''] ?? '#6366f1';
  const isWizardActive = wizardOpen || claudeStream.isActive;

  const ticketsDone = sprint?.done_count ?? 0;
  const ticketsTotal = sprint?.ticket_count ?? 0;
  const step = getStepConfig(phase, ticketsDone, ticketsTotal);

  const handleAction = async () => {
    if (busy) return;
    setBusy(true);
    setLastResult(null);

    try {
      if (step.buttonAction === 'advance' && sprint) {
        const res = await post<{ from: string; to: string; automations: string[] }>(`/api/sprint/${sprint.id}/advance`, {});
        const auto = res.automations?.length ? ` (${res.automations.join(', ')})` : '';
        setLastResult(`${res.from} → ${res.to}${auto}`);
        await fetchSprints();
      } else if (step.buttonAction === 'start') {
        if (onStartSprint) onStartSprint();
      } else if (step.buttonAction === 'implement' && sprint) {
        // Queue implement action for Claude to pick up via /sprint-connect
        const tickets = await import('@/lib/api').then(m => m.get<{ id: number; title: string; status: string }[]>(`/api/sprint/${sprint.id}/tickets`));
        const next = tickets?.find(t => t.status === 'TODO' || t.status === 'IN_PROGRESS');
        if (next) {
          await queueAction('implement_ticket', 'ticket', next.id, { sprint_id: sprint.id, title: next.title });
          setLastResult(`Queued: ${next.title} — waiting for Claude...`);
        } else {
          setLastResult('No remaining tickets to implement');
        }
      }
    } catch (e) {
      setLastResult(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const positionColor = step.position === 'first' ? '#818cf8' : step.position === 'last' ? '#ec4899' : step.color;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        background: 'var(--surface)',
        border: `1px solid var(--border)`,
        borderRadius: 14,
        padding: '20px 24px',
        marginBottom: 20,
        borderLeft: `3px solid ${positionColor}`,
      }}
    >
      {/* Step label */}
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: positionColor,
        marginBottom: 12,
      }}>
        {step.icon} {step.label}
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: 1 }}>
          {sprint && (
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
              {sprint.name}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
            {step.description}
          </div>
          {sprint?.goal && (
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4, fontStyle: 'italic' }}>
              Goal: {sprint.goal}
            </div>
          )}
        </div>

        {/* Single action button */}
        {step.buttonAction && (
          <button
            onClick={handleAction}
            disabled={busy}
            style={{
              background: busy ? 'var(--surface3)' : positionColor,
              color: busy ? 'var(--text3)' : '#fff',
              border: 'none',
              borderRadius: 10,
              padding: '10px 20px',
              fontSize: 13,
              fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {busy ? '...' : step.buttonLabel}
          </button>
        )}
      </div>

      {/* Progress bar for implementation */}
      {phase === 'implementation' && ticketsTotal > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            height: 4,
            background: 'var(--surface2)',
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(ticketsDone / ticketsTotal) * 100}%` }}
              transition={{ duration: 0.5 }}
              style={{ height: '100%', background: step.color, borderRadius: 2 }}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, textAlign: 'right' }}>
            {ticketsDone}/{ticketsTotal} done
            {sprint && sprint.velocity_committed > 0 && ` · ${sprint.velocity_completed}/${sprint.velocity_committed} pts`}
          </div>
        </div>
      )}

      {/* Result feedback */}
      <AnimatePresence>
        {lastResult && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              marginTop: 12,
              padding: '8px 12px',
              background: lastResult.startsWith('Error') ? 'rgba(239,68,68,0.1)' : `${positionColor}10`,
              borderRadius: 8,
              fontSize: 12,
              color: lastResult.startsWith('Error') ? '#f87171' : 'var(--text2)',
            }}
          >
            {lastResult}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inline wizard step indicator */}
      <AnimatePresence>
        {isWizardActive && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: 'auto', marginTop: 14 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              background: `${wizardStepColor}0f`,
              border: `1px solid ${wizardStepColor}30`,
              borderRadius: 10,
            }}>
              {/* Live dot */}
              <motion.div
                animate={prefersReducedMotion ? {} : { scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: wizardStepColor,
                  flexShrink: 0,
                }}
              />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: wizardStepColor, marginBottom: 1 }}>
                  {claudeStream.isActive ? 'Claude is working…' : 'Wizard active'}
                  {wizardSteps.length > 0 && (
                    <span style={{ color: 'var(--text3)', fontWeight: 500, marginLeft: 6 }}>
                      step {wizardSteps.length}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {stepProgress?.title ?? currentWizardStep?.title ?? 'Waiting for input…'}
                </div>
                {stepProgress && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                    {stepProgress.description}
                  </div>
                )}
              </div>

              {/* Step progress fraction */}
              {stepProgress && stepProgress.total > 0 && (
                <div style={{
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--text3)',
                  flexShrink: 0,
                }}>
                  {stepProgress.current}/{stepProgress.total}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
