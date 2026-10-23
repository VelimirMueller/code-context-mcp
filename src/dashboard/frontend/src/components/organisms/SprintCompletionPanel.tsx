'use client';

import React, { useState } from 'react';
import { cx } from '@/lib/utils';
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
  value?: string,
): { type: 'done' | 'partial' | 'pending'; color: string } {
  if (complete) {
    return { type: 'done', color: 'var(--color-green)' };
  }
  if (threshold !== undefined && value) {
    const match = value.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) {
      const current = parseInt(match[1], 10);
      const pct = (current / parseInt(match[2], 10)) * 100;
      if (pct >= threshold * 100) {
        return { type: 'partial', color: 'var(--color-orange)' };
      }
    }
  }
  return { type: 'pending', color: 'var(--color-red)' };
}

function StatusIcon({ type, color }: { type: 'done' | 'partial' | 'pending'; color: string }) {
  if (type === 'done') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill={color} />
        <path
          d="M5 8L7 10L11 6"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (type === 'partial') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill={color} />
        <path d="M8 5V8.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11" r="0.75" fill="white" />
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

  const completedCount = checklistItems.filter((i) => i.complete).length;
  const completedWidth = `${(completedCount / checklistItems.length) * 100}%`;

  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <div className="mb-4 text-14 font-semibold text-fg">Sprint Completion Checklist</div>

      {/* Checklist Items */}
      <div className="flex flex-col gap-2.5">
        {checklistItems.map((item) => {
          const status = getCompletionStatus(item.complete, item.threshold, item.value);
          const isPartial = !item.complete && status.type === 'partial';

          return (
            <div
              key={item.id}
              className={cx(
                'flex items-center gap-2.5 rounded-card border px-3 py-2',
                item.complete ? 'border-green bg-[rgba(16,185,129,0.08)]' : 'border-line bg-bg',
              )}
            >
              {/* Status Icon */}
              <span className="flex shrink-0 items-center">
                <StatusIcon type={status.type} color={status.color} />
              </span>

              {/* Label */}
              <span className="flex-1 text-12 font-medium text-fg">{item.label}</span>

              {/* Value Badge */}
              {item.value && (
                <span
                  className={cx(
                    'rounded-[6px] px-2 py-0.5 font-code text-11 font-semibold',
                    isPartial
                      ? 'bg-[rgba(245,158,11,0.15)] text-orange'
                      : item.complete
                        ? 'bg-[rgba(16,185,129,0.15)] text-green'
                        : 'bg-surface-3 text-fg-3',
                  )}
                >
                  {item.value}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Divider */}
      <div className="my-4 h-px bg-line" />

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2.5">
        <button
          onClick={onComplete}
          disabled={!allComplete}
          className={cx(
            'rounded-card border-none px-4 py-2 text-12 font-semibold transition-all',
            allComplete
              ? 'cursor-pointer bg-green text-[white] hover:[box-shadow:0_4px_12px_rgba(16,185,129,0.3)] hover:[transform:translateY(-1px)]'
              : 'cursor-not-allowed bg-surface-3 text-fg-3',
          )}
        >
          Complete Sprint
        </button>

        <button
          onClick={() => setShowQaReport(!showQaReport)}
          className={cx(
            'cursor-pointer rounded-card border px-4 py-2 text-12 font-medium transition-all',
            showQaReport
              ? 'border-accent bg-[rgba(16,185,129,.08)] text-accent'
              : 'border-line bg-bg text-fg hover:border-fg-3 hover:bg-surface-2',
          )}
        >
          {showQaReport ? 'Hide' : 'Show'} QA Report
        </button>
      </div>

      {/* Inline QA Report */}
      {showQaReport && tickets.items && (
        <div className="mt-3 rounded-card border border-line bg-bg p-3">
          <div className="mb-2.5 flex items-center gap-2 text-12 font-semibold text-fg">
            <span>QA Verification Report</span>
            <span
              className={cx(
                'rounded-[10px] px-2 py-px font-code text-11',
                qaComplete
                  ? 'bg-[rgba(16,185,129,.1)] text-green'
                  : 'bg-[rgba(239,68,68,.1)] text-red',
              )}
            >
              {qaVerified}/{tickets.total} verified
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {tickets.items.map((t) => (
              <div
                key={t.id}
                className={cx(
                  'flex items-center gap-2 rounded-[4px] px-2 py-[5px] text-12',
                  t.qa_verified ? 'bg-[rgba(16,185,129,.05)]' : 'bg-transparent',
                )}
              >
                <span className="flex shrink-0 items-center">
                  {t.qa_verified ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="6" fill="var(--color-green)" />
                      <path
                        d="M4.5 7L6 8.5L9.5 5"
                        stroke="white"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle
                        cx="7"
                        cy="7"
                        r="6"
                        stroke="var(--color-red)"
                        strokeWidth="1.5"
                        fill="none"
                      />
                    </svg>
                  )}
                </span>
                <span className="w-10.5 shrink-0 font-code text-10 text-fg-3">
                  {t.ticket_ref ?? `#${t.id}`}
                </span>
                <span className="flex-1 truncate text-fg-2">{t.title}</span>
                {t.verified_by && (
                  <span className="font-code text-10 text-fg-3">{t.verified_by}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress Summary */}
      <div className="mt-4 flex items-center gap-2 rounded-card bg-bg p-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-surface-3">
          <div
            className={cx(
              'h-full rounded-[3px] [transition:width_0.3s_ease]',
              allComplete ? 'bg-green' : velocityPct >= 50 ? 'bg-orange' : 'bg-red',
            )}
            style={{ width: completedWidth }}
          />
        </div>
        <span className="font-code text-11 font-semibold text-fg-3">
          {completedCount}/{checklistItems.length}
        </span>
      </div>
    </div>
  );
}
