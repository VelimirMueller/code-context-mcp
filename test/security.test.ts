import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexDirectory, resolveImportPath } from '../src/server/indexer.js';
import { initSchema } from '../src/server/schema.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/sample-project');

function createFullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  initScrumSchema(db);
  runMigrations(db);
  return db;
}

describe('Security: .env files excluded from indexing', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullDb();
    indexDirectory(db, FIXTURE_DIR);
  });

  it('should not index .env files', () => {
    const envFiles = db.prepare(`SELECT path FROM files WHERE path LIKE '%/.env%'`).all();
    expect(envFiles).toHaveLength(0);
  });

  it('should not store .env content in the database', () => {
    const rows = db.prepare(`SELECT content FROM files WHERE content LIKE '%SECRET_KEY%'`).all();
    expect(rows).toHaveLength(0);
  });

  it('should still index non-dotfiles', () => {
    const count = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
    expect(count).toBeGreaterThan(0);
  });
});

describe('Security: SQL injection prevention in restore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullDb();
  });

  it('should reject columns not in schema when restoring', () => {
    // Build column whitelist from schema (same logic as restore)
    const info = db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
    const validCols = new Set(info.map((c) => c.name));

    const maliciousCol = 'id"; DROP TABLE agents; --';
    expect(validCols.has(maliciousCol)).toBe(false);

    // Simulate the filtering logic
    const inputCols = ['name', 'role', maliciousCol];
    const safeCols = inputCols.filter((c) => validCols.has(c));
    expect(safeCols).not.toContain(maliciousCol);
    expect(safeCols).toContain('name');
    expect(safeCols).toContain('role');
  });
});

describe('Security: content column filtered from file API responses', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullDb();
    indexDirectory(db, FIXTURE_DIR);
  });

  it('should have content in files table (internal storage)', () => {
    const row = db.prepare(`SELECT content FROM files LIMIT 1`).get() as
      | { content: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.content.length).toBeGreaterThan(0);
  });

  it('should be possible to query files without content column', () => {
    const row = db
      .prepare(
        `SELECT id, path, language, extension, size_bytes, line_count, summary, description, external_imports, created_at, modified_at, indexed_at FROM files LIMIT 1`,
      )
      .get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('content');
  });
});

describe('Security: request body size limit constant exists', () => {
  it('should define MAX_BODY_BYTES', async () => {
    // Verify the constant is in the dashboard source
    const fs = await import('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/dashboard/dashboard.ts'), 'utf-8');
    expect(src).toContain('MAX_BODY_BYTES');
    expect(src).toContain('Request body too large');
  });
});

describe('Security: localhost binding configured', () => {
  it('should bind server to 127.0.0.1', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/dashboard/dashboard.ts'), 'utf-8');
    expect(src).toContain('server.listen(port, "127.0.0.1"');
  });

  it('should set security headers', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/dashboard/dashboard.ts'), 'utf-8');
    expect(src).toContain('X-Content-Type-Options');
    expect(src).toContain('X-Frame-Options');
    expect(src).toContain('X-XSS-Protection');
  });
});

describe('Security: path traversal in resolveImportPath (#14)', () => {
  it('resolves a legitimate relative import inside rootDir', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-root-'));
    try {
      const fromFile = path.join(root, 'a.ts');
      writeFileSync(fromFile, '');
      writeFileSync(path.join(root, 'b.ts'), 'export const x = 1;');
      expect(resolveImportPath('./b', fromFile, root)).toBe(path.join(root, 'b.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a relative import that escapes rootDir via ../', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'cc-out-'));
    try {
      const secret = path.join(outside, 'secret.ts');
      writeFileSync(secret, 'export const s = 1;');
      const fromFile = path.join(root, 'a.ts');
      const escaping = path.relative(path.dirname(fromFile), secret);
      expect(escaping.startsWith('..')).toBe(true); // sanity: the import really escapes root
      expect(existsSync(secret)).toBe(true); // target exists → only a containment check stops it
      expect(resolveImportPath(escaping, fromFile, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('Security: index_directory sandbox (#14)', () => {
  it('refuses to index a directory outside the allowed sandbox', () => {
    const db = createFullDb();
    const outside = mkdtempSync(path.join(tmpdir(), 'cc-evil-'));
    writeFileSync(path.join(outside, 'secret.ts'), 'export const s = 1;');
    try {
      // cwd is the repo root during tests; `outside` (in tmpdir) is not within it.
      expect(() => indexDirectory(db, outside)).toThrow(/sandbox|allowed root/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      db.close();
    }
  });

  it('indexes a directory inside cwd', () => {
    const db = createFullDb();
    try {
      expect(() => indexDirectory(db, FIXTURE_DIR)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('honors CODE_CONTEXT_ALLOWED_ROOTS for out-of-cwd paths', () => {
    const db = createFullDb();
    const allowed = mkdtempSync(path.join(tmpdir(), 'cc-allowed-'));
    writeFileSync(path.join(allowed, 'ok.ts'), 'export const ok = 1;');
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = allowed;
    try {
      expect(() => indexDirectory(db, allowed)).not.toThrow();
    } finally {
      delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
      rmSync(allowed, { recursive: true, force: true });
      db.close();
    }
  });
});
