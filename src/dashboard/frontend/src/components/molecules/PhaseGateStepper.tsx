'use client';

import { useState, useEffect, type CSSProperties } from 'react';
import { PHASE_ORDER, getPhaseStyle, mapLegacyPhase } from '@/lib/phases';
import { post } from '@/lib/api';
import { cx } from '@/lib/utils';

interface PhaseGateStepperProps {
  currentPhase: string;
  sprintId: number;
  updatedAt?: string;
  onTransition?: () => void;
}

const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export function PhaseGateStepper({ currentPhase, sprintId, updatedAt }: PhaseGateStepperProps) {
  const [stuckVisible, setStuckVisible] = useState(false);
  const [stuckSent, setStuckSent] = useState(false);
  const [sending, setSending] = useState(false);

  const mappedPhase = mapLegacyPhase(currentPhase);
  const currentIdx = PHASE_ORDER.indexOf(mappedPhase);

  // Check if phase has been the same for > 10 minutes
  useEffect(() => {
    if (!updatedAt) {
      // No timestamp — show after 10 min from mount
      const timer = setTimeout(() => setStuckVisible(true), STUCK_THRESHOLD_MS);
      return () => clearTimeout(timer);
    }

    const updatedTime = new Date(updatedAt).getTime();
    const elapsed = Date.now() - updatedTime;

    if (elapsed >= STUCK_THRESHOLD_MS) {
      setStuckVisible(true);
    } else {
      setStuckVisible(false);
      const timer = setTimeout(() => setStuckVisible(true), STUCK_THRESHOLD_MS - elapsed);
      return () => clearTimeout(timer);
    }
  }, [updatedAt, currentPhase]);

  // Reset stuck state when phase changes
  useEffect(() => {
    setStuckSent(false);
    setStuckVisible(false);
  }, [currentPhase]);

  const handleStuck = async () => {
    setSending(true);
    try {
      await post(`/api/sprint/${sprintId}/stuck`, { phase: currentPhase });
      setStuckSent(true);
    } catch {
      // silently fail
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-[10px]">
      {/* Stepper row */}
      <div className="flex items-center gap-0">
        {PHASE_ORDER.map((phase, idx) => {
          const isCompleted = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const style = getPhaseStyle(phase);

          return (
            <div
              key={phase}
              className={cx(
                'flex items-center',
                idx < PHASE_ORDER.length - 1 ? 'flex-1' : 'flex-[0]',
              )}
            >
              {/* Circle */}
              <div
                style={{ '--c': style.bg, '--bc': style.border } as CSSProperties}
                className={cx(
                  'w-7 h-7 rounded-[50%] flex items-center justify-center text-10 font-bold shrink-0 transition-all border-2',
                  isCompleted
                    ? 'bg-green text-[white] border-green'
                    : isCurrent
                      ? 'bg-(--c) text-[white] border-(--bc)'
                      : 'bg-transparent text-fg-3 border-line',
                )}
              >
                {isCompleted ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2 6L5 9L10 3"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>

              {/* Connector line */}
              {idx < PHASE_ORDER.length - 1 && (
                <div
                  className={cx(
                    'flex-1 h-0.5 mx-1 [transition:background_.2s]',
                    idx < currentIdx ? 'bg-green' : 'bg-line',
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Phase labels row */}
      <div className="flex items-center gap-0 mt-0.5">
        {PHASE_ORDER.map((phase, idx) => {
          const isCompleted = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const style = getPhaseStyle(phase);
          return (
            <div
              key={phase}
              className={cx('text-left', idx < PHASE_ORDER.length - 1 ? 'flex-1' : 'flex-[0]')}
            >
              <div
                style={{ '--c': style.bg } as CSSProperties}
                className={cx(
                  'text-9 font-semibold uppercase',
                  isCurrent ? 'text-(--c)' : isCompleted ? 'text-green' : 'text-fg-3',
                )}
              >
                {style.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Stuck button — only shows after 10 min in same phase */}
      {stuckVisible && !stuckSent && (
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={handleStuck}
            disabled={sending}
            className={cx(
              'bg-red text-[white] border-none rounded-[6px] py-[5px] px-3.5 text-11 font-bold font-body [transition:opacity_.15s] flex items-center gap-1.5',
              sending ? 'cursor-not-allowed opacity-60' : 'cursor-pointer opacity-100',
            )}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="white" strokeWidth="1.5" />
              <line
                x1="6"
                y1="3"
                x2="6"
                y2="6.5"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="6" cy="8.5" r="0.75" fill="white" />
            </svg>
            {sending ? 'Notifying...' : `Stuck in ${getPhaseStyle(currentPhase).label}`}
          </button>
          <span className="text-10 text-fg-3">10+ min in this phase</span>
        </div>
      )}

      {/* Stuck confirmation */}
      {stuckSent && (
        <div className="flex items-center gap-1.5 mt-1 text-11 text-fg-3 italic">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6L5 9L10 3"
              stroke="#10b981"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Claude notified — sprint is stuck in {getPhaseStyle(currentPhase).label}
        </div>
      )}
    </div>
  );
}
