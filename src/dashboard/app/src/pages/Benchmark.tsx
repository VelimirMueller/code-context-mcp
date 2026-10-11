'use client';

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useBenchmarkStore, type BenchmarkTask, type StochasticReport } from '@/stores/benchmarkStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { HeroText } from '@/components/molecules/HeroText';
import { pageVariants, pageTransition } from '@/lib/motion';

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

/* ─── Main Page ──────────────────────────────────────────────────────────── */

export function Benchmark() {
  const data = useBenchmarkStore((s) => s.data);
  const stochastic = useBenchmarkStore((s) => s.stochastic);
  const loading = useBenchmarkStore((s) => s.loading);
  const error = useBenchmarkStore((s) => s.error);
  const fetchBenchmark = useBenchmarkStore((s) => s.fetchBenchmark);

  useEffect(() => {
    fetchBenchmark();
  }, [fetchBenchmark]);

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
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      transition={pageTransition}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      <HeroText>
        MCP vs Vanilla — <AnimatedNumber value={tasks.length} /> tasks, {stochastic ? <><AnimatedNumber value={stochastic.config.trials} /> trials</> : 'deterministic'}
      </HeroText>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
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
            No benchmark data yet. Run <code style={{ fontFamily: 'var(--mono)' }}>npm test -- test/benchmark.test.ts</code> to generate results.
          </div>
        )}
      </div>
    </motion.div>
  );
}
