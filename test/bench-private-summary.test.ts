/**
 * Redacted private-suite summary (CCA-19, #154): allowlist shape, the guard,
 * refusal paths, the publish path (only data/private/ is written) and the
 * plain-publish refusal of full private runs.
 *
 * Every suite here is synthetic, built in the test from a temp git repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPrivateSummary,
  guardHits,
  mergePrivateIndex,
  stringHits,
  summaryShapeProblems,
  aliasSlug,
  SummaryRefused,
  SUMMARY_KEYS,
  PRIVATE_SUMMARY_SCHEMA,
  PRIVATE_INDEX_SCHEMA,
} from '../scripts/bench/private-summary.mts';
import {
  ANSWERS_SCHEMA,
  SUITE_SCHEMA,
  sha256,
  suiteProblems,
} from '../scripts/bench/live/suite.mts';
import { publish, publishPrivateSummary } from '../scripts/bench/publish.mts';
import { computeVerdict, verdictInputFromBlock } from '../scripts/bench/lib/verdict.mts';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
} as NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
};
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

// Synthetic private values: each one must never reach a summary.
const SOURCE_NAME = 'zephyr-ledger';
const SOURCE_NAME_2 = 'quokka-portal';
const SUITE_ID = 'zq-internal';
const DESCRIPTION = 'Zephyr ledger and quokka portal internal suite';
const PROMPTS: Record<string, string> = {
  A1: 'Which files does QuasarInvoiceMapper read when zephyr totals are built?',
  A2: 'List the callers of quokka_portal_session_guard in the portal.',
  B1: 'Where is the shared NebulaRateTable defined across both repos?',
};
const ANSWER_ITEMS = [
  'zephyr-ledger/src/quasar/InvoiceMapper.php',
  'quokka-portal/app/guards/sessionGuard.ts',
];
const SYMBOLS = ['NebulaRateTable', 'nebulaRateTableFactory'];

interface Fixture {
  suiteDir: string;
  repo: string;
  commit: string;
  suite: Record<string, unknown>;
}

/** A private suite: one synthetic repo, two sources, three tasks in two groups. */
function makeSuite(over: Record<string, unknown> = {}): Fixture {
  const repo = tmp('ps-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'ledger/src/quasar/InvoiceMapper.php', '<?php class InvoiceMapper {}\n');
  write(repo, 'portal/app/guards/sessionGuard.ts', 'export const g = 1;\n');
  write(repo, 'portal/app/rates.ts', 'export class NebulaRateTable {}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'synthetic');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const suiteDir = tmp('ps-suite-');
  const suite = {
    schema: SUITE_SCHEMA,
    id: SUITE_ID,
    description: DESCRIPTION,
    private: true,
    alias: 'Real-world suite A',
    groups: { spa: 'Single-page app', x: 'cross-repo' },
    sources: [
      { name: SOURCE_NAME, repo, commit, subdir: 'ledger' },
      { name: SOURCE_NAME_2, repo, commit: commit.slice(0, 12), subdir: 'portal' },
    ],
    tasks: [
      {
        id: 'A1',
        size: 'S',
        group: 'spa',
        prompt: PROMPTS.A1,
        checker: { type: 'path-set', answer: 'a1', maxExtra: 1 },
      },
      {
        id: 'A2',
        size: 'M',
        group: 'spa',
        prompt: PROMPTS.A2,
        checker: { type: 'answer', answerMustMatch: ['sessionGuard\\.ts'] },
      },
      {
        id: 'B1',
        group: 'x',
        prompt: PROMPTS.B1,
        checker: { type: 'symbol-set', answer: 'b1', maxExtra: 0 },
      },
    ],
    ...over,
  };
  write(suiteDir, 'suite.json', JSON.stringify(suite, null, 2));
  write(
    suiteDir,
    'answers.json',
    JSON.stringify({
      schema: ANSWERS_SCHEMA,
      suite: SUITE_ID,
      answers: {
        a1: { kind: 'paths', items: [ANSWER_ITEMS[0]] },
        b1: { kind: 'symbols', items: [SYMBOLS[0]], universe: SYMBOLS },
      },
    }),
  );
  return { suiteDir, repo, commit, suite };
}

const ARMS = ['vanilla', 'cc', 'cc_guided'] as const;

/** A redacted run of the fixture suite, 2 repeats, with private values in its free-text fields. */
function makeRun(f: Fixture, runId = 'opus-20261012-092421', over: Record<string, unknown> = {}) {
  const tasks = ['A1', 'A2', 'B1'];
  const sess = (task: string, arm: string, rep: number) => ({
    task_id: task,
    success: !(arm === 'vanilla' && task === 'B1' && rep === 2),
    timeout: false,
    tokens: {
      input: arm === 'vanilla' ? 2000 + rep * 100 : 1200 + rep * 50,
      output: 300,
      cache_read: 9000,
      cache_write: arm === 'vanilla' ? 400 : 200,
    },
    first_call_cache_read: 0,
    cost_usd: arm === 'vanilla' ? 0.05 : 0.03,
    tool_calls: 6,
    mcp_tool_calls: arm === 'vanilla' ? 0 : 3,
    wall_ms: arm === 'vanilla' ? 30000 : 24000,
    session_id: `3f9c2a7e-${task}-${arm}-${rep}`,
    events_path: path.join(f.suiteDir, 'data', 'events', runId, `${task}-${arm}-r${rep}.jsonl`),
  });
  const results = (arm: string) => tasks.flatMap((t) => [1, 2].map((r) => sess(t, arm, r)));
  return {
    schema: 'ccc-bench/1',
    run_id: runId,
    kind: 'agent-opus',
    date: '2026-10-12',
    ts: '2026-10-12T09:24:21+0200',
    trigger: 'manual',
    duration_ms: 123456,
    code_context_version: '1.9.0',
    git: {
      commit: 'b'.repeat(8) + '1234567890abcdef1234567890abcdef',
      branch: 'feat/x',
      dirty: false,
    },
    notes: [
      `workspace built from ${f.repo}`,
      `task A1: ${PROMPTS.A1}`,
      `sources ${SOURCE_NAME}, ${SOURCE_NAME_2}`,
    ],
    model: 'claude-opus-4-1',
    agent_cli: { name: 'claude', version: '2.1.0' },
    fixture: `suite ${SUITE_ID}`,
    auth: { keyEnv: 'ANTHROPIC_API_KEY' },
    suite: {
      schema: SUITE_SCHEMA,
      id: SUITE_ID,
      private: true,
      redact: true,
      sources: [
        { name_sha256: sha256(SOURCE_NAME), commit: f.commit },
        { name_sha256: sha256(SOURCE_NAME_2), commit: f.commit },
      ],
    },
    tasks: tasks.map((id) => ({
      id,
      fixture: `suite ${SUITE_ID}`,
      prompt_sha256: sha256(PROMPTS[id]),
      checker: { type: 'path-set', maxExtra: 1, answer_sha256: sha256(ANSWER_ITEMS[0]) },
    })),
    arms: {
      vanilla: { results: results('vanilla') },
      cc: { results: results('cc'), index_ms: 4200, db_bytes: 1048576 },
      cc_guided: { results: results('cc_guided') },
    },
    aggregate: {
      per_task: tasks.map((t) => ({
        task_id: t,
        delta: { cc: { pairs: 2, saved_pct: 10, min: 5, max: 15 } },
      })),
    },
    headline: {
      success_vanilla_pct: 83.3,
      success_cc_pct: 100,
      tokens_saved_pct: 1,
      tool_calls_saved_pct: 0,
    },
    ...over,
  };
}

function writeRun(f: Fixture, run: Record<string, unknown>): void {
  write(f.suiteDir, `data/runs/${run.run_id}.json`, `${JSON.stringify(run, null, 2)}\n`);
}

const NOW = new Date('2026-10-12T12:00:00Z');
const build = (f: Fixture, runIds?: string[]) =>
  buildPrivateSummary({ suiteDir: f.suiteDir, runIds, now: NOW, skipScope: true });

/** Every private value of the fixture, lower-cased, that a summary must never contain. */
function privateValues(f: Fixture): string[] {
  return [
    SOURCE_NAME,
    SOURCE_NAME_2,
    SUITE_ID,
    DESCRIPTION,
    f.repo,
    f.suiteDir,
    f.commit,
    f.commit.slice(0, 7),
    ...Object.values(PROMPTS),
    'QuasarInvoiceMapper',
    'quokka_portal_session_guard',
    ...ANSWER_ITEMS,
    ...SYMBOLS,
    'sessionGuard\\.ts',
    sha256(SOURCE_NAME),
    sha256(PROMPTS.A1),
    'A1',
    'A2',
    'B1',
  ].map((v) => v.toLowerCase());
}

/** Paths of every string or number leaf of `x`. */
function leaves(x: unknown, at: Array<string | number> = []): Array<Array<string | number>> {
  if (typeof x === 'string' || typeof x === 'number') return [at];
  if (Array.isArray(x)) return x.flatMap((v, i) => leaves(v, [...at, i]));
  if (x && typeof x === 'object')
    return Object.entries(x).flatMap(([k, v]) => leaves(v, [...at, k]));
  return [];
}
function setAt(x: any, at: Array<string | number>, v: unknown): void {
  let cur = x;
  for (const k of at.slice(0, -1)) cur = cur[k];
  cur[at[at.length - 1]] = v;
}

describe('suite schema: alias, groups, group, groupByPrefix, publicTaskIds', () => {
  it('accepts the new optional fields and still validates as before', () => {
    const f = makeSuite({ groupByPrefix: true, publicTaskIds: false });
    expect(suiteProblems(f.suite)).toEqual([]);
  });

  it('refuses bad aliases, group ids, labels and flags', () => {
    const f = makeSuite();
    const bad = {
      ...f.suite,
      alias: '/Users/x/suite',
      groups: { 'bad id!': 'ok', spa: 'no/slash' },
      groupByPrefix: 'yes',
      publicTaskIds: 1,
      tasks: [{ ...(f.suite.tasks as any[])[0], group: 'has space' }],
    };
    const p = suiteProblems(bad).join('\n');
    expect(p).toMatch(/alias: must match/);
    expect(p).toMatch(/groups\.bad id!: group id/);
    expect(p).toMatch(/groups\.spa: label/);
    expect(p).toMatch(/groupByPrefix: must be true or false/);
    expect(p).toMatch(/publicTaskIds: must be true or false/);
    expect(p).toMatch(/tasks\[0\]\.group: must match/);
  });
});

describe('private summary: allowlist shape', () => {
  it('has exactly the allowlisted keys at every level', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const { summary, slug, text } = build(f);
    expect(slug).toBe('real-world-suite-a');
    expect(summaryShapeProblems(summary)).toEqual([]);
    expect(Object.keys(summary).sort()).toEqual([...SUMMARY_KEYS.top].sort());
    expect(Object.keys(summary.scope).sort()).toEqual([...SUMMARY_KEYS.scope].sort());
    expect(summary.schema).toBe(PRIVATE_SUMMARY_SCHEMA);
    const run = summary.runs[0];
    expect(Object.keys(run).sort()).toEqual([...SUMMARY_KEYS.run].sort());
    expect(Object.keys(run.arms)).toEqual(['vanilla', 'cc', 'cc_guided']);
    for (const a of Object.values(run.arms))
      expect(Object.keys(a!).sort()).toEqual([...SUMMARY_KEYS.arm].sort());
    for (const s of Object.values(run.saved))
      expect(Object.keys(s!).sort()).toEqual([...SUMMARY_KEYS.saved].sort());
    for (const g of run.groups)
      expect(Object.keys(g).sort()).toEqual([...SUMMARY_KEYS.group].sort());
    expect(JSON.parse(text)).toEqual(summary);
  });

  it('computes the numbers from the sessions and groups by public label', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const { summary } = build(f);
    expect(summary.alias).toBe('Real-world suite A');
    expect(summary.generated).toBe('2026-10-12');
    expect(summary.code_context_version).toBe('1.9.0');
    expect(summary.scope).toEqual({
      sources: 2,
      files: null,
      total_mb: null,
      tasks: 3,
      tasks_per_group: { 'Single-page app': 2, 'cross-repo': 1 },
    });
    const run = summary.runs[0];
    expect(run).toMatchObject({
      model: 'claude-opus-4-1',
      provider_kind: 'agent-opus',
      date: '2026-10-12',
      repeats: 2,
    });
    expect(run.arms.vanilla.sessions).toBe(6);
    expect(run.arms.vanilla.success_pct).toBe(83.3);
    expect(run.arms.cc.success_pct).toBe(100);
    // vanilla uncached per session: input (2100 / 2200) + 300 + 400.
    expect(run.arms.vanilla.uncached_per_session).toBe(2850);
    expect(run.arms.vanilla.uncached_per_pass).toBe(Math.round((2850 * 6) / 5));
    expect(run.arms.vanilla.cost_usd).toBe(0.3);
    expect(run.arms.cc.wall_mean_ms).toBe(24000);
    expect(run.saved.cc.uncached_saved_pct).toBeGreaterThan(0);
    expect(run.saved.cc.uncached_saved_spread).toMatchObject({ repeats: 2 });
    expect(run.saved.cc.cost_saved_pct).toBe(40);
    expect(run.groups.map((g) => [g.group, g.tasks])).toEqual([
      ['cross-repo', 1],
      ['Single-page app', 2],
    ]);
  });

  it('groups by first letter only when the suite opts in, else "all"', () => {
    const tasks = (makeSuite().suite.tasks as any[]).map(({ group: _g, ...t }) => t);
    const off = makeSuite({ tasks, groups: undefined });
    writeRun(off, makeRun(off));
    expect(build(off).summary.scope.tasks_per_group).toEqual({ all: 3 });
    const on = makeSuite({ tasks, groupByPrefix: true, groups: { A: 'Area one' } });
    writeRun(on, makeRun(on));
    const s = build(on).summary;
    expect(s.scope.tasks_per_group).toEqual({ 'Area one': 2, B: 1 });
    expect(s.runs[0].groups.map((g) => g.group)).toEqual(['Area one', 'B']);
  });

  it('counts files and MB of every source at its commit (git, local)', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const s = buildPrivateSummary({ suiteDir: f.suiteDir, now: NOW }).summary;
    expect(s.scope.files).toBe(3);
    expect(s.scope.total_mb).toBe(0);
  });

  it('flags any key or string outside the allowlist', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const { summary } = build(f);
    const extra = JSON.parse(JSON.stringify(summary));
    extra.runs[0].task_ids = ['A1'];
    extra.scope.prompt = 'x';
    extra.runs[0].arms.cc.notes = 'x';
    extra.runs[0].model = '/abs/model';
    const p = summaryShapeProblems(extra).join('\n');
    expect(p).toMatch(/\$\.runs\[0\]\.task_ids: not in the allowlist/);
    expect(p).toMatch(/\$\.scope\.prompt: not in the allowlist/);
    expect(p).toMatch(/\$\.runs\[0\]\.arms\.cc\.notes: not in the allowlist/);
    expect(p).toMatch(/\$\.runs\[0\]\.model: must be a plain model id/);
  });
});

describe('private summary: verdict (CCA-20)', () => {
  it('carries the rule verdict per run and per group, from the block numbers only', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const { summary } = build(f);
    const run = summary.runs[0];
    expect(run.verdict).toEqual(computeVerdict(verdictInputFromBlock(run, run.repeats)!));
    // cc: 100 % vs 83.3 %, uncached −40 %, cost −40 %, 20 % faster; 2 repeats.
    expect(run.verdict.code).toBe('BENEFICIAL');
    expect(run.verdict.indicative).toBe(true);
    expect(run.verdict.sentences.at(-1)).toBe(
      'This result is indicative only: the run has 2 repeats.',
    );
    for (const g of run.groups) {
      expect(g.verdict).toEqual(computeVerdict(verdictInputFromBlock(g, run.repeats)!));
      expect(g.verdict.sentences.join(' ')).not.toContain(g.group);
    }
    expect(summaryShapeProblems(summary)).toEqual([]);
  });

  it('refuses any verdict text the rule did not make (e.g. a planted private word)', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const { summary } = build(f);
    const bad = JSON.parse(JSON.stringify(summary));
    bad.runs[0].verdict.sentences[0] = `Result: ${SOURCE_NAME} helps.`;
    bad.runs[0].groups[1].verdict.code = 'HARMFUL';
    delete bad.runs[0].groups[0].verdict;
    const p = summaryShapeProblems(bad).join('\n');
    expect(p).toMatch(/\$\.runs\[0\]\.verdict: must be the rule's verdict for this block/);
    expect(p).toMatch(/\$\.runs\[0\]\.groups\[1\]\.verdict: must be the rule's verdict/);
    expect(p).toMatch(/\$\.runs\[0\]\.groups\[0\]\.verdict: missing/);
  });

  it('never reads a verdict stored in the run file', () => {
    const f = makeSuite();
    const run = makeRun(f);
    (run.headline as Record<string, unknown>).verdict = {
      code: 'BENEFICIAL',
      indicative: false,
      repeats: 2,
      arm: 'cc',
      arms: {},
      sentences: [`Result: ${PROMPTS.A1}`, `${SOURCE_NAME} helps.`],
    };
    writeRun(f, run);
    const low = build(f).text.toLowerCase();
    for (const v of privateValues(f).filter((x) => x.length > 2))
      expect(low.includes(v), v).toBe(false);
  });

  it('the guard still scans the verdict text', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const { summary, denylist } = build(f);
    const planted = JSON.parse(JSON.stringify(summary));
    planted.runs[0].verdict.sentences.push(`${SOURCE_NAME} is fast.`);
    expect(guardHits(planted, denylist)).toEqual([
      expect.stringMatching(/^\$\.runs\[0\]\.verdict\.sentences\[\d+\]: private suite value$/),
    ]);
  });
});

describe('private summary: no private value ever leaks (property over every run field)', () => {
  it('plants each private value into every string and number of a run: refused or absent', () => {
    const f = makeSuite();
    const base = makeRun(f);
    const paths = leaves(base);
    expect(paths.length).toBeGreaterThan(150);
    const plants = [
      SOURCE_NAME,
      f.repo,
      PROMPTS.A2,
      ANSWER_ITEMS[1],
      SYMBOLS[0],
      'A1',
      f.commit,
      sha256(SOURCE_NAME_2),
      'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    ];
    const deny = [...privateValues(f), 'ghp_'];
    let built = 0;
    let refused = 0;
    for (const at of paths) {
      for (const plant of plants) {
        for (const value of [plant, `x ${plant} y`]) {
          const run = JSON.parse(JSON.stringify(base));
          setAt(run, at, value);
          writeRun(f, run);
          let text: string | null = null;
          try {
            text = build(f, [base.run_id]).text;
          } catch (e) {
            expect(e, `${at.join('.')}: unexpected error ${(e as Error).message}`).toBeInstanceOf(
              SummaryRefused,
            );
            refused++;
          }
          if (text !== null) {
            built++;
            const low = text.toLowerCase();
            for (const d of deny) {
              // Boundary-aware: task id "a1" must not count inside "1a1b"-like numbers.
              const re = new RegExp(
                `(^|[^a-z0-9])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`,
              );
              expect(re.test(low), `${at.join('.')} ← ${plant.slice(0, 20)} leaked`).toBe(false);
            }
          }
        }
      }
    }
    // Most fields are never read into a summary: the build succeeds and stays clean.
    expect(built).toBeGreaterThan(refused);
    expect(refused).toBeGreaterThan(0);
  }, 120_000);

  it('the plain summary of the fixture holds none of the private values', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const low = build(f).text.toLowerCase();
    for (const v of privateValues(f).filter((x) => x.length > 2))
      expect(low.includes(v), v).toBe(false);
    expect(low).not.toMatch(/\/(users|home|private|var|tmp)\//);
  });
});

describe('private summary: refusals', () => {
  it('refuses a suite without alias', () => {
    const f = makeSuite({ alias: undefined });
    writeRun(f, makeRun(f));
    expect(() => build(f)).toThrow(/no "alias"/);
  });

  it('refuses an alias or group label that names a private value', () => {
    const a = makeSuite({ alias: `${SOURCE_NAME} suite` });
    writeRun(a, makeRun(a));
    expect(() => build(a)).toThrow(/\$\.alias: private suite value/);
    const g = makeSuite({ groups: { spa: SOURCE_NAME_2, x: 'cross-repo' } });
    writeRun(g, makeRun(g));
    expect(() => build(g)).toThrow(/private suite value/);
  });

  it('refuses a model id that carries a private name or is not a plain id', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f, 'opus-20261012-092421', { model: `${SOURCE_NAME}-tuned` }));
    expect(() => build(f)).toThrow(/\$\.runs\[0\]\.model: private suite value/);
    writeRun(f, makeRun(f, 'opus-20261012-092421', { model: '/Users/someone/model' }));
    expect(() => build(f)).toThrow(/model is not a plain model id/);
  });

  it('never prints the private value in a refusal', () => {
    const f = makeSuite({ alias: `${SOURCE_NAME} suite` });
    writeRun(f, makeRun(f));
    try {
      build(f);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.toLowerCase()).not.toContain(SOURCE_NAME);
    }
  });

  it('refuses unknown or malformed --runs, runs of another suite, and an empty suite', () => {
    const f = makeSuite();
    expect(() => build(f)).toThrow(/no runs of this suite/);
    writeRun(f, makeRun(f));
    expect(() => build(f, ['nope-1'])).toThrow(/not found/);
    expect(() => build(f, ['../x'])).toThrow(/invalid run id/);
    const other = makeRun(f, 'opus-20261012-100000');
    (other.suite as any).id = 'another-suite';
    writeRun(f, other);
    expect(() => build(f, ['opus-20261012-100000'])).toThrow(/not a run of this suite/);
  });

  it('refuses a run without the vanilla and cc arms', () => {
    const f = makeSuite();
    const run = makeRun(f);
    delete (run.arms as any).cc;
    writeRun(f, run);
    expect(() => build(f)).toThrow(/needs the vanilla and cc arms/);
  });
});

describe('private summary: guard detectors', () => {
  const deny = ['zephyr-ledger', 'a1'];
  it('finds denylist tokens on word boundaries only', () => {
    expect(stringHits('Zephyr-Ledger', deny)).toContain('private suite value');
    expect(stringHits('task A1', deny)).toContain('private suite value');
    expect(stringHits('ba1c', deny)).toEqual([]);
  });
  it('finds absolute paths, secrets and hex ids', () => {
    expect(stringHits('/Users/me/repo', [])).toContain('absolute path');
    expect(stringHits('see /srv/data/x', [])).toContain('absolute path');
    expect(stringHits('C:\\work\\repo', [])).toContain('absolute path');
    expect(stringHits('ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', []).join()).toMatch(
      /secret \(GitHub token\)/,
    );
    expect(stringHits('at 9f3c2a7e1', [])).toContain('hex id (commit or hash)');
    expect(stringHits('zai-coding-plan/glm-5.3', [])).toEqual([]);
    expect(stringHits('claude-opus-4-1-20250805', [])).toEqual([]);
  });
  it('scans keys too', () => {
    expect(guardHits({ groups: { 'zephyr-ledger': 1 } }, deny)).toEqual([
      '$.groups (key): private suite value',
    ]);
  });
});

describe('private index', () => {
  it('replaces the same slug, drops malformed entries, sorts by alias', () => {
    const idx = mergePrivateIndex(
      {
        summaries: [
          {
            slug: 'b-suite',
            alias: 'B suite',
            generated: '2026-10-01',
            file: 'private/b-suite.json',
          },
          {
            slug: 'a-suite',
            alias: 'A suite',
            generated: '2026-10-01',
            file: 'private/a-suite.json',
          },
          { slug: '../evil', alias: 'x', generated: '2026-10-01', file: '../evil.json' },
        ],
      },
      { slug: 'b-suite', alias: 'B suite', generated: '2026-10-12', file: 'private/b-suite.json' },
    );
    expect(idx.schema).toBe(PRIVATE_INDEX_SCHEMA);
    expect(idx.summaries.map((s) => [s.slug, s.generated])).toEqual([
      ['a-suite', '2026-10-01'],
      ['b-suite', '2026-10-12'],
    ]);
    expect(aliasSlug('Real-world suite A')).toBe('real-world-suite-a');
  });
});

describe('bench:publish --private-summary', () => {
  function originAndClone(): string {
    const seed = tmp('ps-seed-');
    git(seed, 'init', '-q', '-b', 'main');
    write(seed, 'README.md', '# seed\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    const origin = tmp('ps-origin-');
    git(origin, 'init', '-q', '--bare');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    const c = tmp('ps-clone-');
    git(path.dirname(c), 'clone', '-q', '-b', 'main', origin, c);
    return c;
  }

  it('dry run returns the guarded summary and writes nothing', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const res = publishPrivateSummary({
      suiteDir: f.suiteDir,
      dryRun: true,
      now: NOW,
      skipScope: true,
    });
    expect(res.dryRun).toBe(true);
    expect(res.files).toEqual(['data/private/real-world-suite-a.json', 'data/private/index.json']);
    expect(JSON.parse(res.text).schema).toBe(PRIVATE_SUMMARY_SCHEMA);
  });

  it('publishes ONLY data/private/<slug>.json + index.json to bench-results, never the runs', () => {
    const f = makeSuite();
    writeRun(f, makeRun(f));
    const c = originAndClone();
    const head = git(c, 'rev-parse', 'HEAD');
    const res = publishPrivateSummary({
      repoDir: c,
      suiteDir: f.suiteDir,
      env: GIT_ENV,
      now: NOW,
      skipScope: true,
    });
    expect(res.pushed).toBe(true);
    git(c, 'fetch', '-q', 'origin', 'bench-results');
    const tree = git(c, 'ls-tree', '-r', '--name-only', 'origin/bench-results').split('\n').sort();
    expect(tree).toEqual(['data/private/index.json', 'data/private/real-world-suite-a.json']);
    const idx = JSON.parse(git(c, 'show', 'origin/bench-results:data/private/index.json'));
    expect(idx.summaries).toEqual([
      {
        slug: 'real-world-suite-a',
        alias: 'Real-world suite A',
        generated: '2026-10-12',
        file: 'private/real-world-suite-a.json',
      },
    ]);
    const published = git(
      c,
      'show',
      'origin/bench-results:data/private/real-world-suite-a.json',
    ).toLowerCase();
    for (const v of privateValues(f).filter((x) => x.length > 2))
      expect(published.includes(v), v).toBe(false);
    // The current checkout is untouched.
    expect(git(c, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(c, 'status', '--porcelain')).toBe('');
    expect(git(c, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a refused summary writes and pushes nothing', () => {
    const f = makeSuite({ alias: `${SOURCE_NAME} suite` });
    writeRun(f, makeRun(f));
    const c = originAndClone();
    expect(() =>
      publishPrivateSummary({ repoDir: c, suiteDir: f.suiteDir, env: GIT_ENV, skipScope: true }),
    ).toThrow(SummaryRefused);
    expect(git(c, 'ls-remote', 'origin', 'bench-results')).toBe('');
  });

  it('plain bench:publish still refuses the full private run', () => {
    const f = makeSuite();
    const c = originAndClone();
    const run = makeRun(f);
    write(c, `data/runs/${run.run_id}.json`, JSON.stringify(run));
    expect(() => publish({ repoDir: c, env: GIT_ENV, dryRun: true })).toThrow(
      /private suite \(suite\.private\)/,
    );
  });
});
