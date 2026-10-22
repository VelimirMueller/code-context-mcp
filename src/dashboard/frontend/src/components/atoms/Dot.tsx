import type { CSSProperties } from 'react';
import { cx } from '@/lib/utils';

interface DotProps {
  color: string;
  size?: number;
  className?: string;
}

export function Dot({ color, size = 8, className }: DotProps) {
  return (
    <span
      className={cx('inline-block shrink-0 rounded-[50%] bg-(--c)', className)}
      style={{ width: size, height: size, '--c': color } as CSSProperties}
    />
  );
}
