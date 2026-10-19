import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, rmSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  discoverRepos,
  runReindex,
  purgeDenied,
  pruneMissing,
  IGNORE_MARKER,
} from '../src/server/reindex.js';
import { parseArgs, formatSummary } from '../src/server/reindex-cli.js';
import { createTestDb } from './helpers/db.js';
import { git, write, commitAll } from './helpers/git-repo.js';

let root: string;
let db: Database.Database;
const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;

function repo(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-reindex-')));
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
  db = createTestDb();
});
afterEach(() => {
  delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('discoverRepos', () => {
  it('finds child checkouts, skips dot-dirs, plain dirs and marked repos', () => {
    const a = repo('alpha');
    const b = repo('beta');
    repo('.worktrees');
    mkdirSync(path.join(root, 'not-a-repo'));
    writeFileSync(path.join(b, IGNORE_MARKER), '');
    expect(discoverRepos(root)).toEqual({ repos: [a], marked: [b] });
  });
});

describe('runReindex', () => {
  it('indexes every repo, purges marked ones and policy rows, reports before/after', () => {
    const a = repo('alpha');
    write(a, 'src/a.ts', 'export const a = 1;\n');
    commitAll(a);
    const b = repo('retired');
    const bFile = write(b, 'x.ts', 'export const x = 1;\n');
    commitAll(b);
    // Legacy rows the old indexer wrote: a vendor file and the now-retired repo.
    db.prepare(
      `INSERT INTO files (path, language, extension, size_bytes, line_count, content) VALUES (?, 'php', '.php', 10, 1, 'x')`,
    ).run(path.join(a, 'vendor/laravel/A.php'));
    db.prepare(
      `INSERT INTO files (path, language, extension, size_bytes, line_count, content) VALUES (?, 'ts', '.ts', 10, 1, 'x')`,
    ).run(bFile);
    writeFileSync(path.join(b, IGNORE_MARKER), '');

    const lines: string[] = [];
    const s = runReindex(db, { root, progress: (l) => lines.push(l) });
    expect(s.ok).toBe(true);
    expect(s.before).toMatchObject({ files: 2, depFiles: 1, reposCovered: 2 });
    expect(s.after).toMatchObject({ files: 1, depFiles: 0, reposCovered: 1 });
    expect(s.purgedDenied).toBe(1);
    expect(s.purgedMarked).toEqual([{ root: b, files: 1 }]);
    expect(s.repos.map((r) => [path.basename(r.root), r.files])).toEqual([['alpha', 1]]);
    expect(count(`SELECT COUNT(*) c FROM indexed_repos`)).toBe(1);
    expect(lines.some((l) => l.startsWith('skip  retired'))).toBe(true);
    expect(formatSummary(s)).toContain('1/1 repos indexed');
  });

  it('reports a failing repo and returns ok=false', () => {
    const a = repo('alpha');
    write(a, 'a.ts', '1\n');
    commitAll(a);
    delete process.env.CODE_CONTEXT_ALLOWED_ROOTS; // the sandbox now refuses the repo
    const s = runReindex(db, { root, repos: [a] });
    expect(s.ok).toBe(false);
    expect(s.repos[0].error).toMatch(/Refusing to index/);
    expect(formatSummary(s)).toContain('FAILED: alpha');
  });
});

describe('pruneMissing / purgeDenied', () => {
  it('drops repos and files that no longer exist on disk', () => {
    const gone = path.join(root, 'gone');
    db.prepare(`INSERT INTO indexed_repos (root, head, file_count) VALUES (?, NULL, 1)`).run(gone);
    db.prepare(`INSERT INTO files (path, size_bytes) VALUES (?, 1)`).run(path.join(gone, 'a.ts'));
    db.prepare(`INSERT INTO files (path, size_bytes) VALUES (?, 1)`).run(
      path.join(root, 'missing.ts'),
    );
    const r = pruneMissing(db);
    expect(r.repos).toBe(1);
    expect(r.files).toBe(2);
    expect(count(`SELECT COUNT(*) c FROM files`)).toBe(0);
  });

  it('purges denied rows with their change-log entries, keeps source', () => {
    const a = repo('alpha');
    const keep = path.join(a, 'src/a.ts');
    const lock = path.join(a, 'package-lock.json');
    for (const p of [keep, lock, path.join(a, 'node_modules/x/i.js')]) {
      db.prepare(`INSERT INTO files (path, size_bytes) VALUES (?, 1)`).run(p);
      db.prepare(`INSERT INTO changes (file_path, event) VALUES (?, 'add')`).run(p);
    }
    expect(purgeDenied(db)).toBe(2);
    expect(
      (db.prepare(`SELECT path FROM files`).all() as { path: string }[]).map((r) => r.path),
    ).toEqual([keep]);
    expect(count(`SELECT COUNT(*) c FROM changes`)).toBe(1);
  });
});

describe('CLI args', () => {
  it('parses repos, flags and ~ paths; rejects unknown options', () => {
    const a = parseArgs([
      '--root',
      '~/x',
      '--db',
      '/tmp/c.db',
      '--prune-missing',
      '--vacuum',
      'repoA',
    ]);
    expect(typeof a).toBe('object');
    if (typeof a === 'object') {
      expect(a.root.endsWith('/x')).toBe(true);
      expect(a.root.startsWith('~')).toBe(false);
      expect(a.db).toBe('/tmp/c.db');
      expect(a.pruneMissing && a.vacuum).toBe(true);
      expect(a.repos).toEqual([path.resolve('repoA')]);
    }
    expect(parseArgs(['--all'])).toMatchObject({ repos: [] });
    expect(parseArgs(['--nope'])).toBe('unknown option --nope');
    expect(parseArgs(['--root'])).toBe('--root needs a directory');
  });

  it('defaults --root to the current directory', () => {
    const a = parseArgs([]);
    expect(typeof a).toBe('object');
    if (typeof a === 'object') expect(a.root).toBe(path.resolve(process.cwd()));
  });
});

describe('CLI end to end (non-TTY)', () => {
  it('indexes, prints a plain summary with no art, exits 0', async () => {
    const { spawnSync } = await import('node:child_process');
    const a = repo('alpha');
    write(a, 'a.ts', 'export const a = 1;\n');
    commitAll(a);
    const dbFile = path.join(root, 'ctx.db');
    const cli = path.resolve(__dirname, '../src/server/reindex-cli.ts');
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, '--root', root, '--db', dbFile, '--prune-missing'],
      {
        encoding: 'utf-8',
        env: { ...process.env, OVERDRIVE_FLAIR: '1', OVERDRIVE_SESSION_LOG: '0' },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1/1 repos indexed');
    expect(r.stdout).not.toMatch(/░▒▓|\x1b\[/);
    const bad = spawnSync(process.execPath, ['--import', 'tsx', cli, '--bogus'], {
      encoding: 'utf-8',
    });
    expect(bad.status).toBe(2);
  });
});
