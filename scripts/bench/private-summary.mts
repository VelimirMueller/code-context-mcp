/**
 * Redacted summary of a private suite (CCA-19, #154).
 *
 *   npm run bench:publish -- --private-summary <suite-dir> [--runs id,id] [--dry-run]
 *
 * A private suite's runs never leave the machine (bench:publish refuses them).
 * This module builds the one thing that may: a `ccc-bench-private-summary/1`
 * JSON with numbers only, under the suite's public `alias`.
 *
 * Two independent layers:
 *   1. Allowlist. The summary is built field by field from numbers the module
 *      recomputes from the sessions (never copied from the run's aggregate),
 *      plus a few strings that must match strict patterns: alias, group
 *      labels, model id, run kind, dates, code-context version. Anything else
 *      in a run file is never read into the output. summaryShapeProblems()
 *      re-checks the exact key set and every string pattern.
 *   2. Guard. Before anything is written, every key and string of the
 *      serialized summary is scanned against a denylist built from the suite
 *      (suite id and description, source names, repo paths, subdirs, commits,
 *      task ids unless the suite marks them public, prompts and the code-like
 *      tokens in them, answer items and patterns) and from the runs (hashes,
 *      session ids, event paths, notes, commits), plus generic detectors:
 *      local absolute paths and secrets (src/scrum/github-sync.ts), any other
 *      absolute path, and hex runs of 7+ chars (commits, hashes). One hit
 *      refuses the summary; the error names the JSON path and the kind of hit,
 *      never the value.
 *
 * Task ids never appear in a summary: groups carry a task count, not ids.
 *
 * Verdict (CCA-20): every run and group carries `verdict` (lib/verdict.mts):
 * a code and ASD-STE100 sentences built from fixed templates and the block's
 * own numbers. The shape check recomputes it from those numbers and refuses
 * any other text, so a verdict can never carry a suite-derived word; the
 * guard scans it like every other string.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findSecret, hasLocalPath } from '../../src/scrum/github-sync.js';
import {
  armEfficiency,
  costOf,
  repeatSpread,
  round1,
  savedPct,
  savedPctOrNull,
  uncachedOf,
} from './lib/metrics.mts';
import type { SessionResult } from './lib/types.mts';
import { computeVerdict, verdictInputFromBlock, type RunVerdict } from './lib/verdict.mts';
import {
  GROUP_RE,
  PUBLIC_LABEL_RE,
  SUITE_SCHEMA,
  suiteProblems,
  type SuiteFile,
} from './live/suite.mts';

export const PRIVATE_SUMMARY_SCHEMA = 'ccc-bench-private-summary/1';
export const PRIVATE_INDEX_SCHEMA = 'ccc-bench-private-index/1';

/** Mirrors scripts/bench/lib/index-builder.mts RUN_ID_PATTERN. */
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/;
/** A plain model id: "claude-opus-4-1", "zai-coding-plan/glm-5.3", "deepseek-v4-pro". */
export const MODEL_RE =
  /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}){0,2}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PROVIDER_KINDS = ['agent-opus', 'agent-glm', 'agent-deepseek'] as const;
type ProviderKind = (typeof PROVIDER_KINDS)[number];
const ARM_KEYS = ['vanilla', 'cc', 'cc_guided'] as const;
type ArmKey = (typeof ARM_KEYS)[number];

/** A refusal of the summary builder or its guard (message never holds a private value). */
export class SummaryRefused extends Error {}

export interface SummaryArm {
  sessions: number;
  success_pct: number;
  /** input + output + cache_write, mean per session. */
  uncached_per_session: number;
  /** Uncached tokens of all sessions / passing sessions; null when none passed. */
  uncached_per_pass: number | null;
  /** Total USD over the sessions; null when any cost is unknown. */
  cost_usd: number | null;
  cost_per_pass: number | null;
  wall_mean_ms: number;
}

export interface SummarySaved {
  uncached_saved_pct: number;
  uncached_saved_spread: { min: number; max: number; repeats: number } | null;
  cost_saved_pct: number | null;
}

export interface SummaryBlock {
  arms: { vanilla: SummaryArm; cc: SummaryArm; cc_guided?: SummaryArm };
  saved: { cc: SummarySaved; cc_guided?: SummarySaved };
}

export interface SummaryGroup extends SummaryBlock {
  group: string;
  tasks: number;
  /** Same rule as the run verdict, on this group's tasks (CCA-20). */
  verdict: RunVerdict;
}

export interface SummaryRun extends SummaryBlock {
  model: string;
  provider_kind: ProviderKind;
  date: string;
  /** Repeats per task and arm. */
  repeats: number;
  /** Rule-based verdict with ASD-STE100 sentences (CCA-20). */
  verdict: RunVerdict;
  groups: SummaryGroup[];
}

export interface PrivateSummary {
  schema: typeof PRIVATE_SUMMARY_SCHEMA;
  alias: string;
  generated: string;
  code_context_version: string | null;
  scope: {
    sources: number;
    files: number | null;
    total_mb: number | null;
    tasks: number;
    tasks_per_group: Record<string, number>;
  };
  runs: SummaryRun[];
}

export interface PrivateIndex {
  schema: typeof PRIVATE_INDEX_SCHEMA;
  summaries: Array<{ slug: string; alias: string; generated: string; file: string }>;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** The public file name of an alias: "Real-world suite A" → "real-world-suite-a". */
export function aliasSlug(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new SummaryRefused(`${what} is missing or not valid JSON (${(e as Error).name})`);
  }
}

/** A session reduced to the fields the metrics read; every number coerced. */
function cleanSession(x: unknown): SessionResult | null {
  if (!isObj(x) || typeof x.task_id !== 'string') return null;
  const t = isObj(x.tokens) ? x.tokens : {};
  return {
    task_id: x.task_id,
    success: x.success === true,
    timeout: x.timeout === true,
    tokens: {
      input: num(t.input),
      output: num(t.output),
      cache_read: num(t.cache_read),
      cache_write: num(t.cache_write),
    },
    cost_usd: typeof x.cost_usd === 'number' && Number.isFinite(x.cost_usd) ? x.cost_usd : null,
    tool_calls: num(x.tool_calls),
    mcp_tool_calls: num(x.mcp_tool_calls),
    wall_ms: num(x.wall_ms),
    session_id: '',
    // Only the -rN repeat suffix is ever read from it (metrics.repeatOf).
    events_path: (/-r\d+\.jsonl$/.exec(str(x.events_path)) ?? [''])[0],
  };
}

function armResults(run: Record<string, unknown>, arm: ArmKey): SessionResult[] | null {
  const arms = isObj(run.arms) ? run.arms : {};
  const a = arms[arm];
  if (!isObj(a) || !Array.isArray(a.results)) return null;
  return a.results.map(cleanSession).filter((r): r is SessionResult => r !== null);
}

const r4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e4) / 1e4);

function armSummary(results: SessionResult[]): SummaryArm {
  const e = armEfficiency(results);
  const n = results.length;
  return {
    sessions: n,
    success_pct: n > 0 ? round1((e.passes / n) * 100) : 0,
    uncached_per_session: n > 0 ? Math.round(e.uncached_tokens / n) : 0,
    uncached_per_pass: e.uncached_per_pass,
    cost_usd: r4(costOf(results)),
    cost_per_pass: r4(e.cost_per_pass),
    wall_mean_ms: n > 0 ? Math.round(results.reduce((s, r) => s + r.wall_ms, 0) / n) : 0,
  };
}

function savedOf(taskIds: string[], v: SessionResult[], a: SessionResult[]): SummarySaved {
  const uv = v.reduce((s, r) => s + uncachedOf(r), 0);
  const ua = a.reduce((s, r) => s + uncachedOf(r), 0);
  const sp = repeatSpread(taskIds, v, a);
  return {
    uncached_saved_pct: savedPct(uv, ua),
    uncached_saved_spread: sp ? { min: sp.min, max: sp.max, repeats: sp.repeats } : null,
    cost_saved_pct: savedPctOrNull(costOf(v), costOf(a)),
  };
}

function blockOf(arms: Partial<Record<ArmKey, SessionResult[]>>, taskIds: string[]): SummaryBlock {
  const ids = new Set(taskIds);
  const pick = (k: ArmKey) => (arms[k] ?? []).filter((r) => ids.has(r.task_id));
  const v = pick('vanilla');
  const c = pick('cc');
  const out: SummaryBlock = {
    arms: { vanilla: armSummary(v), cc: armSummary(c) },
    saved: { cc: savedOf(taskIds, v, c) },
  };
  if (arms.cc_guided) {
    const g = pick('cc_guided');
    out.arms.cc_guided = armSummary(g);
    out.saved.cc_guided = savedOf(taskIds, v, g);
  }
  return out;
}

/** The CCA-20 verdict of one block (vanilla and cc are always present). */
function blockVerdict(block: SummaryBlock, repeats: number): RunVerdict {
  const input = verdictInputFromBlock(block, repeats);
  const v = input ? computeVerdict(input) : null;
  if (!v) throw new SummaryRefused('summary block has no arm to judge');
  return v;
}

/** Group id of a task: its `group`, else its first letter (groupByPrefix), else "all". */
function groupIdOf(suite: SuiteFile, taskId: string): string {
  const t = suite.tasks.find((x) => x.id === taskId);
  if (t?.group) return t.group;
  if (suite.groupByPrefix) return /^[A-Za-z]/.exec(taskId)?.[0] ?? 'all';
  return 'all';
}

/** Public label of a group: groups[id], else the id itself. */
function groupLabel(suite: SuiteFile, id: string): string {
  return suite.groups?.[id] ?? id;
}

/** Files and MB of every source at its pinned commit (git ls-tree, local only); null when unreadable. */
function scopeOfSources(suite: SuiteFile): { files: number | null; total_mb: number | null } {
  let files = 0;
  let bytes = 0;
  try {
    for (const s of suite.sources) {
      const treeish = s.subdir ? `${s.commit}:${s.subdir}` : s.commit;
      const out = execFileSync('git', ['-C', s.repo, 'ls-tree', '-r', '-l', treeish], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 256 * 1024 * 1024,
      });
      for (const line of out.split('\n')) {
        const m = /^\d+ blob [0-9a-f]+ +(\d+)\t/.exec(line);
        if (!m) continue;
        files++;
        bytes += Number(m[1]);
      }
    }
  } catch {
    return { files: null, total_mb: null };
  }
  return { files, total_mb: round1(bytes / (1024 * 1024)) };
}

// ─── denylist + guard ─────────────────────────────────────────────────────────

/** Code-like tokens of a prompt: paths, dotted names, snake/camel identifiers. */
function codeTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_./\\:@$-]+/)) {
    const t = raw.replace(/^[.:/-]+|[.:/-]+$/g, '');
    if (t.length < 4) continue;
    if (/[/._\\$]/.test(t) || /[a-z][A-Z]/.test(t) || /[A-Za-z]\d|\d[A-Za-z]/.test(t)) out.push(t);
  }
  return out;
}

/** Path segments too common to be private (they would refuse every summary). */
const GENERIC_SEGMENTS = new Set([
  'data',
  'runs',
  'events',
  'bench',
  'private',
  'public',
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'test',
  'tests',
  'index',
  'main',
  'docs',
  'packages',
  'workspace',
  'tmp',
  'temp',
]);

/**
 * Every private string of a suite and its runs that must never appear in a
 * summary. Lower-cased; entries shorter than 2 chars are dropped (a single
 * letter cannot be matched without refusing every summary), and so are bare
 * numbers.
 */
export function buildDenylist(suite: SuiteFile, answers: unknown, runs: unknown[]): string[] {
  const d = new Set<string>();
  const add = (x: unknown): void => {
    if (typeof x !== 'string') return;
    const v = x.trim().toLowerCase();
    // Bare numbers are not private and would match every count in the summary.
    if (v.length >= 2 && !/^[\d.,]+$/.test(v)) d.add(v);
  };
  // A path: the whole path and its last segment (a repo folder, a file name),
  // unless that segment is a generic word every project has.
  const addPath = (p: unknown): void => {
    if (typeof p !== 'string') return;
    add(p);
    const base = p
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop();
    if (base && base.length >= 4 && !GENERIC_SEGMENTS.has(base.toLowerCase())) add(base);
  };
  const addCommit = (c: unknown): void => {
    if (typeof c !== 'string') return;
    add(c);
    if (c.length > 7) add(c.slice(0, 7));
  };
  add(suite.id);
  add(suite.description);
  for (const s of suite.sources) {
    add(s.name);
    addPath(s.repo);
    if (s.subdir) addPath(s.subdir);
    addCommit(s.commit);
  }
  for (const t of suite.tasks) {
    if (!suite.publicTaskIds) add(t.id);
    add(t.prompt);
    codeTokens(t.prompt).forEach(add);
    const c = t.checker as unknown as Record<string, unknown>;
    if (Array.isArray(c.answerMustMatch)) c.answerMustMatch.forEach(add);
    add(c.answer);
    if (Array.isArray(c.ignore)) c.ignore.forEach(addPath);
  }
  if (isObj(answers) && isObj(answers.answers)) {
    for (const [k, a] of Object.entries(answers.answers)) {
      add(k);
      if (!isObj(a)) continue;
      for (const list of [a.items, a.universe]) if (Array.isArray(list)) list.forEach(addPath);
    }
  }
  for (const run of runs) {
    if (!isObj(run)) continue;
    if (isObj(run.git)) addCommit(run.git.commit);
    add(run.fixture);
    if (Array.isArray(run.notes)) run.notes.forEach(add);
    if (isObj(run.suite)) {
      add(run.suite.id);
      if (Array.isArray(run.suite.sources))
        for (const s of run.suite.sources) {
          if (!isObj(s)) continue;
          add(s.name);
          add(s.name_sha256);
          addCommit(s.commit);
          if (typeof s.subdir === 'string') addPath(s.subdir);
        }
    }
    if (Array.isArray(run.tasks))
      for (const t of run.tasks) {
        if (!isObj(t)) continue;
        if (!suite.publicTaskIds) add(t.id);
        add(t.prompt);
        if (typeof t.prompt === 'string') codeTokens(t.prompt).forEach(add);
        add(t.prompt_sha256);
        add(t.fixture);
        if (isObj(t.checker)) add(t.checker.answer_sha256);
      }
    if (isObj(run.arms))
      for (const a of Object.values(run.arms)) {
        if (!isObj(a) || !Array.isArray(a.results)) continue;
        for (const r of a.results) {
          if (!isObj(r)) continue;
          add(r.session_id);
          addPath(r.events_path);
          if (!suite.publicTaskIds) add(r.task_id);
        }
      }
  }
  // The public alias and group labels are checked by the guard, never exempted.
  return [...d];
}

const isAlnum = (c: string | undefined): boolean => !!c && /[a-z0-9]/.test(c);

/** `tok` occurs in `hay` (both lower-case) with no letter or digit glued to either end. */
function hasToken(hay: string, tok: string): boolean {
  for (let i = hay.indexOf(tok); i >= 0; i = hay.indexOf(tok, i + 1)) {
    const glued =
      (isAlnum(tok[0]) && isAlnum(hay[i - 1])) ||
      (isAlnum(tok[tok.length - 1]) && isAlnum(hay[i + tok.length]));
    if (!glued) return true;
  }
  return false;
}

const ABS_PATH_RE =
  /(?:^|[^A-Za-z0-9._-])(?:\/[A-Za-z0-9._@~-]+){2,}|~[\\/]|\b[A-Za-z]:[\\/]|\bfile:/;
const HEX_RE = /(?<![0-9a-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,}(?![0-9a-z])/i;

/** Every hit of one string as a kind (never the value). */
export function stringHits(s: string, deny: readonly string[]): string[] {
  const hits: string[] = [];
  const low = s.toLowerCase();
  if (deny.some((t) => hasToken(low, t))) hits.push('private suite value');
  if (hasLocalPath(s) || ABS_PATH_RE.test(s)) hits.push('absolute path');
  const secret = findSecret(s);
  if (secret) hits.push(`secret (${secret})`);
  if (HEX_RE.test(s)) hits.push('hex id (commit or hash)');
  return hits;
}

/** Every `path: kind` hit in the keys and strings of `value`. */
export function guardHits(value: unknown, deny: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string') {
      for (const h of stringHits(v, deny)) out.push(`${at}: ${h}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        for (const h of stringHits(k, deny)) out.push(`${at} (key): ${h}`);
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(value, '$');
  return out;
}

/**
 * Refuse unless `text` (the exact bytes to write) is clean: parsed, every
 * key and string scanned, and the whole text scanned for denylist tokens.
 */
export function assertSummaryText(text: string, deny: readonly string[], what: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SummaryRefused(`${what}: not valid JSON`);
  }
  const hits = guardHits(parsed, deny);
  const low = text.toLowerCase();
  if (hits.length === 0 && deny.some((t) => hasToken(low, t)))
    hits.push('$ (text): private suite value');
  if (hits.length) {
    throw new SummaryRefused(
      `${what}: refusing — ${hits.length} guard hit(s):\n  - ${hits.slice(0, 20).join('\n  - ')}`,
    );
  }
}

// ─── shape (allowlist) check ──────────────────────────────────────────────────

const ARM_FIELDS = [
  'sessions',
  'success_pct',
  'uncached_per_session',
  'uncached_per_pass',
  'cost_usd',
  'cost_per_pass',
  'wall_mean_ms',
];
const SAVED_FIELDS = ['uncached_saved_pct', 'uncached_saved_spread', 'cost_saved_pct'];
export const SUMMARY_KEYS = {
  top: ['schema', 'alias', 'generated', 'code_context_version', 'scope', 'runs'],
  scope: ['sources', 'files', 'total_mb', 'tasks', 'tasks_per_group'],
  run: ['model', 'provider_kind', 'date', 'repeats', 'arms', 'saved', 'verdict', 'groups'],
  group: ['group', 'tasks', 'arms', 'saved', 'verdict'],
  arm: ARM_FIELDS,
  saved: SAVED_FIELDS,
  spread: ['min', 'max', 'repeats'],
} as const;

/** JSON with sorted keys: equal values give equal text. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}

/** Every deviation of `x` from the summary allowlist (exact keys, types, string patterns). */
export function summaryShapeProblems(x: unknown): string[] {
  const p: string[] = [];
  const keys = (
    o: unknown,
    want: readonly string[],
    at: string,
    optional: string[] = [],
  ): boolean => {
    if (!isObj(o)) {
      p.push(`${at}: must be an object`);
      return false;
    }
    for (const k of Object.keys(o))
      if (!want.includes(k)) p.push(`${at}.${k}: not in the allowlist`);
    for (const k of want) if (!(k in o) && !optional.includes(k)) p.push(`${at}.${k}: missing`);
    return true;
  };
  const isN = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const nOrNull = (v: unknown, at: string) => {
    if (v !== null && !isN(v)) p.push(`${at}: must be a number or null`);
  };
  const n = (v: unknown, at: string) => {
    if (!isN(v)) p.push(`${at}: must be a number`);
  };
  const block = (b: Record<string, unknown>, at: string) => {
    if (keys(b.arms, ARM_KEYS, `${at}.arms`, ['cc_guided'])) {
      for (const [k, a] of Object.entries(b.arms as Record<string, unknown>)) {
        if (!keys(a, ARM_FIELDS, `${at}.arms.${k}`)) continue;
        const arm = a as Record<string, unknown>;
        for (const f of ARM_FIELDS) {
          if (['uncached_per_pass', 'cost_usd', 'cost_per_pass'].includes(f))
            nOrNull(arm[f], `${at}.arms.${k}.${f}`);
          else n(arm[f], `${at}.arms.${k}.${f}`);
        }
      }
    }
    if (keys(b.saved, ['cc', 'cc_guided'], `${at}.saved`, ['cc_guided'])) {
      for (const [k, s] of Object.entries(b.saved as Record<string, unknown>)) {
        if (!keys(s, SAVED_FIELDS, `${at}.saved.${k}`)) continue;
        const sv = s as Record<string, unknown>;
        n(sv.uncached_saved_pct, `${at}.saved.${k}.uncached_saved_pct`);
        nOrNull(sv.cost_saved_pct, `${at}.saved.${k}.cost_saved_pct`);
        if (sv.uncached_saved_spread !== null) {
          if (
            keys(
              sv.uncached_saved_spread,
              SUMMARY_KEYS.spread,
              `${at}.saved.${k}.uncached_saved_spread`,
            )
          ) {
            for (const f of SUMMARY_KEYS.spread)
              n(
                (sv.uncached_saved_spread as Record<string, unknown>)[f],
                `${at}.saved.${k}.uncached_saved_spread.${f}`,
              );
          }
        }
      }
    }
  };
  // The verdict must be exactly what the rule makes of the block's own numbers:
  // fixed template text and digits, nothing copied from anywhere else.
  const verdict = (b: Record<string, unknown>, repeats: unknown, at: string) => {
    const input = typeof repeats === 'number' ? verdictInputFromBlock(b, repeats) : null;
    const want = input ? computeVerdict(input) : null;
    if (!want || canonical(b.verdict) !== canonical(want))
      p.push(`${at}.verdict: must be the rule's verdict for this block`);
  };
  if (!keys(x, SUMMARY_KEYS.top, '$')) return p;
  const s = x as Record<string, unknown>;
  if (s.schema !== PRIVATE_SUMMARY_SCHEMA) p.push(`$.schema: must be ${PRIVATE_SUMMARY_SCHEMA}`);
  if (typeof s.alias !== 'string' || !PUBLIC_LABEL_RE.test(s.alias))
    p.push('$.alias: must be a public label');
  if (typeof s.generated !== 'string' || !DATE_RE.test(s.generated))
    p.push('$.generated: must be YYYY-MM-DD');
  if (
    s.code_context_version !== null &&
    (typeof s.code_context_version !== 'string' || !VERSION_RE.test(s.code_context_version))
  )
    p.push('$.code_context_version: must be a semver or null');
  if (keys(s.scope, SUMMARY_KEYS.scope, '$.scope')) {
    const sc = s.scope as Record<string, unknown>;
    n(sc.sources, '$.scope.sources');
    n(sc.tasks, '$.scope.tasks');
    nOrNull(sc.files, '$.scope.files');
    nOrNull(sc.total_mb, '$.scope.total_mb');
    if (!isObj(sc.tasks_per_group)) p.push('$.scope.tasks_per_group: must be an object');
    else
      for (const [k, v] of Object.entries(sc.tasks_per_group)) {
        if (!PUBLIC_LABEL_RE.test(k))
          p.push('$.scope.tasks_per_group: a key is not a public label');
        n(v, `$.scope.tasks_per_group[${JSON.stringify(k)}]`);
      }
  }
  if (!Array.isArray(s.runs)) p.push('$.runs: must be an array');
  else
    s.runs.forEach((r, i) => {
      const at = `$.runs[${i}]`;
      if (!keys(r, SUMMARY_KEYS.run, at)) return;
      const run = r as Record<string, unknown>;
      if (typeof run.model !== 'string' || !MODEL_RE.test(run.model))
        p.push(`${at}.model: must be a plain model id`);
      if (!PROVIDER_KINDS.includes(run.provider_kind as ProviderKind))
        p.push(`${at}.provider_kind: unknown`);
      if (typeof run.date !== 'string' || !DATE_RE.test(run.date))
        p.push(`${at}.date: must be YYYY-MM-DD`);
      n(run.repeats, `${at}.repeats`);
      block(run, at);
      verdict(run, run.repeats, at);
      if (!Array.isArray(run.groups)) p.push(`${at}.groups: must be an array`);
      else
        run.groups.forEach((g, j) => {
          const gat = `${at}.groups[${j}]`;
          if (!keys(g, SUMMARY_KEYS.group, gat)) return;
          const grp = g as Record<string, unknown>;
          if (typeof grp.group !== 'string' || !PUBLIC_LABEL_RE.test(grp.group))
            p.push(`${gat}.group: must be a public label`);
          n(grp.tasks, `${gat}.tasks`);
          block(grp, gat);
          verdict(grp, run.repeats, gat);
        });
    });
  return p;
}

// ─── builder ──────────────────────────────────────────────────────────────────

export interface BuildOptions {
  suiteDir: string;
  /** Only these run ids (from <suite>/data/runs); default: every run of the suite. */
  runIds?: string[];
  /** For tests: the generated date. */
  now?: Date;
  /** For tests: skip git ls-tree for files / MB (null in the summary). */
  skipScope?: boolean;
}

export interface BuiltSummary {
  summary: PrivateSummary;
  slug: string;
  /** The exact bytes to write (guarded). */
  text: string;
  /** For the second guard pass at write time. */
  denylist: string[];
}

function runOf(raw: unknown, suiteId: string, file: string): Record<string, unknown> {
  const name = path.basename(file);
  if (!isObj(raw) || raw.schema !== 'ccc-bench/1')
    throw new SummaryRefused(`run file ${name}: not a ccc-bench/1 run`);
  if (typeof raw.run_id !== 'string' || !RUN_ID_RE.test(raw.run_id))
    throw new SummaryRefused(`run file ${name}: invalid run_id`);
  if (!isObj(raw.suite) || raw.suite.id !== suiteId)
    throw new SummaryRefused(`run ${raw.run_id}: not a run of this suite`);
  return raw;
}

/** Load the suite's runs from <suiteDir>/data/runs (all of the suite, or `ids`). */
function loadRuns(
  suiteDir: string,
  suiteId: string,
  ids?: string[],
): Array<Record<string, unknown>> {
  const dir = path.join(suiteDir, 'data', 'runs');
  if (ids) {
    for (const id of ids)
      if (!RUN_ID_RE.test(id)) throw new SummaryRefused(`--runs: invalid run id "${id}"`);
    return ids.map((id) => {
      const file = path.join(dir, `${id}.json`);
      if (!fs.existsSync(file))
        throw new SummaryRefused(`--runs: run ${id} not found in the suite's data/runs`);
      return runOf(readJson(file, `run ${id}`), suiteId, file);
    });
  }
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(dir, f), `run file ${f}`))
    .filter((r) => isObj(r) && isObj(r.suite) && r.suite.id === suiteId)
    .map((r) =>
      runOf(r, suiteId, path.join(dir, `${String((r as Record<string, unknown>).run_id)}.json`)),
    );
}

function summaryRun(suite: SuiteFile, run: Record<string, unknown>): SummaryRun {
  const id = String(run.run_id);
  const kind = run.kind;
  if (!PROVIDER_KINDS.includes(kind as ProviderKind))
    throw new SummaryRefused(`run ${id}: kind is not an agent kind`);
  const model = run.model;
  if (typeof model !== 'string' || !MODEL_RE.test(model))
    throw new SummaryRefused(`run ${id}: model is not a plain model id`);
  const date =
    typeof run.date === 'string' && DATE_RE.test(run.date) ? run.date : str(run.ts).slice(0, 10);
  if (!DATE_RE.test(date)) throw new SummaryRefused(`run ${id}: no valid date`);
  const arms: Partial<Record<ArmKey, SessionResult[]>> = {};
  for (const k of ARM_KEYS) {
    const r = armResults(run, k);
    if (r) arms[k] = r;
  }
  if (!arms.vanilla || !arms.cc)
    throw new SummaryRefused(`run ${id}: needs the vanilla and cc arms`);
  const taskIds = [...new Set(arms.vanilla.map((r) => r.task_id))];
  const perTask = new Map<string, number>();
  for (const r of arms.vanilla) perTask.set(r.task_id, (perTask.get(r.task_id) ?? 0) + 1);
  const repeats = Math.max(0, ...perTask.values());

  const byGroup = new Map<string, string[]>();
  for (const t of taskIds) {
    const label = groupLabel(suite, groupIdOf(suite, t));
    byGroup.set(label, [...(byGroup.get(label) ?? []), t]);
  }
  const groups: SummaryGroup[] = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, ids]) => {
      const b = blockOf(arms, ids);
      return { group: label, tasks: ids.length, ...b, verdict: blockVerdict(b, repeats) };
    });
  const block = blockOf(arms, taskIds);
  return {
    model,
    provider_kind: kind as ProviderKind,
    date,
    repeats,
    ...block,
    verdict: blockVerdict(block, repeats),
    groups,
  };
}

/**
 * Build, shape-check and guard the redacted summary of the suite at
 * `opts.suiteDir`. Throws SummaryRefused on any problem; never writes.
 */
export function buildPrivateSummary(opts: BuildOptions): BuiltSummary {
  const dir = path.resolve(opts.suiteDir);
  const raw = readJson(path.join(dir, 'suite.json'), 'suite.json');
  const problems = suiteProblems(raw);
  if (problems.length)
    throw new SummaryRefused(
      `suite.json is invalid (${problems.length} problem(s); run npm run bench:suite-check)`,
    );
  const suite = raw as SuiteFile;
  if (suite.schema !== SUITE_SCHEMA) throw new SummaryRefused('suite.json: wrong schema');
  if (!suite.alias)
    throw new SummaryRefused(
      'suite.json has no "alias": a summary is published under the alias only',
    );
  const slug = aliasSlug(suite.alias);
  if (!SLUG_RE.test(slug)) throw new SummaryRefused('suite alias gives no usable file name');
  const answersFile = path.join(dir, 'answers.json');
  const answers = fs.existsSync(answersFile) ? readJson(answersFile, 'answers.json') : null;

  const runs = loadRuns(dir, suite.id, opts.runIds);
  if (runs.length === 0) throw new SummaryRefused('no runs of this suite in its data/runs');
  const deny = buildDenylist(suite, answers, runs);

  const sorted = [...runs].sort((a, b) => str(a.ts).localeCompare(str(b.ts)));
  const newestVersion = str(sorted[sorted.length - 1].code_context_version);
  const tasksPerGroup: Record<string, number> = {};
  for (const t of suite.tasks) {
    const label = groupLabel(suite, groupIdOf(suite, t.id));
    tasksPerGroup[label] = (tasksPerGroup[label] ?? 0) + 1;
  }
  const scope = opts.skipScope ? { files: null, total_mb: null } : scopeOfSources(suite);
  const summary: PrivateSummary = {
    schema: PRIVATE_SUMMARY_SCHEMA,
    alias: suite.alias,
    generated: (opts.now ?? new Date()).toISOString().slice(0, 10),
    code_context_version: VERSION_RE.test(newestVersion) ? newestVersion : null,
    scope: {
      sources: suite.sources.length,
      files: scope.files,
      total_mb: scope.total_mb,
      tasks: suite.tasks.length,
      tasks_per_group: tasksPerGroup,
    },
    runs: sorted.map((r) => summaryRun(suite, r)),
  };
  for (const label of Object.keys(tasksPerGroup)) {
    if (!PUBLIC_LABEL_RE.test(label) && !GROUP_RE.test(label))
      throw new SummaryRefused('a group label is not a public label');
  }
  const shape = summaryShapeProblems(summary);
  if (shape.length)
    throw new SummaryRefused(`summary fails the allowlist:\n  - ${shape.join('\n  - ')}`);
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  assertSummaryText(text, deny, 'private summary');
  return { summary, slug, text, denylist: deny };
}

/** The data/private/index.json after adding (or replacing) one summary. */
export function mergePrivateIndex(
  existing: unknown,
  entry: PrivateIndex['summaries'][number],
): PrivateIndex {
  const prev = isObj(existing) && Array.isArray(existing.summaries) ? existing.summaries : [];
  const kept = prev.filter(
    (e): e is PrivateIndex['summaries'][number] =>
      isObj(e) &&
      typeof e.slug === 'string' &&
      SLUG_RE.test(e.slug) &&
      e.slug !== entry.slug &&
      typeof e.alias === 'string' &&
      PUBLIC_LABEL_RE.test(e.alias) &&
      typeof e.generated === 'string' &&
      DATE_RE.test(e.generated) &&
      e.file === `private/${e.slug}.json`,
  );
  const summaries = [...kept, entry].sort((a, b) => a.alias.localeCompare(b.alias));
  return { schema: PRIVATE_INDEX_SCHEMA, summaries };
}
