import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../scripts/bench/publish.mts';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
} as NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const realpath = (p: string): string => fs.realpathSync(p);

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = realpath(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const legacyRun = (run_id: string, ts: string) => ({
  schema: 'overdrive-bench/2',
  run_id,
  ts,
  date: ts.slice(0, 10),
  kind: 'weekly',
  model: 'opus',
  trigger: 'manual',
  prereg: { version: 'v2', sha256: 'a'.repeat(64) },
  nv: { mean: 0.04, lo: -0.03, hi: 0.11 },
  verdict: 'INCONCLUSIVE',
});

const simulatedRun = (run_id: string, ts: string) => ({
  schema: 'ccc-bench/1',
  run_id,
  ts,
  date: ts.slice(0, 10),
  kind: 'simulated',
  model: null,
  trigger: 'manual',
  headline: { tokensSavedPct: 44.9, callsSavedPct: 27.9, mcpWinsPct: 90.5, wilcoxonP: 0, effectSizeR: 0.953 },
});

/** Bare "origin" with main + bench-results (containing a legacy run). */
function makeOrigin(withBenchResults: boolean): string {
  const seed = tmpDir('bench-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');

  if (withBenchResults) {
    git(seed, 'checkout', '-q', '-b', 'bench-results');
    fs.mkdirSync(path.join(seed, 'data', 'runs'), { recursive: true });
    fs.writeFileSync(
      path.join(seed, 'data', 'runs', 'legacy-1.json'),
      `${JSON.stringify(legacyRun('legacy-1', '2026-10-01T10:00:00+0200'), null, 2)}\n`,
    );
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'legacy run');
    git(seed, 'checkout', '-q', 'main');
  }

  const origin = tmpDir('bench-origin-');
  git(origin, 'init', '-q', '--bare');
  git(seed, 'remote', 'add', 'origin', origin);
  const refs = withBenchResults ? ['main', 'bench-results'] : ['main'];
  git(seed, 'push', '-q', 'origin', ...refs);
  return origin;
}

function clone(origin: string): string {
  const c = tmpDir('bench-clone-');
  git(path.dirname(c), 'clone', '-q', '-b', 'main', origin, c);
  return c;
}

function writeRun(cwd: string, run: Record<string, unknown>): void {
  fs.mkdirSync(path.join(cwd, 'data', 'runs'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'data', 'runs', `${run.run_id}.json`),
    `${JSON.stringify(run, null, 2)}\n`,
  );
}

function show(cwd: string, ref: string, p: string): string {
  return git(cwd, 'show', `${ref}:${p}`);
}

describe('bench:publish', () => {
  it('advances bench-results, preserves legacy bytes, regenerates index/latest', () => {
    const origin = makeOrigin(true);
    const c = clone(origin);
    const mainHead = git(c, 'rev-parse', 'HEAD');
    const legacyBlobBefore = git(c, 'rev-parse', 'origin/bench-results:data/runs/legacy-1.json');

    writeRun(c, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));

    const res = publish({ repoDir: c, env: GIT_ENV });
    expect(res.pushed).toBe(true);
    expect(res.runIds).toEqual(['sim-20261010-120000']);

    // bench-results advanced and the legacy file is byte-for-byte unchanged.
    expect(git(c, 'rev-parse', 'origin/bench-results:data/runs/legacy-1.json')).toBe(legacyBlobBefore);
    expect(JSON.parse(show(c, 'origin/bench-results', 'data/runs/sim-20261010-120000.json')).run_id).toBe(
      'sim-20261010-120000',
    );

    // index has both entries, newest first.
    const index = JSON.parse(show(c, 'origin/bench-results', 'data/index.json'));
    expect(index.schema).toBe('ccc-bench-index/1');
    expect(index.runs.map((r: { run_id: string }) => r.run_id)).toEqual([
      'sim-20261010-120000',
      'legacy-1',
    ]);

    // latest = the new simulated run.
    const latest = JSON.parse(show(c, 'origin/bench-results', 'data/latest.json'));
    expect(latest.run_id).toBe('sim-20261010-120000');

    // main HEAD and working tree unchanged.
    expect(git(c, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(fs.readFileSync(path.join(c, 'README.md'), 'utf-8')).toBe('# seed\n');
  });

  it('bootstraps a missing bench-results branch containing only data/', () => {
    const origin = makeOrigin(false);
    const c = clone(origin);
    writeRun(c, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));

    publish({ repoDir: c, env: GIT_ENV });

    const tree = git(c, 'ls-tree', '-r', '--name-only', 'origin/bench-results');
    expect(tree.split('\n')).toEqual([
      'data/index.json',
      'data/latest.json',
      'data/runs/sim-20261010-120000.json',
    ]);
  });

  it('--dry-run makes no commits and pushes nothing', () => {
    const origin = makeOrigin(true);
    const c = clone(origin);
    writeRun(c, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));
    const headBefore = git(c, 'rev-parse', 'origin/bench-results');

    const res = publish({ repoDir: c, env: GIT_ENV, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.commitMessage).toBe('bench: add sim-20261010-120000');
    expect(res.files).toEqual(['data/runs/sim-20261010-120000.json']);
    expect(git(c, 'rev-parse', 'origin/bench-results')).toBe(headBefore);
  });

  it('refuses to run from a bench-results checkout', () => {
    const origin = makeOrigin(true);
    const c = clone(origin);
    git(c, 'checkout', '-q', 'bench-results');
    writeRun(c, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));
    expect(() => publish({ repoDir: c, env: GIT_ENV })).toThrow(/refuse to run/);
  });

  it('rejects a run file with a malformed run_id — clear error, nothing written or pushed', () => {
    const origin = makeOrigin(true);
    const c = clone(origin);
    const headBefore = git(c, 'rev-parse', 'origin/bench-results');

    // The FILENAME is harmless; the poisoned run_id rides inside the JSON and
    // would otherwise become a copyFileSync path and a commit-message token.
    fs.mkdirSync(path.join(c, 'data', 'runs'), { recursive: true });
    fs.writeFileSync(
      path.join(c, 'data', 'runs', 'innocent-name.json'),
      `${JSON.stringify({ ...simulatedRun('innocent-name', '2026-10-11T00:00:00Z'), run_id: '../../evil' }, null, 2)}\n`,
    );

    expect(() => publish({ repoDir: c, env: GIT_ENV })).toThrow(/invalid run_id.*refusing to publish/s);
    // nothing happened: remote unmoved, no run pushed
    expect(git(c, 'rev-parse', 'origin/bench-results')).toBe(headBefore);
    expect(() => show(c, 'origin/bench-results', 'data/runs/innocent-name.json')).toThrow();
  });

  it('still skips stray JSON without a run_id (editor temps), publishing only real runs', () => {
    const origin = makeOrigin(true);
    const c = clone(origin);
    writeRun(c, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));
    fs.writeFileSync(
      path.join(c, 'data', 'runs', 'stray.json'),
      `${JSON.stringify({ note: 'editor temp file' })}\n`,
    );

    const res = publish({ repoDir: c, env: GIT_ENV });
    expect(res.runIds).toEqual(['sim-20261010-120000']);
    expect(() => show(c, 'origin/bench-results', 'data/runs/stray.json')).toThrow();
  });

  it('copies the merged data/ to CODE_CONTEXT_BENCH_DIR, replacing the old copy', () => {
    const origin = makeOrigin(true);
    const c = clone(origin);
    const dash = path.join(tmpDir('bench-dash-'), 'bench');
    fs.mkdirSync(path.join(dash, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dash, 'runs', 'gone.json'), '{}');
    writeRun(c, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));

    const res = publish({ repoDir: c, env: { ...GIT_ENV, CODE_CONTEXT_BENCH_DIR: dash } });
    expect(res.mirrored).toBe(dash);
    expect(fs.readdirSync(path.join(dash, 'runs')).sort()).toEqual([
      'legacy-1.json',
      'sim-20261010-120000.json',
    ]);
    const index = JSON.parse(fs.readFileSync(path.join(dash, 'index.json'), 'utf-8'));
    expect(index.runs.map((r: { run_id: string }) => r.run_id)).toEqual(['sim-20261010-120000', 'legacy-1']);
    expect(fs.existsSync(path.join(dash, 'latest.json'))).toBe(true);
  });

  it('does not copy without CODE_CONTEXT_BENCH_DIR or inside GitHub Actions', () => {
    const dash = path.join(tmpDir('bench-dash-'), 'bench');
    const c1 = clone(makeOrigin(true));
    writeRun(c1, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));
    expect(publish({ repoDir: c1, env: GIT_ENV }).mirrored).toBeNull();

    const c2 = clone(makeOrigin(true));
    writeRun(c2, simulatedRun('sim-20261010-120000', '2026-10-10T12:00:00+0200'));
    const env = { ...GIT_ENV, CODE_CONTEXT_BENCH_DIR: dash, GITHUB_ACTIONS: 'true' };
    expect(publish({ repoDir: c2, env }).mirrored).toBeNull();
    expect(fs.existsSync(dash)).toBe(false);
  });
});
