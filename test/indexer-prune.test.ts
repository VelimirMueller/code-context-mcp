import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexDirectory } from '../src/server/indexer.js';
import { createTestDb } from './helpers/db.js';

describe('Indexer prune: deleted files and directories leave the index', () => {
  let root: string;
  let db: Database.Database;

  const write = (rel: string, content: string): string => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };

  const filePaths = () =>
    (db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map(
      (r) => r.path,
    );

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-prune-'))); // index stores realpaths (CCA-01)
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
    db = createTestDb();
  });

  afterEach(() => {
    delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('removes rows for files deleted from disk between scans', () => {
    write('a.ts', `import { b } from "./b";\nexport const a = b;\n`);
    const bPath = write('b.ts', `export const b = 1;\n`);
    indexDirectory(db, root);
    expect(filePaths()).toContain(bPath);

    rmSync(bPath);
    const stats = indexDirectory(db, root);

    expect(stats.prunedFiles).toBe(1);
    expect(filePaths()).not.toContain(bPath);
  });

  it('removes exports and dependency edges (both directions) of pruned files', () => {
    write('a.ts', `import { b } from "./b";\nexport const a = b;\n`);
    const bPath = write('b.ts', `import { c } from "./c";\nexport const b = c;\n`);
    write('c.ts', `export const c = 1;\n`);
    indexDirectory(db, root);
    const bId = (db.prepare('SELECT id FROM files WHERE path = ?').get(bPath) as { id: number }).id;
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM exports WHERE file_id = ?').get(bId) as { c: number })
        .c,
    ).toBeGreaterThan(0);

    rmSync(bPath);
    indexDirectory(db, root);

    const orphanExports = db
      .prepare('SELECT COUNT(*) AS c FROM exports WHERE file_id = ?')
      .get(bId) as { c: number };
    const orphanDeps = db
      .prepare('SELECT COUNT(*) AS c FROM dependencies WHERE source_id = ? OR target_id = ?')
      .get(bId, bId) as { c: number };
    expect(orphanExports.c).toBe(0);
    expect(orphanDeps.c).toBe(0);
  });

  it('removes directory rows for deleted directories', () => {
    write('a.ts', `export const a = 1;\n`);
    write('sub/c.ts', `export const c = 1;\n`);
    indexDirectory(db, root);
    const subDir = path.join(root, 'sub');
    expect(
      (
        db.prepare('SELECT COUNT(*) AS c FROM directories WHERE path = ?').get(subDir) as {
          c: number;
        }
      ).c,
    ).toBe(1);

    rmSync(subDir, { recursive: true, force: true });
    const stats = indexDirectory(db, root);

    expect(stats.prunedDirs).toBe(1);
    expect(stats.prunedFiles).toBe(1);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS c FROM directories WHERE path = ?').get(subDir) as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("logs a 'delete' change event for pruned files", () => {
    write('a.ts', `export const a = 1;\n`);
    const bPath = write('b.ts', `export const b = 1;\n`);
    indexDirectory(db, root);

    rmSync(bPath);
    indexDirectory(db, root);

    const events = (
      db.prepare('SELECT event FROM changes WHERE file_path = ? ORDER BY id').all(bPath) as {
        event: string;
      }[]
    ).map((r) => r.event);
    expect(events).toContain('delete');
  });

  it('indexing a subdirectory never evicts sibling rows outside it', () => {
    const aPath = write('a.ts', `export const a = 1;\n`);
    write('sub/c.ts', `export const c = 1;\n`);
    indexDirectory(db, root);

    const stats = indexDirectory(db, path.join(root, 'sub'));

    expect(stats.prunedFiles).toBe(0);
    expect(stats.prunedDirs).toBe(0);
    expect(filePaths()).toContain(aPath);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS c FROM directories WHERE path = ?').get(root) as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });

  it('prunes nothing when the tree is unchanged', () => {
    write('a.ts', `export const a = 1;\n`);
    write('sub/c.ts', `export const c = 1;\n`);
    indexDirectory(db, root);
    const before = filePaths();

    const stats = indexDirectory(db, root);

    expect(stats.prunedFiles).toBe(0);
    expect(stats.prunedDirs).toBe(0);
    expect(filePaths()).toEqual(before);
  });
});

describe('Indexer prune: secret-shaped files', () => {
  let root: string;
  let db: Database.Database;

  const write = (rel: string, content: string): string => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };

  const filePaths = () =>
    (db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map(
      (r) => r.path,
    );

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-secret-')));
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
    db = createTestDb();
  });

  afterEach(() => {
    delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    delete process.env.CODE_CONTEXT_INDEX_ALLOW;
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('never indexes secret-shaped files', () => {
    const rsa = write('id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nsecret\n');
    const pem = write('app.pem', '-----BEGIN CERTIFICATE-----\nsecret\n');
    write('a.ts', 'export const a = 1;\n');

    const stats = indexDirectory(db, root);

    expect(stats.files).toBe(1);
    expect(filePaths()).not.toContain(rsa);
    expect(filePaths()).not.toContain(pem);
  });

  it('drops rows for files the policy now refuses on reindex', () => {
    const rsa = write('id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nsecret\n');
    const pem = write('app.pem', '-----BEGIN CERTIFICATE-----\nsecret\n');
    write('a.ts', 'export const a = 1;\n');

    // Permissive stub: opt the two secret-shaped files back in, index them.
    process.env.CODE_CONTEXT_INDEX_ALLOW = 'id_rsa,*.pem';
    indexDirectory(db, root);
    expect(filePaths()).toContain(rsa);
    expect(filePaths()).toContain(pem);

    // The stub is gone: the next index refuses both and prunes their rows.
    delete process.env.CODE_CONTEXT_INDEX_ALLOW;
    const stats = indexDirectory(db, root);

    expect(stats.prunedFiles).toBe(2);
    expect(filePaths()).not.toContain(rsa);
    expect(filePaths()).not.toContain(pem);
  });
});
