'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion, steps } from 'framer-motion';

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

/** Color map for line types */
const LINE_COLORS: Record<ClaudeOutputLine['type'], string> = {
  text: 'var(--text)',
  tool_call: '#60a5fa',
  tool_result: '#10b981',
  thinking: '#a5b4fc',
  error: '#f87171',
  step: '#fbbf24',
  system: 'var(--text3)',
};

/** Icons for step statuses */
const STEP_STATUS_ICON: Record<ClaudeStep['status'], string> = {
  pending: '\u25CB',
  in_progress: '\u25D0',
  completed: '\u2713',
  error: '\u2717',
};

const STEP_STATUS_COLOR: Record<ClaudeStep['status'], string> = {
  pending: 'var(--text3)',
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

  const stepProgress = currentStep
    ? `${currentStep.current}/${currentStep.total}`
    : null;

  const progressPercent = currentStep
    ? (currentStep.current / currentStep.total) * 100
    : 0;

  return (
    <div
      style={{
        background: 'var(--surface2)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header bar with step info and collapse toggle */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          background: 'var(--surface)',
          borderBottom: expanded ? '1px solid var(--border)' : 'none',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Activity indicator */}
        <motion.div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isActive
              ? '#10b981'
              : lines.length > 0
                ? 'var(--text3)'
                : 'var(--border2)',
            flexShrink: 0,
          }}
          animate={
            isActive && !reduceMotion
              ? { scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }
              : {}
          }
          transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Step info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {currentStep?.title || (lines.length > 0 ? 'Claude Output' : 'Waiting for Claude...')}
            </span>
            {stepProgress && (
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text3)',
                  fontFamily: 'var(--mono)',
                  flexShrink: 0,
                  background: 'var(--surface2)',
                  padding: '1px 6px',
                  borderRadius: 4,
                }}
              >
                {stepProgress}
              </span>
            )}
          </div>
          {currentStep?.description && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--text3)',
                marginTop: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {currentStep.description}
            </div>
          )}
        </div>

        {/* Progress bar mini */}
        {currentStep && (
          <div
            style={{
              width: 60,
              height: 3,
              background: 'var(--border2)',
              borderRadius: 2,
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <motion.div
              style={{
                height: '100%',
                background:
                  currentStep.status === 'error'
                    ? '#f87171'
                    : currentStep.status === 'completed'
                      ? '#10b981'
                      : '#60a5fa',
                borderRadius: 2,
              }}
              initial={{ width: 0 }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            />
          </div>
        )}

        {/* Line count badge */}
        {lines.length > 0 && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--text3)',
              fontFamily: 'var(--mono)',
              flexShrink: 0,
            }}
          >
            {lines.length} lines
          </span>
        )}

        {/* Collapse chevron */}
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
          style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}
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
            style={{ overflow: 'hidden' }}
          >
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              style={{
                maxHeight,
                overflowY: 'auto',
                padding: '10px 14px',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                lineHeight: 1.7,
              }}
            >
              {lines.length === 0 ? (
                <div style={{ color: 'var(--text3)', fontStyle: 'italic' }}>
                  {isActive ? 'Connecting...' : 'No output yet'}
                </div>
              ) : (
                lines.map((line, i) => (
                  <motion.div
                    key={line.id}
                    initial={reduceMotion ? { opacity: 1 } : { opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.15, delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.1) }}
                    style={{
                      color: LINE_COLORS[line.type],
                      wordBreak: 'break-word',
                      whiteSpace: 'pre-wrap',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'baseline',
                    }}
                  >
                    {/* Line type indicator */}
                    {line.type === 'tool_call' && (
                      <span style={{ color: '#60a5fa', flexShrink: 0 }}>&#9654;</span>
                    )}
                    {line.type === 'error' && (
                      <span style={{ color: '#f87171', flexShrink: 0 }}>&#x2717;</span>
                    )}
                    {line.type === 'step' && (
                      <span style={{ color: '#fbbf24', flexShrink: 0 }}>&#9656;</span>
                    )}
                    {line.type === 'thinking' && (
                      <span style={{ color: '#a5b4fc', flexShrink: 0, fontStyle: 'italic' }}>&#8230;</span>
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
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 14,
                    background: 'var(--text)',
                    verticalAlign: 'middle',
                    marginLeft: 2,
                    borderRadius: 1,
                  }}
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
          style={{
            position: 'absolute',
            bottom: 8,
            right: 14,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 10,
            color: 'var(--text2)',
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            zIndex: 2,
          }}
        >
          \u2193 Scroll to bottom
        </motion.button>
      )}
    </div>
  );
}
