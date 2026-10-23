'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { patch } from '@/lib/api';
import { useEventSource } from '@/hooks/useEventSource';
import { useBridgeStore } from '@/stores/bridgeStore';
import { ClaudeOutputStream } from '@/components/atoms/ClaudeOutputStream';
import { cx } from '@/lib/utils';

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

const inputClasses =
  'bg-surface-2 border rounded-[8px] text-fg text-13 py-[10px] px-[14px] font-body w-full [outline:none] box-border [transition:border-color_0.2s_ease,box-shadow_0.2s_ease]';

const focusClasses = (focused: boolean) =>
  focused
    ? 'border-(--c) [box-shadow:0_0_0_3px_rgba(99,102,241,0.1)]'
    : 'border-line-2 [box-shadow:none]';

const buttonClasses =
  'rounded-[8px] py-[10px] px-5 text-13 cursor-pointer font-body font-medium [transition:all_0.15s_ease]';

const underlineClasses =
  'absolute bottom-0 left-0 right-0 h-0.5 rounded-[0_0_8px_8px] origin-center [background:linear-gradient(90deg,var(--c),var(--c-88))]';

// Progress dots component
function ProgressDots({
  currentIndex,
  totalSteps,
  accentColor,
}: {
  currentIndex: number;
  totalSteps: number;
  accentColor: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex gap-2 items-center justify-center py-2">
      {Array.from({ length: totalSteps }).map((_, i) => (
        <motion.div
          key={i}
          initial={false}
          animate={{
            width: i === currentIndex ? 24 : 8,
            backgroundColor: i <= currentIndex ? accentColor : 'var(--color-line-2)',
          }}
          transition={{ duration: reduceMotion ? 0 : 0.3, ease: 'easeInOut' }}
          className="h-2 rounded-[4px]"
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
        const stepIndex = steps.findIndex((s) => s.step === progress.step);
        if (stepIndex !== -1) {
          setStepProgress((prev) => ({
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
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onDismiss]);

  if (!current) return null;

  const setValue = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
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
        setCurrentIndex((i) => i + 1);
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
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[rgba(0,0,0,0.6)] [backdrop-filter:blur(8px)]"
    >
      <motion.div
        variants={modalVariants}
        onClick={(e) => e.stopPropagation()}
        transition={transition}
        className="bg-surface border border-line rounded-[16px] max-w-[520px] w-[92vw] flex flex-col [box-shadow:0_24px_80px_rgba(0,0,0,0.5)] overflow-hidden"
        style={
          {
            '--c': accentColor,
            '--c-10': `${accentColor}10`,
            '--c-18': `${accentColor}18`,
            '--c-30': `${accentColor}30`,
            '--c-33': `${accentColor}33`,
            '--c-88': `${accentColor}88`,
            '--c-cc': `${accentColor}cc`,
          } as React.CSSProperties
        }
      >
        {/* Progress bar */}
        <div className="h-[3px] bg-line relative">
          <motion.div
            className="h-full [background:linear-gradient(90deg,var(--c),var(--c-cc))]"
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
              className="overflow-hidden"
            >
              <div className="py-[10px] px-7 flex items-center gap-[10px] bg-(--c-10) border-b border-b-(color:--c-30)">
                <motion.div
                  className="w-[18px] h-[18px] rounded-[50%] border-2 border-(--c) border-t-transparent"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                />
                <div className="flex-1">
                  <motion.div
                    initial={{ opacity: 0, x: -5 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-12 font-semibold text-fg"
                  >
                    {stepProgress[currentExecutingStep]?.title ||
                      `Step ${currentExecutingStep + 1}`}
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.1 }}
                    className="text-11 text-fg-2"
                  >
                    {stepProgress[currentExecutingStep]?.description || 'Processing...'}
                  </motion.div>
                </div>
                <motion.div
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  className="text-11 text-fg-3"
                >
                  {stepProgress[currentExecutingStep]?.current ?? 0} /{' '}
                  {stepProgress[currentExecutingStep]?.total ?? steps.length}
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
            className="py-6 px-7"
          >
            {/* Header */}
            <div className="flex items-center gap-3">
              <motion.div
                initial={{ rotate: -180, scale: 0 }}
                animate={{
                  rotate: 0,
                  scale: 1,
                  ...(currentExecutingStep === null && !reduceMotion
                    ? {
                        rotate: [0, -5, 5, -5, 0],
                        scale: [1, 1.05, 1],
                      }
                    : {}),
                }}
                transition={{
                  type: 'spring',
                  stiffness: 260,
                  damping: 20,
                  delay: 0.1,
                  ...(currentExecutingStep === null && !reduceMotion
                    ? {
                        duration: 0.5,
                        delay: 0.2,
                        times: [0, 0.25, 0.5, 0.75, 1],
                      }
                    : {}),
                }}
                className="w-10 h-10 rounded-[12px] flex items-center justify-center text-18 text-(--c) shrink-0 bg-(--c-18) [box-shadow:0_0_20px_var(--c-33)]"
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
                  className="text-16 font-bold text-fg"
                >
                  {current.title}
                </motion.div>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2 }}
                  className="text-11 text-fg-3 mt-0.5"
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
              className="pt-3 text-13 text-fg-2 leading-[1.6]"
            >
              {current.description}
            </motion.div>

            {/* Hints */}
            {current.hints && current.hints.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="pt-[10px] flex flex-col gap-[6px]"
              >
                {current.hints.map((hint, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.35 + i * 0.05 }}
                    className="text-12 text-fg-3 flex gap-2 items-baseline"
                  >
                    {!reduceMotion ? (
                      <motion.span
                        animate={{ x: [0, 4, 0] }}
                        transition={{
                          duration: 1.5,
                          repeat: Infinity,
                          repeatDelay: 1,
                          ease: 'easeInOut',
                        }}
                        className="text-(--c)"
                      >
                        ▸
                      </motion.span>
                    ) : (
                      <span className="text-(--c)">▸</span>
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
                  className="overflow-hidden"
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
            <form onSubmit={handleSubmit} className="pt-4 flex flex-col gap-3">
              {current.fields.map((field, idx) => (
                <motion.div
                  key={field.name}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + idx * 0.08 }}
                  className="flex flex-col gap-[6px]"
                >
                  <motion.label
                    animate={{ scale: focusedField === field.name ? 1.01 : 1 }}
                    className={cx(
                      'text-12 font-semibold origin-left [transition:color_0.2s_ease]',
                      focusedField === field.name ? 'text-accent' : 'text-fg-2',
                    )}
                  >
                    {field.label}
                    {field.required !== false && (
                      <motion.span
                        animate={
                          focusedField === field.name ? { scale: [1, 1.2, 1] } : { scale: 1 }
                        }
                        transition={{ duration: 0.3 }}
                        className="text-(--c) ml-1 inline-block"
                      >
                        *
                      </motion.span>
                    )}
                  </motion.label>
                  {field.type === 'textarea' ? (
                    <div className="relative">
                      <motion.textarea
                        ref={
                          idx === 0
                            ? (firstInputRef as React.RefObject<HTMLTextAreaElement>)
                            : undefined
                        }
                        className={cx(
                          inputClasses,
                          'resize-y min-h-[100px]',
                          focusClasses(focusedField === field.name),
                        )}
                        placeholder={field.placeholder}
                        value={values[field.name] ?? ''}
                        onChange={(e) => setValue(field.name, e.target.value)}
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
                          className={underlineClasses}
                        />
                      )}
                    </div>
                  ) : field.type === 'select' ? (
                    <div className="relative">
                      <motion.select
                        ref={
                          idx === 0
                            ? (firstInputRef as React.RefObject<HTMLSelectElement>)
                            : undefined
                        }
                        className={cx(
                          inputClasses,
                          'cursor-pointer',
                          focusClasses(focusedField === field.name),
                        )}
                        value={values[field.name] ?? ''}
                        onChange={(e) => setValue(field.name, e.target.value)}
                        disabled={submitting}
                        onFocus={() => setFocusedField(field.name)}
                        onBlur={() => setFocusedField(null)}
                        whileFocus={reduceMotion ? {} : { scale: 1.005 }}
                        transition={{ duration: 0.15 }}
                      >
                        <option value="">Select...</option>
                        {field.options?.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </motion.select>
                      {!reduceMotion && (
                        <motion.div
                          initial={{ scaleX: 0 }}
                          animate={{ scaleX: focusedField === field.name ? 1 : 0 }}
                          transition={{ duration: 0.2 }}
                          className={underlineClasses}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="relative">
                      <motion.input
                        ref={
                          idx === 0
                            ? (firstInputRef as React.RefObject<HTMLInputElement>)
                            : undefined
                        }
                        type={field.type}
                        className={cx(inputClasses, focusClasses(focusedField === field.name))}
                        placeholder={field.placeholder}
                        value={values[field.name] ?? ''}
                        onChange={(e) => setValue(field.name, e.target.value)}
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
                          className={underlineClasses}
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
                    className="text-12 text-red py-2 px-3 bg-[rgba(239,68,68,0.1)] rounded-[6px] border border-[rgba(239,68,68,0.2)] flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
                      <line
                        x1="7"
                        y1="4"
                        x2="7"
                        y2="8"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                      <circle cx="7" cy="10.5" r="0.75" fill="currentColor" />
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
                <ProgressDots
                  currentIndex={currentIndex}
                  totalSteps={steps.length}
                  accentColor={accentColor}
                />
              </motion.div>

              {/* Actions */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55 }}
                className="flex gap-[10px] justify-end mt-2"
              >
                <motion.button
                  type="button"
                  onClick={onDismiss}
                  className={cx(buttonClasses, 'bg-transparent border border-line-2 text-fg-2')}
                  whileHover={reduceMotion ? {} : { scale: 1.02, borderColor: 'var(--color-line)' }}
                  whileTap={reduceMotion ? {} : { scale: 0.98 }}
                >
                  Dismiss
                </motion.button>
                <motion.button
                  type="submit"
                  disabled={submitting}
                  className={cx(
                    buttonClasses,
                    'border-none text-[#fff] flex items-center gap-2',
                    submitting ? 'bg-fg-3 opacity-70' : 'bg-(--c) opacity-100',
                  )}
                  whileHover={
                    submitting || reduceMotion
                      ? {}
                      : { scale: 1.02, boxShadow: `0 4px 12px ${accentColor}66` }
                  }
                  whileTap={submitting || reduceMotion ? {} : { scale: 0.98 }}
                >
                  {submitting ? (
                    <>
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                        className="inline-block"
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
                        transition={{
                          duration: isLast ? 0.5 : 1,
                          repeat: isLast ? 1 : Infinity,
                          repeatDelay: 0.5,
                        }}
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
