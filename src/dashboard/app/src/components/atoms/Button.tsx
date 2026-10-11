import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  variant?: ButtonVariant;
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  style?: React.CSSProperties;
  className?: string;
  'aria-label'?: string;
}

export function Button({ variant = 'primary', children, style, ...props }: ButtonProps) {
  const reduceMotion = useReducedMotion();

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 14px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font)',
    fontSize: 13,
    fontWeight: 500,
    transition: 'background .15s, color .15s',
    ...(variant === 'primary' && {
      background: 'var(--pill-bg)',
      color: 'var(--pill-fg)',
      borderRadius: 'var(--radius-pill)',
      fontWeight: 600,
    }),
    ...(variant === 'secondary' && {
      background: 'var(--surface3)',
      color: 'var(--text)',
      border: '1px solid var(--border2)',
    }),
    ...(variant === 'ghost' && {
      background: 'transparent',
      color: 'var(--text2)',
    }),
    ...style,
  };

  return (
    <motion.button
      whileTap={reduceMotion ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      style={baseStyle}
      {...props}
    >
      {children}
    </motion.button>
  );
}
