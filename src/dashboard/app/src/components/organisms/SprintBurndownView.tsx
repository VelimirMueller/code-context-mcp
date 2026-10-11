'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { get } from '@/lib/api';
import { useSprintStore } from '@/stores/sprintStore';
import { mapLegacyPhase } from '@/lib/phases';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import type { BurndownData, Sprint } from '@/types';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface BurndownPoint {
  label: string;
  remaining: number;
  completed: number;
  ideal: number;
}

interface SprintBurndownEntry {
  sprint: Sprint;
  data: BurndownData | null;
}

/* ─── Main Component ──────────────────────────────────────────────────────── */

export function SprintBurndownView() {
  const sprints = useSprintStore((s) => s.sprints);
  const [selectedSprintIds, setSelectedSprintIds] = useState<number[]>([]);
  const [burndownData, setBurndownData] = useState<Map<number, BurndownData>>(new Map());
  const [loading, setLoading] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [viewMode, setViewMode] = useState<'chart' | 'metrics' | 'comparison'>('chart');

  // Filter to implementation / done sprints
  const eligibleSprints = useMemo(
    () => sprints.filter(s => {
      const phase = mapLegacyPhase(s.status);
      return phase === 'implementation' || phase === 'done';
    }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    [sprints]
  );

  // Auto-select first sprint
  useEffect(() => {
    if (eligibleSprints.length > 0 && selectedSprintIds.length === 0) {
      setSelectedSprintIds([eligibleSprints[0].id]);
    }
  }, [eligibleSprints]);

  // Fetch burndown data for selected sprints
  useEffect(() => {
    const fetchBurndowns = async () => {
      setLoading(true);
      const newData = new Map(burndownData);
      for (const id of selectedSprintIds) {
        if (!newData.has(id)) {
          try {
            const data = await get<BurndownData>(`/api/sprint/${id}/burndown`);
            if (data) newData.set(id, data);
          } catch { /* ignore */ }
        }
      }
      setBurndownData(newData);
      setLoading(false);
    };
    if (selectedSprintIds.length > 0) fetchBurndowns();
  }, [selectedSprintIds]);

  const toggleSprintSelection = (id: number) => {
    setSelectedSprintIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 4) return prev; // max 4 for comparison
      return [...prev, id];
    });
  };

  const primaryData = selectedSprintIds.length > 0 ? burndownData.get(selectedSprintIds[0]) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            Sprint Burndown
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Track velocity, predict completion, compare sprints
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['chart', 'metrics', 'comparison'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid var(--border)',
                background: viewMode === mode ? 'var(--accent)' : 'var(--surface)',
                color: viewMode === mode ? '#000' : 'var(--text3)',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                textTransform: 'capitalize',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Sprint selector */}
      <div style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        padding: '12px 16px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', alignSelf: 'center', marginRight: 4 }}>
          Select sprints (max 4):
        </span>
        {eligibleSprints.slice(0, 10).map(sprint => {
          const isSelected = selectedSprintIds.includes(sprint.id);
          const hasData = burndownData.has(sprint.id);
          return (
            <button
              key={sprint.id}
              onClick={() => toggleSprintSelection(sprint.id)}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                background: isSelected ? 'var(--accent)' : 'transparent',
                color: isSelected ? '#000' : 'var(--text3)',
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {sprint.name.slice(0, 20)}
              {hasData && (
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: isSelected ? '#000' : 'var(--accent)' }} />
              )}
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {viewMode === 'chart' && (
          <motion.div key="chart" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            {primaryData ? (
              <LargeBurndownChart data={primaryData} />
            ) : (
              <div style={{
                padding: 60,
                textAlign: 'center',
                color: 'var(--text3)',
                fontSize: 13,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
              }}>
                Select a sprint to view its burndown chart
              </div>
            )}
          </motion.div>
        )}

        {viewMode === 'metrics' && (
          <motion.div key="metrics" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            {selectedSprintIds.map(id => {
              const data = burndownData.get(id);
              const sprint = eligibleSprints.find(s => s.id === id);
              if (!data) return null;
              return <BurndownMetricsCard key={id} data={data} sprintName={sprint?.name || ''} />;
            })}
          </motion.div>
        )}

        {viewMode === 'comparison' && (
          <motion.div key="comparison" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <MultiSprintComparison
              entries={selectedSprintIds.map(id => ({
                sprint: eligibleSprints.find(s => s.id === id)!,
                data: burndownData.get(id) || null,
              })).filter(e => e.sprint)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Large Burndown Chart ─────────────────────────────────────────────────── */

function LargeBurndownChart({ data }: { data: BurndownData }) {
  const { committed, current, metrics } = data;
  const total = committed || current.total;
  if (total === 0) return null;

  const points = useMemo(() => {
    const pts: BurndownPoint[] = [];
    const totalDays = metrics.length > 1 ? metrics.length - 1 : 1;
    metrics.forEach((m, i) => {
      pts.push({
        label: m.date.slice(5),
        remaining: m.remaining_points,
        completed: m.completed_points,
        ideal: total - (total / totalDays) * i,
      });
    });
    const today = new Date().toISOString().slice(5, 10);
    const lastLabel = pts.length > 0 ? pts[pts.length - 1].label : null;
    if (lastLabel !== today) {
      pts.push({
        label: today,
        remaining: current.remaining,
        completed: current.completed,
        ideal: 0,
      });
    }
    if (pts.length === 1) {
      pts.unshift({ label: 'Start', remaining: total, completed: 0, ideal: total });
    }
    return pts;
  }, [data]);

  // Chart dimensions
  const W = 800;
  const H = 260;
  const pad = { top: 24, right: 24, bottom: 36, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxY = total;

  const xScale = (i: number) => pad.left + (i / (points.length - 1)) * plotW;
  const yScale = (v: number) => pad.top + plotH - (v / maxY) * plotH;

  const idealPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(Math.max(0, p.ideal)).toFixed(1)}`).join(' ');
  const actualPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.remaining).toFixed(1)}`).join(' ');
  const completedPath = points.map((p, i) => `L${xScale(i).toFixed(1)},${yScale(p.completed).toFixed(1)}`).join(' ');
  const completedArea = `M${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} ${completedPath} L${xScale(points.length - 1).toFixed(1)},${yScale(0).toFixed(1)} Z`;

  // Prediction
  const lastPoint = points[points.length - 1];
  const prevPoint = points.length > 1 ? points[points.length - 2] : lastPoint;
  const velocity = prevPoint.remaining - lastPoint.remaining;
  const daysToFinish = velocity > 0 ? Math.ceil(lastPoint.remaining / velocity) : null;
  const predictedEnd = daysToFinish !== null ? `~${daysToFinish}d left` : 'N/A';

  const yTicks = [0, Math.round(maxY * 0.25), Math.round(maxY * 0.5), Math.round(maxY * 0.75), maxY];

  // Completion percentage
  const completionPct = total > 0 ? Math.round((current.completed / total) * 100) : 0;
  const isOnTrack = lastPoint.remaining <= lastPoint.ideal || lastPoint.ideal === 0;

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
    }}>
      {/* Chart header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
            {data.sprint_name}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 12, fontFamily: 'var(--mono)' }}>
            {current.completed}/{total} pts ({completionPct}%)
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{
            padding: '4px 12px',
            borderRadius: 12,
            background: isOnTrack ? 'var(--green)15' : 'var(--red)15',
            border: `1px solid ${isOnTrack ? 'var(--green)40' : 'var(--red)40'}`,
            fontSize: 11,
            fontWeight: 600,
            color: isOnTrack ? 'var(--green)' : 'var(--red)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: isOnTrack ? 'var(--green)' : 'var(--red)' }} />
            {isOnTrack ? 'On Track' : 'Behind'}
          </div>
          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            ETA: {predictedEnd}
          </span>
        </div>
      </div>

      {/* SVG Chart */}
      <div style={{ padding: '8px 20px 16px' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
          <defs>
            <linearGradient id="completedGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.05" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={pad.left} y1={yScale(v)} x2={pad.left + plotW} y2={yScale(v)} stroke="var(--border)" strokeWidth={0.5} />
              <text x={pad.left - 8} y={yScale(v) + 3} textAnchor="end" fontSize={9} fill="var(--text3)" fontFamily="var(--mono)">{v}</text>
            </g>
          ))}

          {/* Completed area */}
          <path d={completedArea} fill="url(#completedGradient)" />

          {/* Ideal burndown line */}
          <path d={idealPath} fill="none" stroke="var(--text3)" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.4} />

          {/* Actual remaining line */}
          <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />

          {/* Data points */}
          {points.map((p, i) => (
            <g key={i}>
              <circle cx={xScale(i)} cy={yScale(p.remaining)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
              {i === points.length - 1 && (
                <circle cx={xScale(i)} cy={yScale(p.remaining)} r={8} fill="var(--accent)" opacity={0.15} />
              )}
              <text x={xScale(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="var(--text3)" fontFamily="var(--mono)">{p.label}</text>
            </g>
          ))}

          {/* Prediction extrapolation line */}
          {daysToFinish !== null && daysToFinish > 0 && points.length >= 2 && (
            <line
              x1={xScale(points.length - 1)}
              y1={yScale(lastPoint.remaining)}
              x2={xScale(points.length - 1 + Math.min(daysToFinish, points.length))}
              y2={yScale(0)}
              stroke="var(--accent)"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.4}
            />
          )}

          {/* Axes */}
          <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke="var(--border)" strokeWidth={1} />
          <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke="var(--border)" strokeWidth={1} />
        </svg>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 20, padding: '8px 20px 16px', borderTop: '1px solid var(--border)' }}>
        <LegendItem color="var(--accent)" line label="Remaining" />
        <LegendItem color="var(--text3)" dashed label="Ideal" />
        <LegendItem color="var(--green)" area label={`Completed (${current.completed} pts)`} />
        <LegendItem color="var(--accent)" dashed label="Prediction" opacity={0.4} />
      </div>
    </div>
  );
}

/* ─── Burndown Metrics Card ───────────────────────────────────────────────── */

function BurndownMetricsCard({ data, sprintName }: { data: BurndownData; sprintName: string }) {
  const { committed, current, metrics, start_date, end_date } = data;
  const total = committed || current.total;

  const analysis = useMemo(() => {
    if (metrics.length === 0) return null;
    const completedPerDay: number[] = [];
    for (let i = 1; i < metrics.length; i++) {
      completedPerDay.push(metrics[i].completed_points - metrics[i - 1].completed_points);
    }
    const avgVelocity = completedPerDay.length > 0
      ? completedPerDay.reduce((a, b) => a + b, 0) / completedPerDay.length
      : 0;

    const totalDays = start_date && end_date
      ? Math.max(1, Math.round((new Date(end_date).getTime() - new Date(start_date).getTime()) / 86400000))
      : 1;
    const idealVelocity = total / totalDays;

    const daysLeft = avgVelocity > 0 ? Math.ceil(current.remaining / avgVelocity) : null;
    const onTrack = avgVelocity >= idealVelocity * 0.8;
    const risk: 'low' | 'medium' | 'high' = avgVelocity >= idealVelocity ? 'low' : avgVelocity >= idealVelocity * 0.6 ? 'medium' : 'high';

    const scopeAdded = metrics.reduce((s, m) => s + m.added_points, 0);
    const scopeRemoved = metrics.reduce((s, m) => s + m.removed_points, 0);

    return { avgVelocity, idealVelocity, daysLeft, onTrack, risk, scopeAdded, scopeRemoved, scopeNet: scopeAdded - scopeRemoved };
  }, [data]);

  const riskConfig = {
    low: { bg: 'var(--accent)15', border: 'var(--accent)40', text: 'var(--accent)', label: 'Low Risk' },
    medium: { bg: '#fbbf2415', border: '#fbbf2440', text: '#fbbf24', label: 'Medium Risk' },
    high: { bg: '#f8717115', border: '#f8717140', text: '#f87171', label: 'High Risk' },
  };

  const r = analysis ? riskConfig[analysis.risk] : riskConfig.low;

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{sprintName}</span>
        <div style={{
          padding: '4px 12px',
          borderRadius: 12,
          background: r.bg,
          border: `1px solid ${r.border}`,
          fontSize: 11,
          fontWeight: 600,
          color: r.text,
        }}>
          {r.label}
        </div>
      </div>

      {/* Metric cards */}
      {analysis && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, borderBottom: '1px solid var(--border)' }}>
          <MetricCell
            label="Velocity"
            value={`${analysis.avgVelocity.toFixed(1)} pts/d`}
            sub={`Ideal: ${analysis.idealVelocity.toFixed(1)}`}
            color={analysis.onTrack ? 'var(--green)' : 'var(--orange)'}
          />
          <MetricCell
            label="Remaining"
            value={`${current.remaining} pts`}
            sub={analysis.daysLeft ? `~${analysis.daysLeft}d left` : 'N/A'}
            color="var(--blue)"
          />
          <MetricCell
            label="Completion"
            value={`${total > 0 ? Math.round((current.completed / total) * 100) : 0}%`}
            sub={`${current.completed}/${total} pts`}
            color="var(--accent)"
          />
          <MetricCell
            label="Scope Change"
            value={`${analysis.scopeNet > 0 ? '+' : ''}${analysis.scopeNet} pts`}
            sub={`${analysis.scopeAdded} added, ${analysis.scopeRemoved} removed`}
            color={analysis.scopeNet > 0 ? '#fbbf24' : analysis.scopeNet < 0 ? 'var(--green)' : 'var(--text3)'}
          />
        </div>
      )}

      {/* Daily activity table */}
      {metrics.length > 0 && (
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginTop: 12, marginBottom: 8 }}>Daily Activity</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  {['Date', 'Remaining', 'Completed', 'Added', 'Removed'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Date' ? 'left' : 'right', padding: '6px 8px', color: 'var(--text3)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.slice().reverse().slice(0, 7).map((m, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px', color: 'var(--text)', fontFamily: 'var(--mono)' }}>{m.date.slice(5)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text)', fontFamily: 'var(--mono)' }}>{m.remaining_points}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--green)', fontFamily: 'var(--mono)' }}>+{m.completed_points}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#fbbf24', fontFamily: 'var(--mono)' }}>+{m.added_points}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--blue)', fontFamily: 'var(--mono)' }}>-{m.removed_points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Multi-Sprint Comparison ──────────────────────────────────────────────── */

function MultiSprintComparison({ entries }: { entries: SprintBurndownEntry[] }) {
  if (entries.length === 0) {
    return (
      <div style={{
        padding: 60,
        textAlign: 'center',
        color: 'var(--text3)',
        fontSize: 13,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}>
        Select sprints above to compare their burndown trends
      </div>
    );
  }

  const colors = ['#60a5fa', '#10b981', '#fbbf24', '#818cf8'];

  // Build a normalized comparison chart (percentage of total completed over time)
  const W = 700;
  const H = 220;
  const pad = { top: 20, right: 20, bottom: 32, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Sprint Comparison</span>
        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 12 }}>Normalized completion velocity</span>
      </div>

      {/* Comparison chart */}
      <div style={{ padding: '12px 20px 16px' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
          {/* Grid */}
          {[0, 25, 50, 75, 100].map(v => {
            const y = pad.top + plotH - (v / 100) * plotH;
            return (
              <g key={v}>
                <line x1={pad.left} y1={y} x2={pad.left + plotW} y2={y} stroke="var(--border)" strokeWidth={0.5} />
                <text x={pad.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--text3)" fontFamily="var(--mono)">{v}%</text>
              </g>
            );
          })}

          {/* Lines for each sprint */}
          {entries.map((entry, ei) => {
            if (!entry.data) return null;
            const { metrics, committed, current } = entry.data;
            const total = committed || current.total;
            if (total === 0) return null;
            const maxPts = metrics.length || 1;
            const color = colors[ei % colors.length];

            const pathParts = metrics.map((m, i) => {
              const x = pad.left + (i / (maxPts - 1 || 1)) * plotW;
              const pct = Math.min(100, (m.completed_points / total) * 100);
              const y = pad.top + plotH - (pct / 100) * plotH;
              return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(' ');

            return (
              <g key={entry.sprint.id}>
                <path d={pathParts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {metrics.map((m, i) => {
                  const x = pad.left + (i / (maxPts - 1 || 1)) * plotW;
                  const pct = Math.min(100, (m.completed_points / total) * 100);
                  const y = pad.top + plotH - (pct / 100) * plotH;
                  return <circle key={i} cx={x} cy={y} r={3} fill={color} />;
                }).filter((_, i) => i === 0 || i === metrics.length - 1)}
              </g>
            );
          })}

          {/* Axes */}
          <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke="var(--border)" strokeWidth={1} />
          <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke="var(--border)" strokeWidth={1} />
        </svg>
      </div>

      {/* Comparison table */}
      <div style={{ padding: '0 20px 16px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '8px', color: 'var(--text3)', fontWeight: 600 }}>Sprint</th>
              <th style={{ textAlign: 'right', padding: '8px', color: 'var(--text3)', fontWeight: 600 }}>Committed</th>
              <th style={{ textAlign: 'right', padding: '8px', color: 'var(--text3)', fontWeight: 600 }}>Completed</th>
              <th style={{ textAlign: 'right', padding: '8px', color: 'var(--text3)', fontWeight: 600 }}>%</th>
              <th style={{ textAlign: 'right', padding: '8px', color: 'var(--text3)', fontWeight: 600 }}>Scope</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => {
              if (!entry.data) return null;
              const { committed, current, metrics: m } = entry.data;
              const total = committed || current.total;
              const pct = total > 0 ? Math.round((current.completed / total) * 100) : 0;
              const scopeNet = m.reduce((s, x) => s + x.added_points - x.removed_points, 0);
              const color = colors[i % colors.length];
              return (
                <tr key={entry.sprint.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px', color: 'var(--text)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                      {entry.sprint.name}
                    </div>
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text)' }}>{total}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--green)' }}>{current.completed}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)', color: pct >= 80 ? 'var(--green)' : '#fbbf24' }}>{pct}%</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)', color: scopeNet > 0 ? '#fbbf24' : scopeNet < 0 ? 'var(--green)' : 'var(--text3)' }}>
                    {scopeNet > 0 ? '+' : ''}{scopeNet}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Helper Components ────────────────────────────────────────────────────── */

function MetricCell({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div style={{ padding: '14px 20px', borderRight: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function LegendItem({ color, label, line, dashed, area, opacity }: { color: string; label: string; line?: boolean; dashed?: boolean; area?: boolean; opacity?: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text3)' }}>
      {line && <span style={{ width: 16, height: 2, background: color, borderRadius: 1, opacity: opacity ?? 1 }} />}
      {dashed && <span style={{ width: 16, height: 0, borderTop: `2px dashed ${color}`, opacity: opacity ?? 0.5 }} />}
      {area && <span style={{ width: 12, height: 12, borderRadius: 2, background: color, opacity: 0.15 }} />}
      {label}
    </span>
  );
}
