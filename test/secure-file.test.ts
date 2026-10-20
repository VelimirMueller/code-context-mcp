/**
 * #248 (TM-08): the db, its -wal/-shm sidecars, every context.db.bak* backup
 * and the export_to_file dump are created 0600 whatever the umask is; an
 * existing group/world-readable db gets one WARN line and is NOT chmod'ed.
 * Mode assertions are POSIX-only (chmod modes are meaningless on Windows).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';
import { resetThrottle } from '../src/sessionlog.js';
import { openDbSecure, writeFileSecure, copyFileSecure } from '../src/secure-file.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const SETUP = path.join(REPO_ROOT, 'src/server/setup.ts');

const POSIX = process.platform !== 'win32';
const itPosix = POSIX ? it : it.skip;

const mode = (file: string): number => fs.statSync(file).mode & 0o777;
const modeStr = (file: string): string => `0${mode(file).toString(8)}`;

// ─── session-log capture (pattern: sessionlog.test.ts) ───────────────────────
const ENV_KEYS = [
  'OVERDRIVE_SESSION_LOG',
  'OVERDRIVE_SESSION_LOG_DIR',
  'CLAUDE_CODE_SESSION_ID',
] as const;
let savedEnv: Record<string, string | undefined>;
let logDir: string;

function readLogLines(): string[] {
  const file = path.join(logDir, 'test-session.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
}

let savedUmask: number;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secure-')), 'sessions');
  delete process.env.OVERDRIVE_SESSION_LOG;
  process.env.OVERDRIVE_SESSION_LOG_DIR = logDir;
  process.env.CLAUDE_CODE_SESSION_ID = 'test-session';
  resetThrottle();
  // macOS default: without the fix everything below lands at 0644.
  savedUmask = process.umask(0o022);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(path.dirname(logDir), { recursive: true, force: true });
  process.umask(savedUmask);
});

describe('openDbSecure — fresh db (#248)', () => {
  itPosix(
    'the db and its -wal/-shm sidecars are 0600 after the first write, umask-independent',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-open-secure-'));
      try {
        const dbPath = path.join(dir, 'context.db');
        const db = openDbSecure(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t (x)');
        db.prepare('INSERT INTO t VALUES (1)').run();
        expect(mode(dbPath)).toBe(0o600);
        expect(mode(dbPath + '-wal')).toBe(0o600);
        expect(mode(dbPath + '-shm')).toBe(0o600);
        db.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  itPosix('a reopened db recreates missing sidecars as 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-open-secure-'));
    try {
      const dbPath = path.join(dir, 'context.db');
      const first = openDbSecure(dbPath);
      first.pragma('journal_mode = WAL');
      first.exec('CREATE TABLE t (x)');
      first.close();
      if (fs.existsSync(dbPath + '-wal')) fs.rmSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.rmSync(dbPath + '-shm');

      const second = openDbSecure(dbPath);
      second.pragma('journal_mode = WAL');
      second.prepare('INSERT INTO t VALUES (2)').run();
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(dbPath + '-wal')).toBe(0o600);
      expect(mode(dbPath + '-shm')).toBe(0o600);
      expect((second.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(1);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openDbSecure — existing loose db (#248)', () => {
  itPosix('is NOT chmod’ed and gets exactly one WARN line in the session log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-open-loose-'));
    try {
      const dbPath = path.join(dir, 'context.db');
      const seed = new Database(dbPath); // plain open: 0644 & ~umask
      seed.close();
      fs.chmodSync(dbPath, 0o644);

      const db = openDbSecure(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (x)');

      expect(modeStr(dbPath)).toBe('0644'); // user file: never changed without notice
      const warns = readLogLines().filter((l) => l.split('\t')[1] === 'WARN');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('secure-db: database is group/world-readable');
      expect(warns[0]).toContain('db=context.db');
      expect(warns[0]).toContain('mode=0644');

      // A second open of the same loose db stays at one WARN (throttled).
      db.close();
      fs.rmSync(dbPath + '-wal', { force: true });
      fs.rmSync(dbPath + '-shm', { force: true });
      const again = openDbSecure(dbPath);
      again.close();
      expect(readLogLines().filter((l) => l.split('\t')[1] === 'WARN')).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itPosix('a tight db logs nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-open-tight-'));
    try {
      const dbPath = path.join(dir, 'context.db');
      fs.closeSync(fs.openSync(dbPath, 'w', 0o600));
      const db = openDbSecure(dbPath);
      db.close();
      expect(readLogLines()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeFileSecure / copyFileSecure (#248)', () => {
  itPosix('the dump is 0600 at creation and on an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-write-secure-'));
    try {
      const dump = path.join(dir, 'code-context-dump.json');
      writeFileSecure(dump, '{"version":"2.0.0"}');
      expect(mode(dump)).toBe(0o600);
      // Overwrite an existing 0644 file: the chmod after the write tightens it.
      fs.chmodSync(dump, 0o644);
      writeFileSecure(dump, '{"version":"2.0.0","tables":{}}');
      expect(mode(dump)).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(dump, 'utf-8')).tables).toEqual({});

      const src = path.join(dir, 'context.db');
      fs.writeFileSync(src, 'db-bytes', { mode: 0o644 });
      fs.chmodSync(src, 0o644);
      const bak = path.join(dir, 'context.db.bak');
      copyFileSecure(src, bak);
      expect(mode(bak)).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('export_to_file dump (#248)', () => {
  type Handler = (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  class FakeServer {
    tools = new Map<string, Handler>();
    tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
      this.tools.set(name, handler);
    }
  }

  itPosix('writes the dump with mode 0600', async () => {
    const db = createTestDb();
    initScrumSchema(db);
    runMigrations(db);
    const server = new FakeServer();
    registerScrumTools(server as never, db);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-export-secure-'));
    // The dump path must sit inside the allowed roots (#250)
    const savedRoots = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = dir;
    try {
      const dump = path.join(dir, 'code-context-dump.json');
      const res = await server.tools.get('export_to_file')!({ output_path: dump });
      expect(res.isError).toBeUndefined();
      expect(mode(dump)).toBe(0o600);
      const parsed = JSON.parse(fs.readFileSync(dump, 'utf-8')) as {
        version: string;
        tables: unknown;
      };
      expect(parsed.version).toBe('2.0.0');
      expect(parsed.tables).toBeTypeOf('object');
    } finally {
      if (savedRoots === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
      else process.env.CODE_CONTEXT_ALLOWED_ROOTS = savedRoots;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setup --force backup (#248)', () => {
  function runSetup(dir: string, ...extra: string[]): string {
    return execFileSync(TSX, [SETUP, dir, '--defaults', ...extra], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      timeout: 120_000,
      env: { ...process.env, CODE_CONTEXT_ALLOWED_ROOTS: dir },
    });
  }

  itPosix(
    'the .bak-<ts> backup and the new context.db are 0600',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-secure-'));
      try {
        fs.writeFileSync(path.join(dir, 'hello.ts'), 'export const hi = 1;\n');
        runSetup(dir);
        const dbPath = path.join(dir, 'context.db');
        expect(modeStr(dbPath)).toBe('0600'); // setup creates the db 0600

        // A pre-fix db: group/world-readable. The backup it becomes must not be.
        fs.chmodSync(dbPath, 0o644);

        runSetup(dir, '--force');
        const backups = fs
          .readdirSync(dir)
          .filter(
            (f) => /^context\.db\.bak-/.test(f) && !f.endsWith('-wal') && !f.endsWith('-shm'),
          );
        expect(backups.length).toBeGreaterThanOrEqual(1);
        for (const bak of backups) expect(modeStr(path.join(dir, bak))).toBe('0600');
        expect(modeStr(dbPath)).toBe('0600'); // the fresh db setup wrote
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
