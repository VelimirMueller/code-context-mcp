import { cx } from '@/lib/utils';

type BadgeVariant = 'fn' | 'type' | 'const' | 'class' | 'interface' | 'pkg' | 'default';

interface BadgeProps {
  text: string;
  variant?: BadgeVariant;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  fn: 'bg-[rgba(59,130,246,.08)] text-blue border-[rgba(59,130,246,.12)]',
  type: 'bg-[rgba(167,139,250,.08)] text-accent-2 border-[rgba(167,139,250,.12)]',
  const: 'bg-[rgba(52,211,153,.08)] text-green border-[rgba(52,211,153,.12)]',
  class: 'bg-[rgba(251,191,36,.08)] text-orange border-[rgba(251,191,36,.12)]',
  interface: 'bg-[rgba(244,114,182,.08)] text-accent border-[rgba(244,114,182,.12)]',
  pkg: 'bg-surface-2 text-fg-2 border-line',
  default: 'bg-surface-2 text-fg-2 border-line',
};

export function Badge({ text, variant = 'default', className }: BadgeProps) {
  return (
    <span data-variant={variant} className={cx('border', variantClasses[variant], className)}>
      {text}
    </span>
  );
}
