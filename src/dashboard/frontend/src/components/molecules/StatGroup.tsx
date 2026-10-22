import React from 'react';
import { Stat } from '@/components/atoms/Stat';
import { fmtSize } from '@/lib/utils';
import type { Stats } from '@/types';

interface StatGroupProps {
  stats: Stats | null;
}

export function StatGroup({ stats }: StatGroupProps) {
  if (!stats) return null;

  return (
    <div
      className="stats"
      style={{ display: 'flex', alignItems: 'center', gap: 24, flexShrink: 0 }}
    >
      <Stat value={stats.files ?? 0} label="files" />
      <Stat value={stats.exports ?? 0} label="exports" />
      <Stat value={stats.deps ?? 0} label="deps" />
      <Stat value={(stats.totalLines ?? 0).toLocaleString()} label="lines" />
      <Stat value={fmtSize(stats.totalSize ?? 0)} label="size" />
    </div>
  );
}
