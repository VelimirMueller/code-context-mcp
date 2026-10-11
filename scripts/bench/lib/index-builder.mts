/**
 * Build data/index.json and data/latest.json from a merged set of run files.
 *
 * Legacy runs (schema `overdrive-bench/2`, or `prereg`+`nv` fallback) map to
 * kind `agent-claude` and are read-only; they never change. `ts` falls back to
 * `date` for legacy files that lack a full timestamp.
 *
 * Ordering (owner decision): the newest run wins across ALL kinds — legacy
 * included. Runs compare by timestamp first (`ts`, falling back to `date`),
 * parsed as UTC milliseconds so date-only legacy stamps and timezone-offset
 * stamps compare correctly; a missing or unparseable stamp counts as the
 * oldest. Equal timestamps break the tie deterministically on `run_id`
 * (descending). `buildIndex` and `pickLatest` share one comparator, so the
 * index order and latest.json can never disagree.
 */
import { honestMetrics } from './metrics.mts';
import type { IndexEntry, IndexJson, IndexKind, NewRunKind, SessionResult } from './types.mts';

function asRecord(x: unknown): Record<string, unknown> {
  return (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
}

export function legacyKindOf(run: unknown): boolean {
  if (!run || typeof run !== 'object') return false;
  const r = run as Record<string, unknown>;
  if (r.schema === 'overdrive-bench/2') return true;
  return r.prereg !== undefined && r.nv !== undefined;
}

const NEW_RUN_KINDS: ReadonlySet<string> = new Set<NewRunKind>([
  'simulated',
  'agent-glm',
  'agent-deepseek',
  'agent-opus',
]);

/**
 * Run-id charset (security audit 2026-10-10): run ids become filenames
 * (`<run_id>.json`) and commit-message tokens during publish, so they must
 * be inert — lowercase alphanumerics and dashes, 1–81 chars, starting with
 * a letter or digit. Everything else (`../x`, newlines, spaces, …) is
 * rejected before any file is written.
 */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Null when `x` is a publishable run file (string `run_id` matching
 * RUN_ID_PATTERN, and either a legacy run or a known `kind`); otherwise a
 * short reason. Lets the runners skip stray JSON in data/runs (editor temp
 * files, partial writes) instead of feeding them into the index builder.
 * Publish treats an invalid run_id as fatal (publish.mts).
 */
export function runFileProblem(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'not a JSON object';
  const r = x as Record<string, unknown>;
  if (typeof r.run_id !== 'string' || !r.run_id) return 'missing string run_id';
  if (!RUN_ID_PATTERN.test(r.run_id)) {
    return `invalid run_id ${JSON.stringify(r.run_id)} (must match ^[a-z0-9][a-z0-9-]{0,80}$)`;
  }
  if (legacyKindOf(x)) return null;
  if (typeof r.kind !== 'string' || !NEW_RUN_KINDS.has(r.kind)) {
    return `unknown kind ${JSON.stringify(r.kind)}`;
  }
  return null;
}

function legacyHeadline(run: Record<string, unknown>): unknown {
  const nv = asRecord(run.nv);
  if (typeof nv.mean !== 'number') return null;
  return {
    nv_mean: nv.mean,
    nv_lo: typeof nv.lo === 'number' ? nv.lo : null,
    nv_hi: typeof nv.hi === 'number' ? nv.hi : null,
    verdict: typeof run.verdict === 'string' ? run.verdict : null,
  };
}

function tsOf(run: Record<string, unknown>): string {
  if (typeof run.ts === 'string') return run.ts;
  if (typeof run.date === 'string') return run.date;
  return '';
}

function idOf(run: Record<string, unknown>): string {
  return typeof run.run_id === 'string' ? run.run_id : '';
}

/** UTC milliseconds for a run stamp; missing/unparseable stamps are oldest. */
function tsMillis(run: Record<string, unknown>): number {
  const raw = tsOf(run);
  if (!raw) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Newest-first: parsed timestamp descending, then run_id descending. */
function compareRunsDesc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const ta = tsMillis(a);
  const tb = tsMillis(b);
  if (ta !== tb) return ta > tb ? -1 : 1;
  const ia = idOf(a);
  const ib = idOf(b);
  if (ia !== ib) return ia > ib ? -1 : 1;
  return 0;
}

const AGENT_KINDS: ReadonlySet<string> = new Set(['agent-glm', 'agent-deepseek', 'agent-opus']);

function resultsOf(arms: Record<string, unknown>, key: string): SessionResult[] | null {
  const arm = asRecord(arms[key]);
  return Array.isArray(arm.results) ? (arm.results as SessionResult[]) : null;
}

/**
 * Agent headline for the index (CCA-08). A run normalised since CCA-08
 * carries the honest fields (uncached saved %, cost saved %, uncached per
 * PASS) itself. An older run file gets them derived from its sessions here,
 * so the site and dashboard can show them without loading the run; the
 * recorded fields are never overwritten.
 */
function agentHeadline(r: Record<string, unknown>): unknown {
  const h = r.headline;
  if (!h || typeof h !== 'object') return h ?? null;
  if ('uncached_saved_pct' in h) return h;
  const arms = asRecord(r.arms);
  const vanilla = resultsOf(arms, 'vanilla');
  const cc = resultsOf(arms, 'cc');
  if (!vanilla || !cc) return h;
  const guided = resultsOf(arms, 'cc_guided') ?? [];
  const ids = Array.isArray(r.tasks)
    ? (r.tasks as unknown[]).map((t) => String(asRecord(t).id))
    : [];
  for (const s of [...vanilla, ...cc, ...guided]) if (!ids.includes(s.task_id)) ids.push(s.task_id);
  try {
    return { ...honestMetrics(ids, vanilla, cc, guided).headline, ...h };
  } catch {
    return h; // malformed sessions: keep the recorded headline as is
  }
}

function toEntry(run: unknown): IndexEntry {
  const r = asRecord(run);
  if (typeof r.run_id !== 'string') throw new Error('buildIndex: run missing run_id');
  const legacy = legacyKindOf(run);
  const kind: IndexKind = legacy ? 'agent-claude' : (r.kind as IndexKind);
  return {
    run_id: r.run_id,
    kind,
    date: typeof r.date === 'string' ? r.date : '',
    ts: tsOf(r),
    model: typeof r.model === 'string' ? r.model : null,
    trigger: typeof r.trigger === 'string' ? r.trigger : '',
    headline: legacy
      ? legacyHeadline(r)
      : AGENT_KINDS.has(kind)
        ? agentHeadline(r)
        : (r.headline ?? null),
  };
}

export function buildIndex(runs: unknown[]): IndexJson {
  const seen = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const run of runs) {
    const entry = toEntry(run);
    if (seen.has(entry.run_id)) {
      throw new Error(`buildIndex: duplicate run_id ${entry.run_id}`);
    }
    seen.add(entry.run_id);
    entries.push(entry);
  }
  entries.sort((a, b) =>
    compareRunsDesc(a as Record<string, unknown>, b as Record<string, unknown>),
  );
  return { schema: 'ccc-bench-index/1', runs: entries };
}

export function pickLatest(runs: unknown[]): object {
  if (runs.length === 0) throw new Error('pickLatest: no runs');
  const sorted = [...runs].sort((a, b) => compareRunsDesc(asRecord(a), asRecord(b)));
  return sorted[0] as object;
}
