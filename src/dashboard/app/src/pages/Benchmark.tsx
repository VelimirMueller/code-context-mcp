'use client';

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useBenchmarkStore,
  latestPerKind,
  type BenchmarkTask,
  type StochasticReport,
  type BenchIndexEntry,
  type BenchRun,
  type BenchArmStats,
  type AgentHeadline,
  type SimulatedHeadline,
  type LegacyHeadline,
} from '@/stores/benchmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { HeroText } from '@/components/molecules/HeroText';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { tabVariants, tabTransition } from '@/lib/motion';

const MCP_COLOR = '#10b981';
const VANILLA_COLOR = '#fbbf24';
const STAT_COLOR = '#818cf8';

const CATEGORY_ICONS: Record<string, string> = {
  retrieval: 'search', analysis: 'diagram', exploration: 'compass',
  implementation: 'code', debugging: 'bug', refactoring: 'refresh',
};

/* ─── Metric Bar ─────────────────────────────────────────────────────────── */

function MetricBar({ label, mcp, vanilla, unit, lowerIsBetter = true }: {
  label: string; mcp: number; vanilla: number; unit?: string; lowerIsBetter?: boolean;
}) {
  const max = Math.max(mcp, vanilla) || 1;
  const mcpPct = (mcp / max) * 100;
  const vanillaPct = (vanilla / max) * 100;
  const mcpWins = lowerIsBetter ? mcp < vanilla : mcp > vanilla;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
        {label}
      </div>
      {[
        { label: 'MCP', pct: mcpPct, val: mcp, color: MCP_COLOR, wins: mcpWins },
        { label: 'VAN', pct: vanillaPct, val: vanilla, color: VANILLA_COLOR, wins: !mcpWins },
      ].map(({ label: l, pct, val, color, wins }) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ width: 32, fontSize: 10, color, fontFamily: 'var(--mono)', fontWeight: 600, textAlign: 'right' }}>{l}</span>
          <div style={{ flex: 1, height: 12, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              style={{ height: '100%', background: color, borderRadius: 4, opacity: wins ? 1 : 0.4 }}
            />
          </div>
          <span style={{ width: 56, fontSize: 11, color: wins ? color : 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: wins ? 700 : 400 }}>
            {val.toLocaleString()}{unit ?? ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─── Task Card ──────────────────────────────────────────────────────────── */

function TaskCard({ task }: { task: BenchmarkTask }) {
  const saved = task.tokenSavingsPct;

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 16, minWidth: 280,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
            padding: '2px 7px', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text3)', fontFamily: 'var(--mono)',
          }}>
            {task.category}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{task.label}</span>
        </div>
        <span style={{
          background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '2px 8px', fontSize: 11, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text2)',
        }}>
          {task.points}pt
        </span>
      </div>

      <MetricBar label="Tokens" mcp={task.mcp.tokens} vanilla={task.vanilla.tokens} />
      <MetricBar label="Tool Calls" mcp={task.mcp.calls} vanilla={task.vanilla.calls} />

      <div style={{
        marginTop: 8, padding: '6px 10px', borderRadius: 6,
        background: saved > 0 ? 'rgba(16,185,129,.06)' : 'rgba(245,158,11,.06)',
        border: `1px solid ${saved > 0 ? 'rgba(16,185,129,.15)' : 'rgba(245,158,11,.15)'}`,
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: saved > 0 ? MCP_COLOR : VANILLA_COLOR, fontWeight: 700 }}>
          {saved > 0 ? `${saved}% tokens saved` : `+${Math.abs(saved)}% more tokens`}
        </span>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
          {task.callSavingsPct > 0 ? `${task.callSavingsPct}% fewer calls` : ''}
        </span>
      </div>
    </div>
  );
}

/* ─── Summary Hero Cards ─────────────────────────────────────────────────── */

function SummaryHero({ data, stochastic }: {
  data: { totalSavingsPct: number; callSavingsPct: number; taskCount: number; totalPoints: number; totalMcpTokens: number; totalVanillaTokens: number };
  stochastic: StochasticReport | null;
}) {
  const cards = [
    { label: 'Token Savings', value: `${data.totalSavingsPct}%`, sub: `${data.totalMcpTokens.toLocaleString()} vs ${data.totalVanillaTokens.toLocaleString()}`, color: MCP_COLOR },
    { label: 'Fewer Calls', value: `${data.callSavingsPct}%`, sub: `${data.taskCount} tasks, ${data.totalPoints}pts`, color: MCP_COLOR },
    ...(stochastic ? [
      { label: 'Win Rate', value: `${stochastic.results.mcpWinRate}%`, sub: `${stochastic.results.mcpWins}/${stochastic.config.trials} trials`, color: STAT_COLOR },
      { label: 'p-value', value: stochastic.statistics.wilcoxon.p < 0.001 ? '<.001' : stochastic.statistics.wilcoxon.p.toFixed(3), sub: `z=${stochastic.statistics.wilcoxon.z}`, color: STAT_COLOR },
      { label: 'Effect Size', value: `r=${stochastic.statistics.effectSize}`, sub: stochastic.statistics.effectLabel, color: STAT_COLOR },
      { label: '95% CI', value: `${stochastic.tokens.ci95.lower}–${stochastic.tokens.ci95.upper}%`, sub: 'savings range', color: STAT_COLOR },
    ] : []),
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cards.length}, 1fr)`, gap: 10, marginBottom: 20 }}>
      {cards.map((c) => (
        <motion.div
          key={c.label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          style={{
            padding: 14, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 10, textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{c.label}</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--mono)', color: c.color }}>{c.value}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{c.sub}</div>
        </motion.div>
      ))}
    </div>
  );
}

/* ─── Category Breakdown ─────────────────────────────────────────────────── */

function CategoryBreakdown({ categories }: { categories: Record<string, { mcpTokens: number; vanillaTokens: number; savingsPct: number }> }) {
  const sorted = Object.entries(categories).sort(([, a], [, b]) => b.savingsPct - a.savingsPct);

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 16, marginBottom: 16,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>Savings by Category</div>
      {sorted.map(([cat, data]) => {
        const max = Math.max(data.mcpTokens, data.vanillaTokens) || 1;
        return (
          <div key={cat} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'capitalize' }}>{cat}</span>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)', color: MCP_COLOR }}>{data.savingsPct}%</span>
            </div>
            <div style={{ display: 'flex', gap: 4, height: 8 }}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(data.mcpTokens / max) * 100}%` }}
                transition={{ duration: 0.6 }}
                style={{ height: '100%', background: MCP_COLOR, borderRadius: 4 }}
              />
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(data.vanillaTokens / max) * 100}%` }}
                transition={{ duration: 0.6, delay: 0.1 }}
                style={{ height: '100%', background: VANILLA_COLOR, borderRadius: 4, opacity: 0.5 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Stochastic Proof Panel ─────────────────────────────────────────────── */

function StochasticProof({ report }: { report: StochasticReport }) {
  const significant = report.statistics.significant;

  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid ${significant ? 'rgba(139,92,246,.3)' : 'var(--border)'}`,
      borderRadius: 10, padding: 20, marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: significant ? 'rgba(139,92,246,.12)' : 'rgba(113,113,122,.12)',
          color: significant ? STAT_COLOR : 'var(--text3)', fontSize: 14, fontWeight: 700,
        }}>
          {significant ? '✓' : '?'}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Statistical Proof</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            {report.config.trials} randomized trials &middot; Wilcoxon signed-rank test &middot; seed {report.config.seed}
          </div>
        </div>
      </div>

      <div style={{
        padding: '10px 14px', borderRadius: 8, marginBottom: 14,
        background: significant ? 'rgba(139,92,246,.06)' : 'rgba(245,158,11,.06)',
        border: `1px solid ${significant ? 'rgba(139,92,246,.15)' : 'rgba(245,158,11,.15)'}`,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: significant ? STAT_COLOR : VANILLA_COLOR }}>
          {significant
            ? 'H₀ rejected — MCP savings are statistically significant (p < 0.05)'
            : 'Insufficient evidence to reject H₀'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Hypothesis</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
            H₀: MCP and vanilla consume equal tokens<br />
            H₁: MCP consumes fewer tokens (one-tailed)
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Methodology</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
            Random file role assignment<br />
            Poisson exploration noise (λ={report.config.poissonLambda})<br />
            Bootstrap 95% CI ({report.config.bootstrapResamples} resamples)
          </div>
        </div>
      </div>

      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        By Template
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
        {Object.entries(report.byTemplate).map(([name, data]) => (
          <div key={name} style={{
            padding: '8px 12px', background: 'var(--surface2)', borderRadius: 6,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>{name}</span>
              <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 6 }}>n={data.count}</span>
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)', color: data.savingsPct > 0 ? MCP_COLOR : VANILLA_COLOR }}>
              {data.savingsPct}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Live runs (ccc-bench/1) ────────────────────────────────────────────── */

const BENCHMARK_TABS = [
  { key: 'overview', label: 'Live runs' },
  { key: 'simulated', label: 'Simulated (2026-06)' },
];

const KIND_ORDER = ['agent-opus', 'agent-glm', 'agent-deepseek', 'simulated'] as const;
const KIND_LABELS: Record<string, string> = {
  'agent-opus': 'Opus agent',
  'agent-glm': 'GLM agent',
  'agent-deepseek': 'DeepSeek agent',
  simulated: 'Simulated',
  'agent-claude': 'Claude (legacy)',
};
const STALE_DAYS = 14;

const sectionLabel: CSSProperties = {
  fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em',
};
const panel: CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 16,
};

function isAgentHeadline(h: BenchIndexEntry['headline']): h is AgentHeadline {
  return !!h && 'success_vanilla_pct' in h;
}
function isSimulatedHeadline(h: BenchIndexEntry['headline']): h is SimulatedHeadline {
  return !!h && 'tokensSavedPct' in h;
}
function isLegacyHeadline(h: BenchIndexEntry['headline']): h is LegacyHeadline {
  return !!h && 'nv_mean' in h;
}

/** Whole calendar days (UTC) between the run date and today. */
function daysAgo(date: string): number | null {
  const t = Date.parse(date.slice(0, 10));
  if (Number.isNaN(t)) return null;
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return Math.max(0, Math.round((today - t) / 86_400_000));
}

function agoLabel(days: number | null): string {
  if (days === null) return 'unknown age';
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Saved % with sign colour: green = fewer than vanilla, red = more. */
function SavedPct({ value }: { value: number | undefined }) {
  if (value === undefined) return <span style={{ color: 'var(--text3)' }}>—</span>;
  const color = value > 0 ? 'var(--green)' : value < 0 ? 'var(--red)' : 'var(--text2)';
  return <span style={{ color }}>{value > 0 ? '+' : ''}{value}%</span>;
}

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${value}%`;
}

function HeadlineStats({ entry }: { entry: BenchIndexEntry }) {
  const h = entry.headline;
  const rows: Array<[string, ReactNode]> = [];
  if (isAgentHeadline(h)) {
    rows.push(
      ['Success vanilla', pct(h.success_vanilla_pct)],
      ['Success cc', pct(h.success_cc_pct)],
      ['Success cc-guided', pct(h.success_cc_guided_pct)],
      ['Tokens saved', <SavedPct value={h.tokens_saved_pct} />],
      ['Tool calls saved', <SavedPct value={h.tool_calls_saved_pct} />],
    );
  } else if (isSimulatedHeadline(h)) {
    rows.push(
      ['Tokens saved', <SavedPct value={h.tokensSavedPct} />],
      ['Calls saved', <SavedPct value={h.callsSavedPct} />],
      ['MCP wins', pct(h.mcpWinsPct)],
    );
  } else if (isLegacyHeadline(h)) {
    rows.push(['Net value', h.nv_mean.toFixed(3)], ['Verdict', h.verdict ?? '—']);
  }
  if (rows.length === 0) return <div style={{ fontSize: 11, color: 'var(--text3)' }}>No headline</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 10px' }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{label}</span>
          <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)', textAlign: 'right' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function LatestRunCard({ entry, run, selected, onSelect }: {
  entry: BenchIndexEntry; run: BenchRun | undefined; selected: boolean; onSelect: () => void;
}) {
  const days = daysAgo(entry.date || entry.ts);
  const stale = days !== null && days > STALE_DAYS;
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        ...panel, textAlign: 'left', cursor: 'pointer', fontFamily: 'var(--font)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
        borderColor: selected ? 'var(--accent)' : 'var(--border)',
        boxShadow: selected ? '0 0 0 1px var(--accent-glow)' : 'none',
      }}
    >
      <div style={{ ...sectionLabel, color: selected ? 'var(--accent)' : 'var(--text3)', marginBottom: 6 }}>
        {KIND_LABELS[entry.kind] ?? entry.kind}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{entry.date}</div>
      <div style={{ fontSize: 11, color: stale ? 'var(--orange)' : 'var(--text3)', marginBottom: 8 }}>
        {agoLabel(days)}{stale ? ' — stale' : ''}
      </div>
      <div title={entry.model ?? undefined} style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.model ?? 'no model'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 10 }}>
        code-context {run?.code_context_version ?? '…'}
      </div>
      <HeadlineStats entry={entry} />
    </button>
  );
}

function RunList({ runs, selectedId, onSelect }: {
  runs: BenchIndexEntry[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  return (
    <div style={{ ...panel, padding: 0, overflow: 'hidden' }}>
      <div style={{ ...sectionLabel, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        All runs ({runs.length})
      </div>
      <div role="listbox" aria-label="Benchmark runs">
        {runs.map((r) => {
          const active = r.run_id === selectedId;
          return (
            <button
              key={r.run_id}
              role="option"
              aria-selected={active}
              onClick={() => onSelect(r.run_id)}
              style={{
                display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '8px 14px',
                border: 'none', borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                background: active ? 'var(--surface2)' : 'none', cursor: 'pointer', textAlign: 'left',
                fontFamily: 'var(--font)',
              }}
            >
              <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', width: 78, flexShrink: 0 }}>{r.date}</span>
              <span style={{ fontSize: 11, color: active ? 'var(--accent)' : 'var(--text)', fontWeight: 600, flex: 1 }}>
                {KIND_LABELS[r.kind] ?? r.kind}
              </span>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>{r.run_id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const ARMS = [
  { key: 'vanilla', label: 'vanilla' },
  { key: 'cc', label: 'cc' },
  { key: 'cc_guided', label: 'cc-guided' },
] as const;

function PerTaskTable({ run }: { run: BenchRun }) {
  const perTask = run.aggregate?.per_task ?? [];
  if (perTask.length === 0) return null;
  const arms = ARMS.filter((a) => perTask.some((t) => t[a.key]));
  const sizes = new Map((run.tasks ?? []).map((t) => [t.id, t.size]));
  const cell = (s: BenchArmStats | undefined) =>
    s ? `${Math.round(s.success_rate * 100)}% · ${s.tokens.total.toLocaleString()} tok · ${s.tool_calls} calls` : '—';
  const th: CSSProperties = { ...sectionLabel, textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' };
  const td: CSSProperties = { fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', padding: '6px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Task</th>
            {arms.map((a) => <th key={a.key} style={th}>{a.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {perTask.map((t) => (
            <tr key={t.task_id}>
              <td style={{ ...td, color: 'var(--text)', fontWeight: 600 }}>
                {t.task_id}{sizes.get(t.task_id) ? <span style={{ color: 'var(--text3)', fontWeight: 400 }}> {sizes.get(t.task_id)}</span> : null}
              </td>
              {arms.map((a) => <td key={a.key} style={td}>{cell(t[a.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetail({ entry, run, error }: { entry: BenchIndexEntry; run: BenchRun | undefined; error: string | undefined }) {
  const days = daysAgo(entry.date || entry.ts);
  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{KIND_LABELS[entry.kind] ?? entry.kind}</span>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{entry.date}</span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{agoLabel(days)}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 14, wordBreak: 'break-all' }}>
        {entry.run_id} · {entry.model ?? 'no model'}
        {run?.agent_cli ? ` · ${run.agent_cli.name} ${run.agent_cli.version}` : ''}
        {run?.code_context_version ? ` · code-context ${run.code_context_version}` : ''}
        {run?.duration_ms ? ` · ${Math.round(run.duration_ms / 1000)}s` : ''}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: 16, marginBottom: 14 }}>
        <div>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>Headline</div>
          <HeadlineStats entry={entry} />
        </div>
        <div>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>Notes</div>
          {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>Could not load run file: {error}</div>}
          {!error && !run && <div style={{ fontSize: 11, color: 'var(--text3)' }}>Loading run file…</div>}
          {run && (run.notes?.length ? (
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
              {run.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          ) : <div style={{ fontSize: 11, color: 'var(--text3)' }}>No notes</div>)}
        </div>
      </div>

      {run && (run.aggregate?.per_task?.length ?? 0) > 0 && (
        <>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>Per task (success · tokens · tool calls)</div>
          <PerTaskTable run={run} />
        </>
      )}
    </div>
  );
}

function LiveRunsView() {
  const runs = useBenchmarkStore((s) => s.benchRuns);
  const source = useBenchmarkStore((s) => s.benchSource);
  const message = useBenchmarkStore((s) => s.benchMessage);
  const loading = useBenchmarkStore((s) => s.benchLoading);
  const error = useBenchmarkStore((s) => s.benchError);
  const runDetails = useBenchmarkStore((s) => s.runDetails);
  const runErrors = useBenchmarkStore((s) => s.runErrors);
  const selectedRunId = useBenchmarkStore((s) => s.selectedRunId);
  const selectRun = useBenchmarkStore((s) => s.selectRun);

  if (loading && runs.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        {[1, 2].map((i) => (
          <div key={i} style={{ height: 160, background: 'var(--surface2)', borderRadius: 12, marginBottom: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: error ? 'var(--red)' : 'var(--text2)' }}>
        {error ? `Failed to load benchmark runs: ${error}` : 'No benchmark runs available.'}
        {message && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text3)', maxWidth: 620, marginInline: 'auto', lineHeight: 1.6 }}>{message}</div>}
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text3)' }}>The June 2026 simulated benchmark is in the “Simulated (2026-06)” tab.</div>
      </div>
    );
  }

  const latest = latestPerKind(runs);
  const cards = KIND_ORDER.map((k) => latest.find((r) => r.kind === k)).filter((r): r is BenchIndexEntry => !!r);
  const newest = runs[0];
  const newestDays = daysAgo(newest.date || newest.ts);
  const selected = runs.find((r) => r.run_id === selectedRunId) ?? newest;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ ...sectionLabel }}>Latest run</span>
        <span style={{ fontSize: 16, fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{newest.date}</span>
        <span style={{ fontSize: 11, color: newestDays !== null && newestDays > STALE_DAYS ? 'var(--orange)' : 'var(--text3)' }}>
          {agoLabel(newestDays)}
        </span>
        {source && <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>source: {source.label}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        {cards.map((entry) => (
          <LatestRunCard
            key={entry.run_id}
            entry={entry}
            run={runDetails[entry.run_id]}
            selected={entry.run_id === selected.run_id}
            onSelect={() => selectRun(entry.run_id)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', maxWidth: 380 }}>
          <RunList runs={runs} selectedId={selected.run_id} onSelect={selectRun} />
        </div>
        <div style={{ flex: '3 1 480px', minWidth: 0 }}>
          <RunDetail entry={selected} run={runDetails[selected.run_id]} error={runErrors[selected.run_id]} />
        </div>
      </div>
    </div>
  );
}

/* ─── Simulated (2026-06) ────────────────────────────────────────────────── */

function SimulatedView() {
  const data = useBenchmarkStore((s) => s.data);
  const stochastic = useBenchmarkStore((s) => s.stochastic);
  const loading = useBenchmarkStore((s) => s.loading);
  const error = useBenchmarkStore((s) => s.error);

  if (loading && !data) {
    return (
      <div style={{ padding: 20 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ height: 180, background: 'var(--surface2)', borderRadius: 12, marginBottom: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--red, #f87171)', fontSize: 13 }}>
        Failed to load benchmark data: {error}
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)' }}>
          Run <code style={{ fontFamily: 'var(--mono)', background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>npm test -- test/benchmark.test.ts</code> to generate benchmark-results.json
        </div>
      </div>
    );
  }

  const summary = data?.summary;
  const tasks = data?.tasks ?? [];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div style={{
        padding: '10px 14px', marginBottom: 14, borderRadius: 8, fontSize: 11, lineHeight: 1.6,
        background: 'var(--accent-glow)', border: '1px solid var(--border)', color: 'var(--text2)',
      }}>
        <strong style={{ color: 'var(--accent)' }}>Simulated benchmark (2026-06).</strong>{' '}
        Scripted tool-call workflows with estimated tokens, no real agent. Kept for reference; the “Live runs” tab shows measured agent runs.
      </div>

      {data?.meta && (
        <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 12 }}>
          Fixture: {data.meta.fixture} &middot; {data.meta.fileCount} files, {data.meta.tsFileCount} TS, {data.meta.exportCount} exports &middot; Generated {new Date(data.meta.generatedAt).toLocaleDateString()}
        </div>
      )}

      {summary && <SummaryHero data={summary} stochastic={stochastic} />}

      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <div style={{ flex: 2 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>
            Deterministic Benchmark — {tasks.length} Tasks
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {tasks.map((task) => <TaskCard key={task.id} task={task} />)}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 280 }}>
          {summary && <CategoryBreakdown categories={summary.categories} />}
          {stochastic && <StochasticProof report={stochastic} />}
        </div>
      </div>

      {data?.meta && (
        <div style={{
          padding: '12px 16px', background: 'var(--surface2)', borderRadius: 8,
          border: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6,
        }}>
          <strong>Methodology:</strong> {data.meta.methodology}<br />
          <strong>Token estimation:</strong> {data.meta.tokenEstimation}
        </div>
      )}

      {tasks.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          No simulated benchmark data. Run <code style={{ fontFamily: 'var(--mono)' }}>npm test -- test/benchmark.test.ts</code> to generate results.
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */

export function Benchmark() {
  const activeTab = useUIStore((s) => s.activeTab);
  const runCount = useBenchmarkStore((s) => s.benchRuns.length);
  const taskCount = useBenchmarkStore((s) => s.data?.tasks.length ?? 0);
  const fetchBenchmark = useBenchmarkStore((s) => s.fetchBenchmark);
  const fetchBenchIndex = useBenchmarkStore((s) => s.fetchBenchIndex);
  const simulated = activeTab === 'simulated';

  useEffect(() => {
    fetchBenchIndex();
    fetchBenchmark();
  }, [fetchBenchIndex, fetchBenchmark]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SubTabBar tabs={BENCHMARK_TABS} />
      <AnimatePresence mode="wait">
        <motion.div
          key={simulated ? 'simulated' : 'overview'}
          variants={tabVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={tabTransition}
          style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
          {simulated
            ? <HeroText>Simulated MCP vs Vanilla (2026-06) — <AnimatedNumber value={taskCount} /> tasks</HeroText>
            : <HeroText>Real agent runs — <AnimatedNumber value={runCount} /> runs, vanilla vs code-context</HeroText>}
          {simulated ? <SimulatedView /> : <LiveRunsView />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
