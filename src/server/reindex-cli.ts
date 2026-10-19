#!/usr/bin/env node
// code-context-reindex — re-index every git repo under a root into one db.
//
//   code-context-reindex [--all | <repo-path>…] [--root <dir>] [--db <file>]
//                        [--prune-missing] [--vacuum] [--quiet]
//
// No repo paths = --all. --root defaults to the current directory.
// Repos with a `.code-context-ignore` file are skipped
// and their rows purged; dot-directories (.worktrees) are never descended into.
// Exit 0 when every repo indexed, 1 when any failed, 2 on bad usage.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import { runReindex, type ReindexSummary } from './reindex.js';
import { log as slog } from '../sessionlog.js';
import { flairFooter } from './tool-wrap.js';

// ─── Flair (overdrive FLAIR.md): TTY only, never with --quiet, OVERDRIVE_FLAIR=0 off ──
const QUIPS = [
  '[ jacking in... ]',
  '[ hack the planet ]',
  '[ there is no spoon ]',
  "[ it's a unix system, I know this ]",
];
function flair(quiet: boolean) {
  const on = !quiet && process.stdout.isTTY === true && process.env.OVERDRIVE_FLAIR !== '0';
  const color = on && !process.env.NO_COLOR;
  const c = (rgb: string, s: string) => (color ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : s);
  return {
    banner: () =>
      on &&
      console.log(
        `${c('238;79;255', '●')} ${c('0;255;247', 'code-context')} ${c('238;79;255', '▸ reindex ░▒▓')}  ${c('90;80;130', QUIPS[process.pid % QUIPS.length])}`,
      ),
    div: () => on && console.log(c('90;80;130', '─'.repeat(60))),
    done: (ok: boolean, ms: number) =>
      on && console.log(c(ok ? '5;255;161' : '255;42;109', flairFooter(ms, !ok))),
  };
}

const USAGE =
  'usage: code-context-reindex [--all | <repo-path>...] [--root <dir>] [--db <file>] [--prune-missing] [--vacuum] [--quiet]\n' +
  '  --root <dir>  directory to scan for git repos (default: the current directory)';

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

interface Args {
  root: string;
  db: string;
  repos: string[];
  pruneMissing: boolean;
  vacuum: boolean;
  quiet: boolean;
}

export function parseArgs(argv: string[]): Args | string {
  const a: Args = {
    root: process.cwd(),
    db: process.env.CODE_CONTEXT_DB || './context.db',
    repos: [],
    pruneMissing: false,
    vacuum: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    if (arg === '--all') continue;
    else if (arg === '--prune-missing') a.pruneMissing = true;
    else if (arg === '--vacuum') a.vacuum = true;
    else if (arg === '--quiet' || arg === '-q') a.quiet = true;
    else if (arg === '--root') {
      const v = next();
      if (!v) return '--root needs a directory';
      a.root = expandHome(v);
    } else if (arg === '--db') {
      const v = next();
      if (!v) return '--db needs a file';
      a.db = expandHome(v);
    } else if (arg === '-h' || arg === '--help') return 'help';
    else if (arg.startsWith('-')) return `unknown option ${arg}`;
    else a.repos.push(path.resolve(expandHome(arg)));
  }
  a.root = path.resolve(a.root);
  a.db = path.resolve(a.db);
  return a;
}

const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;
const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)} %` : '0 %');

export function formatSummary(s: ReindexSummary): string {
  const lines = [
    `files       ${s.before.files} → ${s.after.files}`,
    `deps share  ${s.before.depFiles} (${pct(s.before.depFiles, s.before.files)}) → ${s.after.depFiles} (${pct(s.after.depFiles, s.after.files)})`,
    `repos       ${s.before.reposCovered} → ${s.after.reposCovered} covered under the root`,
    `purged      ${s.purgedDenied} policy rows, ${s.purgedMarked.reduce((n, m) => n + m.files, 0)} rows from ${s.purgedMarked.length} marked repos`,
    `pruned      ${s.prunedMissing.repos} missing repos, ${s.prunedMissing.files} missing files`,
  ];
  if (s.before.bytes)
    lines.push(`db size     ${mb(s.before.bytes)} → ${mb(s.after.bytes)} (db + wal)`);
  const failed = s.repos.filter((r) => r.error);
  lines.push(
    `result      ${s.repos.length - failed.length}/${s.repos.length} repos indexed${failed.length ? `, FAILED: ${failed.map((f) => path.basename(f.root)).join(', ')}` : ''}`,
  );
  return lines.join('\n');
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    if (parsed === 'help') {
      console.log(USAGE);
      return 0;
    }
    console.error(`code-context-reindex: ${parsed}\n${USAGE}`);
    return 2;
  }
  if (!fs.existsSync(path.dirname(parsed.db))) {
    console.error(`code-context-reindex: db directory does not exist: ${path.dirname(parsed.db)}`);
    return 2;
  }
  // An operator-run CLI: the repos it is pointed at are the allowed roots.
  const allowed = [parsed.root, ...parsed.repos];
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = [process.env.CODE_CONTEXT_ALLOWED_ROOTS, ...allowed]
    .filter(Boolean)
    .join(',');

  const start = Date.now();
  const art = flair(parsed.quiet);
  art.banner();
  const db = new Database(parsed.db);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 15000');
    initSchema(db);
    const summary = runReindex(db, {
      root: parsed.root,
      repos: parsed.repos,
      pruneMissing: parsed.pruneMissing,
      vacuum: parsed.vacuum,
      dbPath: parsed.db,
      progress: parsed.quiet ? undefined : (l) => console.log(l),
    });
    art.div();
    console.log(formatSummary(summary));
    const ms = Date.now() - start;
    art.done(summary.ok, ms);
    slog(
      summary.ok ? 'INFO' : 'WARN',
      `reindex: repos=${summary.repos.length} failed=${summary.repos.filter((r) => r.error).length} files=${summary.after.files} purged=${summary.purgedDenied}`,
    );
    slog('INFO', `done reindex in ${ms} ms`);
    return summary.ok ? 0 : 1;
  } catch (err) {
    console.error(`code-context-reindex: ${err instanceof Error ? err.message : String(err)}`);
    slog('CRITICAL', `reindex: failed error=${err instanceof Error ? err.name : typeof err}`);
    return 1;
  } finally {
    db.close();
  }
}

// Run only as a program, never on import (tests import parseArgs).
let invoked = '';
try {
  invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
} catch {
  /* argv[1] is not a real path (some runners): not invoked as a program */
}
if (
  invoked.endsWith(`${path.sep}reindex-cli.js`) ||
  invoked.endsWith(`${path.sep}reindex-cli.ts`)
) {
  process.exitCode = main();
}
