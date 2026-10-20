/**
 * #245 (TM-04): the bridge hook reads its db path from configuration only —
 * never from a directory walk. A `context.db` planted in a subdirectory is
 * ignored, a configured db is honoured, and a db not owned by the current
 * user (or a symlink) is refused with one WARN on stderr.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { resolveDbPath, dbFromArgs, validateDbPath, runHook } from '../src/bridge/hook.js';

const POSIX = process.platform !== 'win32';
const itPosix = POSIX ? it : it.skip;

const tmpDirs: string[] = [];

function tmpdir(prefix = 'cc-hook-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Create a real on-disk db with the scrum schema. */
function makeDb(dir: string, name = 'context.db'): string {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initScrumSchema(db);
  runMigrations(db);
  db.close();
  return dbPath;
}

function insertPending(dbPath: string, action: string): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO pending_actions (action, entity_type, entity_id, payload, status, source, created_at)
     VALUES (?, NULL, NULL, NULL, 'pending', 'dashboard', datetime('now'))`,
  ).run(action);
  db.close();
}

describe('dbFromArgs', () => {
  it('parses --db <path> and --db=<path>', () => {
    expect(dbFromArgs(['--db', '/x/y.db'])).toBe('/x/y.db');
    expect(dbFromArgs(['--db=/x/y.db'])).toBe('/x/y.db');
    expect(dbFromArgs(['--db'])).toBeNull();
    expect(dbFromArgs([])).toBeNull();
  });
});

describe('resolveDbPath', () => {
  it('prefers CODE_CONTEXT_DB', () => {
    const dir = tmpdir();
    const db = path.join(dir, 'env.db');
    const got = resolveDbPath({
      args: ['--db', '/other.db'],
      env: { CODE_CONTEXT_DB: db },
      cwd: dir,
    });
    expect(got).toBe(db);
  });

  it('falls back to the --db argument', () => {
    const dir = tmpdir();
    const got = resolveDbPath({ args: ['--db', '/abs/context.db'], env: {}, cwd: dir });
    expect(got).toBe(path.resolve('/abs/context.db'));
  });

  it('ignores a cwd-relative .mcp.json (no fallback, #245 follow-up)', () => {
    const dir = tmpdir('hook-mcp-');
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'code-context': { command: 'node', args: ['x', 'context.db'] } },
      }),
    );
    expect(resolveDbPath({ args: [], env: {}, cwd: dir })).toBeNull();
  });

  it('returns null with no configuration (no directory walk)', () => {
    const dir = tmpdir();
    expect(resolveDbPath({ args: [], env: {}, cwd: dir })).toBeNull();
  });
});

describe('validateDbPath', () => {
  it('accepts a regular file owned by the current user', () => {
    const dir = tmpdir();
    expect(validateDbPath(makeDb(dir))).toEqual({ ok: true });
  });

  itPosix('refuses a symlink', () => {
    const dir = tmpdir();
    const real = makeDb(dir, 'real.db');
    const link = path.join(dir, 'link.db');
    fs.symlinkSync(real, link);
    expect(validateDbPath(link)).toEqual({ ok: false, reason: 'symlink' });
  });

  itPosix('refuses a db owned by another uid', () => {
    const dir = tmpdir();
    const db = makeDb(dir);
    const uid = process.getuid() ?? 0;
    const spy = vi.spyOn(fs, 'statSync').mockReturnValue({ uid: uid + 1 } as unknown as fs.Stats);
    expect(validateDbPath(db)).toEqual({ ok: false, reason: 'owner' });
    spy.mockRestore();
  });
});

describe('runHook', () => {
  it('ignores a planted sub/context.db when no db is configured', () => {
    const dir = tmpdir();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    insertPending(makeDb(sub), 'update_ticket');

    const result = runHook({ args: [], env: {}, cwd: sub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('injects actions from a configured db', () => {
    const dir = tmpdir();
    const db = makeDb(dir);
    insertPending(db, 'update_ticket');

    const result = runHook({ args: ['--db', db], env: {}, cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('update_ticket');
  });

  itPosix('refuses a db owned by another uid with one WARN on stderr', () => {
    const dir = tmpdir();
    const db = makeDb(dir);
    insertPending(db, 'update_ticket');

    const uid = process.getuid() ?? 0;
    const spy = vi.spyOn(fs, 'statSync').mockReturnValue({ uid: uid + 1 } as unknown as fs.Stats);
    const result = runHook({ args: ['--db', db], env: {}, cwd: dir });
    spy.mockRestore();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    const warns = result.stderr.split('\n').filter((l) => l.includes('WARN'));
    expect(warns).toHaveLength(1);
  });
});
