'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { patch } from '@/lib/api';
import { useEventSource } from '@/hooks/useEventSource';
import { useBridgeStore } from '@/stores/bridgeStore';
import { ClaudeOutputStream } from '@/components/atoms/ClaudeOutputStream';

interface StepProgressData {
  step: string;
  title: string;
  description: string;
  current: number;
  total: number;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  error?: string;
}

export interface WizardField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number';
  placeholder?: string;
  options?: string[];
  required?: boolean;
}

export interface WizardStep {
  actionId: number;
  step: string;
  title: string;
  description: string;
  fields: WizardField[];
  hints?: string[];
}

interface WizardModalProps {
  steps: WizardStep[];
  onComplete: () => void;
  onDismiss: () => void;
}

const STEP_ICONS: Record<string, string> = {
  vision: '◈',
  discovery: '?',
  milestone: '▶',
  epics: '≡',
  tickets: '#',
  sprint_launch: '⚡',
  retro: '◁',
};

const STEP_COLORS: Record<string, string> = {
  vision: '#818cf8',
  discovery: '#60a5fa',
  milestone: '#10b981',
  epics: '#fbbf24',
  tickets: '#ec4899',
  sprint_launch: '#06b6d4',
  retro: '#f87171',
};

// Animation variants
const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: {
    opacity: 0,
    scale: 0.95,
    y: 20,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 20,
  },
};

const contentVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 20 : -20,
    opacity: 0,
    scale: 0.98,
  }),
  center: {
    x: 0,
    opacity: 1,
    scale: 1,
  },
  exit: (direction: number) => ({
    x: direction < 0 ? 20 : -20,
    opacity: 0,
    scale: 0.98,
  }),
};

const inputStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border2)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13,
  padding: '10px 14px',
  fontFamily: 'var(--font)',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
};

const buttonStyle: React.CSSProperties = {
  borderRadius: 8,
  padding: '10px 20px',
  fontSize: 13,
  cursor: 'pointer',
  fontFamily: 'var(--font)',
  fontWeight: 500,
  border: 'none',
  transition: 'all 0.15s ease',
};

// Progress dots component
function ProgressDots({ currentIndex, totalSteps, accentColor }: { currentIndex: number; totalSteps: number; accentColor: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: '8px 0' }}>
      {Array.from({ length: totalSteps }).map((_, i) => (
        <motion.div
          key={i}
          initial={false}
          animate={{
            width: i === currentIndex ? 24 : 8,
            backgroundColor: i <= currentIndex ? accentColor : 'var(--border2)',
          }}
          transition={{ duration: reduceMotion ? 0 : 0.3, ease: 'easeInOut' }}
          style={{
            height: 8,
            borderRadius: 4,
          }}
        />
      ))}
    </div>
  );
}

export function WizardModal({ steps, onComplete, onDismiss }: WizardModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepProgress, setStepProgress] = useState<Record<number, StepProgressData>>({});
  const [currentExecutingStep, setCurrentExecutingStep] = useState<number | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [showOutputStream, setShowOutputStream] = useState(false);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  const reduceMotion = useReducedMotion();

  // Claude stream state from bridgeStore
  const claudeStream = useBridgeStore((s) => s.claudeStream);
  const hasClaudeOutput = claudeStream.lines.length > 0 || claudeStream.isActive;

  const current = steps[currentIndex];
  const isLast = currentIndex === steps.length - 1;
  const accentColor = STEP_COLORS[current?.step] ?? '#60a5fa';
  const icon = STEP_ICONS[current?.step] ?? '◈';

  // Listen for step progress events via SSE
  useEventSource({
    onEvent: (event) => {
      if (event.type === 'step_progress' && event.stepProgress) {
        const progress = event.stepProgress;
        const stepIndex = steps.findIndex(s => s.step === progress.step);
        if (stepIndex !== -1) {
          setStepProgress(prev => ({
            ...prev,
            [stepIndex]: progress,
          }));
          if (progress.status === 'in_progress') {
            setCurrentExecutingStep(stepIndex);
          } else if (progress.status === 'completed') {
            setCurrentExecutingStep(null);
          }
        }
      }
    },
  });

  // Reset values when step changes
  useEffect(() => {
    if (!current) return;
    const initial: Record<string, string> = {};
    for (const f of current.fields) initial[f.name] = '';
    setValues(initial);
    setError(null);
    setFocusedField(null);
    setTimeout(() => firstInputRef.current?.focus(), 50);
  }, [currentIndex, current]);

  // Escape to dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onDismiss]);

  if (!current) return null;

  const setValue = (name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }));
  };

  const validate = (): boolean => {
    for (const f of current.fields) {
      if (f.required !== false && !values[f.name]?.trim()) {
        setError(`"${f.label}" is required`);
        return false;
      }
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setError(null);
    setShowOutputStream(true);
    try {
      await patch(`/api/bridge/actions/${current.actionId}/respond`, { result: values });
      if (isLast) {
        onComplete();
      } else {
        setDirection(1);
        setCurrentIndex(i => i + 1);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const progress = ((currentIndex + 1) / steps.length) * 100;

  const transition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 300, damping: 30 };

  return (
    <motion.div
      variants={backdropVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      onClick={onDismiss}
      transition={transition}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <motion.div
        variants={modalVariants}
        onClick={e => e.stopPropagation()}
        transition={transition}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          maxWidth: 520,
          width: '92vw',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--border)', position: 'relative' }}>
          <motion.div
            style={{
              height: '100%',
              background: `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`,
            }}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
          />
        </div>

        {/* Real-time step progress indicator */}
        <AnimatePresence>
          {currentExecutingStep !== null && stepProgress[currentExecutingStep] && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{
                padding: '10px 28px',
                background: `${accentColor}10`,
                borderBottom: `1px solid ${accentColor}30`,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <motion.div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: `2px solid ${accentColor}`,
                    borderTopColor: 'transparent',
                  }}
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                />
                <div style={{ flex: 1 }}>
                  <motion.div
                    initial={{ opacity: 0, x: -5 }}
                    animate={{ opacity: 1, x: 0 }}
                    style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}
                  >
                    {stepProgress[currentExecutingStep]?.title || `Step ${currentExecutingStep + 1}`}
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.1 }}
                    style={{ fontSize: 11, color: 'var(--text2)' }}
                  >
                    {stepProgress[currentExecutingStep]?.description || 'Processing...'}
                  </motion.div>
                </div>
                <motion.div
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  style={{ fontSize: 11, color: 'var(--text3)' }}
                >
                  {stepProgress[currentExecutingStep]?.current ?? 0} / {stepProgress[currentExecutingStep]?.total ?? steps.length}
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Animated content container */}
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentIndex}
            custom={direction}
            variants={contentVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={transition}
            style={{ padding: '24px 28px 24px' }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <motion.div
                initial={{ rotate: -180, scale: 0 }}
                animate={{
                  rotate: 0,
                  scale: 1,
                  ...(currentExecutingStep === null && !reduceMotion ? {
                    rotate: [0, -5, 5, -5, 0],
                    scale: [1, 1.05, 1],
                  } : {})
                }}
                transition={{
                  type: 'spring',
                  stiffness: 260,
                  damping: 20,
                  delay: 0.1,
                  ...(currentExecutingStep === null && !reduceMotion ? {
                    duration: 0.5,
                    delay: 0.2,
                    times: [0, 0.25, 0.5, 0.75, 1],
                  } : {})
                }}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: `${accentColor}18`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  color: accentColor,
                  flexShrink: 0,
                  boxShadow: `0 0 20px ${accentColor}33`,
                }}
              >
                {currentExecutingStep !== null && currentExecutingStep === currentIndex ? (
                  <motion.span
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  >
                    ○
                  </motion.span>
                ) : (
                  icon
                )}
              </motion.div>
              <div>
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 }}
                  style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}
                >
                  {current.title}
                </motion.div>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2 }}
                  style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}
                >
                  Step {currentIndex + 1} of {steps.length}
                </motion.div>
              </div>
            </div>

            {/* Description */}
            <motion.div
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
              style={{ paddingTop: 12, fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}
            >
              {current.description}
            </motion.div>

            {/* Hints */}
            {current.hints && current.hints.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                style={{ paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {current.hints.map((hint, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.35 + i * 0.05 }}
                    style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', gap: 8, alignItems: 'baseline' }}
                  >
                    {!reduceMotion ? (
                      <motion.span
                        animate={{ x: [0, 4, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 1, ease: 'easeInOut' }}
                        style={{ color: accentColor }}
                      >
                        ▸
                      </motion.span>
                    ) : (
                      <span style={{ color: accentColor }}>▸</span>
                    )}
                    {hint}
                  </motion.div>
                ))}
              </motion.div>
            )}

            {/* Claude Output Stream Panel - visible after submission or when output arrives */}
            <AnimatePresence>
              {(showOutputStream || hasClaudeOutput) && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 12 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.25 }}
                  style={{ overflow: 'hidden' }}
                >
                  <ClaudeOutputStream
                    lines={claudeStream.lines}
                    currentStep={claudeStream.currentStepProgress}
                    isActive={claudeStream.isActive}
                    maxHeight={260}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {current.fields.map((field, idx) => (
                <motion.div
                  key={field.name}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + idx * 0.08 }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  <motion.label
                    animate={{ scale: focusedField === field.name ? 1.01 : 1 }}
                    style={{ fontSize: 12, fontWeight: 600, color: focusedField === field.name ? 'var(--accent)' : 'var(--text2)', originX: 0, transition: 'color 0.2s ease' }}
                  >
                    {field.label}
                    {field.required !== false && (
                      <motion.span
                        animate={focusedField === field.name ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                        transition={{ duration: 0.3 }}
                        style={{ color: accentColor, marginLeft: 4, display: 'inline-block' }}
                      >
                        *
                      </motion.span>
                    )}
                  </motion.label>
                  {field.type === 'textarea' ? (
                    <div style={{ position: 'relative' }}>
                      <motion.textarea
                        ref={idx === 0 ? firstInputRef as React.RefObject<HTMLTextAreaElement> : undefined}
                        style={{
                          ...inputStyle,
                          resize: 'vertical',
                          minHeight: 100,
                          borderColor: focusedField === field.name ? accentColor : 'var(--border2)',
                          boxShadow: focusedField === field.name ? `0 0 0 3px rgba(99, 102, 241, 0.1)` : 'none',
                        }}
                        placeholder={field.placeholder}
                        value={values[field.name] ?? ''}
                        onChange={e => setValue(field.name, e.target.value)}
                        disabled={submitting}
                        onFocus={() => setFocusedField(field.name)}
                        onBlur={() => setFocusedField(null)}
                        whileFocus={reduceMotion ? {} : { scale: 1.005 }}
                        transition={{ duration: 0.15 }}
                      />
                      {!reduceMotion && (
                        <motion.div
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: focusedField === field.name ? 1 : 0 }}
                          transition={{ duration: 0.2 }}
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: 2,
                            background: `linear-gradient(90deg, ${accentColor}, ${accentColor}88)`,
                            borderRadius: '0 0 8px 8px',
                            originX: 0.5,
                          }}
                        />
                      )}
                    </div>
                  ) : field.type === 'select' ? (
                    <div style={{ position: 'relative' }}>
                      <motion.select
                        ref={idx === 0 ? firstInputRef as React.RefObject<HTMLSelectElement> : undefined}
                        style={{
                          ...inputStyle,
                          cursor: 'pointer',
                          borderColor: focusedField === field.name ? accentColor : 'var(--border2)',
                          boxShadow: focusedField === field.name ? `0 0 0 3px rgba(99, 102, 241, 0.1)` : 'none',
                        }}
                        value={values[field.name] ?? ''}
                        onChange={e => setValue(field.name, e.target.value)}
                        disabled={submitting}
                        onFocus={() => setFocusedField(field.name)}
                        onBlur={() => setFocusedField(null)}
                        whileFocus={reduceMotion ? {} : { scale: 1.005 }}
                        transition={{ duration: 0.15 }}
                      >
                        <option value="">Select...</option>
                        {field.options?.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </motion.select>
                      {!reduceMotion && (
                        <motion.div
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: focusedField === field.name ? 1 : 0 }}
                          transition={{ duration: 0.2 }}
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: 2,
                            background: `linear-gradient(90deg, ${accentColor}, ${accentColor}88)`,
                            borderRadius: '0 0 8px 8px',
                            originX: 0.5,
                          }}
                        />
                      )}
                    </div>
                  ) : (
                    <div style={{ position: 'relative' }}>
                      <motion.input
                        ref={idx === 0 ? firstInputRef as React.RefObject<HTMLInputElement> : undefined}
                        type={field.type}
                        style={{
                          ...inputStyle,
                          borderColor: focusedField === field.name ? accentColor : 'var(--border2)',
                          boxShadow: focusedField === field.name ? `0 0 0 3px rgba(99, 102, 241, 0.1)` : 'none',
                        }}
                        placeholder={field.placeholder}
                        value={values[field.name] ?? ''}
                        onChange={e => setValue(field.name, e.target.value)}
                        disabled={submitting}
                        onFocus={() => setFocusedField(field.name)}
                        onBlur={() => setFocusedField(null)}
                        whileFocus={reduceMotion ? {} : { scale: 1.005 }}
                        transition={{ duration: 0.15 }}
                      />
                      {!reduceMotion && (
                        <motion.div
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: focusedField === field.name ? 1 : 0 }}
                          transition={{ duration: 0.2 }}
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: 2,
                            background: `linear-gradient(90deg, ${accentColor}, ${accentColor}88)`,
                            borderRadius: '0 0 8px 8px',
                            originX: 0.5,
                          }}
                        />
                      )}
                    </div>
                  )}
                </motion.div>
              ))}

              {/* Error message */}
              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, height: 0, y: -10 }}
                    animate={{ opacity: 1, height: 'auto', y: 0 }}
                    exit={{ opacity: 0, height: 0, y: -10 }}
                    style={{
                      fontSize: 12,
                      color: '#f87171',
                      padding: '8px 12px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      borderRadius: 6,
                      border: '1px solid rgba(239, 68, 68, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/>
                      <line x1="7" y1="4" x2="7" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      <circle cx="7" cy="10.5" r="0.75" fill="currentColor"/>
                    </svg>
                    {error}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Progress dots */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
              >
                <ProgressDots currentIndex={currentIndex} totalSteps={steps.length} accentColor={accentColor} />
              </motion.div>

              {/* Actions */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55 }}
                style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}
              >
                <motion.button
                  type="button"
                  onClick={onDismiss}
                  style={{
                    ...buttonStyle,
                    background: 'none',
                    border: '1px solid var(--border2)',
                    color: 'var(--text2)',
                  }}
                  whileHover={reduceMotion ? {} : { scale: 1.02, borderColor: 'var(--border)' }}
                  whileTap={reduceMotion ? {} : { scale: 0.98 }}
                >
                  Dismiss
                </motion.button>
                <motion.button
                  type="submit"
                  disabled={submitting}
                  style={{
                    ...buttonStyle,
                    background: submitting ? 'var(--text3)' : accentColor,
                    color: '#fff',
                    opacity: submitting ? 0.7 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  whileHover={submitting || reduceMotion ? {} : { scale: 1.02, boxShadow: `0 4px 12px ${accentColor}66` }}
                  whileTap={submitting || reduceMotion ? {} : { scale: 0.98 }}
                >
                  {submitting ? (
                    <>
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                        style={{ display: 'inline-block' }}
                      >
                        ○
                      </motion.span>
                      Sending...
                    </>
                  ) : (
                    <>
                      {isLast ? 'Finish' : 'Next'}
                      <motion.span
                        animate={isLast ? { scale: [1, 1.2, 1] } : { x: [0, 4, 0] }}
                        transition={{ duration: isLast ? 0.5 : 1, repeat: isLast ? 1 : Infinity, repeatDelay: 0.5 }}
                      >
                        {isLast ? '✓' : '→'}
                      </motion.span>
                    </>
                  )}
                </motion.button>
              </motion.div>
            </form>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
