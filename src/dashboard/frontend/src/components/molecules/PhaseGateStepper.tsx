'use client';

import { useState, useEffect } from 'react';
import { PHASE_ORDER, getPhaseStyle, mapLegacyPhase } from '@/lib/phases';
import { post } from '@/lib/api';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Stepper row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        {PHASE_ORDER.map((phase, idx) => {
          const isCompleted = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const style = getPhaseStyle(phase);

          return (
            <div key={phase} style={{ display: 'flex', alignItems: 'center', flex: idx < PHASE_ORDER.length - 1 ? 1 : 0 }}>
              {/* Circle */}
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700,
                  flexShrink: 0,
                  transition: 'all .2s',
                  ...(isCompleted
                    ? { background: '#10b981', color: 'white', border: '2px solid #10b981' }
                    : isCurrent
                      ? { background: style.bg, color: 'white', border: `2px solid ${style.border}` }
                      : { background: 'transparent', color: 'var(--text3)', border: '2px solid var(--border)' }
                  ),
                }}
              >
                {isCompleted ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>

              {/* Connector line */}
              {idx < PHASE_ORDER.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    background: idx < currentIdx ? '#10b981' : 'var(--border)',
                    margin: '0 4px',
                    transition: 'background .2s',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Phase labels row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginTop: 2 }}>
        {PHASE_ORDER.map((phase, idx) => {
          const isCompleted = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const style = getPhaseStyle(phase);
          return (
            <div key={phase} style={{ flex: idx < PHASE_ORDER.length - 1 ? 1 : 0, textAlign: 'left' }}>
              <div style={{
                fontSize: 9,
                fontWeight: 600,
                color: isCurrent ? style.bg : isCompleted ? '#10b981' : 'var(--text3)',
                textTransform: 'uppercase',
              }}>
                {style.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Stuck button — only shows after 10 min in same phase */}
      {stuckVisible && !stuckSent && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <button
            onClick={handleStuck}
            disabled={sending}
            style={{
              background: 'var(--red)',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              padding: '5px 14px',
              fontSize: 11,
              fontWeight: 700,
              cursor: sending ? 'not-allowed' : 'pointer',
              opacity: sending ? 0.6 : 1,
              fontFamily: 'var(--font)',
              transition: 'opacity .15s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="white" strokeWidth="1.5"/>
              <line x1="6" y1="3" x2="6" y2="6.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="6" cy="8.5" r="0.75" fill="white"/>
            </svg>
            {sending ? 'Notifying...' : `Stuck in ${getPhaseStyle(currentPhase).label}`}
          </button>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>
            10+ min in this phase
          </span>
        </div>
      )}

      {/* Stuck confirmation */}
      {stuckSent && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
          fontSize: 11, color: 'var(--text3)', fontStyle: 'italic',
        }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6L5 9L10 3" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Claude notified — sprint is stuck in {getPhaseStyle(currentPhase).label}
        </div>
      )}
    </div>
  );
}
