/**
 * Private suites (CCA-17, #149): suite.json/answers.json validation, the
 * git-archive workspace, the suite checkers, redacted run JSON, the
 * publish refusal and the --data-dir refusal.
 *
 * Every suite here is built in the test from a temp git repo with synthetic
 * content only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANSWERS_SCHEMA,
  SUITE_SCHEMA,
  loadSuite,
  privateSuiteContaining,
  sha256,
  suiteProblems,
  writeSuiteWorkspace,
  type SuiteFile,
} from '../scripts/bench/live/suite.mts';
import { runChecker, suiteAnswerPaths } from '../scripts/bench/live/checkers.mts';
import { prepareArmSession, type PreparedArm } from '../scripts/bench/live/prepare.mts';
import { normalizeLive } from '../scripts/bench/normalize-live.mts';
import { publish } from '../scripts/bench/publish.mts';
import type { SessionResult } from '../scripts/bench/lib/types.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isPosix = process.platform !== 'win32';

const tmps: string[] = [];
const prepped: PreparedArm[] = [];
afterEach(() => {
  for (const p of prepped.splice(0)) p.cleanup();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** A synthetic two-folder repo: a TS app and a PHP backend. Returns repo + commit. */
function makeRepo(): { repo: string; commit: string } {
  const repo = tmp('suite-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'web/src/lib/clock.ts', 'export function tick(): number {\n  return 1;\n}\n');
  write(repo, 'web/src/a.ts', "import { tick } from './lib/clock';\nexport const a = tick();\n");
  write(repo, 'web/src/b.ts', "import { tick } from './lib/clock';\nexport const b = tick();\n");
  write(repo, 'web/src/c.ts', 'export const c = 3;\n');
  write(repo, 'api/app/Jobs/PingJob.php', '<?php\nnamespace App\\Jobs;\nclass PingJob {}\n');
  write(repo, 'api/app/Jobs/PongJob.php', '<?php\nnamespace App\\Jobs;\nclass PongJob {}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'synthetic');
  const commit = git(repo, 'rev-parse', 'HEAD');
  // Dirty working tree AFTER the commit: the workspace must not see it.
  write(repo, 'web/src/a.ts', 'export const a = "dirty";\n');
  write(repo, 'web/src/untracked.ts', 'export const u = 1;\n');
  return { repo, commit };
}

function suiteJson(repo: string, commit: string, over: Partial<SuiteFile> = {}): SuiteFile {
  return {
    schema: SUITE_SCHEMA,
    id: 'synthetic',
    description: 'test suite',
    private: true,
    sources: [
      { name: 'mono', repo, commit },
      { name: 'webonly', repo, commit: commit.slice(0, 10), subdir: 'web' },
    ],
    tasks: [
      {
        id: 'T1',
        size: 'M',
        prompt: 'SECRET-PROMPT-TEXT Which files import web/src/lib/clock.ts?',
        checker: { type: 'path-set', answer: 'clockImporters', maxExtra: 0 },
      },
      {
        id: 'T2',
        prompt: 'Which job classes exist?',
        checker: { type: 'symbol-set', answer: 'jobs', maxExtra: 0 },
      },
      {
        id: 'T3',
        prompt: 'Where is tick declared?',
        checker: { type: 'path-set', answer: 'tickDef', maxExtra: 0, first: true },
      },
    ],
    ...over,
  };
}

const ANSWERS = {
  schema: ANSWERS_SCHEMA,
  suite: 'synthetic',
  answers: {
    clockImporters: { kind: 'paths', items: ['mono/web/src/a.ts', 'mono/web/src/b.ts'] },
    jobs: {
      kind: 'symbols',
      items: ['PingJob', 'PongJob'],
      universe: ['PingJob', 'PongJob', 'Other'],
    },
    tickDef: { kind: 'paths', items: ['webonly/src/lib/clock.ts'] },
  },
};

function makeSuite(
  over: Partial<SuiteFile> = {},
  answers: unknown = ANSWERS,
): {
  dir: string;
  repo: string;
  commit: string;
} {
  const { repo, commit } = makeRepo();
  const dir = tmp('suite-dir-');
  fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify(suiteJson(repo, commit, over)));
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  return { dir, repo, commit };
}

describe('suite.json validation (CCA-17)', () => {
  it('loads a valid suite: full commit shas, suite tasks, redact defaults to private', () => {
    const { dir, commit } = makeSuite();
    const s = loadSuite(dir, { repoRoot });
    expect(s.id).toBe('synthetic');
    expect(s.private).toBe(true);
    expect(s.redact).toBe(true);
    expect(s.sources.map((x) => x.commit)).toEqual([commit, commit]);
    expect(s.tasks.map((t) => [t.id, t.fixture])).toEqual([
      ['T1', 'suite'],
      ['T2', 'suite'],
      ['T3', 'suite'],
    ]);
    expect(s.tasks[0].suite?.roots).toEqual(['mono', 'webonly']);
  });

  it('lists every schema problem at once', () => {
    const problems = suiteProblems({
      schema: 'nope',
      id: 'bad id!',
      private: 'yes',
      sources: [{ name: 'x', repo: 'relative/path', commit: 'zz', subdir: '../up' }],
      tasks: [{ id: 'T1', prompt: '', checker: { type: 'magic' } }],
      extra: 1,
    });
    const text = problems.join('\n');
    for (const want of [
      'schema:',
      'id:',
      'description:',
      'private:',
      'sources[0].repo',
      'sources[0].commit',
      'sources[0].subdir',
      'tasks[0].prompt',
      'tasks[0].checker.type',
      'extra: unknown field',
    ]) {
      expect(text).toContain(want);
    }
  });

  it('refuses a missing answer key, a kind mismatch and a symbols answer without universe', () => {
    const { dir } = makeSuite(
      {},
      {
        ...ANSWERS,
        answers: {
          jobs: { kind: 'paths', items: ['mono/api/app/Jobs/PingJob.php'] },
          tickDef: { kind: 'symbols', items: ['tick'] },
        },
      },
    );
    expect(() => loadSuite(dir)).toThrow(/clockImporters" is missing/);
    expect(() => loadSuite(dir)).toThrow(/symbol-set needs a "symbols" answer/);
    expect(() => loadSuite(dir)).toThrow(/symbols need the universe/);
  });

  it('refuses a commit that does not exist and a subdir that is not a folder', () => {
    const { dir, repo } = makeSuite();
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'suite.json'), 'utf-8')) as SuiteFile;
    s.sources[0].commit = 'deadbeefdeadbeef';
    s.sources[1].subdir = 'web/src/a.ts';
    fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify(s));
    expect(() => loadSuite(dir)).toThrow(/commit deadbeefdeadbeef does not exist/);
    expect(() => loadSuite(dir)).toThrow(/web\/src\/a\.ts is not a folder/);
    expect(repo).toBeTruthy();
  });

  it('refuses a private suite inside this repository', () => {
    const { dir } = makeSuite();
    const inside = fs.mkdtempSync(path.join(repoRoot, '.suite-test-'));
    try {
      for (const f of ['suite.json', 'answers.json'])
        fs.copyFileSync(path.join(dir, f), path.join(inside, f));
      expect(() => loadSuite(inside, { repoRoot })).toThrow(/must live outside this repository/);
    } finally {
      fs.rmSync(inside, { recursive: true, force: true });
    }
  });
});

describe('suite workspace (git archive)', () => {
  it('extracts each source at its commit, ignores the dirty tree, honours subdir', () => {
    const { dir } = makeSuite();
    const s = loadSuite(dir);
    const ws = tmp('suite-ws-');
    writeSuiteWorkspace(s, ws);
    expect(fs.readFileSync(path.join(ws, 'mono/web/src/a.ts'), 'utf-8')).toContain('tick()');
    expect(fs.existsSync(path.join(ws, 'mono/web/src/untracked.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'mono/api/app/Jobs/PingJob.php'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'webonly/src/lib/clock.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'webonly/api'))).toBe(false);
  });

  it('prepareArmSession builds a cc workspace with an index over every source', () => {
    const { dir } = makeSuite();
    const s = loadSuite(dir);
    const root = tmp('suite-prep-');
    const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
    try {
      const p = prepareArmSession({
        provider: 'glm',
        arm: 'cc',
        model: 'm',
        fixture: 'suite',
        suite: s,
        distServer: '/nonexistent/dist/server/index.js',
        keyExportName: 'ZHIPU_API_KEY',
        key: 'k',
        tmpdir: root,
      });
      prepped.push(p);
      expect(fs.existsSync(path.join(p.ws, 'opencode.json'))).toBe(true);
      expect(fs.existsSync(path.join(p.ws, 'mono/web/src/b.ts'))).toBe(true);
      expect(p.indexInfo?.dbBytes).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
      else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
    }
  });

  it('a suite task without its loaded suite cannot build a workspace', () => {
    const root = tmp('suite-prep-');
    expect(() =>
      prepareArmSession({
        provider: 'glm',
        arm: 'vanilla',
        model: 'm',
        fixture: 'suite',
        distServer: '/x',
        keyExportName: 'ZHIPU_API_KEY',
        key: 'k',
        tmpdir: root,
      }),
    ).toThrow(/needs its loaded suite/);
  });
});

describe('suite checkers', () => {
  const load = () => loadSuite(makeSuite().dir);

  it('suiteAnswerPaths cuts absolute and prefixed paths at the source folder', () => {
    const got = suiteAnswerPaths(
      [
        '- /tmp/bench-ws-x/mono/web/src/a.ts',
        '- `./mono/web/src/b.ts`',
        '- webonly/src/lib/clock.ts (the definition)',
        '',
        'Excluded:',
        '- mono/web/src/c.ts',
      ].join('\n'),
      ['mono', 'webonly'],
    );
    expect([...got].sort()).toEqual([
      'mono/web/src/a.ts',
      'mono/web/src/b.ts',
      'webonly/src/lib/clock.ts',
    ]);
  });

  it('path-set passes on the exact set, fails on a missing or extra path', async () => {
    const s = load();
    const t1 = s.tasks[0];
    expect((await runChecker(t1, '/unused', 'mono/web/src/a.ts\nmono/web/src/b.ts')).pass).toBe(
      true,
    );
    const miss = await runChecker(t1, '/unused', 'mono/web/src/a.ts');
    expect(miss.pass).toBe(false);
    expect(miss.detail).toContain('missing mono/web/src/b.ts');
    const extra = await runChecker(
      t1,
      '/unused',
      'mono/web/src/a.ts\nmono/web/src/b.ts\nmono/web/src/c.ts',
    );
    expect(extra.pass).toBe(false);
  });

  it('path-set first: only the first claimed path counts', async () => {
    const t3 = load().tasks[2];
    expect(
      (await runChecker(t3, '/unused', 'webonly/src/lib/clock.ts\nmono/web/src/a.ts')).pass,
    ).toBe(true);
    expect((await runChecker(t3, '/unused', 'mono/web/src/lib/clock.ts')).pass).toBe(false);
  });

  it('symbol-set compares unqualified names from the universe', async () => {
    const t2 = load().tasks[1];
    expect((await runChecker(t2, '/unused', '- App\\Jobs\\PingJob\n- `PongJob`')).pass).toBe(true);
    const r = await runChecker(t2, '/unused', '- PingJob\n- Other');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('missing PongJob');
  });
});

const session = (task_id: string): SessionResult => ({
  task_id,
  success: true,
  timeout: false,
  tokens: { input: 10, output: 2, cache_read: 0, cache_write: 0 },
  first_call_cache_read: 0,
  tool_calls: 1,
  mcp_tool_calls: 0,
  wall_ms: 100,
  session_id: 's',
  events_path: `x-${task_id}.jsonl`,
});

describe('run JSON of a suite', () => {
  const ctx = {
    trigger: 'manual' as const,
    git: { commit: 'c', branch: 'b', dirty: false },
    durationMs: 1,
    codeContextVersion: '0.0.0',
    agentVersion: '1',
    now: new Date('2026-10-12T10:00:00Z'),
  };

  it('redacted (private default): suite block with commits, tasks by id + hash, no text', () => {
    const s = loadSuite(makeSuite().dir);
    const tasks = s.tasks.slice(0, 1);
    const run = normalizeLive(
      'glm',
      'm',
      tasks,
      { vanilla: [session('T1')], cc: [session('T1')], indexMs: 1, dbBytes: 1 },
      { ...ctx, suite: s },
    );
    const text = JSON.stringify(run);
    expect(run.suite).toMatchObject({ id: 'synthetic', private: true, redact: true });
    expect(run.fixture).toBe('suite synthetic');
    expect(text).not.toContain('SECRET-PROMPT-TEXT');
    expect(text).not.toContain('mono/web/src/a.ts');
    expect(text).not.toContain('"mono"');
    expect(text).not.toContain('clockImporters');
    expect(text).toContain(s.sources[0].commit);
    expect(run.tasks[0]).toEqual({
      id: 'T1',
      size: 'M',
      fixture: 'suite synthetic',
      prompt_sha256: sha256(s.tasks[0].prompt),
      checker: {
        type: 'path-set',
        maxExtra: 0,
        answer_sha256: sha256(JSON.stringify(s.answers.clockImporters)),
      },
    });
  });

  it('redact: false keeps prompts, checker refs and source names', () => {
    const s = loadSuite(makeSuite({ private: false }).dir);
    expect(s.redact).toBe(false);
    const run = normalizeLive(
      'glm',
      'm',
      s.tasks.slice(0, 1),
      { vanilla: [session('T1')], cc: [session('T1')], indexMs: 1, dbBytes: 1 },
      { ...ctx, suite: s },
    );
    expect(JSON.stringify(run)).toContain('SECRET-PROMPT-TEXT');
    expect(run.suite).toMatchObject({ private: false });
    expect((run.suite?.sources as Array<{ name: string }>)[0].name).toBe('mono');
  });
});

describe('bench:publish refuses private suite runs', () => {
  function publishRepo(): string {
    const c = tmp('suite-pub-');
    git(c, 'init', '-q', '-b', 'main');
    write(c, 'README.md', 'x\n');
    git(c, 'add', '-A');
    git(c, 'commit', '-q', '-m', 'init');
    return c;
  }
  const runJson = (id: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ run_id: id, kind: 'agent-glm', ts: '2026-10-12T10:00:00Z', ...extra });

  it('refuses a run whose JSON says suite.private', () => {
    const c = publishRepo();
    write(
      c,
      'data/runs/glm-20261012-100000.json',
      runJson('glm-20261012-100000', { suite: { id: 's', private: true } }),
    );
    expect(() => publish({ repoDir: c, dryRun: true })).toThrow(/private suite \(suite\.private\)/);
  });

  it('refuses run files that live under a private suite dir (via symlink)', () => {
    const c = publishRepo();
    const { dir } = makeSuite();
    write(dir, 'data/runs/glm-20261012-100000.json', runJson('glm-20261012-100000'));
    fs.mkdirSync(path.join(c, 'data'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'data', 'runs'), path.join(c, 'data', 'runs'));
    expect(() => publish({ repoDir: c, dryRun: true })).toThrow(/lies under the private suite/);
    expect(privateSuiteContaining(path.join(dir, 'data', 'runs', 'x.json'))).toBe(
      fs.realpathSync(dir),
    );
  });

  it('still publishes (dry run) a public run', () => {
    const c = publishRepo();
    write(c, 'data/runs/glm-20261012-100000.json', runJson('glm-20261012-100000'));
    expect(publish({ repoDir: c, dryRun: true }).runIds).toEqual(['glm-20261012-100000']);
  });
});

/** Fake opencode that answers with the two clock importers. */
function fakeOpencode(binDir: string): void {
  const body = `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('9.9.9-fake'); process.exit(0); }
const ev = (o) => process.stdout.write(JSON.stringify({ sessionID: 'ses_fake', timestamp: Date.now(), ...o }) + '\\n');
ev({ type: 'text', part: { id: 'prt_t', type: 'text', text: 'mono/web/src/a.ts\\nmono/web/src/b.ts' } });
ev({ type: 'step_finish', part: { id: 'prt_1', type: 'step-finish', tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001 } });
`;
  fs.writeFileSync(path.join(binDir, 'opencode'), body);
  fs.chmodSync(path.join(binDir, 'opencode'), 0o755);
}

function runSuiteBench(dir: string, extra: string[]): { status: number | null; out: string } {
  const root = tmp('suite-e2e-');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fakeOpencode(binDir);
  const fakeDist = path.join(root, 'fake-dist-server.js');
  fs.writeFileSync(fakeDist, '// never started by the fake agent\n');
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(repoRoot, 'scripts', 'bench', 'live', 'run.mts'),
      '--provider',
      'deepseek',
      '--suite',
      dir,
      '--arms',
      'vanilla,cc',
      ...extra,
    ],
    {
      cwd: repoRoot,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: root,
        TMPDIR: os.tmpdir(),
        DEEPSEEK_API_KEY: 'fake-key-not-used',
        BENCH_LIVE_DIST_SERVER: fakeDist,
      },
      encoding: 'utf-8',
      timeout: 90_000,
    },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe.runIf(isPosix)('bench:live --suite end to end (fake opencode)', () => {
  it('runs a suite task and writes the redacted run into <suite>/data', () => {
    const { dir } = makeSuite();
    const r = runSuiteBench(dir, ['--tasks', 'T1']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('2/2 paths found');
    const runs = fs.readdirSync(path.join(dir, 'data', 'runs'));
    expect(runs).toHaveLength(1);
    const text = fs.readFileSync(path.join(dir, 'data', 'runs', runs[0]), 'utf-8');
    const run = JSON.parse(text) as {
      suite: { private: boolean };
      headline: { success_cc_pct: number };
    };
    expect(run.suite.private).toBe(true);
    expect(run.headline.success_cc_pct).toBe(100);
    expect(text).not.toContain('SECRET-PROMPT-TEXT');
    expect(fs.existsSync(path.join(dir, 'data', 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'data', 'latest.json'))).toBe(true);
  }, 120_000);

  it('refuses --data-dir inside this repository for a private suite', () => {
    const { dir } = makeSuite();
    const r = runSuiteBench(dir, ['--data-dir', path.join(repoRoot, 'data')]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('is inside this repository');
  });

  it('refuses an unknown suite task id', () => {
    const { dir } = makeSuite();
    const r = runSuiteBench(dir, ['--tasks', 'L1']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('unknown task id L1 in suite synthetic');
  });
});

describe('bench:suite-check', () => {
  it('validates, builds one workspace, finds every answer path and indexes it', async () => {
    const { checkSuite } = await import('../scripts/bench/live/suite-check.mts');
    const { dir } = makeSuite();
    const r = checkSuite(dir, { tmpdir: tmp('suite-check-') });
    expect(r).toMatchObject({ suite: 'synthetic', sources: 2, tasks: 3, missingPaths: [] });
    expect(r.files).toBe(10); // 6 committed files in mono + the 4 under web/ in webonly
    expect(r.index?.files).toBeGreaterThan(0);
  });

  it('reports answer paths that are missing in the workspace', async () => {
    const { checkSuite } = await import('../scripts/bench/live/suite-check.mts');
    const answers = structuredClone(ANSWERS);
    answers.answers.clockImporters.items.push('mono/web/src/gone.ts');
    const { dir } = makeSuite({}, answers);
    expect(checkSuite(dir, { index: false }).missingPaths).toEqual(['mono/web/src/gone.ts']);
  });
});
