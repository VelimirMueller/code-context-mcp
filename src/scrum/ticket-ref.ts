import type Database from 'better-sqlite3';

/**
 * Ticket refs (`T-<n>`) are unique across the whole database (#222), soft-deleted
 * rows included. Earlier only UNIQUE(sprint_id, ticket_ref) held, and SQLite treats
 * NULL sprints as distinct, so two tickets without a sprint could share a ref.
 */
export const TICKET_REF_INDEX = 'idx_tickets_ticket_ref_unique';

/**
 * Next free `T-<n>` ref (#210). `n` starts after the highest id of all rows,
 * soft-deleted ones included (ids are AUTOINCREMENT, so they are never reused),
 * and skips any ref that a row already has, for example one set by hand.
 *
 * The one allocation function for every writer: the MCP `create_ticket` and
 * `start_sprint` tools, the dashboard `POST /api/tickets` route and the v27
 * migration. Call it in the write transaction that inserts (IMMEDIATE, #215), so
 * no other connection on the same file can take the ref between the read and
 * the insert.
 */
export function nextTicketRef(db: Database.Database): string {
  const maxId = db.prepare(`SELECT MAX(id) AS m FROM tickets`).get() as { m: number | null };
  let n = (maxId.m ?? 0) + 1;
  while (ticketRefOwner(db, `T-${n}`) !== undefined) n++;
  return `T-${n}`;
}

/** Id of the row that holds `ref` (soft-deleted rows count), or undefined. */
export function ticketRefOwner(db: Database.Database, ref: string): number | undefined {
  const row = db.prepare(`SELECT id FROM tickets WHERE ticket_ref = ? LIMIT 1`).get(ref) as
    | { id: number }
    | undefined;
  return row?.id;
}

/** True when two or more rows share a non-NULL ticket_ref. */
export function hasDuplicateTicketRefs(db: Database.Database): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM tickets WHERE ticket_ref IS NOT NULL GROUP BY ticket_ref HAVING COUNT(*) > 1 LIMIT 1`,
    )
    .get();
}

export interface RenamedTicketRef {
  id: number;
  from: string;
  to: string;
}

/**
 * Give every duplicate ref but one a new ref, deterministically (#222 migration).
 * Per shared ref the row with the lowest id keeps it; the other rows, in ref
 * then id order, get the next free ref from {@link nextTicketRef}. Each change is
 * written to the ticket history (event_log: action `updated`, field `ticket_ref`,
 * old and new value, actor `migration`). Returns the changes; none when the refs
 * are already unique. Runs inside the caller's transaction.
 */
export function renameDuplicateTicketRefs(db: Database.Database): RenamedTicketRef[] {
  const losers = db
    .prepare(
      `SELECT t.id, t.ticket_ref AS ref FROM tickets t
       JOIN (SELECT ticket_ref, MIN(id) AS keep FROM tickets
             WHERE ticket_ref IS NOT NULL GROUP BY ticket_ref HAVING COUNT(*) > 1) d
         ON d.ticket_ref = t.ticket_ref
       WHERE t.id <> d.keep
       ORDER BY t.ticket_ref, t.id`,
    )
    .all() as Array<{ id: number; ref: string }>;
  if (losers.length === 0) return [];

  const setRef = db.prepare(`UPDATE tickets SET ticket_ref = ? WHERE id = ?`);
  const history = db.prepare(
    `INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
     VALUES ('ticket', ?, 'updated', 'ticket_ref', ?, ?, 'migration')`,
  );
  const renamed: RenamedTicketRef[] = [];
  for (const { id, ref } of losers) {
    const to = nextTicketRef(db);
    setRef.run(to, id);
    history.run(id, ref, to);
    renamed.push({ id, from: ref, to });
  }
  return renamed;
}

/**
 * Create the database-wide unique index on ticket_ref. Returns false (and creates
 * nothing) while duplicates exist: a legacy DB reaches initScrumSchema before the
 * migration has renamed them, and the migration calls this again afterwards.
 */
export function ensureTicketRefIndex(db: Database.Database): boolean {
  if (hasDuplicateTicketRefs(db)) return false;
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${TICKET_REF_INDEX} ON tickets(ticket_ref)`);
  return true;
}
