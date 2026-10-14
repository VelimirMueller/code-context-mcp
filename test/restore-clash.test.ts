/**
 * #230: restore_database, import_from_file and the shared restoreTables never
 * replace an existing row. Earlier `INSERT OR REPLACE` silently overwrote a
 * ticket with a clashing id or (since v27) a clashing ticket_ref, and the
 * delete behind REPLACE cascaded to its children.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';
import { formatRestoreSummary, restoreTables } from '../src/scrum/restore.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

type Row = Record<string, unknown>;

function setup() {
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  const sprintId = Number(
    db.prepare(`INSERT INTO sprints (name, goal, status) VALUES ('S1', 'g', 'planning')`).run()
      .lastInsertRowid,
  );
  const ticketId = Number(
    db
      .prepare(
        `INSERT INTO tickets (sprint_id, ticket_ref, title, status) VALUES (?, 'T-1', 'Existing ticket', 'IN_PROGRESS')`,
      )
      .run(sprintId).lastInsertRowid,
  );
  db.prepare(`INSERT INTO subtasks (ticket_id, description) VALUES (?, 'Existing subtask')`).run(
    ticketId,
  );
  const server = new FakeServer();
  registerScrumTools(server as never, db);
  return { db, tools: server.tools, sprintId, ticketId };
}

const ticket = (db: Database.Database, id: number) =>
  db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as Row;
const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
const text = (res: { content: Array<{ text: string }> }) =>
  res.content.map((c) => c.text).join('\n');

/** A dump with one clashing ticket (same id, other values) and one new ticket. */
function clashingDump(db: Database.Database, ticketId: number, sprintId: number) {
  const existing = ticket(db, ticketId);
  return {
    version: '2.0.0',
    exported_at: '2026-10-14T00:00:00.000Z',
    tables: {
      tickets: [
        { ...existing, title: 'Title from the dump', status: 'DONE' },
        { ...existing, id: ticketId + 100, ticket_ref: 'T-900', title: 'New ticket from dump' },
      ].map((r) => ({ ...r, sprint_id: sprintId })),
    },
  };
}

describe('restoreTables', () => {
  it('refuses a clashing ticket id: the existing row and its subtask stay unchanged', () => {
    const { db, sprintId, ticketId } = setup();
    const before = ticket(db, ticketId);
    const dump = clashingDump(db, ticketId, sprintId);

    const summary = restoreTables(db, dump.tables);

    expect(summary.written).toBe(false);
    expect(summary.clashes).toHaveLength(1);
    expect(summary.clashes[0]).toMatchObject({
      table: 'tickets',
      row: `id=${ticketId} ticket_ref=T-1`,
    });
    expect(ticket(db, ticketId)).toEqual(before);
    expect(count(db, 'subtasks')).toBe(1);
    // abort is all-or-nothing: the new ticket is not written either
    expect(count(db, 'tickets')).toBe(1);
    const report = formatRestoreSummary(summary);
    expect(report).toContain('Restore refused');
    expect(report).toContain('Nothing was written');
    expect(report).toContain(`tickets id=${ticketId} ticket_ref=T-1`);
  });

  it('refuses a ticket whose ref belongs to another existing ticket', () => {
    const { db, sprintId, ticketId } = setup();
    const before = ticket(db, ticketId);
    const summary = restoreTables(db, {
      tickets: [{ id: ticketId + 50, sprint_id: sprintId, ticket_ref: 'T-1', title: 'Other' }],
    });
    expect(summary.written).toBe(false);
    expect(summary.clashes[0].reason).toBe(
      `ticket_ref T-1 belongs to existing ticket id=${ticketId}`,
    );
    expect(ticket(db, ticketId)).toEqual(before);
    expect(count(db, 'tickets')).toBe(1);
  });

  it('counts a row identical to the existing row as unchanged and restores the rest', () => {
    const { db, sprintId, ticketId } = setup();
    const existing = ticket(db, ticketId);
    const summary = restoreTables(db, {
      sprints: db.prepare(`SELECT * FROM sprints`).all(),
      tickets: [existing, { ...existing, id: ticketId + 1, ticket_ref: 'T-2', title: 'New' }],
    });
    expect(summary.written).toBe(true);
    expect(summary.clashes).toEqual([]);
    expect(summary.tables.sprints).toEqual({ inserted: 0, unchanged: 1, clashes: 0 });
    expect(summary.tables.tickets).toEqual({ inserted: 1, unchanged: 1, clashes: 0 });
    expect(count(db, 'tickets')).toBe(2);
    expect(ticket(db, ticketId + 1).sprint_id).toBe(sprintId);
  });

  it('skip keeps the existing row, inserts the rest and reports the clash', () => {
    const { db, sprintId, ticketId } = setup();
    const before = ticket(db, ticketId);
    const summary = restoreTables(db, clashingDump(db, ticketId, sprintId).tables, {
      onConflict: 'skip',
    });
    expect(summary.written).toBe(true);
    expect(summary.tables.tickets).toEqual({ inserted: 1, unchanged: 0, clashes: 1 });
    expect(ticket(db, ticketId)).toEqual(before);
    expect(count(db, 'subtasks')).toBe(1);
    expect(ticket(db, ticketId + 100).title).toBe('New ticket from dump');
    expect(formatRestoreSummary(summary)).toContain('1 kept (clash, not replaced)');
  });

  it('a clashing sprint never cascades into its existing tickets', () => {
    const { db, ticketId } = setup();
    const sprint = db.prepare(`SELECT * FROM sprints`).get() as Row;
    const summary = restoreTables(
      db,
      { sprints: [{ ...sprint, name: 'Sprint from the dump' }] },
      { onConflict: 'skip' },
    );
    expect(summary.tables.sprints.clashes).toBe(1);
    expect(ticket(db, ticketId).title).toBe('Existing ticket');
    expect(count(db, 'subtasks')).toBe(1);
  });

  it('dry run reports the summary and writes nothing', () => {
    const { db, sprintId, ticketId } = setup();
    const summary = restoreTables(db, clashingDump(db, ticketId, sprintId).tables, {
      dryRun: true,
      onConflict: 'skip',
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.written).toBe(false);
    expect(summary.tables.tickets).toEqual({ inserted: 1, unchanged: 0, clashes: 1 });
    expect(count(db, 'tickets')).toBe(1);
    expect(formatRestoreSummary(summary)).toContain('Dry run: nothing was written.');
  });

  it('rejects rows that are not objects and writes nothing', () => {
    const { db } = setup();
    expect(() =>
      restoreTables(db, { milestones: [{ name: 'M' }], tickets: ['not a row'] }),
    ).toThrow('every row of tickets must be an object');
    expect(count(db, 'milestones')).toBe(0);
  });
});

describe('restore_database / import_from_file tools', () => {
  it('restore_database refuses a clashing ticket with isError and a clear message', async () => {
    const { db, tools, sprintId, ticketId } = setup();
    const before = ticket(db, ticketId);
    const res = await tools.get('restore_database')!({
      dump_json: JSON.stringify(clashingDump(db, ticketId, sprintId)),
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('# Restore refused');
    expect(text(res)).toContain('1 row(s) clash with existing rows');
    expect(text(res)).toContain('on_conflict "skip"');
    expect(ticket(db, ticketId)).toEqual(before);
  });

  it('restore_database with on_conflict skip restores the rest', async () => {
    const { db, tools, sprintId, ticketId } = setup();
    const res = await tools.get('restore_database')!({
      dump_json: JSON.stringify(clashingDump(db, ticketId, sprintId)),
      on_conflict: 'skip',
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('# Restore complete');
    expect(text(res)).toContain('tickets: 1 inserted, 0 unchanged, 1 kept (clash, not replaced)');
    expect(ticket(db, ticketId).title).toBe('Existing ticket');
    expect(count(db, 'tickets')).toBe(2);
  });

  it('import_from_file refuses a clashing ticket and supports dry_run', async () => {
    const { db, tools, sprintId, ticketId } = setup();
    const before = ticket(db, ticketId);
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-restore-'));
    try {
      const file = path.join(dir, 'dump.json');
      writeFileSync(file, JSON.stringify(clashingDump(db, ticketId, sprintId)));

      const refused = await tools.get('import_from_file')!({ input_path: file });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('refused');
      expect(ticket(db, ticketId)).toEqual(before);

      const dry = await tools.get('import_from_file')!({ input_path: file, dry_run: true });
      expect(dry.isError).toBeUndefined();
      expect(text(dry)).toContain('(dry run)');
      expect(text(dry)).toContain('tickets: 1 inserted, 0 unchanged, 1 clash');
      expect(count(db, 'tickets')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dump restored onto its own database changes nothing and succeeds', async () => {
    const { db, tools, ticketId } = setup();
    const dumped = await tools.get('dump_database')!({});
    const res = await tools.get('restore_database')!({ dump_json: text(dumped) });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('tickets: 0 inserted, 1 unchanged, 0 kept');
    expect(ticket(db, ticketId).title).toBe('Existing ticket');
  });
});
