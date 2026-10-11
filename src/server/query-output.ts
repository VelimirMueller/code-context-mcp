// The `query` tool's contract (CCA-03, #118): a self-describing description
// and bounded output. Bench transcripts showed 57 % of query calls wasted on
// schema guessing (PRAGMA rejected, invented column names), sqlite_master dumps
// of up to 19.5k chars, and `SELECT * FROM files` returning whole file texts.
//
// Choices:
// - The schema of the three code-index tables sits in the description. It
//   costs about 500 chars on every call; one sqlite_master dump cost 5–19k.
// - Output is capped by rows, by total chars and per cell, with a note that
//   says what was cut and how to narrow. No `limit` parameter: SQL LIMIT does
//   the same job and a parameter would cost description budget.
// - files.content (whole file text) leaves only when the SELECT list names it.
// - No table restriction (sqlite_master, scrum tables stay readable in every
//   profile): a reliable table filter needs a SQL parser (subqueries, CTEs,
//   pragma_* functions), and the caps already bound the worst case to ~8 KB.

import type Database from "better-sqlite3";
import { prepareReadOnlyQuery } from "./sql-guard.js";

/** Rows shown at most. */
export const QUERY_MAX_ROWS = 50;
/** Characters of row output at most (the first row is always shown). */
export const QUERY_MAX_CHARS = 8_000;
/** A longer string cell is cut to this many characters plus a marker. */
export const QUERY_MAX_CELL_CHARS = 1_000;
/** Rows counted for the "shown of total" note; beyond that the total reads "N+". */
export const QUERY_COUNT_LIMIT = 10_000;

/**
 * The tool description: compact schema of files/exports/dependencies (column
 * names from schema.ts, `files.content` left out on purpose) and the two
 * common joins. Pinned by test/code-toolset-size.test.ts.
 */
export const QUERY_DESCRIPTION =
  "Read-only SQL on the code index: SELECT or PRAGMA table_info(t). " +
  "files(id, path, language, extension, size_bytes, line_count, summary, description, external_imports, import_lines, created_at, modified_at, indexed_at); " +
  "exports(id, file_id, name, kind, description, signature, line); " +
  "dependencies(id, source_id, target_id, symbols): source imports target. *_id = files.id; paths are absolute. " +
  "Who imports X: dependencies d JOIN files t ON t.id=d.target_id JOIN files s ON s.id=d.source_id WHERE t.path LIKE '%X'. " +
  "Exports of X: exports e JOIN files f ON f.id=e.file_id. " +
  `Max ${QUERY_MAX_ROWS} rows, ${QUERY_MAX_CHARS / 1000} KB.`;

/**
 * True when `column` appears as a word in a SELECT list of `sql` — between a
 * SELECT keyword and the FROM that closes it, at any nesting depth. String
 * literals do not count; WHERE/ORDER BY/JOIN uses do not count. So
 * `SELECT content FROM files`, `SELECT substr(f.content,1,99) …` and
 * `SELECT (SELECT 1 FROM t), content FROM files` name it;
 * `SELECT * FROM files WHERE content LIKE '%x%'` does not.
 */
export function namedInSelectList(sql: string, column: string): boolean {
  const target = column.toLowerCase();
  const text = sql.replace(/'(?:[^']|'')*'/g, "''");
  const tokens = text.match(/[A-Za-z_]\w*|[()]/g) ?? [];
  const stack: boolean[] = [];
  let inList = false;
  for (const tok of tokens) {
    if (tok === "(") {
      stack.push(inList);
    } else if (tok === ")") {
      inList = stack.pop() ?? false;
    } else {
      const word = tok.toLowerCase();
      if (word === "select") inList = true;
      else if (word === "from") inList = false;
      else if (inList && word === target) return true;
    }
  }
  return false;
}

function cutCell(value: unknown): { value: unknown; cut: boolean } {
  if (typeof value === "string" && value.length > QUERY_MAX_CELL_CHARS) {
    const rest = value.length - QUERY_MAX_CELL_CHARS;
    return { value: `${value.slice(0, QUERY_MAX_CELL_CHARS)}…[+${rest} chars]`, cut: true };
  }
  if (Buffer.isBuffer(value)) return { value: `<blob ${value.length} bytes>`, cut: false };
  return { value, cut: false };
}

export type BoundedQueryResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Run a read-only statement for the `query` tool. The text is a JSON array,
 * one row per line; when anything was cut, plain-text notes follow the array.
 */
export function runBoundedQuery(db: Database.Database, rawSql: string): BoundedQueryResult {
  const prepared = prepareReadOnlyQuery(db, rawSql);
  if (!prepared.ok) return { ok: false, error: withSchemaHint(prepared.error) };
  const { sql, stmt } = prepared;

  // files.content: drop every result column that originates from it (through
  // `*`, `f.*`, CTEs and subqueries alike — SQLite reports the origin) unless
  // the SELECT list names `content`. The column is still read by SQLite, but
  // never leaves the server.
  const dropped = stmt
    .columns()
    .filter((c) => c.table === "files" && c.column === "content")
    .map((c) => c.name);
  const drop = dropped.length > 0 && !namedInSelectList(sql, "content") ? new Set(dropped) : null;

  const lines: string[] = [];
  let chars = 0;
  let total = 0;
  let byteCapped = false;
  let cellsCut = false;
  try {
    for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
      total++;
      if (lines.length < QUERY_MAX_ROWS && !byteCapped) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (drop?.has(k)) continue;
          const c = cutCell(v);
          if (c.cut) cellsCut = true;
          out[k] = c.value;
        }
        const line = JSON.stringify(out);
        if (lines.length > 0 && chars + line.length > QUERY_MAX_CHARS) byteCapped = true;
        else {
          lines.push(line);
          chars += line.length + 2;
        }
      }
      if (total >= QUERY_COUNT_LIMIT) break; // leaving the loop closes the iterator
    }
  } catch (err) {
    return { ok: false, error: withSchemaHint(`SQL Error: ${(err as Error).message}`) };
  }

  const body = lines.length === 0 ? "[]" : `[\n${lines.join(",\n")}\n]`;
  const notes: string[] = [];
  if (lines.length < total) {
    const all = total >= QUERY_COUNT_LIMIT ? `${QUERY_COUNT_LIMIT}+` : String(total);
    const cap = byteCapped ? `${QUERY_MAX_CHARS / 1000} KB output cap` : `${QUERY_MAX_ROWS}-row cap`;
    notes.push(
      `Truncated: ${lines.length} of ${all} rows shown (${cap}). Narrow it: add WHERE or LIMIT, or select fewer columns.`,
    );
  }
  if (cellsCut) {
    notes.push(`Values over ${QUERY_MAX_CELL_CHARS} chars are cut (…[+N chars]); use substr(col, start, len) for the rest.`);
  }
  if (drop) notes.push("files.content (whole file text) omitted; name it in the SELECT list to get it.");
  return { ok: true, text: notes.length ? `${body}\n\n${notes.join("\n")}` : body };
}

/** Guessed names were the other half of the waste: point back at the schema. */
function withSchemaHint(error: string): string {
  return /no such (column|table)/i.test(error)
    ? `${error}. Columns are listed in the query tool description; PRAGMA table_info(<table>) shows any table.`
    : error;
}
