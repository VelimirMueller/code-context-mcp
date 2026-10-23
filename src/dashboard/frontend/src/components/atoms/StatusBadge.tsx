import type { CSSProperties } from 'react';
import { cx } from '@/lib/utils';

type StatusIcon = '✓' | '✗' | '⚠' | '★' | '●' | '○';
type StatusVariant = 'solid' | 'outline';

interface StatusBadgeProps {
  icon: StatusIcon;
  label: string;
  color?: string;
  variant?: StatusVariant;
  className?: string;
  style?: CSSProperties;
}

const defaultColors: Record<string, string> = {
  success: 'var(--color-green)',
  warning: 'var(--color-orange)',
  error: 'var(--color-red)',
  info: 'var(--color-blue)',
  purple: 'var(--color-accent-2)',
  neutral: 'var(--color-fg-3)',
};

export function StatusBadge({
  icon,
  label,
  color = 'var(--color-accent)',
  variant = 'solid',
  className,
  style = {},
}: StatusBadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-[12px] px-2 py-[2px] text-10 font-semibold whitespace-nowrap',
        variant === 'solid'
          ? 'border-none bg-(--c) text-[white]'
          : 'border border-(--c) bg-transparent text-(--c)',
        className,
      )}
      style={{ ...style, '--c': color } as CSSProperties}
      role="status"
      aria-label={`${label} status`}
    >
      <span className="text-11 leading-none">{icon}</span>
      <span>{label}</span>
    </span>
  );
}

// Preset badges for common statuses
export function RetroDoneBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="✓" label="Retro" color="var(--color-accent)" variant={variant} />;
}

export function QaVerifiedBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="✓" label="QA" color="var(--color-accent)" variant={variant} />;
}

export function QaPendingBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="⚠" label="QA Pending" color="var(--color-orange)" variant={variant} />;
}

export function VelocityMetBadge({ variant }: { variant?: StatusVariant }) {
  return (
    <StatusBadge icon="★" label="Target Met" color="var(--color-accent-2)" variant={variant} />
  );
}

export function VelocityLowBadge({ variant }: { variant?: StatusVariant }) {
  return <StatusBadge icon="⚠" label="Velocity Low" color="var(--color-red)" variant={variant} />;
}
