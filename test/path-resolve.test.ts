import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/server/schema.js';
import { resolveToolPath } from '../src/server/path-resolve.js';

let db: Database.Database;
const add = (p: string) =>
  db
    .prepare(
      `INSERT INTO files (path, language, extension, size_bytes, line_count, modified_at) VALUES (?, 'typescript', '.ts', 1, 1, '2026-10-11')`,
    )
    .run(p);

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  add('/repos/a/src/server/schema.ts');
  add('/repos/a/src/scrum/schema.ts');
  add('/repos/b/src/server/schema.ts');
  add('/repos/a/src/odd_%name.ts');
});

describe('resolveToolPath', () => {
  it('keeps absolute paths', () => {
    expect(resolveToolPath(db, '/x/y.ts', '/repos/a')).toEqual({ kind: 'path', path: '/x/y.ts' });
  });
  it('resolves a repo-relative path against cwd', () => {
    expect(resolveToolPath(db, 'src/server/schema.ts', '/repos/a')).toEqual({
      kind: 'path',
      path: '/repos/a/src/server/schema.ts',
    });
    expect(resolveToolPath(db, './src/server/schema.ts', '/repos/b')).toEqual({
      kind: 'path',
      path: '/repos/b/src/server/schema.ts',
    });
  });
  it('falls back to a unique suffix match when cwd is elsewhere', () => {
    expect(resolveToolPath(db, 'scrum/schema.ts', '/elsewhere')).toEqual({
      kind: 'path',
      path: '/repos/a/src/scrum/schema.ts',
    });
  });
  it('prefers the match under cwd, else lists candidates', () => {
    expect(resolveToolPath(db, 'server/schema.ts', '/repos/b')).toEqual({
      kind: 'path',
      path: '/repos/b/src/server/schema.ts',
    });
    const r = resolveToolPath(db, 'server/schema.ts', '/elsewhere');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });
  it('treats LIKE wildcards in the input literally', () => {
    expect(resolveToolPath(db, 'odd_%name.ts', '/elsewhere')).toEqual({
      kind: 'path',
      path: '/repos/a/src/odd_%name.ts',
    });
    expect(resolveToolPath(db, '%.ts', '/elsewhere')).toEqual({
      kind: 'path',
      path: '/elsewhere/%.ts',
    });
  });
  it('returns the cwd-relative path for an unindexed file (on-demand indexing)', () => {
    expect(resolveToolPath(db, 'src/new.ts', '/repos/a')).toEqual({
      kind: 'path',
      path: '/repos/a/src/new.ts',
    });
  });
});
