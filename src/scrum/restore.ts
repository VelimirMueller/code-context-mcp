import type Database from 'better-sqlite3';

/**
 * Restore rows from a dump (dump_database, export_to_file, GET /api/dump)
 * without replacing existing rows (#230).
 *
 * Earlier every restore path used `INSERT OR REPLACE`. A dump row whose id,
 * or (since v27) whose ticket ref, matched an existing row silently replaced
 * that row, and the delete behind REPLACE cascaded to its children.
 *
 * Now a row is one of three things:
 * - inserted: no existing row has its id or any of its unique values.
 * - unchanged: a row with the same primary key holds the same values.
 * - a clash: any other uniqueness conflict. The existing row is never changed.
 *
 * `onConflict: 'abort'` (the default) writes nothing when there is a clash.
 * `onConflict: 'skip'` keeps the existing rows and inserts the rest.
 * `dryRun` computes the same summary and writes nothing.
 */

/** Parents before children, so foreign keys resolve. */
export const RESTORE_TABLE_ORDER = [
  'milestones',
  'epics',
  'agents',
  'skills',
  'processes',
  'sprints',
  'tickets',
  'subtasks',
  'retro_findings',
  'blockers',
  'bugs',
  'files',
  'exports',
  'dependencies',
  'directories',
  'changes',
] as const;

export type RestoreConflictMode = 'abort' | 'skip';

export interface RestoreOptions {
  onConflict?: RestoreConflictMode;
  dryRun?: boolean;
}

export interface RestoreClash {
  table: string;
  /** The dump row's key, e.g. `id=4` or `id=4 ticket_ref=T-7`. */
  row: string;
  reason: string;
}

export interface RestoreTableCount {
  inserted: number;
  unchanged: number;
  clashes: number;
}

export interface RestoreSummary {
  /** True when rows were written (not a dry run, and no abort). */
  written: boolean;
  dryRun: boolean;
  onConflict: RestoreConflictMode;
  tables: Record<string, RestoreTableCount>;
  clashes: RestoreClash[];
}

/** Thrown for a dump that is not `{ tables: { <table>: object[] } }`. */
export class RestoreInputError extends Error {}

type SqlValue = string | number | bigint | Buffer | null;

/** Thrown inside the transaction to roll it back (dry run or abort). */
class Rollback extends Error {}

const CLASH_LIST_LIMIT = 20;

function rowKey(table: string, row: Record<string, unknown>, pk: string[]): string {
  const parts = pk.filter((c) => row[c] !== undefined).map((c) => `${c}=${String(row[c])}`);
  if (table === 'tickets' && row.ticket_ref != null) parts.push(`ticket_ref=${row.ticket_ref}`);
  return parts.length > 0 ? parts.join(' ') : '(no key)';
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  // A JSON dump turns integers into numbers; SQLite may hand back a bigint.
  if (typeof a === 'bigint' || typeof b === 'bigint') return String(a) === String(b);
  return a === b;
}

/**
 * Restore `tables` into `db` in one transaction. Returns a summary; it
 * throws only for invalid input or a database error (foreign key, CHECK,
 * NOT NULL), and then nothing is written.
 */
export function restoreTables(
  db: Database.Database,
  tables: Record<string, unknown>,
  options: RestoreOptions = {},
): RestoreSummary {
  const onConflict = options.onConflict ?? 'abort';
  const dryRun = options.dryRun ?? false;
  const summary: RestoreSummary = {
    written: false,
    dryRun,
    onConflict,
    tables: {},
    clashes: [],
  };

  const run = db.transaction(() => {
    for (const table of RESTORE_TABLE_ORDER) {
      const rows = tables[table];
      if (rows === undefined || rows === null) continue;
      if (!Array.isArray(rows)) throw new RestoreInputError(`${table} must be an array of rows`);
      if (rows.length === 0) continue;
      if (!rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
        throw new RestoreInputError(`every row of ${table} must be an object`);
      }
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        pk: number;
      }[];
      if (info.length === 0) continue; // table not in this schema
      const validCols = new Set(info.map((c) => c.name));
      const pk = info
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      const first = rows[0] as Record<string, unknown>;
      // Only columns that exist in the schema reach the SQL (names are not bound).
      const cols = Object.keys(first).filter((c) => validCols.has(c));
      if (cols.length === 0) continue;

      const insert = db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`,
      );
      const pkInCols = pk.length > 0 && pk.every((c) => cols.includes(c));
      const byPk = pkInCols
        ? db.prepare(
            `SELECT ${cols.join(',')} FROM ${table} WHERE ${pk.map((c) => `${c} = ?`).join(' AND ')}`,
          )
        : null;
      const byRef =
        table === 'tickets' && cols.includes('ticket_ref')
          ? db.prepare(`SELECT id FROM tickets WHERE ticket_ref = ?`)
          : null;

      const count: RestoreTableCount = { inserted: 0, unchanged: 0, clashes: 0 };
      for (const raw of rows as Record<string, unknown>[]) {
        const values = cols.map((c) => (raw[c] ?? null) as SqlValue);
        if (insert.run(...values).changes === 1) {
          count.inserted++;
          continue;
        }
        const existing = byPk
          ? (byPk.get(...pk.map((c) => (raw[c] ?? null) as SqlValue)) as
              | Record<string, unknown>
              | undefined)
          : undefined;
        if (existing && cols.every((c, i) => sameValue(existing[c], values[i]))) {
          count.unchanged++;
          continue;
        }
        count.clashes++;
        let reason: string;
        if (existing) {
          reason = `a row with ${pk.join(', ')} ${pk.map((c) => String(raw[c])).join(', ')} exists with other values`;
        } else {
          const owner =
            byRef && raw.ticket_ref != null
              ? (byRef.get(raw.ticket_ref as SqlValue) as { id: number } | undefined)
              : undefined;
          reason = owner
            ? `ticket_ref ${String(raw.ticket_ref)} belongs to existing ticket id=${owner.id}`
            : 'a unique value is already used by an existing row';
        }
        summary.clashes.push({ table, row: rowKey(table, raw, pk), reason });
      }
      summary.tables[table] = count;
    }
    if (dryRun || (onConflict === 'abort' && summary.clashes.length > 0)) throw new Rollback();
  });

  try {
    run();
    summary.written = true;
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return summary;
}

/** Human-readable report of a restore summary (MCP tools and the dashboard). */
export function formatRestoreSummary(summary: RestoreSummary): string {
  const lines: string[] = [];
  if (summary.dryRun) lines.push('Dry run: nothing was written.');
  else if (!summary.written) {
    lines.push(
      `Restore refused: ${summary.clashes.length} row(s) clash with existing rows. Nothing was written.`,
      'Existing rows are never replaced. Check the clashes below; to restore the other rows and keep the existing ones, run again with on_conflict "skip".',
    );
  }
  if (lines.length > 0) lines.push('');
  for (const [table, c] of Object.entries(summary.tables)) {
    lines.push(
      `${table}: ${c.inserted} inserted, ${c.unchanged} unchanged, ${c.clashes} ${
        summary.written ? 'kept (clash, not replaced)' : 'clash'
      }`,
    );
  }
  if (summary.clashes.length > 0) {
    lines.push('', 'Clashes (the existing row stays unchanged):');
    for (const c of summary.clashes.slice(0, CLASH_LIST_LIMIT)) {
      lines.push(`- ${c.table} ${c.row}: ${c.reason}`);
    }
    if (summary.clashes.length > CLASH_LIST_LIMIT) {
      lines.push(`- … and ${summary.clashes.length - CLASH_LIST_LIMIT} more`);
    }
  }
  return lines.join('\n');
}
