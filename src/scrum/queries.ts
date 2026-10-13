/**
 * Data-access helpers for the duplicated sprint/ticket lookups in tools.ts.
 *
 * Discovery #16 flagged 8+ inline copies of `SELECT * FROM sprints WHERE id=?`
 * plus repeated tickets-by-sprint, latest-active-sprint, ticket-by-id, and
 * per-sprint status-count queries. These helpers centralise only the exact,
 * mechanically-identical query strings so call sites in tools.ts stay
 * behaviour-for-behaviour the same — no caching, no new column selection, no
 * altered filters. Each helper uses per-call `db.prepare(...)` exactly as the
 * original sites did (better-sqlite3 caches the prepared statement internally,
 * so semantics are unchanged).
 *
 * Rows are returned as the full row types from ./rows.ts.
 */
import type Database from "better-sqlite3";

// Full row types live in ./rows.ts (#190); re-exported for existing importers.
import type { SprintRow, TicketRow } from "./rows.js";
export type { SprintRow, TicketRow };

/** One `{ status, c }` bucket from a per-sprint ticket status-count query. */
export interface StatusCountRow {
  status: string;
  c: number;
}

/** `SELECT * FROM sprints WHERE id = ?` — full sprint row by id (no soft-delete filter). */
export function getSprintById(db: Database.Database, id: number): SprintRow | undefined {
  return db.prepare(`SELECT * FROM sprints WHERE id = ?`).get(id) as SprintRow | undefined;
}

/** `SELECT * FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL` — non-deleted tickets for a sprint. */
export function getTicketsBySprint(db: Database.Database, sprintId: number): TicketRow[] {
  return db
    .prepare(`SELECT * FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL`)
    .all(sprintId) as TicketRow[];
}

/** `SELECT * FROM tickets WHERE id = ?` — full ticket row by id (no soft-delete filter). */
export function getTicketById(db: Database.Database, id: number): TicketRow | undefined {
  return db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as TicketRow | undefined;
}

/**
 * Latest non-rest/closed sprint:
 * `SELECT * FROM sprints WHERE status NOT IN ('closed', 'rest') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`.
 */
export function getLatestSprint(db: Database.Database): SprintRow | undefined {
  return db
    .prepare(
      `SELECT * FROM sprints WHERE status NOT IN ('closed', 'rest') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as SprintRow | undefined;
}

/** `SELECT status, COUNT(*) as c FROM tickets WHERE sprint_id = ? GROUP BY status` — ticket counts grouped by status. */
export function getTicketStatusCounts(db: Database.Database, sprintId: number): StatusCountRow[] {
  return db
    .prepare(`SELECT status, COUNT(*) as c FROM tickets WHERE sprint_id = ? GROUP BY status`)
    .all(sprintId) as StatusCountRow[];
}
