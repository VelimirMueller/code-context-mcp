/**
 * Deterministic checkers for the live bench task set (PLAN.md task 6).
 *
 * Checkers take `(workspaceDir, finalAnswer)` and return `{ pass, detail }` —
 * no model, no opencode, no network. Symbol detection reuses `parseExports`
 * from src/server/indexer.ts instead of reimplementing it. Hidden check
 * files are copied into the workspace only at check time, never before.
 * The tests checker runs vitest with a harness-owned config outside the
 * workspace (`--config` + `--root`, see vitest.trusted.config.mts), so
 * agent-authored workspace config is never loaded.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExports } from '../../../src/server/indexer.js';
import { checkerSpawnEnv } from './sandbox.mts';
import type { LiveTask } from './tasks.mts';

export interface CheckResult {
  pass: boolean;
  detail: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const CHECKS_DIR = path.join(scriptDir, 'checks');
const CHECK_TIMEOUT_MS = 120_000;

/** Lowercase, strip quotes/backticks, forward slashes, collapse whitespace. */
export function normaliseAnswer(answer: string): string {
  return answer.toLowerCase().replace(/[`"']/g, '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

function checkAnswer(task: LiveTask, finalAnswer: string): CheckResult {
  const norm = normaliseAnswer(finalAnswer);
  if (!norm) return { pass: false, detail: 'empty final answer' };
  const missing: string[] = [];
  for (const source of (task.checker as { answerMustMatch: string[] }).answerMustMatch) {
    let re: RegExp;
    try {
      re = new RegExp(source);
    } catch {
      // A bad pattern is a checker bug, not a crash of the whole live run:
      // fail this task with a clear reason instead.
      return { pass: false, detail: `invalid checker pattern /${source}/` };
    }
    if (!re.test(norm)) missing.push(`/${source}/`);
  }
  return missing.length === 0
    ? { pass: true, detail: 'answer matches all patterns' }
    : { pass: false, detail: `answer missing: ${missing.join(' ')}` };
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function checkSymbol(task: LiveTask, workspaceDir: string): CheckResult {
  const { symbol, barrel } = task.checker as { symbol: string; barrel: string };
  const srcDir = path.join(workspaceDir, 'src');
  if (!fs.existsSync(srcDir)) return { pass: false, detail: 'no src/ directory in workspace' };

  const definers: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const exports = parseExports(fs.readFileSync(file, 'utf-8'));
    if (exports.some((e) => e.name === symbol)) {
      definers.push(path.relative(workspaceDir, file));
    }
  }
  if (definers.length === 0) {
    return { pass: false, detail: `no workspace file exports ${symbol}` };
  }

  const barrelPath = path.join(workspaceDir, barrel);
  if (!fs.existsSync(barrelPath)) {
    return {
      pass: false,
      detail: `barrel ${barrel} not found (defined in ${definers.join(', ')})`,
    };
  }
  const barrelExports = parseExports(fs.readFileSync(barrelPath, 'utf-8'));
  if (!barrelExports.some((e) => e.name === symbol)) {
    return {
      pass: false,
      detail: `${barrel} does not re-export ${symbol} (defined in ${definers.join(', ')})`,
    };
  }
  return {
    pass: true,
    detail: `${symbol} defined in ${definers.join(', ')} and re-exported from ${barrel}`,
  };
}

async function checkTests(task: LiveTask, workspaceDir: string): Promise<CheckResult> {
  const { checkFile } = task.checker as { checkFile: string };
  const source = path.join(CHECKS_DIR, checkFile);
  if (!fs.existsSync(source))
    return { pass: false, detail: `hidden check file missing: ${checkFile}` };

  const targetDir = path.join(workspaceDir, 'test');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, checkFile);
  fs.copyFileSync(source, target);

  const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitestBin)) {
    return { pass: false, detail: 'vitest not installed in the repo (npm ci first)' };
  }

  // Config containment (security audit 2026-10-10): vitest runs with a
  // harness-owned config passed EXPLICITLY (--config, this file lives in the
  // repo, outside every workspace) and --root pinned to the workspace, so an
  // agent-authored vitest.config.*/vitest.workspace.* in the workspace is
  // never loaded — its globalSetup/setupFiles cannot run.
  const trustedConfig = path.join(CHECKS_DIR, 'vitest.trusted.config.mts');

  // The code under test was written by the model and is untrusted: run it in a
  // fresh fake HOME with a scrubbed env (no provider keys, no GITHUB_TOKEN),
  // cwd inside the temp workspace, and a hard timeout that kills the process
  // group (SIGTERM then SIGKILL) so a hung test cannot outlive the checker.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-check-home-'));
  const { code, tail } = await new Promise<{ code: number | null; tail: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        vitestBin,
        'run',
        '--config',
        trustedConfig,
        '--root',
        workspaceDir,
        path.join('test', checkFile),
      ],
      {
        cwd: workspaceDir,
        env: checkerSpawnEnv({ fakeHome }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let timedOut = false;
    let closed = false; // guards the SIGKILL timer against a recycled pid
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));

    let settled = false; // 'error' and 'close' can both fire; resolve once
    let killTimer: NodeJS.Timeout | undefined;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        if (closed) return;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000);
    }, CHECK_TIMEOUT_MS);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      closed = true;
      clearTimeout(killer);
      clearTimeout(killTimer);
      const out = Buffer.concat([...stdout, ...stderr]).toString('utf-8');
      resolve({ code: timedOut ? null : code, tail: out.slice(-600) });
    };
    child.on('close', finish);
    child.on('error', () => finish(null));
  });

  fs.rmSync(fakeHome, { recursive: true, force: true });

  return code === 0
    ? { pass: true, detail: `hidden check passed (${checkFile})` }
    : {
        pass: false,
        detail: `hidden check failed (exit ${code ?? 'timeout'}): …${tail.replace(/\s+/g, ' ').slice(-300)}`,
      };
}

// ---- ladder checkers (L4–L6): expected answers are COMPUTED from source ----

/** Every .ts/.tsx/.mts file under `<root>/src`, skipping node_modules. */
function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

const rel = (root: string, f: string): string => path.relative(root, f).split(path.sep).join('/');
const stripExt = (p: string): string => p.replace(/\.(ts|tsx|mts|js|mjs)$/, '');
const wordRe = (name: string, flags = ''): RegExp =>
  new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, flags);

const IMPORT_SPEC_RES = [
  /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s+['"]([^'"]+)['"]/g,
];

/** Workspace files that import or re-export `target` (relative specifiers only). */
export function importersOf(root: string, target: string): string[] {
  const want = stripExt(target);
  const hits: string[] = [];
  for (const f of srcFiles(root)) {
    const src = fs.readFileSync(f, 'utf-8');
    const specs = IMPORT_SPEC_RES.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));
    const hit = specs.some(
      (sp) => sp.startsWith('.') && stripExt(rel(root, path.resolve(path.dirname(f), sp))) === want,
    );
    if (hit && rel(root, f) !== target) hits.push(rel(root, f));
  }
  return hits.sort();
}

/** File paths named in an answer, normalised to `src/…`. */
function answerPaths(answer: string): Set<string> {
  const out = new Set<string>();
  for (const m of answer
    .replace(/\\/g, '/')
    .matchAll(/(?:\.\/)?((?:src\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|mts))/g)) {
    out.add(m[1].startsWith('src/') ? m[1] : `src/${m[1]}`);
  }
  return out;
}

function checkImporters(task: LiveTask, ws: string, finalAnswer: string): CheckResult {
  const { target, maxExtra } = task.checker as { target: string; maxExtra: number };
  const expected = importersOf(ws, target);
  if (expected.length === 0) {
    return { pass: false, detail: `fixture drifted: nothing imports ${target} any more` };
  }
  const named = answerPaths(finalAnswer);
  named.delete(target);
  const missing = expected.filter((f) => !named.has(f));
  const extra = [...named].filter((f) => !expected.includes(f));
  const pass = expected.length > 0 && missing.length === 0 && extra.length <= maxExtra;
  return {
    pass,
    detail:
      `${expected.length - missing.length}/${expected.length} importers found, ${extra.length} extra` +
      (missing.length ? `; missing ${missing.join(', ')}` : '') +
      (extra.length ? `; extra ${extra.join(', ')}` : ''),
  };
}

function countWord(files: string[], name: string): number {
  return files.reduce(
    (n, f) => n + (fs.readFileSync(f, 'utf-8').match(wordRe(name, 'g'))?.length ?? 0),
    0,
  );
}

function checkRename(task: LiveTask, ws: string): CheckResult {
  const { from, to, definedIn } = task.checker as { from: string; to: string; definedIn: string };
  // The workspace is a copy of this repo's src/, so the pristine counts come from the repo.
  const pristine = srcFiles(repoRoot);
  const wantTo = countWord(pristine, from) + countWord(pristine, to);
  const files = srcFiles(ws);
  const leftFrom = countWord(files, from);
  const gotTo = countWord(files, to);
  const defPath = path.join(ws, definedIn);
  const defines =
    fs.existsSync(defPath) &&
    parseExports(fs.readFileSync(defPath, 'utf-8')).some((e) => e.name === to);
  const pass = leftFrom === 0 && gotTo === wantTo && defines;
  return {
    pass,
    detail: `${from} left: ${leftFrom}; ${to}: ${gotTo}/${wantTo}; ${definedIn} exports ${to}: ${defines ? 'yes' : 'no'}`,
  };
}

// Exactly the four forms the L6 prompt names; "appears" = any whole-word
// mention in another file's text, as the prompt defines it.
const EXPORT_DECL_RE = /^export (?:async )?(?:function|const|class) ([\w$]+)/gm;

/** Exports of `<dir>/*.ts` (top level only) that no other src file references by name. */
export function deadExportsOf(
  root: string,
  dir: string,
): { universe: Set<string>; dead: Set<string> } {
  const files = srcFiles(root);
  const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf-8')]));
  const universe = new Set<string>();
  const dead = new Set<string>();
  for (const f of files) {
    if (path.dirname(rel(root, f)) !== dir) continue;
    for (const m of (texts.get(f) ?? '').matchAll(EXPORT_DECL_RE)) {
      const name = m[1];
      universe.add(name);
      const re = wordRe(name);
      if (![...texts].some(([g, t]) => g !== f && re.test(t))) dead.add(name);
    }
  }
  return { universe, dead };
}

function checkDeadExports(task: LiveTask, ws: string, finalAnswer: string): CheckResult {
  const { dir, minRecall, minPrecision } = task.checker as {
    dir: string;
    minRecall: number;
    minPrecision: number;
  };
  const { universe, dead } = deadExportsOf(ws, dir);
  // Case-sensitive: identifiers are compared as written.
  const named = new Set(
    [...finalAnswer.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((t) => universe.has(t)),
  );
  const hit = [...named].filter((n) => dead.has(n)).length;
  const recall = dead.size ? hit / dead.size : 0;
  const precision = named.size ? hit / named.size : 0;
  const pct = (x: number): string => `${Math.round(x * 100)} %`;
  return {
    pass: recall >= minRecall && precision >= minPrecision,
    detail: `${hit}/${dead.size} dead exports named, ${named.size - hit} wrong; recall ${pct(recall)}, precision ${pct(precision)}`,
  };
}

export async function runChecker(
  task: LiveTask,
  workspaceDir: string,
  finalAnswer: string,
): Promise<CheckResult> {
  switch (task.checker.type) {
    case 'answer':
      return checkAnswer(task, finalAnswer);
    case 'symbol':
      return checkSymbol(task, workspaceDir);
    case 'tests':
      return checkTests(task, workspaceDir);
    case 'importers':
      return checkImporters(task, workspaceDir, finalAnswer);
    case 'rename':
      return checkRename(task, workspaceDir);
    case 'dead-exports':
      return checkDeadExports(task, workspaceDir, finalAnswer);
  }
}
