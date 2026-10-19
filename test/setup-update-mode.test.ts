/**
 * Setup update mode (spec 2026-06-11): existing context.db → migrate + config repair,
 * no re-index/seed/wizard; backup only when migrations pending; --force renames.
 * Spawns the real setup script against a temp project dir (pattern: sprint-archive.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_SCHEMA_VERSION } from '../src/scrum/schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const SETUP = path.join(REPO_ROOT, 'src/server/setup.ts');

function runSetup(dir: string, ...extra: string[]): string {
  return execFileSync(TSX, [SETUP, dir, '--defaults', ...extra], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...process.env, CODE_CONTEXT_ALLOWED_ROOTS: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function countFiles(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const c = (db.prepare('SELECT COUNT(*) c FROM files').get() as any).c;
  db.close();
  return c;
}

describe('setup update mode', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'setup-update-'));
    writeFileSync(path.join(dir, 'hello.ts'), 'export const hi = 1;\n');
    runSetup(dir); // initial full setup
    dbPath = path.join(dir, 'context.db');
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('first run is full setup and creates the DB', () => {
    expect(existsSync(dbPath)).toBe(true);
    expect(countFiles(dbPath)).toBeGreaterThanOrEqual(1);
  });

  it('second run enters update mode: no re-index, no backup when schema is current', () => {
    const filesBefore = countFiles(dbPath);
    writeFileSync(path.join(dir, 'new-file.ts'), 'export const two = 2;\n'); // would be indexed by a full run
    const out = runSetup(dir);
    expect(out).toMatch(/migration mode/i);
    expect(out).toMatch(new RegExp(`up to date \\(v${LATEST_SCHEMA_VERSION}\\)`, 'i'));
    expect(out).not.toMatch(/Indexing target directory/);
    expect(countFiles(dbPath)).toBe(filesBefore); // new-file.ts NOT indexed
    expect(existsSync(dbPath + '.bak')).toBe(false);
  });

  it('backs up and reports when migrations are pending', () => {
    rmSync(dbPath + '.bak', { force: true }); // self-contained fixture: no stale backup from earlier runs
    const db = new Database(dbPath);
    db.prepare('DELETE FROM schema_versions WHERE version > 19').run();
    db.close();
    const out = runSetup(dir);
    expect(out).toMatch(new RegExp(`Migrated v19 → v${LATEST_SCHEMA_VERSION}`, 'i'));
    expect(existsSync(dbPath + '.bak')).toBe(true);
    const vdb = new Database(dbPath, { readonly: true });
    const v = (vdb.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v;
    vdb.close();
    expect(v).toBe(LATEST_SCHEMA_VERSION);
  });

  it('update mode preserves user data', () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO sprints (name, goal, status) VALUES ('Keep Me', 'survives update', 'planning')",
    ).run();
    db.close();
    runSetup(dir);
    const rdb = new Database(dbPath, { readonly: true });
    const row = rdb.prepare("SELECT goal FROM sprints WHERE name='Keep Me'").get() as any;
    rdb.close();
    expect(row.goal).toBe('survives update');
  });

  it('--force renames the old DB instead of deleting it', () => {
    const out = runSetup(dir, '--force');
    expect(out).toMatch(/context\.db\.bak-/);
    const backups = readdirSync(dir).filter((f) => f.startsWith('context.db.bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const rdb = new Database(dbPath, { readonly: true });
    const row = rdb.prepare("SELECT COUNT(*) c FROM sprints WHERE name='Keep Me'").get() as any;
    rdb.close();
    expect(row.c).toBe(0); // fresh DB
  });
});

describe('--force backup WAL handling (discovery #27)', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'setup-force-wal-'));
    writeFileSync(path.join(dir, 'hello.ts'), 'export const hi = 1;\n');
    runSetup(dir);
    dbPath = path.join(dir, 'context.db');
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('checkpoints tail writes into the renamed .bak and keeps SQLite sibling pairing', () => {
    // Leave a committed write in the WAL only: autocheckpoint off + connection
    // held open across the --force run, so nothing checkpoints it for us.
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer
      .prepare(
        "INSERT INTO sprints (name, goal, status) VALUES ('WAL Tail', 'must survive --force backup', 'planning')",
      )
      .run();
    try {
      expect(existsSync(dbPath + '-wal')).toBe(true);

      runSetup(dir, '--force');

      const entries = readdirSync(dir);
      const bak = entries.find(
        (f) => /^context\.db\.bak-/.test(f) && !f.endsWith('-wal') && !f.endsWith('-shm'),
      );
      expect(bak).toBeDefined();

      // Pre-fix naming (context.db-wal.bak-<ts>) breaks SQLite pairing — must be gone.
      expect(entries.some((f) => /^context\.db-wal\.bak-/.test(f))).toBe(false);

      // The .bak alone holds the tail write (WAL was checkpointed before the rename).
      const bakDb = new Database(path.join(dir, bak!), { readonly: true });
      const row = bakDb.prepare("SELECT goal FROM sprints WHERE name = 'WAL Tail'").get() as any;
      bakDb.close();
      expect(row?.goal).toBe('must survive --force backup');
    } finally {
      writer.close();
    }
  }, 120_000);
});

describe('setup writes the tool profile into .mcp.json (#178)', () => {
  let dir: string;
  const entry = () =>
    JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf-8')).mcpServers['code-context'];
  const writeEntry = (e: Record<string, unknown>) =>
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'code-context': e, other: { command: 'x' } } }),
    );

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'setup-profile-'));
    writeFileSync(path.join(dir, 'hello.ts'), 'export const hi = 1;\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a fresh setup turns the sprint process on: CODE_CONTEXT_PROFILE=full', () => {
    const out = runSetup(dir);
    expect(entry().env).toEqual({ CODE_CONTEXT_PROFILE: 'full' });
    expect(out).toMatch(/Tool profile: full/);
  }, 120_000);

  it('update mode keeps an existing setting and the other keys of the entry', () => {
    writeEntry({
      command: 'old',
      args: [],
      type: 'stdio',
      env: { CODE_CONTEXT_PROFILE: 'code', FOO: '1' },
    });
    const out = runSetup(dir);
    const e = entry();
    expect(e.env).toEqual({ CODE_CONTEXT_PROFILE: 'code', FOO: '1' });
    expect(e.type).toBe('stdio');
    expect(e.command).toBe('node');
    expect(JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf-8')).mcpServers.other).toEqual(
      { command: 'x' },
    );
    expect(out).toMatch(/Sprint tools are off.*CODE_CONTEXT_PROFILE=full/);
  }, 120_000);

  it('a 2.x install without a setting gets full, so it keeps its sprint tools', () => {
    writeEntry({ command: 'node', args: [] });
    runSetup(dir);
    expect(entry().env).toEqual({ CODE_CONTEXT_PROFILE: 'full' });
  }, 120_000);

  it('an unknown kept profile is replaced with full', () => {
    writeEntry({ command: 'node', args: [], env: { CODE_CONTEXT_PROFILE: 'sprint' } });
    const out = runSetup(dir);
    expect(entry().env).toEqual({ CODE_CONTEXT_PROFILE: 'full' });
    expect(out).toMatch(/Tool profile: full/);
  }, 120_000);

  it('a 2.x lean install (CODE_CONTEXT_TOOLSETS=code) stays lean', () => {
    writeEntry({ command: 'node', args: [], env: { CODE_CONTEXT_TOOLSETS: 'code' } });
    runSetup(dir);
    expect(entry().env).toEqual({ CODE_CONTEXT_TOOLSETS: 'code' });
  }, 120_000);

  it('--profile wins over an existing setting and is not taken as the path', () => {
    execFileSync(TSX, [SETUP, '--profile', 'code', dir, '--defaults'], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      timeout: 120_000,
      env: { ...process.env, CODE_CONTEXT_ALLOWED_ROOTS: dir },
    });
    expect(entry().env.CODE_CONTEXT_PROFILE).toBe('code');
    runSetup(dir, '--profile=full');
    expect(entry().env.CODE_CONTEXT_PROFILE).toBe('full');
  }, 120_000);

  it('an unknown --profile is refused before anything is written', () => {
    const fresh = mkdtempSync(path.join(tmpdir(), 'setup-badprofile-'));
    try {
      expect(() => runSetup(fresh, '--profile', 'sprint')).toThrow();
      expect(existsSync(path.join(fresh, 'context.db'))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }, 120_000);
});
