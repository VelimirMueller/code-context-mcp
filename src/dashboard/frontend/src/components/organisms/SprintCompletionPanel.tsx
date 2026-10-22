'use client';

import React, { useState } from 'react';
import type { Sprint, Ticket } from '@/types';

interface ChecklistItem {
  id: string;
  label: string;
  complete: boolean;
  value?: string;
  threshold?: number;
}

interface SprintCompletionPanelProps {
  sprint: Sprint;
  tickets: { total: number; done: number; qaVerified: number; items?: Ticket[] };
  retroFindings: { count: number; hasFindings: boolean };
  onComplete?: () => void;
}

function getCompletionStatus(
  complete: boolean,
  threshold?: number,
  value?: string
): { type: 'done' | 'partial' | 'pending'; color: string } {
  if (complete) {
    return { type: 'done', color: 'var(--green)' };
  }
  if (threshold !== undefined && value) {
    const match = value.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) {
      const current = parseInt(match[1], 10);
      const pct = (current / parseInt(match[2], 10)) * 100;
      if (pct >= (threshold * 100)) {
        return { type: 'partial', color: 'var(--orange)' };
      }
    }
  }
  return { type: 'pending', color: 'var(--red)' };
}

function StatusIcon({ type, color }: { type: 'done' | 'partial' | 'pending'; color: string }) {
  if (type === 'done') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill={color} />
        <path d="M5 8L7 10L11 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (type === 'partial') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill={color} />
        <path d="M8 5V8.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="8" cy="11" r="0.75" fill="white"/>
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke={color} strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function SprintCompletionPanel({
  sprint,
  tickets,
  retroFindings,
  onComplete,
}: SprintCompletionPanelProps) {
  const [showQaReport, setShowQaReport] = useState(false);
  const done = sprint.velocity_completed ?? 0;
  const committed = sprint.velocity_committed ?? 0;
  const velocityPct = committed > 0 ? Math.round((done / committed) * 100) : 0;

  // All tickets are DONE or NOT_DONE (partial completion)
  const ticketsComplete = tickets.done >= tickets.total && tickets.total > 0;

  // QA verified: 90%+ of tickets verified (use tickets.qaVerified directly, not sprint.qa_count)
  const qaVerified = tickets.qaVerified;
  const qaThreshold = tickets.total > 0 ? Math.round(tickets.total * 0.9) : 0;
  const qaComplete = tickets.total > 0 && qaVerified >= qaThreshold;

  // Retro findings recorded
  const retroComplete = retroFindings.hasFindings;

  // Velocity target met: 80%+ of committed
  const velocityComplete = velocityPct >= 80;

  const checklistItems: ChecklistItem[] = [
    {
      id: 'tickets',
      label: 'All tickets DONE or NOT_DONE',
      complete: ticketsComplete,
      value: `${tickets.done}/${tickets.total}`,
    },
    {
      id: 'qa',
      label: 'QA Verified',
      complete: qaComplete,
      value: `${qaVerified}/${tickets.total} tickets`,
      threshold: 0.9,
    },
    {
      id: 'retro',
      label: 'Retro findings recorded',
      complete: retroComplete,
      value: `${retroFindings.count} findings`,
    },
    {
      id: 'velocity',
      label: 'Velocity target met',
      complete: velocityComplete,
      value: `${done}/${committed} = ${velocityPct}%`,
      threshold: 0.8,
    },
  ];

  const allComplete = checklistItems.every((item) => item.complete);

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '16px 20px',
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text)',
          marginBottom: 16,
        }}
      >
        Sprint Completion Checklist
      </div>

      {/* Checklist Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {checklistItems.map((item) => {
          const status = getCompletionStatus(item.complete, item.threshold, item.value);
          const isPartial = !item.complete && status.type === 'partial';

          return (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 'var(--radius)',
                background: item.complete ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg)',
                border: `1px solid ${item.complete ? 'var(--green)' : 'var(--border)'}`,
              }}
            >
              {/* Status Icon */}
              <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <StatusIcon type={status.type} color={status.color} />
              </span>

              {/* Label */}
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--text)',
                  flex: 1,
                }}
              >
                {item.label}
              </span>

              {/* Value Badge */}
              {item.value && (
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--mono)',
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: isPartial
                      ? 'rgba(245, 158, 11, 0.15)'
                      : item.complete
                      ? 'rgba(16, 185, 129, 0.15)'
                      : 'var(--surface3)',
                    color: isPartial
                      ? 'var(--orange)'
                      : item.complete
                      ? 'var(--green)'
                      : 'var(--text3)',
                  }}
                >
                  {item.value}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Divider */}
      <div
        style={{
          height: 1,
          background: 'var(--border)',
          margin: '16px 0',
        }}
      />

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={onComplete}
          disabled={!allComplete}
          style={{
            padding: '8px 16px',
            borderRadius: 'var(--radius)',
            fontSize: 12,
            fontWeight: 600,
            border: 'none',
            cursor: allComplete ? 'pointer' : 'not-allowed',
            background: allComplete ? 'var(--green)' : 'var(--surface3)',
            color: allComplete ? 'white' : 'var(--text3)',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (allComplete) {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.3)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          Complete Sprint
        </button>

        <button
          onClick={() => setShowQaReport(!showQaReport)}
          style={{
            padding: '8px 16px',
            borderRadius: 'var(--radius)',
            fontSize: 12,
            fontWeight: 500,
            border: `1px solid ${showQaReport ? 'var(--accent)' : 'var(--border)'}`,
            background: showQaReport ? 'rgba(16,185,129,.08)' : 'var(--bg)',
            color: showQaReport ? 'var(--accent)' : 'var(--text)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (!showQaReport) {
              e.currentTarget.style.background = 'var(--surface2)';
              e.currentTarget.style.borderColor = 'var(--text3)';
            }
          }}
          onMouseLeave={(e) => {
            if (!showQaReport) {
              e.currentTarget.style.background = 'var(--bg)';
              e.currentTarget.style.borderColor = 'var(--border)';
            }
          }}
        >
          {showQaReport ? 'Hide' : 'Show'} QA Report
        </button>
      </div>

      {/* Inline QA Report */}
      {showQaReport && tickets.items && (
        <div style={{ marginTop: 12, padding: '12px', borderRadius: 'var(--radius)', background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>QA Verification Report</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: qaComplete ? 'var(--green)' : 'var(--red)', background: qaComplete ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)', padding: '1px 8px', borderRadius: 10 }}>
              {qaVerified}/{tickets.total} verified
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tickets.items.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  background: t.qa_verified ? 'rgba(16,185,129,.05)' : 'transparent',
                }}
              >
                <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                  {t.qa_verified ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" fill="var(--green)"/><path d="M4.5 7L6 8.5L9.5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="var(--red)" strokeWidth="1.5" fill="none"/></svg>
                  )}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', width: 42, flexShrink: 0 }}>{t.ticket_ref ?? `#${t.id}`}</span>
                <span style={{ color: 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                {t.verified_by && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{t.verified_by}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress Summary */}
      <div
        style={{
          marginTop: 16,
          padding: '12px',
          borderRadius: 'var(--radius)',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            background: 'var(--surface3)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${(checklistItems.filter((i) => i.complete).length / checklistItems.length) * 100}%`,
              height: '100%',
              background: allComplete ? 'var(--green)' : velocityPct >= 50 ? 'var(--orange)' : 'var(--red)',
              borderRadius: 3,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'var(--mono)',
            color: 'var(--text3)',
          }}
        >
          {checklistItems.filter((i) => i.complete).length}/{checklistItems.length}
        </span>
      </div>
    </div>
  );
}
