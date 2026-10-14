/**
 * #222: ticket refs are unique across the database, with or without a sprint.
 * The MCP tools and the dashboard route allocate refs with one function
 * (src/scrum/ticket-ref.ts). The migration test with shared refs is in
 * migrations.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';
import { apiCreateTicket } from '../src/dashboard/handlers/sprint.js';
import { TICKET_REF_INDEX } from '../src/scrum/ticket-ref.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

function setup() {
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  const server = new FakeServer();
  registerScrumTools(server as never, db);
  const sprint = (name: string) =>
    Number(
      db.prepare(`INSERT INTO sprints (name, goal, status) VALUES (?, 'g', 'planning')`).run(name)
        .lastInsertRowid,
    );
  const tool = (name: string) => server.tools.get(name)!;
  return { db, sprint, tool };
}

const text = (res: { content: Array<{ text: string }> }) =>
  res.content.map((c) => c.text).join('\n');
const refs = (db: Database.Database) =>
  (
    db.prepare(`SELECT ticket_ref FROM tickets ORDER BY id`).all() as Array<{ ticket_ref: string }>
  ).map((r) => r.ticket_ref);

describe('ticket refs are unique across the database (#222)', () => {
  it('gives unique refs to tickets with and without a sprint, from the dashboard and MCP', async () => {
    const { db, sprint, tool } = setup();
    const a = sprint('A');
    const b = sprint('B');

    apiCreateTicket(db, { title: 'dashboard, no sprint 1' });
    apiCreateTicket(db, { title: 'dashboard, no sprint 2' });
    apiCreateTicket(db, { title: 'dashboard, sprint A', sprint_id: a });
    const mcp = await tool('create_ticket')({
      sprint_id: b,
      title: 'mcp, sprint B',
      priority: 'P2',
    });
    expect(mcp.isError).toBeFalsy();
    const started = await tool('start_sprint')({
      name: 'C',
      goal: 'g',
      tickets: [{ title: 'start_sprint 1' }, { title: 'start_sprint 2' }],
      acknowledge_open_items: true,
    });
    expect(started.isError).toBeFalsy();
    apiCreateTicket(db, { title: 'dashboard, no sprint 3' });

    const all = refs(db);
    expect(all).toHaveLength(7);
    expect(all.every((r) => /^T-\d+$/.test(r))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(text(mcp)).toContain(`Ticket created: ${all[3]} — mcp, sprint B`);
  });

  it('MCP create_ticket and the dashboard skip a ref that a row already has', async () => {
    const { db, sprint, tool } = setup();
    const s = sprint('S');
    // Hand-set refs T-2 and T-3; the next ref by id (MAX(id) + 1 = T-3) is taken.
    const hand1 = await tool('create_ticket')({
      sprint_id: s,
      title: 'hand 1',
      ticket_ref: 'T-2',
      priority: 'P2',
    });
    const hand2 = await tool('create_ticket')({
      sprint_id: s,
      title: 'hand 2',
      ticket_ref: 'T-3',
      priority: 'P2',
    });
    expect(hand1.isError).toBeFalsy();
    expect(hand2.isError).toBeFalsy();

    const fromMcp = await tool('create_ticket')({
      sprint_id: s,
      title: 'auto mcp',
      priority: 'P2',
    });
    const fromDashboard = apiCreateTicket(db, { title: 'auto dashboard' });
    expect(text(fromMcp)).toContain('Ticket created: T-4');
    expect(fromDashboard.ticket_ref).toBe('T-5');
    expect(refs(db)).toEqual(['T-2', 'T-3', 'T-4', 'T-5']);
  });

  it('MCP create_ticket refuses a hand-set ref that another ticket has, in any sprint', async () => {
    const { db, sprint, tool } = setup();
    apiCreateTicket(db, { title: 'no sprint' }); // T-1, sprint NULL
    const res = await tool('create_ticket')({
      sprint_id: sprint('S'),
      title: 'dup',
      ticket_ref: 'T-1',
      priority: 'P2',
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/ticket_ref T-1 is already used by ticket #1/);
    expect(refs(db)).toEqual(['T-1']);
  });

  it('a soft-deleted ticket keeps its ref', async () => {
    const { db, tool, sprint } = setup();
    const first = apiCreateTicket(db, { title: 'then deleted' });
    db.prepare(`UPDATE tickets SET deleted_at = datetime('now') WHERE id = ?`).run(first.id);
    const res = await tool('create_ticket')({
      sprint_id: sprint('S'),
      title: 'reuse?',
      ticket_ref: first.ticket_ref,
      priority: 'P2',
    });
    expect(res.isError).toBe(true);
    expect(apiCreateTicket(db, { title: 'next' }).ticket_ref).not.toBe(first.ticket_ref);
  });

  it('the database refuses a shared ref, also when both tickets have no sprint', () => {
    const { db } = setup();
    expect(
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get(TICKET_REF_INDEX),
    ).toBeTruthy();
    db.prepare(`INSERT INTO tickets (ticket_ref, title) VALUES ('T-7', 'one')`).run();
    expect(() =>
      db.prepare(`INSERT INTO tickets (ticket_ref, title) VALUES ('T-7', 'two')`).run(),
    ).toThrow(/UNIQUE constraint failed: tickets\.ticket_ref/);
    // Tickets without a ref stay allowed.
    db.prepare(`INSERT INTO tickets (title) VALUES ('no ref 1')`).run();
    db.prepare(`INSERT INTO tickets (title) VALUES ('no ref 2')`).run();
  });
});
