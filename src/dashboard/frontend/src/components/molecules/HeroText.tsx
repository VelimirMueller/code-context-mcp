import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

interface HeroTextProps {
  children: React.ReactNode;
  subtitle?: string;
}

const containerVariants = {
  animate: {
    transition: { staggerChildren: 0.06 },
  },
};

const wordVariants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 400, damping: 30 },
  },
};

const reducedVariants = {
  initial: { opacity: 1, y: 0 },
  animate: { opacity: 1, y: 0 },
};

/**
 * Splits ReactNode children into words and non-word elements, staggering each
 * word in with a spring animation. Non-string children (e.g. AnimatedNumber)
 * are rendered inline as their own motion item.
 */
function splitToItems(children: React.ReactNode): React.ReactNode[] {
  const items: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (typeof child === 'string') {
      // Split on spaces, re-add a trailing space to each word except the last
      const words = child.split(/(\s+)/);
      words.forEach((part) => {
        if (part.trim().length > 0) {
          items.push(part);
        } else if (part.length > 0) {
          // whitespace token — attach to previous item or emit as separator
          items.push(part);
        }
      });
    } else {
      items.push(child);
    }
  });

  return items;
}

export function HeroText({ children, subtitle }: HeroTextProps) {
  const shouldReduce = useReducedMotion();
  const items = splitToItems(children);

  const wv = shouldReduce ? reducedVariants : wordVariants;

  return (
    <div
      style={{
        maxHeight: 80,
        padding: '14px 24px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <motion.div
        variants={shouldReduce ? undefined : containerVariants}
        initial="initial"
        animate="animate"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 4px', lineHeight: 1.4 }}
      >
        {items.map((item, i) => {
          if (typeof item === 'string') {
            if (item.trim().length === 0) {
              // pure whitespace — render without animation wrapper
              return <span key={i}>{item}</span>;
            }
            return (
              <motion.span
                key={i}
                variants={wv}
                style={{ fontSize: 15, fontWeight: 600, color: 'var(--text2)', fontFamily: 'var(--font)' }}
              >
                {item}
              </motion.span>
            );
          }
          // Non-string child (e.g. AnimatedNumber) — wrap in motion.span
          return (
            <motion.span key={i} variants={wv} style={{ display: 'inline-flex', alignItems: 'baseline' }}>
              {item}
            </motion.span>
          );
        })}
      </motion.div>

      {subtitle && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text3)',
            marginTop: 2,
            fontFamily: 'var(--font)',
            letterSpacing: '0.02em',
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}
