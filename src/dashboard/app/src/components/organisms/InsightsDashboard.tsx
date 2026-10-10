'use client';

import React, { useEffect, useMemo } from 'react';
import { useSprintStore } from '@/stores/sprintStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import type { Sprint, RetroFinding } from '@/types';

// ─── Color palette ──────────────────────────────────────────────────────────

const COLORS = {
  accent: 'var(--accent)',
  blue: '#60a5fa',
  green: '#10b981',
  red: '#f87171',
  orange: '#fbbf24',
  purple: '#818cf8',
  cyan: '#06b6d4',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
  surface: 'var(--surface)',
  surface3: 'var(--surface3)',
  border: 'var(--border)',
  bg: 'var(--bg)',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

// ─── SVG Chart: Velocity Trend ───────────────────────────────────────────────

function VelocityChart({ sprints }: { sprints: Sprint[] }) {
  if (sprints.length === 0) {
    return <Empty message="No closed sprints yet" />;
  }

  const W = 520;
  const H = 180;
  const pad = { top: 16, right: 16, bottom: 28, left: 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxVal = Math.max(
    1,
    ...sprints.map((s) => Math.max(s.velocity_committed, s.velocity_completed))
  );

  const xScale = (i: number) => pad.left + (i / Math.max(1, sprints.length - 1)) * plotW;
  const yScale = (v: number) => pad.top + plotH - (v / maxVal) * plotH;

  // Committed line
  const committedPath = sprints
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(s.velocity_committed).toFixed(1)}`)
    .join(' ');

  // Completed area fill
  const completedPath = sprints
    .map((s, i) => `L${xScale(i).toFixed(1)},${yScale(s.velocity_completed).toFixed(1)}`)
    .join(' ');
  const completedArea = `M${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} ${completedPath} L${xScale(sprints.length - 1).toFixed(1)},${yScale(0).toFixed(1)} Z`;

  // Completed line
  const completedLine = sprints
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(s.velocity_completed).toFixed(1)}`)
    .join(' ');

  const yTicks = [0, Math.round(maxVal / 2), maxVal];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      {/* Grid */}
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={pad.left} y1={yScale(v)} x2={pad.left + plotW} y2={yScale(v)} stroke={COLORS.border} strokeWidth={0.5} />
          <text x={pad.left - 6} y={yScale(v) + 3} textAnchor="end" fontSize={9} fill={COLORS.text3} fontFamily="var(--mono)">
            {v}
          </text>
        </g>
      ))}

      {/* Completed area */}
      <path d={completedArea} fill={COLORS.green} opacity={0.1} />

      {/* Committed line (dashed) */}
      <path d={committedPath} fill="none" stroke={COLORS.blue} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />

      {/* Completed line */}
      <path d={completedLine} fill="none" stroke={COLORS.green} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* Data points */}
      {sprints.map((s, i) => (
        <g key={s.id}>
          <circle cx={xScale(i)} cy={yScale(s.velocity_committed)} r={2.5} fill={COLORS.blue} opacity={0.6} />
          <circle cx={xScale(i)} cy={yScale(s.velocity_completed)} r={3.5} fill={COLORS.green} />
          {/* Sprint label */}
          <text
            x={xScale(i)}
            y={H - 4}
            textAnchor="middle"
            fontSize={7}
            fill={COLORS.text3}
            fontFamily="var(--mono)"
          >
            {s.name.length > 10 ? s.name.slice(0, 10) : s.name}
          </text>
        </g>
      ))}

      {/* Axes */}
      <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke={COLORS.border} strokeWidth={0.5} />
      <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke={COLORS.border} strokeWidth={0.5} />
    </svg>
  );
}

// ─── SVG Chart: Completion Rate Bars ─────────────────────────────────────────

function CompletionBars({ sprints }: { sprints: Sprint[] }) {
  if (sprints.length === 0) {
    return <Empty message="No closed sprints yet" />;
  }

  const W = 520;
  const H = 160;
  const pad = { top: 12, right: 12, bottom: 28, left: 12 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const barGap = 6;
  const barW = Math.min(36, Math.max(12, (plotW - barGap * (sprints.length - 1)) / sprints.length));
  const totalBarsW = sprints.length * barW + (sprints.length - 1) * barGap;
  const offsetX = pad.left + (plotW - totalBarsW) / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      {/* 100% reference line */}
      <line x1={pad.left} y1={pad.top} x2={pad.left + plotW} y2={pad.top} stroke={COLORS.border} strokeWidth={0.5} strokeDasharray="3 3" />
      <text x={pad.left + plotW + 2} y={pad.top + 3} fontSize={8} fill={COLORS.text3} fontFamily="var(--mono)">100%</text>

      {/* 50% reference line */}
      <line x1={pad.left} y1={pad.top + plotH / 2} x2={pad.left + plotW} y2={pad.top + plotH / 2} stroke={COLORS.border} strokeWidth={0.5} strokeDasharray="3 3" />

      {sprints.map((s, i) => {
        const completion = pct(s.done_count, s.ticket_count);
        const barH = (completion / 100) * plotH;
        const x = offsetX + i * (barW + barGap);
        const y = pad.top + plotH - barH;
        const color =
          completion >= 80 ? COLORS.green : completion >= 60 ? COLORS.orange : COLORS.red;

        return (
          <g key={s.id}>
            {/* Background track */}
            <rect
              x={x}
              y={pad.top}
              width={barW}
              height={plotH}
              fill={COLORS.surface3}
              rx={3}
            />
            {/* Bar fill */}
            <rect x={x} y={y} width={barW} height={barH} fill={color} rx={3} opacity={0.85} />
            {/* Percentage label */}
            <text
              x={x + barW / 2}
              y={y - 3}
              textAnchor="middle"
              fontSize={9}
              fill={color}
              fontFamily="var(--mono)"
              fontWeight={600}
            >
              {completion}%
            </text>
            {/* Sprint name */}
            <text
              x={x + barW / 2}
              y={H - 4}
              textAnchor="middle"
              fontSize={7}
              fill={COLORS.text3}
              fontFamily="var(--mono)"
            >
              {s.name.length > 8 ? s.name.slice(0, 8) : s.name}
            </text>
          </g>
        );
      })}

      {/* Bottom axis */}
      <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke={COLORS.border} strokeWidth={0.5} />
    </svg>
  );
}

// ─── Sprint Health Indicator ─────────────────────────────────────────────────

function SprintHealthCard({ sprints }: { sprints: Sprint[] }) {
  const latest = sprints.length > 0 ? sprints[sprints.length - 1] : null;
  if (!latest) {
    return <Empty message="No closed sprints" />;
  }

  const completion = pct(latest.done_count, latest.ticket_count);
  const velocityRatio = latest.velocity_committed > 0
    ? latest.velocity_completed / latest.velocity_committed
    : 0;

  let health: 'on track' | 'at risk' | 'off track' = 'on track';
  let healthColor = COLORS.green;
  if (completion < 50 || velocityRatio < 0.5) {
    health = 'off track';
    healthColor = COLORS.red;
  } else if (completion < 80 || velocityRatio < 0.8) {
    health = 'at risk';
    healthColor = COLORS.orange;
  }

  // Show last 5 sprints health
  const recentSprints = sprints.slice(-5);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Current health */}
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: `${healthColor}18`,
            border: `2px solid ${healthColor}`,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            {health === 'on track' && (
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke={healthColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            )}
            {health === 'at risk' && (
              <path d="M12 9v2m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" stroke={healthColor} strokeWidth="2" strokeLinecap="round" />
            )}
            {health === 'off track' && (
              <path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" stroke={healthColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </div>
        <div style={{ marginTop: 6, fontWeight: 700, color: healthColor, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 12 }}>
          {health}
        </div>
      </div>

      {/* Recent sprints mini health bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {recentSprints.map((s) => {
          const cp = pct(s.done_count, s.ticket_count);
          const c = cp >= 80 ? COLORS.green : cp >= 60 ? COLORS.orange : COLORS.red;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 10,
                  color: COLORS.text3,
                  fontFamily: 'var(--mono)',
                  width: 64,
                  flexShrink: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.name}
              </span>
              <div style={{ flex: 1, background: COLORS.surface3, borderRadius: 3, height: 6, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${cp}%`,
                    background: c,
                    height: '100%',
                    borderRadius: 3,
                    transition: 'width .4s ease',
                  }}
                />
              </div>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: c, width: 30, textAlign: 'right', flexShrink: 0 }}>
                {cp}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Retrospective Pattern Cloud ─────────────────────────────────────────────

function RetroPatterns({ findings }: { findings: RetroFinding[] }) {
  const grouped = useMemo(() => {
    const categories: Record<string, { color: string; label: string }> = {
      went_well: { color: COLORS.green, label: 'Went Well' },
      went_wrong: { color: COLORS.red, label: 'Went Wrong' },
      try_next: { color: COLORS.purple, label: 'Try Next' },
    };

    const result: Record<string, { label: string; color: string; items: { text: string; count: number }[] }> = {};

    for (const [cat, meta] of Object.entries(categories)) {
      const catFindings = findings.filter((f) => f.category === cat);
      // Group similar findings by normalized text
      const freq: Record<string, number> = {};
      for (const f of catFindings) {
        const key = f.finding.trim().toLowerCase().slice(0, 60);
        freq[key] = (freq[key] || 0) + 1;
      }
      const sorted = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([text, count]) => ({ text, count }));
      result[cat] = { label: meta.label, color: meta.color, items: sorted };
    }

    return result;
  }, [findings]);

  if (findings.length === 0) {
    return <Empty message="No retro findings yet" />;
  }

  const maxCount = Math.max(1, ...Object.values(grouped).flatMap((g) => g.items.map((i) => i.count)));

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      {Object.entries(grouped).map(([cat, group]) => (
        <div key={cat} style={{ flex: '1 1 200px', minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.color }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: group.color }}>{group.label}</span>
            <span style={{ fontSize: 10, color: COLORS.text3, fontFamily: 'var(--mono)' }}>
              ({findings.filter((f) => f.category === cat).length})
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {group.items.length === 0 ? (
              <span style={{ fontSize: 11, color: COLORS.text3, fontStyle: 'italic' }}>No findings</span>
            ) : (
              group.items.map((item, i) => {
                const size = 10 + Math.round((item.count / maxCount) * 4);
                const opacity = 0.4 + (item.count / maxCount) * 0.6;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 8px',
                      borderRadius: 4,
                      background: `${group.color}10`,
                      borderLeft: `2px solid ${group.color}`,
                    }}
                  >
                    <span style={{ fontSize: size, color: group.color, opacity, lineHeight: 1.3, flex: 1 }}>
                      {item.text.length > 55 ? item.text.slice(0, 55) + '...' : item.text}
                    </span>
                    {item.count > 1 && (
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'var(--mono)',
                          color: group.color,
                          fontWeight: 700,
                          background: `${group.color}20`,
                          padding: '1px 5px',
                          borderRadius: 8,
                          flexShrink: 0,
                        }}
                      >
                        x{item.count}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function Empty({ message }: { message: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: COLORS.text3, fontSize: 12 }}>
      {message}
    </div>
  );
}

// ─── Card wrapper ────────────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  borderColor,
  children,
  wide = false,
}: {
  title: string;
  subtitle: string;
  borderColor: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 'var(--radius)',
        borderTop: `3px solid ${borderColor}`,
        padding: 16,
        gridColumn: wide ? 'span 2' : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{title}</div>
        <div style={{ fontSize: 11, color: COLORS.text3, marginTop: 2 }}>{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

// ─── Metric card ─────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  suffix,
  color,
}: {
  label: string;
  value: number;
  suffix?: string;
  color: string;
}) {
  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderTop: `3px solid ${color}`,
      }}
    >
      <div style={{ fontSize: 10, color: COLORS.text3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 28, fontWeight: 700, color, lineHeight: 1 }}>
          <AnimatedNumber value={value} />
        </span>
        {suffix && <span style={{ fontSize: 14, color: COLORS.text3 }}>{suffix}</span>}
      </div>
    </div>
  );
}

// ─── Main InsightsDashboard ──────────────────────────────────────────────────

export function InsightsDashboard() {
  const allSprints = useSprintStore((s) => s.sprints);
  const fetchSprints = useSprintStore((s) => s.fetchSprints);
  const fetchAllRetro = useSprintStore((s) => s.fetchAllRetro);
  const allRetroFindings = useSprintStore((s) => s.allRetroFindings);

  useEffect(() => {
    fetchSprints();
    fetchAllRetro();
  }, [fetchSprints, fetchAllRetro]);

  // Only use closed sprints for historical analysis
  const closedSprints = useMemo(
    () => allSprints.filter((s) => s.status === 'closed' || s.status === 'rest').reverse(),
    [allSprints]
  );

  const last10Closed = useMemo(() => closedSprints.slice(-10), [closedSprints]);

  // ── Key Metrics ──────────────────────────────────────────────────────────────
  const totalTicketsDone = useMemo(
    () => closedSprints.reduce((sum, s) => sum + s.done_count, 0),
    [closedSprints]
  );

  const avgVelocity = useMemo(() => {
    const vels = closedSprints.map((s) => s.velocity_completed).filter((v) => v > 0);
    return vels.length > 0 ? Math.round(vels.reduce((a, b) => a + b, 0) / vels.length) : 0;
  }, [closedSprints]);

  const avgCompletion = useMemo(() => {
    const rates = closedSprints.filter((s) => s.ticket_count > 0).map((s) => pct(s.done_count, s.ticket_count));
    return rates.length > 0 ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 0;
  }, [closedSprints]);

  const totalRetroFindings = allRetroFindings.length;

  // ── Velocity trend ───────────────────────────────────────────────────────────
  const velocityTrend = useMemo(() => {
    const vels = closedSprints.map((s) => s.velocity_completed);
    if (vels.length < 3) return 'stable' as const;
    const last3 = vels.slice(-3);
    if (last3[2] > last3[0] * 1.1) return 'improving' as const;
    if (last3[2] < last3[0] * 0.9) return 'declining' as const;
    return 'stable' as const;
  }, [closedSprints]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.text }}>Insights Dashboard</span>
        <span style={{ fontSize: 12, color: COLORS.text3 }}>
          {closedSprints.length} closed sprints analyzed
        </span>
      </div>

      {/* Key metric cards row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <MetricCard label="Avg Velocity" value={avgVelocity} suffix="pts/sprint" color={COLORS.blue} />
        <MetricCard label="Total Tickets Done" value={totalTicketsDone} color={COLORS.green} />
        <MetricCard label="Avg Completion" value={avgCompletion} suffix="%" color={COLORS.orange} />
        <MetricCard label="Retro Findings" value={totalRetroFindings} color={COLORS.purple} />
      </div>

      {/* Charts row: velocity + completion */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Card
          title="Velocity Trend"
          subtitle={`Committed (dashed) vs Completed — last ${last10Closed.length} sprints`}
          borderColor={COLORS.blue}
        >
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 4, fontSize: 10, color: COLORS.text3 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 2, background: COLORS.blue, borderRadius: 1, borderStyle: 'dashed' }} />
              Committed
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 2, background: COLORS.green, borderRadius: 1 }} />
              Completed
            </span>
          </div>
          <VelocityChart sprints={last10Closed} />
        </Card>

        <Card
          title="Completion Rate"
          subtitle="Ticket completion percentage per sprint"
          borderColor={COLORS.green}
        >
          <CompletionBars sprints={last10Closed} />
        </Card>
      </div>

      {/* Health + Retro patterns row */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
        <Card
          title="Sprint Health"
          subtitle={`Trend: ${velocityTrend} · last sprint basis`}
          borderColor={velocityTrend === 'improving' ? COLORS.green : velocityTrend === 'declining' ? COLORS.red : COLORS.orange}
        >
          <SprintHealthCard sprints={closedSprints} />
        </Card>

        <Card
          title="Retrospective Patterns"
          subtitle="Most common themes across all sprints"
          borderColor={COLORS.purple}
          wide
        >
          <RetroPatterns findings={allRetroFindings} />
        </Card>
      </div>
    </div>
  );
}
