'use client';

import { useState, useEffect } from 'react';
import { get } from '@/lib/api';
import { Skeleton } from '@/components/atoms/Skeleton';
import { cx } from '@/lib/utils';

interface BurndownMetric {
  date: string;
  remaining_points: number;
  completed_points: number;
  added_points: number;
  removed_points: number;
}

interface BurndownData {
  sprint_name: string;
  committed: number;
  start_date: string | null;
  end_date: string | null;
  current: { remaining: number; completed: number; total: number };
  metrics: BurndownMetric[];
}

interface BurndownChartProps {
  sprintId: number;
}

export function BurndownChart({ sprintId }: BurndownChartProps) {
  const [data, setData] = useState<BurndownData | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    get<BurndownData>(`/api/sprint/${sprintId}/burndown`)
      .then(setData)
      .catch(() => {});
  }, [sprintId]);

  if (!data) {
    return (
      <div className="mb-4 overflow-hidden rounded-card border border-line bg-surface px-[14px] py-[10px]">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton width={14} height={14} />
          <Skeleton width={80} height={14} />
          <Skeleton width={60} height={18} />
        </div>
        <Skeleton width="100%" height={100} />
      </div>
    );
  }

  const { committed, current, metrics } = data;
  const total = committed || current.total;
  if (total === 0) return null;

  // Build data points: metrics + current live state
  const points: { label: string; remaining: number; completed: number }[] = [];

  if (metrics.length > 0) {
    metrics.forEach((m) => {
      points.push({
        label: m.date.slice(5),
        remaining: m.remaining_points,
        completed: m.completed_points,
      });
    });
  }

  // Always add current state as last point
  const today = new Date().toISOString().slice(5, 10);
  const lastLabel = points.length > 0 ? points[points.length - 1].label : null;
  if (lastLabel !== today) {
    points.push({ label: today, remaining: current.remaining, completed: current.completed });
  }

  // If only 1 point, add a start point
  if (points.length === 1) {
    points.unshift({ label: 'Start', remaining: total, completed: 0 });
  }

  // SVG dimensions
  const W = 460;
  const H = 140;
  const pad = { top: 16, right: 12, bottom: 24, left: 36 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxY = total;

  const xScale = (i: number) => pad.left + (i / (points.length - 1)) * plotW;
  const yScale = (v: number) => pad.top + plotH - (v / maxY) * plotH;

  // Ideal burndown line
  const idealStart = { x: pad.left, y: yScale(maxY) };
  const idealEnd = { x: pad.left + plotW, y: yScale(0) };

  // Actual remaining line
  const actualPath = points
    .map(
      (p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.remaining).toFixed(1)}`,
    )
    .join(' ');

  // Completed area (filled from bottom)
  const completedPath = points
    .map((p, i) => `L${xScale(i).toFixed(1)},${yScale(p.completed).toFixed(1)}`)
    .join(' ');
  const completedArea = `M${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} ${completedPath} L${xScale(points.length - 1).toFixed(1)},${yScale(0).toFixed(1)} Z`;

  // Y-axis ticks
  const yTicks = [0, Math.round(maxY / 2), maxY];

  return (
    <div className="mb-4 overflow-hidden rounded-card border border-line bg-surface">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-[14px] py-[10px] font-body [transition:background_.15s] hover:bg-bg"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className={cx(
            'shrink-0 [transition:transform_.2s]',
            expanded && '[transform:rotate(90deg)]',
          )}
        >
          <path
            d="M5 2.5L9.5 7L5 11.5"
            stroke="var(--color-fg-3)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-13 font-semibold text-fg">Burndown</span>
        <span className="rounded-[10px] bg-bg px-2 py-[1px] font-code text-11 text-fg-3">
          {current.completed}/{total}pts
        </span>
        <div className="ml-auto flex gap-[10px] text-10 text-fg-3">
          <span className="flex items-center gap-1">
            <span className="h-[2px] w-2 rounded-[1px] bg-fg-3 opacity-50" />
            Ideal
          </span>
          <span className="flex items-center gap-1">
            <span className="h-[2px] w-2 rounded-[1px] bg-accent" />
            Remaining
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-[2px] bg-accent opacity-15" />
            Done
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-[14px] pb-[14px]">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block">
            {/* Grid lines */}
            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={pad.left}
                  y1={yScale(v)}
                  x2={pad.left + plotW}
                  y2={yScale(v)}
                  stroke="var(--color-line)"
                  strokeWidth={0.5}
                />
                <text
                  x={pad.left - 6}
                  y={yScale(v) + 3}
                  textAnchor="end"
                  fontSize={9}
                  fill="var(--color-fg-3)"
                  fontFamily="var(--font-code)"
                >
                  {v}
                </text>
              </g>
            ))}

            {/* Completed area */}
            <path d={completedArea} fill="var(--color-green)" opacity={0.1} />

            {/* Ideal burndown line */}
            <line
              x1={idealStart.x}
              y1={idealStart.y}
              x2={idealEnd.x}
              y2={idealEnd.y}
              stroke="var(--color-fg-3)"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.4}
            />

            {/* Actual remaining line */}
            <path
              d={actualPath}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Data points */}
            {points.map((p, i) => (
              <g key={i}>
                <circle cx={xScale(i)} cy={yScale(p.remaining)} r={3} fill="var(--color-accent)" />
                {/* X-axis labels */}
                <text
                  x={xScale(i)}
                  y={H - 4}
                  textAnchor="middle"
                  fontSize={8}
                  fill="var(--color-fg-3)"
                  fontFamily="var(--font-code)"
                >
                  {p.label}
                </text>
              </g>
            ))}

            {/* Axes */}
            <line
              x1={pad.left}
              y1={pad.top}
              x2={pad.left}
              y2={pad.top + plotH}
              stroke="var(--color-line)"
              strokeWidth={0.5}
            />
            <line
              x1={pad.left}
              y1={pad.top + plotH}
              x2={pad.left + plotW}
              y2={pad.top + plotH}
              stroke="var(--color-line)"
              strokeWidth={0.5}
            />
          </svg>
        </div>
      )}
    </div>
  );
}
