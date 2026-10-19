import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  validateReadOnlyQuery,
  validateWriteStatement,
  runReadOnlyQuery,
  runWriteStatement,
} from '../src/server/sql-guard.js';

function tmpDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO t (name) VALUES ('a'), ('b')");
  return db;
}

describe('SQL guard: validateReadOnlyQuery (#15a)', () => {
  it('accepts a plain SELECT', () => {
    expect(validateReadOnlyQuery('SELECT * FROM files').ok).toBe(true);
  });
  it('accepts a case-insensitive select against sqlite_master', () => {
    expect(validateReadOnlyQuery('select name from sqlite_master').ok).toBe(true);
  });
  it('accepts a WITH (CTE) query', () => {
    expect(validateReadOnlyQuery('WITH x AS (SELECT 1 AS n) SELECT n FROM x').ok).toBe(true);
  });
  it('accepts a single trailing semicolon', () => {
    expect(validateReadOnlyQuery('SELECT 1;').ok).toBe(true);
  });
  it('rejects stacked statements after a semicolon', () => {
    expect(validateReadOnlyQuery('SELECT 1; DROP TABLE files').ok).toBe(false);
  });
  it('rejects line comments', () => {
    expect(validateReadOnlyQuery('SELECT 1 -- evil').ok).toBe(false);
  });
  it('rejects block comments', () => {
    expect(validateReadOnlyQuery('SELECT 1 /* evil */').ok).toBe(false);
  });
  it('rejects non-SELECT statements (DROP/ATTACH)', () => {
    expect(validateReadOnlyQuery('DROP TABLE files').ok).toBe(false);
    expect(validateReadOnlyQuery("ATTACH DATABASE '/tmp/x.db' AS x").ok).toBe(false);
  });
  it('accepts the schema PRAGMAs table_info(<table>) and table_list (CCA-03)', () => {
    expect(validateReadOnlyQuery('PRAGMA table_info(files)').ok).toBe(true);
    expect(validateReadOnlyQuery("pragma table_info ( 'exports' );").ok).toBe(true);
    expect(validateReadOnlyQuery('PRAGMA table_list').ok).toBe(true);
  });
  it('rejects every other PRAGMA with a message that names what is allowed (CCA-03)', () => {
    for (const sql of [
      'PRAGMA journal_mode=WAL',
      'PRAGMA user_version = 3',
      'PRAGMA writable_schema=ON',
      'PRAGMA table_info(files) = 1',
      'PRAGMA foreign_keys',
    ]) {
      const r = validateReadOnlyQuery(sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('PRAGMA table_info(<table>)');
        expect(r.error).toContain('SELECT');
        expect(r.error).not.toMatch(/execute/);
      }
    }
  });
  it('rejects empty input', () => {
    expect(validateReadOnlyQuery('   ').ok).toBe(false);
  });
});

describe('SQL guard: validateWriteStatement (#15a)', () => {
  it("accepts the bridge's UPDATE pending_actions statement", () => {
    expect(
      validateWriteStatement("UPDATE pending_actions SET status='completed' WHERE id=1").ok,
    ).toBe(true);
  });
  it('accepts INSERT and DELETE', () => {
    expect(validateWriteStatement("INSERT INTO tags (name) VALUES ('x')").ok).toBe(true);
    expect(validateWriteStatement('DELETE FROM tags WHERE id=1').ok).toBe(true);
  });
  it('rejects stacked statements', () => {
    expect(validateWriteStatement("UPDATE tags SET name='x' WHERE id=1; DROP TABLE tags").ok).toBe(
      false,
    );
  });
  it('rejects comments', () => {
    expect(validateWriteStatement("UPDATE tags SET name='x' -- evil").ok).toBe(false);
  });
  it('rejects DDL and escape verbs (DROP/ALTER/CREATE/ATTACH/PRAGMA)', () => {
    expect(validateWriteStatement('DROP TABLE tags').ok).toBe(false);
    expect(validateWriteStatement('ALTER TABLE tags ADD COLUMN x TEXT').ok).toBe(false);
    expect(validateWriteStatement('CREATE TABLE x (id INT)').ok).toBe(false);
    expect(validateWriteStatement("ATTACH DATABASE '/tmp/x.db' AS x").ok).toBe(false);
    expect(validateWriteStatement('PRAGMA journal_mode=WAL').ok).toBe(false);
  });
  it('rejects SELECT (belongs in query)', () => {
    expect(validateWriteStatement('SELECT * FROM tags').ok).toBe(false);
  });
  it('rejects empty input', () => {
    expect(validateWriteStatement('').ok).toBe(false);
  });
});

describe('SQL guard: runReadOnlyQuery enforces read-only at the driver (#15a)', () => {
  it('runs a SELECT and returns rows', () => {
    const db = tmpDb();
    try {
      const r = runReadOnlyQuery(db, 'SELECT * FROM t');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rows).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('rejects a CTE-prefixed DELETE that the text allowlist passes — and does NOT mutate', () => {
    const db = tmpDb();
    try {
      const r = runReadOnlyQuery(db, 'WITH x AS (SELECT 1) DELETE FROM t');
      expect(r.ok).toBe(false);
      // The decisive assertion: the DELETE must never have executed.
      const count = (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
      expect(count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('runs PRAGMA table_info and returns the columns (CCA-03)', () => {
    const db = tmpDb();
    try {
      const r = runReadOnlyQuery(db, 'PRAGMA table_info(t)');
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.rows as { name: string }[]).map((c) => c.name)).toEqual(['id', 'name']);
    } finally {
      db.close();
    }
  });
});

describe('SQL guard: runWriteStatement (#15a)', () => {
  it('runs an UPDATE and reports the change', () => {
    const db = tmpDb();
    try {
      const r = runWriteStatement(db, "UPDATE t SET name='z' WHERE id=1");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.changes).toBe(1);
      expect((db.prepare('SELECT name FROM t WHERE id=1').get() as { name: string }).name).toBe(
        'z',
      );
    } finally {
      db.close();
    }
  });

  it('rejects a SELECT submitted to execute', () => {
    const db = tmpDb();
    try {
      expect(runWriteStatement(db, 'SELECT * FROM t').ok).toBe(false);
    } finally {
      db.close();
    }
  });
});
