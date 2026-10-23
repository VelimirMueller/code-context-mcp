import { useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { motion, AnimatePresence, useReducedMotion, useAnimation } from 'framer-motion';

interface LandingAnimationProps {
  onComplete: () => void;
}

// ── Phase 1: Grid lines (SVG) ─────────────────────────────────────────
const GRID_LINES = [
  // Horizontal lines [x1, y1, x2, y2] in a 400×300 viewBox
  { id: 'h0', x1: 0, y1: 80, x2: 400, y2: 80, delay: 0.0 },
  { id: 'h1', x1: 0, y1: 150, x2: 400, y2: 150, delay: 0.06 },
  { id: 'h2', x1: 0, y1: 220, x2: 400, y2: 220, delay: 0.12 },
  // Vertical lines
  { id: 'v0', x1: 100, y1: 0, x2: 100, y2: 300, delay: 0.03 },
  { id: 'v1', x1: 200, y1: 0, x2: 200, y2: 300, delay: 0.09 },
  { id: 'v2', x1: 300, y1: 0, x2: 300, y2: 300, delay: 0.15 },
];

// ── Phase 2: File nodes (constellation) ──────────────────────────────
const FILE_NODES = [
  { id: 'f0', x: 55, y: 62, color: 'var(--blue)', delay: 0.4 },
  { id: 'f1', x: 155, y: 40, color: 'var(--purple)', delay: 0.5 },
  { id: 'f2', x: 260, y: 70, color: 'var(--green)', delay: 0.55 },
  { id: 'f3', x: 100, y: 130, color: 'var(--accent)', delay: 0.6 },
  { id: 'f4', x: 310, y: 125, color: 'var(--blue)', delay: 0.65 },
  { id: 'f5', x: 195, y: 155, color: 'var(--purple)', delay: 0.7 },
];

// ── Phase 4: Agent circles ────────────────────────────────────────────
const AGENT_CIRCLES = [
  { id: 'a0', color: 'var(--accent)', delay: 1.5 },
  { id: 'a1', color: 'var(--blue)', delay: 1.65 },
  { id: 'a2', color: 'var(--purple)', delay: 1.8 },
  { id: 'a3', color: 'var(--orange)', delay: 1.95 },
];

// ── Phase 5: Labels ───────────────────────────────────────────────────
const LABELS = [
  { id: 'l0', text: 'Code Context', delay: 2.0 },
  { id: 'l1', text: 'MCP Platform', delay: 2.25 },
];

function TypewriterText({ text, delay }: { text: string; delay: number }) {
  const letters = Array.from(text);
  return (
    <motion.span className="font-code text-13 text-fg-2 tracking-[0.04em]">
      {letters.map((ch, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: delay + i * 0.045, duration: 0.01 }}
        >
          {ch}
        </motion.span>
      ))}
    </motion.span>
  );
}

export function LandingAnimation({ onComplete }: LandingAnimationProps) {
  const prefersReduced = useReducedMotion();
  const overlayControls = useAnimation();

  // Skip logic: reduced motion or already played
  useEffect(() => {
    if (prefersReduced) {
      sessionStorage.setItem('landing-played', 'true');
      onComplete();
    }
  }, [prefersReduced, onComplete]);

  const dismiss = useCallback(() => {
    overlayControls.start({ opacity: 0, transition: { duration: 0.4 } }).then(() => {
      sessionStorage.setItem('landing-played', 'true');
      onComplete();
    });
  }, [overlayControls, onComplete]);

  // Auto-dismiss after 3.5 s
  useEffect(() => {
    if (prefersReduced) return;
    const t = setTimeout(dismiss, 3500);
    return () => clearTimeout(t);
  }, [prefersReduced, dismiss]);

  // Escape key skips
  useEffect(() => {
    if (prefersReduced) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [prefersReduced, dismiss]);

  // If reduced motion, render nothing (effect above calls onComplete immediately)
  if (prefersReduced) return null;

  return (
    <AnimatePresence>
      <motion.div
        animate={overlayControls}
        initial={{ opacity: 1 }}
        className="fixed inset-0 z-[9999] bg-bg flex items-center justify-center flex-col gap-6"
      >
        {/* ── Central composition (max 400px wide) ── */}
        <div className="w-full max-w-[400px] relative">
          {/* Phase 1: Grid lines SVG */}
          <svg
            viewBox="0 0 400 300"
            width="400"
            height="300"
            className="absolute inset-0 pointer-events-none"
          >
            {GRID_LINES.map((l) => (
              <motion.line
                key={l.id}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                stroke="var(--border2)"
                strokeWidth={0.75}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ delay: l.delay, duration: 0.5, ease: 'easeOut' }}
              />
            ))}
          </svg>

          {/* Phase 2: File nodes */}
          <svg
            viewBox="0 0 400 300"
            width="400"
            height="300"
            className="absolute inset-0 pointer-events-none"
          >
            {FILE_NODES.map((n) => (
              <motion.rect
                key={n.id}
                x={n.x - 18}
                y={n.y - 10}
                width={36}
                height={20}
                rx={5}
                fill={n.color}
                fillOpacity={0.18}
                stroke={n.color}
                strokeWidth={1.2}
                initial={{ opacity: 0, scaleX: 0.8, scaleY: 0.8, y: n.y + 8 }}
                animate={{ opacity: 1, scaleX: 1, scaleY: 1, y: n.y - 10 }}
                transition={{
                  delay: n.delay,
                  type: 'spring',
                  stiffness: 280,
                  damping: 22,
                }}
                style={{ originX: n.x + 'px', originY: n.y + 'px' }}
              />
            ))}
          </svg>

          {/* Phase 3: Sprint board — slides in from right */}
          <motion.div
            initial={{ x: 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 1.0, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-2 bottom-7 w-[110px] h-16 bg-surface-2 border border-line-2 rounded-[8px] p-2 flex gap-[6px] items-stretch"
          >
            {['var(--text3)', 'var(--accent)', 'var(--blue)'].map((c, i) => (
              <div
                key={i}
                style={{ '--c': c } as CSSProperties}
                className="flex-1 bg-(--c) opacity-35 rounded-[4px]"
              />
            ))}
          </motion.div>

          {/* Spacer so the composition has correct height */}
          <div className="w-[400px] h-[300px]" />
        </div>

        {/* Phase 4: Agent circles */}
        <div className="flex gap-[14px] items-center">
          {AGENT_CIRCLES.map((a) => (
            <motion.div
              key={a.id}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: [0, 1.15, 1], opacity: 1 }}
              transition={{
                delay: a.delay,
                duration: 0.4,
                times: [0, 0.6, 1],
                ease: 'easeOut',
              }}
              className="w-7 h-7 rounded-[50%] bg-(--c) opacity-85"
              style={
                {
                  '--c': a.color,
                  boxShadow: `0 0 12px ${a.color}55`,
                } as CSSProperties
              }
            />
          ))}
        </div>

        {/* Phase 5: Typewriter labels */}
        <div className="flex gap-3 items-center">
          {LABELS.map((l, i) => (
            <span key={l.id} className="flex items-center gap-2">
              {i > 0 && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: l.delay - 0.05 }}
                  className="text-fg-3 text-13"
                >
                  /
                </motion.span>
              )}
              <TypewriterText text={l.text} delay={l.delay} />
            </span>
          ))}
        </div>

        {/* Skip button */}
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.4 }}
          onClick={dismiss}
          className="fixed bottom-6 right-6 bg-transparent border border-line-2 rounded-[6px] text-fg-3 text-12 py-[5px] px-3 cursor-pointer font-body tracking-[0.02em]"
          whileHover={{ color: 'var(--text2)', borderColor: 'var(--border)' }}
        >
          Skip
        </motion.button>
      </motion.div>
    </AnimatePresence>
  );
}
