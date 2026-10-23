import { useReducedMotion } from 'framer-motion';
import { cx } from '@/lib/utils';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  count?: number;
}

const SHIMMER =
  'bg-[linear-gradient(90deg,var(--color-surface-2)_25%,var(--color-surface-3)_50%,var(--color-surface-2)_75%)] bg-size-[200%_100%] animate-shimmer';

export function Skeleton({ width = '100%', height = 14, className, count = 1 }: SkeletonProps) {
  const reduceMotion = useReducedMotion();
  const bars = Array.from({ length: count });

  return (
    <>
      {bars.map((_, i) => (
        <div
          key={i}
          data-testid="skeleton-bar"
          className={cx('my-2 rounded-[6px]', reduceMotion ? 'bg-surface-2' : SHIMMER, className)}
          style={{ width, height }}
        />
      ))}
    </>
  );
}
