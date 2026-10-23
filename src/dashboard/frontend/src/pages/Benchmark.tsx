'use client';

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useBenchmarkStore,
  latestPerKind,
  runKey,
  filterRuns,
  type BenchFilter,
  type BenchmarkTask,
  type StochasticReport,
  type BenchIndexEntry,
  type BenchRun,
  type BenchArmStats,
  type BenchPairedDelta,
  type BenchPhaseArmStats,
  type SavedSpread,
  type SimulatedHeadline,
  type LegacyHeadline,
} from '@/stores/benchmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { HeroText } from '@/components/molecules/HeroText';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { tabVariants, tabTransition } from '@/lib/motion';
import { VERDICT_LABELS, type RunVerdict, type VerdictCode } from '@bench/verdict.mts';
import {
  changeSign,
  changeText,
  isAgentHeadline,
  latestPerModel,
  plainSummary,
  simpleRow,
  successText,
  verdictOf,
  type SimpleRow,
} from '@/lib/latestRun';
import { cx } from '@/lib/utils';

// Colour classes: MCP = green, vanilla = orange, statistics = accent (same hex values as the tokens).
const MCP_TEXT = 'text-green';
const VANILLA_TEXT = 'text-orange';
const STAT_TEXT = 'text-accent';

const SECTION_LABEL_BASE = 'text-10 font-semibold uppercase tracking-[0.06em]';
const SECTION_LABEL = `${SECTION_LABEL_BASE} text-fg-3`;
const PANEL = 'bg-surface border border-line rounded-[10px]';

const CATEGORY_ICONS: Record<string, string> = {
  retrieval: 'search',
  analysis: 'diagram',
  exploration: 'compass',
  implementation: 'code',
  debugging: 'bug',
  refactoring: 'refresh',
};

/* ─── Metric Bar ─────────────────────────────────────────────────────────── */

function MetricBar({
  label,
  mcp,
  vanilla,
  unit,
  lowerIsBetter = true,
}: {
  label: string;
  mcp: number;
  vanilla: number;
  unit?: string;
  lowerIsBetter?: boolean;
}) {
  const max = Math.max(mcp, vanilla) || 1;
  const mcpPct = (mcp / max) * 100;
  const vanillaPct = (vanilla / max) * 100;
  const mcpWins = lowerIsBetter ? mcp < vanilla : mcp > vanilla;

  return (
    <div className="mb-2">
      <div className={cx(SECTION_LABEL, 'mb-[3px]')}>{label}</div>
      {[
        { label: 'MCP', pct: mcpPct, val: mcp, text: MCP_TEXT, bg: 'bg-green', wins: mcpWins },
        {
          label: 'VAN',
          pct: vanillaPct,
          val: vanilla,
          text: VANILLA_TEXT,
          bg: 'bg-orange',
          wins: !mcpWins,
        },
      ].map(({ label: l, pct, val, text, bg, wins }) => (
        <div key={l} className="mb-[2px] flex items-center gap-2">
          <span className={cx('w-8 text-right font-code text-10 font-semibold', text)}>{l}</span>
          <div className="h-3 flex-1 overflow-hidden rounded-[4px] bg-surface-2">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className={cx('h-full rounded-[4px]', bg, wins ? 'opacity-100' : 'opacity-40')}
            />
          </div>
          <span
            className={cx(
              'w-14 font-code text-11',
              wins ? text : 'text-fg-3',
              wins ? 'font-bold' : 'font-normal',
            )}
          >
            {val.toLocaleString()}
            {unit ?? ''}
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
    <div className={cx(PANEL, 'min-w-[280px] p-4')}>
      <div className="mb-[10px] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-[6px] bg-surface-2 px-[7px] py-[2px] font-code text-9 font-semibold tracking-[0.06em] text-fg-3 uppercase">
            {task.category}
          </span>
          <span className="text-13 font-bold text-fg">{task.label}</span>
        </div>
        <span className="rounded-[6px] border border-line bg-surface-2 px-2 py-[2px] font-code text-11 font-bold text-fg-2">
          {task.points}pt
        </span>
      </div>

      <MetricBar label="Tokens" mcp={task.mcp.tokens} vanilla={task.vanilla.tokens} />
      <MetricBar label="Tool Calls" mcp={task.mcp.calls} vanilla={task.vanilla.calls} />

      <div
        className={cx(
          'mt-2 flex justify-between rounded-[6px] px-[10px] py-[6px]',
          saved > 0
            ? 'border border-[rgba(16,185,129,.15)] bg-[rgba(16,185,129,.06)]'
            : 'border border-[rgba(245,158,11,.15)] bg-[rgba(245,158,11,.06)]',
        )}
      >
        <span className={cx('font-code text-11 font-bold', saved > 0 ? MCP_TEXT : VANILLA_TEXT)}>
          {saved > 0 ? `${saved}% tokens saved` : `+${Math.abs(saved)}% more tokens`}
        </span>
        <span className="font-code text-11 text-fg-3">
          {task.callSavingsPct > 0 ? `${task.callSavingsPct}% fewer calls` : ''}
        </span>
      </div>
    </div>
  );
}

/* ─── Summary Hero Cards ─────────────────────────────────────────────────── */

function SummaryHero({
  data,
  stochastic,
}: {
  data: {
    totalSavingsPct: number;
    callSavingsPct: number;
    taskCount: number;
    totalPoints: number;
    totalMcpTokens: number;
    totalVanillaTokens: number;
  };
  stochastic: StochasticReport | null;
}) {
  const cards = [
    {
      label: 'Token Savings',
      value: `${data.totalSavingsPct}%`,
      sub: `${data.totalMcpTokens.toLocaleString()} vs ${data.totalVanillaTokens.toLocaleString()}`,
      color: MCP_TEXT,
    },
    {
      label: 'Fewer Calls',
      value: `${data.callSavingsPct}%`,
      sub: `${data.taskCount} tasks, ${data.totalPoints}pts`,
      color: MCP_TEXT,
    },
    ...(stochastic
      ? [
          {
            label: 'Win Rate',
            value: `${stochastic.results.mcpWinRate}%`,
            sub: `${stochastic.results.mcpWins}/${stochastic.config.trials} trials`,
            color: STAT_TEXT,
          },
          {
            label: 'p-value',
            value:
              stochastic.statistics.wilcoxon.p < 0.001
                ? '<.001'
                : stochastic.statistics.wilcoxon.p.toFixed(3),
            sub: `z=${stochastic.statistics.wilcoxon.z}`,
            color: STAT_TEXT,
          },
          {
            label: 'Effect Size',
            value: `r=${stochastic.statistics.effectSize}`,
            sub: stochastic.statistics.effectLabel,
            color: STAT_TEXT,
          },
          {
            label: '95% CI',
            value: `${stochastic.tokens.ci95.lower}–${stochastic.tokens.ci95.upper}%`,
            sub: 'savings range',
            color: STAT_TEXT,
          },
        ]
      : []),
  ];

  return (
    <div
      className="mb-5 grid grid-cols-[repeat(var(--cols),1fr)] gap-[10px]"
      style={{ '--cols': cards.length } as CSSProperties}
    >
      {cards.map((c) => (
        <motion.div
          key={c.label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className={cx(PANEL, 'p-[14px] text-center')}
        >
          <div className="mb-1 text-9 font-semibold tracking-[0.06em] text-fg-3 uppercase">
            {c.label}
          </div>
          <div className={cx('font-code text-[22px] font-extrabold', c.color)}>{c.value}</div>
          <div className="mt-[2px] font-code text-10 text-fg-3">{c.sub}</div>
        </motion.div>
      ))}
    </div>
  );
}

/* ─── Category Breakdown ─────────────────────────────────────────────────── */

function CategoryBreakdown({
  categories,
}: {
  categories: Record<string, { mcpTokens: number; vanillaTokens: number; savingsPct: number }>;
}) {
  const sorted = Object.entries(categories).sort(([, a], [, b]) => b.savingsPct - a.savingsPct);

  return (
    <div className={cx(PANEL, 'mb-4 p-4')}>
      <div className="mb-3 text-12 font-bold text-fg">Savings by Category</div>
      {sorted.map(([cat, data]) => {
        const max = Math.max(data.mcpTokens, data.vanillaTokens) || 1;
        return (
          <div key={cat} className="mb-[10px]">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-11 font-semibold text-fg-2 capitalize">{cat}</span>
              <span className={cx('font-code text-12 font-bold', MCP_TEXT)}>
                {data.savingsPct}%
              </span>
            </div>
            <div className="flex h-2 gap-1">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(data.mcpTokens / max) * 100}%` }}
                transition={{ duration: 0.6 }}
                className="h-full rounded-[4px] bg-green"
              />
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${(data.vanillaTokens / max) * 100}%` }}
                transition={{ duration: 0.6, delay: 0.1 }}
                className="h-full rounded-[4px] bg-orange opacity-50"
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
    <div
      className={cx(
        'mb-4 rounded-[10px] border bg-surface p-5',
        significant ? 'border-[rgba(139,92,246,.3)]' : 'border-line',
      )}
    >
      <div className="mb-[14px] flex items-center gap-[10px]">
        <div
          className={cx(
            'flex h-7 w-7 items-center justify-center rounded-[6px] text-14 font-bold',
            significant
              ? 'bg-[rgba(139,92,246,.12)] text-accent'
              : 'bg-[rgba(113,113,122,.12)] text-fg-3',
          )}
        >
          {significant ? '✓' : '?'}
        </div>
        <div>
          <div className="text-14 font-bold text-fg">Statistical Proof</div>
          <div className="text-11 text-fg-3">
            {report.config.trials} randomized trials &middot; Wilcoxon signed-rank test &middot;
            seed {report.config.seed}
          </div>
        </div>
      </div>

      <div
        className={cx(
          'mb-[14px] rounded-[8px] px-[14px] py-[10px]',
          significant
            ? 'border border-[rgba(139,92,246,.15)] bg-[rgba(139,92,246,.06)]'
            : 'border border-[rgba(245,158,11,.15)] bg-[rgba(245,158,11,.06)]',
        )}
      >
        <div className={cx('text-12 font-bold', significant ? STAT_TEXT : VANILLA_TEXT)}>
          {significant
            ? 'H₀ rejected — MCP savings are statistically significant (p < 0.05)'
            : 'Insufficient evidence to reject H₀'}
        </div>
      </div>

      <div className="mb-[14px] grid grid-cols-[1fr_1fr] gap-3">
        <div>
          <div className={cx(SECTION_LABEL, 'mb-[6px]')}>Hypothesis</div>
          <div className="text-11 leading-[1.6] text-fg-2">
            H₀: MCP and vanilla consume equal tokens
            <br />
            H₁: MCP consumes fewer tokens (one-tailed)
          </div>
        </div>
        <div>
          <div className={cx(SECTION_LABEL, 'mb-[6px]')}>Methodology</div>
          <div className="text-11 leading-[1.6] text-fg-2">
            Random file role assignment
            <br />
            Poisson exploration noise (λ={report.config.poissonLambda})<br />
            Bootstrap 95% CI ({report.config.bootstrapResamples} resamples)
          </div>
        </div>
      </div>

      <div className={cx(SECTION_LABEL, 'mb-2')}>By Template</div>
      <div className="grid grid-cols-[repeat(2,1fr)] gap-2">
        {Object.entries(report.byTemplate).map(([name, data]) => (
          <div
            key={name}
            className="flex items-center justify-between rounded-[6px] bg-surface-2 px-3 py-2"
          >
            <div>
              <span className="text-11 font-semibold text-fg-2">{name}</span>
              <span className="ml-[6px] text-10 text-fg-3">n={data.count}</span>
            </div>
            <span
              className={cx(
                'font-code text-12 font-bold',
                data.savingsPct > 0 ? MCP_TEXT : VANILLA_TEXT,
              )}
            >
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

/** "private · <alias>" chip on a private suite run (local only, never published). */
function PrivateChip({ entry }: { entry: BenchIndexEntry }) {
  if (!entry.private) return null;
  return (
    <span
      title={`Private suite${entry.suite ? ` ${entry.suite}` : ''}: local only, never published`}
      className="shrink-0 rounded-[4px] border border-orange px-[5px] py-0 text-9 font-bold tracking-[0.06em] whitespace-nowrap text-orange uppercase"
    >
      private{entry.suite ? ` · ${entry.suite}` : ''}
    </span>
  );
}

const FILTERS: Array<{ key: BenchFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'public', label: 'Public' },
  { key: 'private', label: 'Private' },
];

function RunFilter({
  value,
  onChange,
  counts,
}: {
  value: BenchFilter;
  onChange: (f: BenchFilter) => void;
  counts: Record<BenchFilter, number>;
}) {
  return (
    <div role="group" aria-label="Run filter" className="flex gap-1">
      {FILTERS.map((f) => {
        const active = f.key === value;
        return (
          <button
            key={f.key}
            aria-pressed={active}
            onClick={() => onChange(f.key)}
            className={cx(
              'cursor-pointer rounded-[6px] border px-[10px] py-[3px] font-body text-11',
              active
                ? 'border-accent bg-surface-2 text-accent'
                : 'border-line bg-transparent text-fg-2',
            )}
          >
            {f.label} ({counts[f.key]})
          </button>
        );
      })}
    </div>
  );
}

function isSimulatedHeadline(h: BenchIndexEntry['headline']): h is SimulatedHeadline {
  return !!h && 'tokensSavedPct' in h;
}
function isLegacyHeadline(h: BenchIndexEntry['headline']): h is LegacyHeadline {
  return !!h && 'nv_mean' in h;
}

/** Status colours: green = beneficial, grey = no clear effect, red = suboptimal (text + border). */
const VERDICT_COLORS: Record<VerdictCode, string> = {
  BENEFICIAL: 'text-green border-green',
  NO_CLEAR_EFFECT: 'text-fg-3 border-fg-3',
  SUBOPTIMAL: 'text-red border-red',
};

/** One-line verdict chip: BENEFICIAL / NO CLEAR EFFECT / SUBOPTIMAL + "indicative". */
function VerdictChip({ verdict }: { verdict: RunVerdict | null }) {
  if (!verdict) return null;
  return (
    <div
      data-testid="verdict-chip"
      title={verdict.sentences[0]}
      className="mb-2 flex flex-wrap items-center gap-[6px]"
    >
      <span
        data-verdict={verdict.code}
        className={cx(
          'rounded-[4px] border px-[6px] py-[1px] text-10 font-bold tracking-[0.06em] whitespace-nowrap uppercase',
          VERDICT_COLORS[verdict.code],
        )}
      >
        {VERDICT_LABELS[verdict.code]}
      </span>
      {verdict.indicative && (
        <span title={`${verdict.repeats} repeat(s): fewer than 3`} className="text-10 text-fg-3">
          indicative
        </span>
      )}
    </div>
  );
}

/** "Verdict" section: the chip and the ASD-STE100 sentences. */
function VerdictSection({ verdict }: { verdict: RunVerdict | null }) {
  if (!verdict) return null;
  const [headline, ...rest] = verdict.sentences;
  return (
    <section aria-label="Verdict" className="mb-[14px]">
      <div className={cx(SECTION_LABEL, 'mb-[6px]')}>Verdict</div>
      <VerdictChip verdict={verdict} />
      <div className="mb-1 text-12 font-bold text-fg">{headline}</div>
      <ul className="m-0 pl-4 text-11 leading-[1.6] text-fg-2">
        {rest.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </section>
  );
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
  if (value === undefined) return <span className="text-fg-3">—</span>;
  const color = value > 0 ? 'text-green' : value < 0 ? 'text-red' : 'text-fg-2';
  return (
    <span className={color}>
      {value > 0 ? '+' : ''}
      {value}%
    </span>
  );
}

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${value}%`;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}%`;
}

/** Min–max of a saved % over repeats, muted next to the value it qualifies. */
function Spread({ spread }: { spread: SavedSpread | null | undefined }) {
  if (!spread) return null;
  return (
    <span title={`min … max over ${spread.repeats} repeats`} className="font-normal text-fg-3">
      {' '}
      [{signed(spread.min)} … {signed(spread.max)}]
    </span>
  );
}

function tokens(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function HeadlineStats({ entry }: { entry: BenchIndexEntry }) {
  const h = entry.headline;
  const rows: Array<[string, ReactNode]> = [];
  if (isAgentHeadline(h)) {
    // CCA-08: success, then uncached tokens (input + output + cache write),
    // cost and uncached tokens per PASS. The all-tokens figure is mostly cache
    // reads (billed at ~1 % of input) and lives in the run detail.
    const guided = h.success_cc_guided_pct !== undefined;
    const pp = h.uncached_per_pass;
    rows.push(
      ['Success vanilla', pct(h.success_vanilla_pct)],
      ['Success cc', pct(h.success_cc_pct)],
      ['Success cc-guided', pct(h.success_cc_guided_pct)],
      [
        'Uncached saved cc',
        <>
          <SavedPct value={h.uncached_saved_pct} />
          <Spread spread={h.uncached_saved_spread} />
        </>,
      ],
    );
    if (guided) {
      rows.push([
        'Uncached saved guided',
        <>
          <SavedPct value={h.guided_uncached_saved_pct} />
          <Spread spread={h.guided_uncached_saved_spread} />
        </>,
      ]);
    }
    rows.push(['Cost saved cc', <SavedPct value={h.cost_saved_pct ?? undefined} />]);
    if (guided)
      rows.push(['Cost saved guided', <SavedPct value={h.guided_cost_saved_pct ?? undefined} />]);
    rows.push(
      ['Uncached / PASS vanilla', tokens(pp?.vanilla)],
      ['Uncached / PASS cc', tokens(pp?.cc)],
    );
    if (guided) rows.push(['Uncached / PASS guided', tokens(pp?.cc_guided)]);
    rows.push(['Tool calls saved', <SavedPct value={h.tool_calls_saved_pct} />]);
  } else if (isSimulatedHeadline(h)) {
    rows.push(
      ['Tokens saved', <SavedPct value={h.tokensSavedPct} />],
      ['Calls saved', <SavedPct value={h.callsSavedPct} />],
      ['MCP wins', pct(h.mcpWinsPct)],
    );
  } else if (isLegacyHeadline(h)) {
    rows.push(['Net value', h.nv_mean.toFixed(3)], ['Verdict', h.verdict ?? '—']);
  }
  if (rows.length === 0) return <div className="text-11 text-fg-3">No headline</div>;
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-[10px] gap-y-[3px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <span className="text-11 text-fg-3">{label}</span>
          <span className="text-right font-code text-12 font-bold text-fg">{value}</span>
        </div>
      ))}
    </div>
  );
}

function LatestRunCard({
  entry,
  run,
  selected,
  onSelect,
}: {
  entry: BenchIndexEntry;
  run: BenchRun | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const days = daysAgo(entry.date || entry.ts);
  const stale = days !== null && days > STALE_DAYS;
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        'flex cursor-pointer flex-col justify-start rounded-[10px] border bg-surface p-4 text-left font-body',
        selected
          ? 'border-accent [box-shadow:0_0_0_1px_var(--color-accent-glow)]'
          : 'border-line [box-shadow:none]',
      )}
    >
      <div
        className={cx(
          SECTION_LABEL_BASE,
          selected ? 'text-accent' : 'text-fg-3',
          'mb-[6px] flex items-center gap-[6px]',
        )}
      >
        {KIND_LABELS[entry.kind] ?? entry.kind}
        <PrivateChip entry={entry} />
      </div>
      <div className="font-code text-18 font-extrabold text-fg">{entry.date}</div>
      <div className={cx('mb-2 text-11', stale ? 'text-orange' : 'text-fg-3')}>
        {agoLabel(days)}
        {stale ? ' — stale' : ''}
      </div>
      <div
        title={entry.model ?? undefined}
        className="overflow-hidden font-code text-11 text-ellipsis whitespace-nowrap text-fg-2"
      >
        {entry.model ?? 'no model'}
      </div>
      <div className="mb-[10px] font-code text-11 text-fg-3">
        code-context {run?.code_context_version ?? '…'}
      </div>
      <VerdictChip verdict={verdictOf(entry, run)} />
      <HeadlineStats entry={entry} />
    </button>
  );
}

function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: BenchIndexEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={cx(PANEL, 'overflow-hidden p-0')}>
      <div className={cx(SECTION_LABEL, 'border-b border-b-line px-[14px] py-3')}>
        All runs ({runs.length})
      </div>
      <div role="listbox" aria-label="Benchmark runs">
        {runs.map((r) => {
          const key = runKey(r);
          const active = key === selectedId;
          return (
            <button
              key={key}
              role="option"
              aria-selected={active}
              onClick={() => onSelect(key)}
              className={cx(
                'flex w-full cursor-pointer items-center gap-[10px] px-[14px] py-2 text-left font-body [border-top-style:none] [border-right-style:none] [border-bottom-style:none] border-l-2',
                active ? 'border-l-accent bg-surface-2' : 'border-l-transparent bg-transparent',
              )}
            >
              <span className="w-[78px] shrink-0 font-code text-11 text-fg-2">{r.date}</span>
              <span
                className={cx('flex-1 text-11 font-semibold', active ? 'text-accent' : 'text-fg')}
              >
                {KIND_LABELS[r.kind] ?? r.kind}
              </span>
              <PrivateChip entry={r} />
              <span className="font-code text-10 text-fg-3">{r.run_id}</span>
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

// Table cells. The colour is not part of the base, so a cell can pick its own without a clash.
const TH = `${SECTION_LABEL} border-b border-b-line px-2 py-[6px]`;
const TH_LEFT = `${TH} text-left`;
const TH_NUM = `${TH} text-right`;
const TD_BASE = 'border-b border-b-line px-2 py-[6px] font-code text-11 whitespace-nowrap';
const TD = `${TD_BASE} text-fg-2`;
const TD_NUM = `${TD} text-right`;

/** Paired uncached delta vs vanilla: green = fewer tokens, red = more; min … max muted. */
function DeltaCell({ d }: { d: BenchPairedDelta | null | undefined }) {
  if (!d) return <td className={TD_NUM}>—</td>;
  const color = d.saved_pct > 0 ? 'text-green' : d.saved_pct < 0 ? 'text-red' : 'text-fg-2';
  return (
    <td className={TD_NUM}>
      <span className={color}>{signed(d.saved_pct)}</span>
      {d.pairs > 1 && (
        <span className="text-fg-3">
          {' '}
          [{signed(d.min)} … {signed(d.max)}]
        </span>
      )}
    </td>
  );
}

function PerTaskTable({ run }: { run: BenchRun }) {
  const perTask = run.aggregate?.per_task ?? [];
  if (perTask.length === 0) return null;
  const arms = ARMS.filter((a) => perTask.some((t) => t[a.key]));
  const deltaArms = arms.filter(
    (a) => a.key !== 'vanilla' && perTask.some((t) => t.delta && a.key in t.delta),
  );
  const sizes = new Map((run.tasks ?? []).map((t) => [t.id, t.size]));
  // Uncached tokens when the run has them (CCA-08); older runs show all tokens, marked.
  const cell = (s: BenchArmStats | undefined) =>
    s
      ? `${Math.round(s.success_rate * 100)}% · ${
          typeof s.uncached_tokens === 'number'
            ? `${s.uncached_tokens.toLocaleString()} unc`
            : `${s.tokens.total.toLocaleString()} tok (all)`
        } · ${s.tool_calls} calls`
      : '—';
  return (
    <div className="overflow-x-auto">
      <table aria-label="Per task" className="w-full border-collapse">
        <thead>
          <tr>
            <th className={TH_LEFT}>Task</th>
            {arms.map((a) => (
              <th key={a.key} className={TH_LEFT}>
                {a.label}
              </th>
            ))}
            {deltaArms.map((a) => (
              <th key={`d-${a.key}`} className={TH_NUM}>
                Δ unc {a.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {perTask.map((t) => (
            <tr key={t.task_id}>
              <td className={cx(TD_BASE, 'font-semibold text-fg')}>
                {t.task_id}
                {sizes.get(t.task_id) ? (
                  <span className="font-normal text-fg-3"> {sizes.get(t.task_id)}</span>
                ) : null}
              </td>
              {arms.map((a) => (
                <td key={a.key} className={TD}>
                  {cell(t[a.key])}
                </td>
              ))}
              {deltaArms.map((a) => (
                <DeltaCell key={`d-${a.key}`} d={a.key === 'vanilla' ? null : t.delta?.[a.key]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PHASES = ['cold', 'warm'] as const;

/** Cold vs warm per arm (only `--cache-mode cold-warm` runs carry aggregate.by_phase). */
function PhaseTable({ run }: { run: BenchRun }) {
  const byPhase = run.aggregate?.by_phase;
  if (!byPhase) return null;
  const rows: Array<{ arm: string; phase: string; s: BenchPhaseArmStats }> = [];
  for (const a of ARMS) {
    for (const p of PHASES) {
      const s = byPhase[p]?.[a.key];
      if (s) rows.push({ arm: a.label, phase: p, s });
    }
  }
  if (rows.length === 0) return null;
  const showCost = rows.some((r) => typeof r.s.cost_usd === 'number');
  return (
    <div className="overflow-x-auto">
      <table aria-label="Cold vs warm" className="w-full border-collapse">
        <thead>
          <tr>
            <th className={TH_LEFT}>Arm</th>
            <th className={TH_LEFT}>Phase</th>
            <th className={TH_NUM}>Success</th>
            <th className={TH_NUM}>Tokens</th>
            <th className={TH_NUM}>Uncached</th>
            <th className={TH_NUM}>Calls</th>
            <th className={TH_NUM}>MCP calls</th>
            <th className={TH_NUM}>Wall s</th>
            {showCost && <th className={TH_NUM}>Cost</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ arm, phase, s }) => (
            <tr key={`${arm}-${phase}`}>
              <td className={cx(TD_BASE, 'font-semibold text-fg')}>{arm}</td>
              <td className={cx(TD_BASE, phase === 'cold' ? 'text-accent' : 'text-fg-3')}>
                {phase}
                <span className="text-fg-3"> n={s.sessions}</span>
              </td>
              <td className={TD_NUM}>{Math.round(s.success_rate * 100)}%</td>
              <td className={TD_NUM}>{s.tokens.total.toLocaleString()}</td>
              <td className={TD_NUM}>{s.uncached_tokens.toLocaleString()}</td>
              <td className={TD_NUM}>{s.tool_calls}</td>
              <td className={TD_NUM}>{s.mcp_tool_calls}</td>
              <td className={TD_NUM}>{(s.wall_ms_mean / 1000).toFixed(1)}</td>
              {showCost && (
                <td className={TD_NUM}>
                  {typeof s.cost_usd === 'number' ? `$${s.cost_usd.toFixed(4)}` : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetail({
  entry,
  run,
  error,
}: {
  entry: BenchIndexEntry;
  run: BenchRun | undefined;
  error: string | undefined;
}) {
  const days = daysAgo(entry.date || entry.ts);
  return (
    <div className={cx(PANEL, 'p-4')}>
      <div className="mb-1 flex flex-wrap items-baseline gap-[10px]">
        <span className="text-14 font-bold text-fg">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
        <span className="font-code text-14 font-bold text-accent">{entry.date}</span>
        <span className="text-11 text-fg-3">{agoLabel(days)}</span>
        <PrivateChip entry={entry} />
      </div>
      <div className="mb-[14px] font-code text-11 [word-break:break-all] text-fg-3">
        {entry.run_id} · {entry.model ?? 'no model'}
        {run?.agent_cli ? ` · ${run.agent_cli.name} ${run.agent_cli.version}` : ''}
        {run?.code_context_version ? ` · code-context ${run.code_context_version}` : ''}
        {run?.duration_ms ? ` · ${Math.round(run.duration_ms / 1000)}s` : ''}
      </div>
      <VerdictSection verdict={verdictOf(entry, run)} />
      {entry.private && (
        <div className="mb-[14px] text-11 leading-[1.6] text-fg-3">
          Private suite{entry.suite ? ` ${entry.suite}` : ''}: shown from your local suite dir only,
          never published.
          {run?.suite?.redact || run?.tasks?.some((t) => t.prompt === undefined && t.prompt_sha256)
            ? ' Redacted run: tasks by id only, no prompts, answers or source names.'
            : ''}
        </div>
      )}

      <div className="mb-[14px] grid grid-cols-[minmax(200px,260px)_1fr] gap-4">
        <div>
          <div className={cx(SECTION_LABEL, 'mb-[6px]')}>Headline</div>
          <HeadlineStats entry={entry} />
        </div>
        <div>
          <div className={cx(SECTION_LABEL, 'mb-[6px]')}>Notes</div>
          {error && <div className="text-11 text-red">Could not load run file: {error}</div>}
          {!error && !run && <div className="text-11 text-fg-3">Loading run file…</div>}
          {run &&
            (run.notes?.length ? (
              <ul className="m-0 pl-4 text-11 leading-[1.6] text-fg-2">
                {run.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : (
              <div className="text-11 text-fg-3">No notes</div>
            ))}
        </div>
      </div>

      {run && (run.aggregate?.per_task?.length ?? 0) > 0 && (
        <>
          <div className={cx(SECTION_LABEL, 'mb-[6px]')}>
            Per task (success · uncached tokens · tool calls · Δ vs vanilla, min … max over repeats)
          </div>
          <PerTaskTable run={run} />
        </>
      )}

      {isAgentHeadline(entry.headline) && (
        <div className="mt-[10px] text-11 text-fg-3">
          All tokens incl. cache reads (billed at ~1 % of input): saved cc{' '}
          <SavedPct value={entry.headline.tokens_saved_pct} />
          {entry.headline.guided_tokens_saved_pct !== undefined && (
            <>
              {' '}
              · guided <SavedPct value={entry.headline.guided_tokens_saved_pct} />
            </>
          )}
        </div>
      )}

      {run?.aggregate?.by_phase && (
        <div className="mt-[14px]">
          <div className={cx(SECTION_LABEL, 'mb-[6px]')}>
            Cold vs warm (totals per phase · wall = mean per session)
          </div>
          <PhaseTable run={run} />
        </div>
      )}
    </div>
  );
}

function LiveRunsView() {
  const allRuns = useBenchmarkStore((s) => s.benchRuns);
  const filter = useBenchmarkStore((s) => s.benchFilter);
  const setFilter = useBenchmarkStore((s) => s.setBenchFilter);
  const source = useBenchmarkStore((s) => s.benchSource);
  const message = useBenchmarkStore((s) => s.benchMessage);
  const loading = useBenchmarkStore((s) => s.benchLoading);
  const error = useBenchmarkStore((s) => s.benchError);
  const runDetails = useBenchmarkStore((s) => s.runDetails);
  const runErrors = useBenchmarkStore((s) => s.runErrors);
  const selectedRunId = useBenchmarkStore((s) => s.selectedRunId);
  const selectRun = useBenchmarkStore((s) => s.selectRun);

  const runs = filterRuns(allRuns, filter);
  const privateCount = allRuns.filter((r) => r.private).length;

  if (loading && allRuns.length === 0) {
    return (
      <div className="p-5">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="mb-3 h-40 rounded-[12px] bg-surface-2 [animation:pulse_1.5s_ease-in-out_infinite]"
          />
        ))}
      </div>
    );
  }

  if (allRuns.length === 0) {
    return (
      <div className={cx('p-10 text-center text-13', error ? 'text-red' : 'text-fg-2')}>
        {error ? `Failed to load benchmark runs: ${error}` : 'No benchmark runs available.'}
        {message && (
          <div className="mx-auto mt-[10px] max-w-[620px] text-11 leading-[1.6] text-fg-3">
            {message}
          </div>
        )}
        <div className="mt-[10px] text-11 text-fg-3">
          The June 2026 simulated benchmark is in the “Simulated (2026-06)” tab.
        </div>
      </div>
    );
  }

  const filterBar = privateCount > 0 && (
    <div className="mb-[14px] flex flex-wrap items-center gap-[10px]">
      <RunFilter
        value={filter}
        onChange={setFilter}
        counts={{
          all: allRuns.length,
          public: allRuns.length - privateCount,
          private: privateCount,
        }}
      />
      <span className="text-11 text-fg-3">
        Private suite runs are local only (CODE_CONTEXT_BENCH_PRIVATE_DIRS).
      </span>
    </div>
  );

  if (runs.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-5">
        {filterBar}
        <div className="p-10 text-center text-13 text-fg-2">No {filter} runs.</div>
      </div>
    );
  }

  const latest = latestPerKind(runs);
  const cards = KIND_ORDER.map((k) => latest.find((r) => r.kind === k)).filter(
    (r): r is BenchIndexEntry => !!r,
  );
  const newest = runs[0];
  const newestDays = daysAgo(newest.date || newest.ts);
  const selected = runs.find((r) => runKey(r) === selectedRunId) ?? newest;
  const selectedKey = runKey(selected);

  return (
    <div className="flex-1 overflow-y-auto p-5">
      {filterBar}
      <div className="mb-[14px] flex flex-wrap items-baseline gap-[10px]">
        <span className={SECTION_LABEL}>Latest run</span>
        <span className="font-code text-16 font-extrabold text-fg">{newest.date}</span>
        <span
          className={cx(
            'text-11',
            newestDays !== null && newestDays > STALE_DAYS ? 'text-orange' : 'text-fg-3',
          )}
        >
          {agoLabel(newestDays)}
        </span>
        {source && (
          <span className="ml-auto font-code text-11 text-fg-3">source: {source.label}</span>
        )}
      </div>

      <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {cards.map((entry) => (
          <LatestRunCard
            key={runKey(entry)}
            entry={entry}
            run={runDetails[runKey(entry)]}
            selected={runKey(entry) === selectedKey}
            onSelect={() => selectRun(runKey(entry))}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="max-w-[380px] flex-[1_1_280px]">
          <RunList runs={runs} selectedId={selectedKey} onSelect={selectRun} />
        </div>
        <div className="min-w-0 flex-[3_1_480px]">
          <RunDetail
            entry={selected}
            run={runDetails[selectedKey]}
            error={runErrors[selectedKey]}
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Latest run: one plain table (#160) ─────────────────────────────────── */

/** Green = better than vanilla, red = worse, muted = unknown. */
function changeColor(value: number | null): string {
  const s = changeSign(value);
  return s === null ? 'text-fg-3' : s > 0 ? 'text-green' : s < 0 ? 'text-red' : 'text-fg-2';
}

/** Verdict chip for the table: BENEFICIAL / NO CLEAR EFFECT / SUBOPTIMAL + "indicative". */
function ResultChip({ verdict }: { verdict: RunVerdict | null }) {
  if (!verdict) return <span className="text-fg-3">—</span>;
  return (
    <span
      data-testid="result-chip"
      data-verdict={verdict.code}
      className="inline-flex flex-col items-start gap-[2px]"
    >
      <span
        data-verdict={verdict.code}
        className={cx(
          'rounded-[4px] border px-[6px] py-[1px] font-code text-10 font-bold tracking-[0.06em] whitespace-nowrap',
          VERDICT_COLORS[verdict.code],
        )}
      >
        {VERDICT_LABELS[verdict.code]}
      </span>
      {verdict.indicative && (
        <span title={`${verdict.repeats} repeat(s): fewer than 3`} className="text-10 text-fg-3">
          indicative
        </span>
      )}
    </span>
  );
}

// Column widths in px: the minimum each column needs for its longest value
// ("NO CLEAR EFFECT", "100 % → 100 %", "23 % slower") without wrapping. The
// table stretches above their sum and scrolls sideways below it, with the
// model column pinned.
const SIMPLE_COLS: Array<{ label: string; width: number; num?: boolean }> = [
  { label: 'Model', width: 88 },
  { label: 'Result', width: 136 },
  { label: 'Success', width: 108, num: true },
  { label: 'Tokens', width: 88, num: true },
  { label: 'Cost', width: 88, num: true },
  { label: 'Speed', width: 100, num: true },
  { label: 'Repeats', width: 68, num: true },
];
const SIMPLE_MIN_WIDTH = SIMPLE_COLS.reduce((n, c) => n + c.width, 0);

const STH = `${SECTION_LABEL} border-b border-b-line p-[10px] whitespace-nowrap`;
/** The model column stays in view while the table scrolls sideways. */
const PINNED = 'sticky left-0 z-1 bg-surface';
// The last row has no bottom border.
const stdBorder = (last: boolean) => (last ? '[border-bottom:none]' : 'border-b border-b-line');
const STD = 'overflow-hidden px-[10px] py-3 align-middle text-ellipsis whitespace-nowrap';
const STD_NUM = `${STD} text-right font-code text-12 [font-variant-numeric:tabular-nums]`;

function SimpleTable({ rows }: { rows: SimpleRow[] }) {
  return (
    <div className={cx(PANEL, 'overflow-x-auto p-0')}>
      <table
        aria-label="Latest run per model"
        className="w-full table-fixed border-collapse [font-variant-numeric:tabular-nums]"
        style={{ minWidth: SIMPLE_MIN_WIDTH }}
      >
        <colgroup>
          {SIMPLE_COLS.map((c) => (
            <col key={c.label} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {SIMPLE_COLS.map((c, i) => (
              <th
                key={c.label}
                scope="col"
                className={cx(STH, c.num ? 'text-right' : 'text-left', i === 0 && !c.num && PINNED)}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const border = stdBorder(i === rows.length - 1);
            return (
              <tr key={r.kind} data-kind={r.kind}>
                <th
                  scope="row"
                  className={cx(STD, PINNED, border, 'text-left text-13 font-bold text-fg')}
                >
                  {r.label}
                </th>
                <td className={cx(STD, border)}>
                  <ResultChip verdict={r.verdict} />
                </td>
                <td className={cx(STD_NUM, border, 'text-fg')}>{successText(r)}</td>
                <td className={cx(STD_NUM, border, changeColor(r.tokensSavedPct))}>
                  {changeText(r.tokensSavedPct, 'less', 'more')}
                </td>
                <td className={cx(STD_NUM, border, changeColor(r.costSavedPct))}>
                  {changeText(r.costSavedPct, 'less', 'more')}
                </td>
                <td className={cx(STD_NUM, border, changeColor(r.fasterPct))}>
                  {changeText(r.fasterPct, 'faster', 'slower')}
                </td>
                <td className={cx(STD_NUM, border, 'text-fg-2')}>
                  {r.repeats !== null ? `${r.repeats}×` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LatestRunTable() {
  const allRuns = useBenchmarkStore((s) => s.benchRuns);
  const runDetails = useBenchmarkStore((s) => s.runDetails);
  const loading = useBenchmarkStore((s) => s.benchLoading);
  const error = useBenchmarkStore((s) => s.benchError);

  const rows = latestPerModel(allRuns).map((e) => simpleRow(e, runDetails[runKey(e)]));
  if (rows.length === 0) {
    return (
      <div className={cx(PANEL, 'p-6 text-center text-13', error ? 'text-red' : 'text-fg-2')}>
        {loading
          ? 'Loading the latest run…'
          : error
            ? `Could not load the benchmark runs: ${error}`
            : 'No GLM, Opus or DeepSeek run yet.'}
      </div>
    );
  }
  const dates = [...new Set(rows.map((r) => r.entry.date))].join(' / ');
  const suites = [
    ...new Set(
      rows.map((r) => (r.entry.private ? (r.entry.suite ?? 'private suite') : 'test fixture')),
    ),
  ].join(' / ');
  return (
    <section aria-label="Latest run">
      <div className="mb-[10px] text-12 leading-[1.6] text-fg-3">
        <span className="font-code font-bold text-fg">
          {dates} · {suites}
        </span>
        {' — '}Tokens = tokens the model had to process (cache excluded). With code-context = the
        better of the two code-context setups.
      </div>
      <SimpleTable rows={rows} />
      <ul
        aria-label="Result per model"
        className="mt-3 mr-0 mb-0 ml-0 list-disc pl-[18px] text-12 leading-[1.7] text-fg-2"
      >
        {rows
          .filter((r) => r.summary.length > 0)
          .map((r) => (
            <li key={r.kind}>
              <strong className="text-fg">{r.label}:</strong> {plainSummary(r.summary)}
            </li>
          ))}
      </ul>
    </section>
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
      <div className="p-5">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="mb-3 h-[180px] rounded-[12px] bg-surface-2 [animation:pulse_1.5s_ease-in-out_infinite]"
          />
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-10 text-center text-13 text-red">
        Failed to load benchmark data: {error}
        <div className="mt-2 text-11 text-fg-3">
          Run{' '}
          <code className="rounded-[4px] bg-surface-2 px-[6px] py-[2px] font-code">
            pnpm test test/benchmark.test.ts
          </code>{' '}
          to generate benchmark-results.json
        </div>
      </div>
    );
  }

  const summary = data?.summary;
  const tasks = data?.tasks ?? [];

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-[14px] rounded-[8px] border border-line bg-accent-glow px-[14px] py-[10px] text-11 leading-[1.6] text-fg-2">
        <strong className="text-accent">Simulated benchmark (2026-06).</strong> Scripted tool-call
        workflows with estimated tokens, no real agent. Kept for reference; the “Live runs” tab
        shows measured agent runs.
      </div>

      {data?.meta && (
        <div className="mb-3 font-code text-11 text-fg-3">
          Fixture: {data.meta.fixture} &middot; {data.meta.fileCount} files, {data.meta.tsFileCount}{' '}
          TS, {data.meta.exportCount} exports &middot; Generated{' '}
          {new Date(data.meta.generatedAt).toLocaleDateString()}
        </div>
      )}

      {summary && <SummaryHero data={summary} stochastic={stochastic} />}

      <div className="mb-4 flex gap-4">
        <div className="flex-[2]">
          <div className="mb-[10px] text-12 font-bold text-fg">
            Deterministic Benchmark — {tasks.length} Tasks
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        </div>

        <div className="min-w-[280px] flex-1">
          {summary && <CategoryBreakdown categories={summary.categories} />}
          {stochastic && <StochasticProof report={stochastic} />}
        </div>
      </div>

      {data?.meta && (
        <div className="rounded-[8px] border border-line bg-surface-2 px-4 py-3 text-11 leading-[1.6] text-fg-3">
          <strong>Methodology:</strong> {data.meta.methodology}
          <br />
          <strong>Token estimation:</strong> {data.meta.tokenEstimation}
        </div>
      )}

      {tasks.length === 0 && (
        <div className="p-10 text-center text-13 text-fg-3">
          No simulated benchmark data. Run{' '}
          <code className="font-code">pnpm test test/benchmark.test.ts</code> to generate results.
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
    <div className="flex h-full flex-col overflow-hidden">
      <HeroText>Latest benchmark run — vanilla vs code-context</HeroText>
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 pt-5 pb-2">
          <LatestRunTable />
        </div>
        {/* #160: everything else stays one click away, collapsed by default. */}
        <details data-testid="bench-details" className={cx(PANEL, 'mx-5 mt-3 mb-5 p-0')}>
          <summary className="cursor-pointer px-4 py-3 text-12 font-semibold text-accent">
            Show details{' '}
            <span className="font-normal text-fg-3">
              — all {runCount} runs, filter, per-run numbers, simulated benchmark
            </span>
          </summary>
          <SubTabBar tabs={BENCHMARK_TABS} />
          <AnimatePresence mode="wait">
            <motion.div
              key={simulated ? 'simulated' : 'overview'}
              variants={tabVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={tabTransition}
              className="flex flex-col"
            >
              <div className="px-5 pt-3 pb-0 text-12 text-fg-3">
                {simulated ? (
                  <>
                    Simulated MCP vs Vanilla (2026-06) — <AnimatedNumber value={taskCount} /> tasks
                  </>
                ) : (
                  <>
                    Real agent runs — <AnimatedNumber value={runCount} /> runs, vanilla vs
                    code-context
                  </>
                )}
              </div>
              {simulated ? <SimulatedView /> : <LiveRunsView />}
            </motion.div>
          </AnimatePresence>
        </details>
      </div>
    </div>
  );
}
