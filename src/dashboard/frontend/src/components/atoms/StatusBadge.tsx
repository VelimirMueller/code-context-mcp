import React from 'react';

type StatusIcon = '✓' | '✗' | '⚠' | '★' | '●' | '○';
type StatusVariant = 'solid' | 'outline';

interface StatusBadgeProps {
  icon: StatusIcon;
  label: string;
  color?: string;
  variant?: StatusVariant;
  className?: string;
  style?: React.CSSProperties;
}

const defaultColors: Record<string, string> = {
  success: 'var(--green)',
  warning: 'var(--orange)',
  error: 'var(--red)',
  info: 'var(--blue)',
  purple: 'var(--purple)',
  neutral: 'var(--text3)',
};

export function StatusBadge({
  icon,
  label,
  color = 'var(--accent)',
  variant = 'solid',
  className = '',
  style = {},
}: StatusBadgeProps) {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 10,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    ...style,
  };

  const variantStyle: React.CSSProperties =
    variant === 'solid'
      ? { background: color, color: 'white', border: 'none' }
      : { background: 'transparent', color, border: `1px solid ${color}` };

  return (
    <span
      className={`status-badge ${className}`}
      style={{ ...baseStyle, ...variantStyle }}
      role="status"
      aria-label={`${label} status`}
    >
      <span style={{ fontSize: 11, lineHeight: 1 }}>{icon}</span>
      <span>{label}</span>
    </span>
  );
}

// Preset badges for common statuses
export function RetroDoneBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="✓" label="Retro" color="var(--accent)" variant={variant} />;
}

export function QaVerifiedBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="✓" label="QA" color="var(--accent)" variant={variant} />;
}

export function QaPendingBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="⚠" label="QA Pending" color="var(--orange)" variant={variant} />;
}

export function VelocityMetBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="★" label="Target Met" color="var(--purple)" variant={variant} />;
}

export function VelocityLowBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="⚠" label="Velocity Low" color="var(--red)" variant={variant} />;
}
