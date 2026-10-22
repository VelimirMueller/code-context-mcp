import React from 'react';

interface DotProps {
  color: string;
  size?: number;
  className?: string;
}

export function Dot({ color, size = 8, className = '' }: DotProps) {
  return (
    <span
      className={`file-lang-dot ${className}`}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: color,
      }}
    />
  );
}
