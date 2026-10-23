'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion, steps } from 'framer-motion';
import { cx } from '@/lib/utils';

/** A single line of Claude output */
export interface ClaudeOutputLine {
  id: string;
  text: string;
  timestamp: number;
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'step' | 'system';
}

/** Step descriptor for the progress tracker */
export interface ClaudeStep {
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  title?: string;
  description?: string;
}

interface ClaudeOutputStreamProps {
  /** Streaming output lines */
  lines: ClaudeOutputLine[];
  /** Current step info from step_progress events */
  currentStep?: {
    step: string;
    title: string;
    description: string;
    current: number;
    total: number;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    error?: string;
  } | null;
  /** Whether the stream is actively receiving data */
  isActive?: boolean;
  /** Max height before scrolling (default 320) */
  maxHeight?: number;
  /** Whether the detail panel starts expanded */
  defaultExpanded?: boolean;
}

/** Generate a simple unique id for output lines */
let lineCounter = 0;
export function makeLineId(): string {
  return `cl-${Date.now()}-${++lineCounter}`;
}

/** Text colour per line type */
const LINE_COLORS: Record<ClaudeOutputLine['type'], string> = {
  text: 'text-fg',
  tool_call: 'text-blue',
  tool_result: 'text-green',
  thinking: 'text-accent-2',
  error: 'text-red',
  step: 'text-orange',
  system: 'text-fg-3',
};

/** Icons for step statuses */
const STEP_STATUS_ICON: Record<ClaudeStep['status'], string> = {
  pending: '\u25CB',
  in_progress: '\u25D0',
  completed: '\u2713',
  error: '\u2717',
};

const STEP_STATUS_COLOR: Record<ClaudeStep['status'], string> = {
  pending: 'var(--color-fg-3)',
  in_progress: '#60a5fa',
  completed: '#10b981',
  error: '#f87171',
};

/**
 * ClaudeOutputStream - Displays Claude's real-time output in a terminal-like view.
 *
 * Features:
 * - Terminal-style streaming text with auto-scroll
 * - Step progress indicator (step 3 of 6)
 * - Color-coded output types (tool calls, errors, thinking, etc.)
 * - Collapsible detail panel for verbose output
 * - Animated transitions between steps
 */
export function ClaudeOutputStream({
  lines,
  currentStep,
  isActive = false,
  maxHeight = 320,
  defaultExpanded = true,
}: ClaudeOutputStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [userScrolled, setUserScrolled] = useState(false);
  const reduceMotion = useReducedMotion();

  // Auto-scroll to bottom when new lines arrive, unless user manually scrolled up
  useEffect(() => {
    if (!scrollRef.current || userScrolled) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, userScrolled]);

  // Reset user-scrolled flag when stream becomes active again
  useEffect(() => {
    if (isActive) setUserScrolled(false);
  }, [isActive]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setUserScrolled(!isAtBottom);
  }, []);

  const stepProgress = currentStep ? `${currentStep.current}/${currentStep.total}` : null;

  const progressPercent = currentStep ? (currentStep.current / currentStep.total) * 100 : 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-surface-2">
      {/* Header bar with step info and collapse toggle */}
      <div
        onClick={() => setExpanded((e) => !e)}
        className={cx(
          'flex cursor-pointer items-center gap-[10px] bg-surface px-[14px] py-2 select-none',
          // Bottom side only: border-line would recolour all four sides.
          expanded ? 'border-b border-b-line' : '[border-bottom:none]',
        )}
      >
        {/* Activity indicator */}
        <motion.div
          className={cx(
            'h-2 w-2 shrink-0 rounded-[50%]',
            isActive ? 'bg-green' : lines.length > 0 ? 'bg-fg-3' : 'bg-line-2',
          )}
          animate={isActive && !reduceMotion ? { scale: [1, 1.3, 1], opacity: [1, 0.7, 1] } : {}}
          transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Step info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="overflow-hidden text-12 font-semibold text-ellipsis whitespace-nowrap text-fg">
              {currentStep?.title || (lines.length > 0 ? 'Claude Output' : 'Waiting for Claude...')}
            </span>
            {stepProgress && (
              <span className="shrink-0 rounded-[4px] bg-surface-2 px-[6px] py-px font-code text-10 text-fg-3">
                {stepProgress}
              </span>
            )}
          </div>
          {currentStep?.description && (
            <div className="mt-px overflow-hidden text-10 text-ellipsis whitespace-nowrap text-fg-3">
              {currentStep.description}
            </div>
          )}
        </div>

        {/* Progress bar mini */}
        {currentStep && (
          <div className="h-[3px] w-[60px] shrink-0 overflow-hidden rounded-[2px] bg-line-2">
            <motion.div
              className={cx(
                'h-full rounded-[2px]',
                currentStep.status === 'error'
                  ? 'bg-red'
                  : currentStep.status === 'completed'
                    ? 'bg-green'
                    : 'bg-blue',
              )}
              initial={{ width: 0 }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            />
          </div>
        )}

        {/* Line count badge */}
        {lines.length > 0 && (
          <span className="shrink-0 font-code text-10 text-fg-3">{lines.length} lines</span>
        )}

        {/* Collapse chevron */}
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
          className="shrink-0 text-10 text-fg-3"
        >
          \u25BC
        </motion.span>
      </div>

      {/* Terminal output area */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="overflow-hidden"
          >
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="overflow-y-auto px-[14px] py-[10px] font-code text-12 leading-[1.7]"
              style={{ maxHeight }}
            >
              {lines.length === 0 ? (
                <div className="text-fg-3 italic">
                  {isActive ? 'Connecting...' : 'No output yet'}
                </div>
              ) : (
                lines.map((line, i) => (
                  <motion.div
                    key={line.id}
                    initial={reduceMotion ? { opacity: 1 } : { opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      duration: 0.15,
                      delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.1),
                    }}
                    className={cx(
                      'flex items-baseline gap-2 [word-break:break-word] whitespace-pre-wrap',
                      LINE_COLORS[line.type],
                    )}
                  >
                    {/* Line type indicator */}
                    {line.type === 'tool_call' && (
                      <span className="shrink-0 text-blue">&#9654;</span>
                    )}
                    {line.type === 'error' && <span className="shrink-0 text-red">&#x2717;</span>}
                    {line.type === 'step' && <span className="shrink-0 text-orange">&#9656;</span>}
                    {line.type === 'thinking' && (
                      <span className="shrink-0 text-accent-2 italic">&#8230;</span>
                    )}
                    <span>{line.text}</span>
                  </motion.div>
                ))
              )}

              {/* Active cursor */}
              {isActive && (
                <motion.span
                  animate={reduceMotion ? {} : { opacity: [1, 0] }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: steps(2) }}
                  className="ml-[2px] inline-block h-[14px] w-[7px] rounded-[1px] bg-fg align-middle"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Scroll-to-bottom button */}
      {userScrolled && expanded && (
        <motion.button
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          onClick={() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              setUserScrolled(false);
            }
          }}
          className="absolute right-[14px] bottom-2 z-2 cursor-pointer rounded-[6px] border border-line bg-surface px-2 py-[3px] font-code text-10 text-fg-2"
        >
          \u2193 Scroll to bottom
        </motion.button>
      )}
    </div>
  );
}
