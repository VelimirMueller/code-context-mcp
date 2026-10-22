import React from 'react';
import { useReducedMotion } from 'framer-motion';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  count?: number;
}

export function Skeleton({ width = '100%', height = 14, className = '', count = 1 }: SkeletonProps) {
  const reduceMotion = useReducedMotion();
  const bars = Array.from({ length: count });

  const shimmerStyle: React.CSSProperties = reduceMotion
    ? {
        background: 'var(--surface2)',
      }
    : {
        background: 'linear-gradient(90deg, var(--surface2) 25%, var(--surface3) 50%, var(--surface2) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
      };

  return (
    <>
      {bars.map((_, i) => (
        <div
          key={i}
          className={`skeleton skeleton-bar ${className}`}
          style={{
            width,
            height,
            margin: '8px 0',
            borderRadius: 6,
            ...shimmerStyle,
          }}
        />
      ))}
    </>
  );
}
