/**
 * CCA-15 (#146): the session timeout ends a stalled agent, the whole process
 * tree goes with it, and a harness/provider fault is retried once.
 *
 * Unit tests drive session.mts runAgentProcess with small node scripts; the
 * end-to-end tests run `scripts/bench/live/run.mts` with a fake `opencode`
 * first on PATH (no provider call, no key, no dist build needed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptFault, descendantPids, runAgentProcess } from '../scripts/bench/live/session.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isPosix = process.platform !== 'win32';

const tmpDirs: string[] = [];
const pidsToReap: number[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const p of pidsToReap.splice(0)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

function script(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

const IGNORE_TERM = "process.on('SIGTERM', () => {});";

describe.runIf(isPosix)('runAgentProcess — timeout (CCA-15)', () => {
  it('kills a stalled child that ignores SIGTERM at the timeout and keeps its partial output', async () => {
    const dir = tmp('cca15-stall-');
    const s = script(
      dir,
      'stall.cjs',
      `${IGNORE_TERM}
       process.stdout.write('{"partial":1}\\n');
       require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    const t0 = Date.now();
    const res = await runAgentProcess({
      bin: process.execPath,
      args: [s],
      cwd: dir,
      env: process.env,
      timeoutMs: 400,
      graceMs: 300,
      drainMs: 300,
      tickMs: 50,
    });
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf-8'));
    pidsToReap.push(pid);
    expect(res.timedOut).toBe(true);
    expect(res.spawnError).toBe('');
    expect(res.stdout.toString()).toContain('{"partial":1}');
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(await waitDead(pid)).toBe(true);
  });

  it('leaves no orphan: grandchildren in the group and in their own group die with it', async () => {
    const dir = tmp('cca15-tree-');
    const grand = script(
      dir,
      'grand.cjs',
      `${IGNORE_TERM}
       require('fs').writeFileSync(process.argv[2], String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    const parent = script(
      dir,
      'parent.cjs',
      `${IGNORE_TERM}
       const { spawn } = require('child_process');
       // same process group, inherits stdout (holds the pipe open)
       spawn(process.execPath, [${JSON.stringify(grand)}, ${JSON.stringify(path.join(dir, 'g1'))}], { stdio: 'inherit' });
       // own process group / session: escapes a group kill
       spawn(process.execPath, [${JSON.stringify(grand)}, ${JSON.stringify(path.join(dir, 'g2'))}], { stdio: 'inherit', detached: true });
       setInterval(() => {}, 1000);`,
    );
    const res = await runAgentProcess({
      bin: process.execPath,
      args: [parent],
      cwd: dir,
      env: process.env,
      timeoutMs: 800,
      graceMs: 300,
      drainMs: 300,
      tickMs: 50,
    });
    expect(res.timedOut).toBe(true);
    const g1 = Number(fs.readFileSync(path.join(dir, 'g1'), 'utf-8'));
    const g2 = Number(fs.readFileSync(path.join(dir, 'g2'), 'utf-8'));
    pidsToReap.push(g1, g2);
    expect(await waitDead(g1)).toBe(true);
    expect(await waitDead(g2)).toBe(true);
  });

  it('does not wait on a pipe a leftover grandchild holds after a normal exit', async () => {
    const dir = tmp('cca15-pipe-');
    const grand = script(
      dir,
      'grand.cjs',
      `require('fs').writeFileSync(process.argv[2], String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    const parent = script(
      dir,
      'parent.cjs',
      `const { spawn } = require('child_process');
       const c = spawn(process.execPath, [${JSON.stringify(grand)}, ${JSON.stringify(path.join(dir, 'g'))}], { stdio: 'inherit', detached: true });
       c.unref();
       process.stdout.write('done\\n');
       setTimeout(() => process.exit(0), 300);`,
    );
    const t0 = Date.now();
    const res = await runAgentProcess({
      bin: process.execPath,
      args: [parent],
      cwd: dir,
      env: process.env,
      timeoutMs: 30_000,
      drainMs: 300,
      tickMs: 50,
    });
    expect(res.timedOut).toBe(false);
    expect(res.stdout.toString()).toContain('done');
    expect(Date.now() - t0).toBeLessThan(5_000);
    const g = Number(fs.readFileSync(path.join(dir, 'g'), 'utf-8'));
    pidsToReap.push(g);
    expect(await waitDead(g)).toBe(true);
  });

  it('flags a wall-clock gap (machine sleep) as slept', async () => {
    const dir = tmp('cca15-sleep-');
    const s = script(dir, 'short.cjs', 'setTimeout(() => process.exit(0), 600);');
    const p = runAgentProcess({
      bin: process.execPath,
      args: [s],
      cwd: dir,
      env: process.env,
      timeoutMs: 30_000,
      tickMs: 50,
      sleepGapMs: 150,
      drainMs: 100,
    });
    // Block the event loop: the next tick sees a gap, as after a sleep.
    setTimeout(() => {
      const end = Date.now() + 400;
      while (Date.now() < end) {
        /* busy */
      }
    }, 100);
    const res = await p;
    expect(res.slept).toBe(true);
    expect(res.timedOut).toBe(false);
  });

  it('reports a spawn failure instead of hanging', async () => {
    const res = await runAgentProcess({
      bin: '/nonexistent/agent-binary',
      args: [],
      cwd: os.tmpdir(),
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(res.spawnError).toMatch(/ENOENT/);
  });

  it('descendantPids finds a child of this process', async () => {
    const { spawn } = await import('node:child_process');
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    pidsToReap.push(c.pid as number);
    expect(descendantPids(process.pid)).toContain(c.pid);
    c.kill('SIGKILL');
  });
});

describe('attemptFault — retry rule (CCA-15)', () => {
  it.each([
    [{ providerError: 'rate limit', modelCalls: 3 }, 'provider error: rate limit'],
    [{ providerError: null, modelCalls: 0 }, 'the model never answered (0 model calls)'],
    [
      { providerError: null, modelCalls: 0, timeout: true },
      'the model never answered (0 model calls, timeout)',
    ],
    [{ providerError: null, modelCalls: 4, slept: true }, 'the machine slept during the session'],
    [{ providerError: null, modelCalls: 4, timeout: true }, null], // a normal model FAIL
    [{ providerError: null, modelCalls: 4 }, null],
  ])('%j → %s', (signals, expected) => {
    expect(attemptFault(signals)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// End to end: run.mts with a fake opencode on PATH.
// ---------------------------------------------------------------------------

type Mode = 'ok' | 'zero' | 'stall-calls';

/**
 * Fake `opencode`: `--version` prints a version; `run …` takes the next mode
 * from <ctl>/plan (one per line, consumed in order) and logs it to <ctl>/log.
 * The control dir is baked into the script: the agent env is minimal.
 */
function fakeOpencode(binDir: string, ctl: string): void {
  const body = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const ctl = ${JSON.stringify(ctl)};
if (process.argv.includes('--version')) { console.log('9.9.9-fake'); process.exit(0); }
const plan = fs.readFileSync(path.join(ctl, 'plan'), 'utf-8').split('\\n').filter(Boolean);
const n = fs.existsSync(path.join(ctl, 'log')) ? fs.readFileSync(path.join(ctl, 'log'), 'utf-8').split('\\n').filter(Boolean).length : 0;
const mode = plan[n] || 'ok';
fs.appendFileSync(path.join(ctl, 'log'), mode + '\\n');
const ev = (o) => process.stdout.write(JSON.stringify({ sessionID: 'ses_fake', timestamp: Date.now(), ...o }) + '\\n');
const step = (id) => ev({ type: 'step_finish', part: { id, type: 'step-finish', tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001 } });
if (mode === 'zero') process.exit(0);
if (mode === 'stall-calls') {
  process.on('SIGTERM', () => {});
  step('prt_1');
  setInterval(() => {}, 1000);
} else {
  ev({ type: 'text', part: { id: 'prt_t', type: 'text', text: 'src/utils/helpers.ts exports formatDate. It has no dependencies.' } });
  step('prt_1');
}
`;
  const p = path.join(binDir, 'opencode');
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

function runBench(
  plan: Mode[],
  extraArgs: string[] = [],
): { status: number | null; out: string; dataDir: string; log: string[] } {
  const root = tmp('cca15-e2e-');
  const binDir = path.join(root, 'bin');
  const ctl = path.join(root, 'ctl');
  fs.mkdirSync(binDir);
  fs.mkdirSync(ctl);
  fs.writeFileSync(path.join(ctl, 'plan'), `${plan.join('\n')}\n`);
  fakeOpencode(binDir, ctl);
  const fakeDist = path.join(root, 'fake-dist-server.js');
  fs.writeFileSync(fakeDist, '// never started by the fake agent\n');
  const dataDir = path.join(root, 'data');
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root, // no rig key store: the key comes from the env
    TMPDIR: os.tmpdir(),
    DEEPSEEK_API_KEY: 'fake-key-not-used',
    BENCH_LIVE_DIST_SERVER: fakeDist,
    BENCH_LIVE_KILL_GRACE_MS: '300',
  };
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(repoRoot, 'scripts', 'bench', 'live', 'run.mts'),
      '--provider',
      'deepseek',
      '--tasks',
      'L1',
      '--arms',
      'vanilla,cc',
      '--data-dir',
      dataDir,
      ...extraArgs,
    ],
    { cwd: repoRoot, env, encoding: 'utf-8', timeout: 90_000 },
  );
  const logPath = path.join(ctl, 'log');
  const log = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
    : [];
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, dataDir, log };
}

function runFile(dataDir: string): Record<string, unknown> | null {
  const runs = path.join(dataDir, 'runs');
  if (!fs.existsSync(runs)) return null;
  const files = fs.readdirSync(runs).filter((f) => f.endsWith('.json'));
  if (files.length !== 1) return null;
  return JSON.parse(fs.readFileSync(path.join(runs, files[0]), 'utf-8')) as Record<string, unknown>;
}

describe.runIf(isPosix)('bench:live retry — end to end with a fake opencode (CCA-15)', () => {
  it('0-call first attempt + successful retry → run file written, retry in the notes', () => {
    const r = runBench(['zero', 'ok', 'ok']);
    expect(r.status, r.out).toBe(0);
    expect(r.log).toEqual(['zero', 'ok', 'ok']);
    const run = runFile(r.dataDir);
    expect(run, r.out).not.toBeNull();
    const notes = (run as { notes: string[] }).notes;
    expect(notes).toContain('retry: vanilla L1 r1 — the model never answered (0 model calls)');
    expect(r.out).toContain('RETRY');
  }, 120_000);

  it('two failed attempts → run voided, no run file', () => {
    const r = runBench(['zero', 'zero']);
    expect(r.status).toBe(1);
    expect(r.log).toEqual(['zero', 'zero']);
    expect(r.out).toContain('vanilla L1: the model never answered (0 model calls)');
    expect(r.out).toContain('Retried once');
    expect(r.out).toContain('No run file written.');
    expect(runFile(r.dataDir)).toBeNull();
  }, 120_000);

  it('timeout with model calls → recorded as a timeout FAIL with partial usage, no retry', () => {
    const r = runBench(['stall-calls', 'ok'], ['--timeout', '1']);
    expect(r.status, r.out).toBe(0);
    expect(r.log).toEqual(['stall-calls', 'ok']); // no third session: no retry
    const run = runFile(r.dataDir) as {
      notes: string[];
      sessions?: unknown;
    } | null;
    expect(run, r.out).not.toBeNull();
    expect((run as { notes: string[] }).notes).toContain('retries: none');
    const raw = JSON.stringify(run);
    expect(raw).toContain('"timeout":true');
    expect(r.out).toMatch(/vanilla\s+L1\s+TIMEOUT/);
    expect(r.out).toContain('tok 100+0c+0w→10'); // partial usage parsed before the kill
  }, 120_000);
});
