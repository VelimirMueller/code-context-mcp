import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cx } from '@/lib/utils';

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

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'rounded-pill border-none bg-pill font-semibold text-pill-fg',
  secondary: 'rounded-[8px] border border-line-2 bg-surface-3 font-medium text-fg',
  ghost: 'rounded-[8px] border-none bg-transparent font-medium text-fg-2',
};

export function Button({ variant = 'primary', children, className, ...props }: ButtonProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      whileTap={reduceMotion ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={cx(
        'inline-flex cursor-pointer items-center gap-[6px] px-[14px] py-[6px] font-body text-13 [transition:background_.15s,color_.15s]',
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </motion.button>
  );
}
