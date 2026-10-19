// SQL guards for the `query` (read-only) and `execute` (write) escape-hatch
// tools. Allowlist-based, not denylist: a statement must positively match an
// allowed shape, and the run* helpers additionally verify better-sqlite3's
// stmt.reader flag — the driver's own read/write classification — before
// executing. Closes denylist-bypass vectors (stacked statements, comments,
// ATTACH/PRAGMA/DDL, and CTE-prefixed writes) flagged in discovery #15a.

import type Database from 'better-sqlite3';
import { checkGateColumns } from './sql-gate-columns.js';

export type SqlGuardResult = { ok: true; sql: string } | { ok: false; error: string };

const COMMENT = /--|\/\*/;

/**
 * Schema PRAGMAs `query` accepts (CCA-03, #118): readers want the column list
 * and used to get "Only SELECT queries are allowed". Both forms only read.
 * Every other PRAGMA (journal_mode=, user_version=, writable_schema, …) stays
 * rejected; the driver reader check below runs on these too.
 */
const READ_PRAGMA = /^pragma\s+(?:table_info\s*\(\s*(["'`]?)[A-Za-z_]\w*\1\s*\)|table_list)$/i;

/** The one rejection text `query` uses: say what IS allowed, never point at execute (it may not be listed). */
export const READ_ONLY_HINT =
  'query is read-only: use one SELECT (or WITH … SELECT), PRAGMA table_info(<table>) or PRAGMA table_list.';

/** Trim and drop a single trailing semicolon (the only semicolon we tolerate). */
function normalize(rawSql: string): string {
  return rawSql.trim().replace(/;\s*$/, '');
}

export function validateReadOnlyQuery(rawSql: string): SqlGuardResult {
  const sql = normalize(rawSql);
  if (!sql) return { ok: false, error: 'Empty query.' };
  if (sql.includes(';')) {
    return { ok: false, error: 'Multiple statements are not allowed; submit a single SELECT.' };
  }
  if (COMMENT.test(sql)) return { ok: false, error: 'SQL comments are not allowed.' };
  if (!/^(select|with)\b/i.test(sql) && !READ_PRAGMA.test(sql)) {
    return { ok: false, error: READ_ONLY_HINT };
  }
  return { ok: true, sql };
}

export function validateWriteStatement(rawSql: string): SqlGuardResult {
  const sql = normalize(rawSql);
  if (!sql) return { ok: false, error: 'Empty statement.' };
  if (sql.includes(';')) {
    return {
      ok: false,
      error: 'Multiple statements are not allowed; submit a single write statement.',
    };
  }
  if (COMMENT.test(sql)) return { ok: false, error: 'SQL comments are not allowed.' };
  if (!/^(insert|update|delete)\b/i.test(sql)) {
    return {
      ok: false,
      error: 'Only INSERT, UPDATE, or DELETE are allowed. Use query() for SELECT.',
    };
  }
  // CCA-37 (#181): gate columns (tickets.status, qa_verified, github_*, …) only through their tools.
  return checkGateColumns(sql);
}

export type QueryResult = { ok: true; rows: unknown[] } | { ok: false; error: string };

export type PreparedRead =
  | { ok: true; sql: string; stmt: Database.Statement }
  | { ok: false; error: string };

/** Validate and prepare a read-only statement — refusing anything the driver reports as a writer. */
export function prepareReadOnlyQuery(db: Database.Database, rawSql: string): PreparedRead {
  const check = validateReadOnlyQuery(rawSql);
  if (!check.ok) return check;
  let stmt: Database.Statement;
  try {
    stmt = db.prepare(check.sql);
  } catch (err) {
    return { ok: false, error: `SQL Error: ${(err as Error).message}` };
  }
  // Driver ground truth: a non-reader (e.g. a CTE-prefixed DELETE) is rejected
  // BEFORE execution, so it cannot mutate the database.
  if (!stmt.reader) return { ok: false, error: READ_ONLY_HINT };
  return { ok: true, sql: check.sql, stmt };
}

/** Validate, then run a read-only query and return every row (no caps — see query-output.ts for the tool). */
export function runReadOnlyQuery(db: Database.Database, rawSql: string): QueryResult {
  const prepared = prepareReadOnlyQuery(db, rawSql);
  if (!prepared.ok) return prepared;
  const { stmt } = prepared;
  try {
    return { ok: true, rows: stmt.all() };
  } catch (err) {
    return { ok: false, error: `SQL Error: ${(err as Error).message}` };
  }
}

export type ExecResult =
  | { ok: true; changes: number; lastInsertRowid: number | bigint }
  | { ok: false; error: string };

/** Validate, then run a single write statement — refusing readers (e.g. RETURNING). */
export function runWriteStatement(
  db: Database.Database,
  rawSql: string,
  params: unknown[] = [],
): ExecResult {
  const check = validateWriteStatement(rawSql);
  if (!check.ok) return check;
  let stmt: Database.Statement;
  try {
    stmt = db.prepare(check.sql);
  } catch (err) {
    return { ok: false, error: `SQL Error: ${(err as Error).message}` };
  }
  if (stmt.reader) {
    return { ok: false, error: 'Use query() for SELECT.' };
  }
  try {
    // params are user-supplied bind values; cast to satisfy the variadic signature.
    const result = stmt.run(...(params as never[]));
    return { ok: true, changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  } catch (err) {
    return { ok: false, error: `SQL Error: ${(err as Error).message}` };
  }
}
