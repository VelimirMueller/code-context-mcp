import React from 'react';

type BadgeVariant = 'fn' | 'type' | 'const' | 'class' | 'interface' | 'pkg' | 'default';

interface BadgeProps {
  text: string;
  variant?: BadgeVariant;
  className?: string;
}

const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
  fn:        { background: 'rgba(59,130,246,.08)',   color: '#60a5fa',           border: '1px solid rgba(59,130,246,.12)' },
  type:      { background: 'rgba(167,139,250,.08)',  color: 'var(--purple)',     border: '1px solid rgba(167,139,250,.12)' },
  const:     { background: 'rgba(52,211,153,.08)',   color: 'var(--green)',      border: '1px solid rgba(52,211,153,.12)' },
  class:     { background: 'rgba(251,191,36,.08)',   color: 'var(--orange)',     border: '1px solid rgba(251,191,36,.12)' },
  interface: { background: 'rgba(244,114,182,.08)',  color: 'var(--pink)',       border: '1px solid rgba(244,114,182,.12)' },
  pkg:       { background: 'var(--surface2)',         color: 'var(--text2)',      border: '1px solid var(--border)' },
  default:   { background: 'var(--surface2)',         color: 'var(--text2)',      border: '1px solid var(--border)' },
};

export function Badge({ text, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={`badge badge-${variant} ${className}`}
      style={variantStyles[variant]}
    >
      {text}
    </span>
  );
}
