import React from 'react';
import type { DiscoveryCoverage } from '@/types';

interface Props {
  coverage: DiscoveryCoverage;
  height?: number;
}

const COLORS: Record<string, string> = {
  implemented: '#10b981',
  planned: '#60a5fa',
  discovered: '#6b6b84',
  dropped: '#f87171',
};

export function DiscoveryCoverageBar({ coverage, height = 24 }: Props) {
  const { total } = coverage;
  if (total === 0) return null;
  const segments = (['implemented', 'planned', 'discovered', 'dropped'] as const)
    .filter((s) => coverage[s] > 0)
    .map((s) => ({ status: s, count: coverage[s], pct: Math.round((coverage[s] / total) * 100) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', borderRadius: height / 2, overflow: 'hidden', height, background: 'var(--surface-2)' }}>
        {segments.map((seg) => (
          <div
            key={seg.status}
            title={`${seg.status}: ${seg.count} (${seg.pct}%)`}
            style={{ width: `${seg.pct}%`, background: COLORS[seg.status], minWidth: seg.pct > 0 ? 4 : 0, transition: 'width 0.3s ease' }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)' }}>
        {segments.map((seg) => (
          <span key={seg.status} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[seg.status], display: 'inline-block' }} />
            {seg.status} {seg.count} ({seg.pct}%)
          </span>
        ))}
      </div>
    </div>
  );
}
