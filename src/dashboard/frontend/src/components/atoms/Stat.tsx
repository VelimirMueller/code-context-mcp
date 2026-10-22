import React from 'react';

interface StatProps {
  value: string | number;
  label: string;
  mono?: boolean;
}

export function Stat({ value, label, mono = true }: StatProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <span
        style={{
          fontFamily: mono ? 'var(--mono)' : 'var(--font)',
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--text)',
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
    </div>
  );
}
