/**
 * #190 — dashboard write handlers parse their body with zod.
 *
 * In-process: the handlers in handlers/sprint.ts get an in-memory DB and a
 * bad body, and must throw a 400 before any row changes. The schemas must
 * still accept the bodies the dashboard app sends.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import {
  parseBody,
  AgentCreateBody,
  PlanSprintBody,
  SprintProcessBody,
  TicketPatchBody,
  BridgeRespondBody,
} from '../src/dashboard/handlers/schemas.js';
import {
  apiCreateBlocker,
  apiCreateBug,
  apiCreateTicket,
  apiPlanSprint,
  apiSprintUpdate,
  apiUpdateTicket,
  apiPatchTicket,
  createRetroFinding,
  updateRetroFinding,
} from '../src/dashboard/handlers/sprint.js';

let db: Database.Database;
let sprintId: number;
let ticketId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initScrumSchema(db);
  runMigrations(db);
  sprintId = Number(
    db.prepare("INSERT INTO sprints (name, status) VALUES ('s1', 'planning')").run()
      .lastInsertRowid,
  );
  ticketId = Number(
    db
      .prepare(
        "INSERT INTO tickets (title, sprint_id, priority, status) VALUES ('t', ?, 'P1', 'TODO')",
      )
      .run(sprintId).lastInsertRowid,
  );
});

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;

function expect400(fn: () => unknown, message: RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected a 400 error').toBeInstanceOf(Error);
  expect((err as { status?: number }).status).toBe(400);
  expect((err as Error).message).toMatch(message);
}

describe('parseBody', () => {
  it('returns the typed body and drops unknown keys', () => {
    const b = parseBody(AgentCreateBody, { role: 'qa', name: 'QA', extra: 1 });
    expect(b).toEqual({ role: 'qa', name: 'QA' });
  });

  it('names the field and the reason on a wrong type', () => {
    expect400(() => parseBody(AgentCreateBody, { role: 'qa', name: 5 }), /^name: /);
  });

  it('keeps the old message for a missing required field', () => {
    expect400(() => parseBody(AgentCreateBody, { name: 'x' }), /role and name are required/);
  });

  it('refuses null, arrays and scalars as a body', () => {
    for (const bad of [null, [], 'x', 3]) {
      expect400(() => parseBody(AgentCreateBody, bad), /request body must be a JSON object/);
      expect400(() => parseBody(TicketPatchBody, bad), /request body must be a JSON object/);
    }
  });

  it('plan sprint needs ticketIds or ticket_ids', () => {
    expect400(() => parseBody(PlanSprintBody, { name: 'x' }), /ticket_ids array is required/);
    expect(parseBody(PlanSprintBody, { name: 'x', ticket_ids: [] }).ticket_ids).toEqual([]);
  });

  it('sprint process: phases must be a non-empty list of named phases', () => {
    expect400(() => parseBody(SprintProcessBody, { phases: [] }), /phases array is required/);
    expect400(
      () => parseBody(SprintProcessBody, { phases: [{ name: '', criteria: [], actions: [] }] }),
      /Each phase requires a name/,
    );
    expect400(
      () => parseBody(SprintProcessBody, { phases: [{ name: 'p', criteria: 'x', actions: [] }] }),
      /criteria must be an array/,
    );
    const ok = parseBody(SprintProcessBody, { phases: [{ name: 'p', criteria: [], actions: [] }] });
    expect(ok.phases[0].duration).toBe('');
  });

  it('bridge respond needs a result', () => {
    expect400(() => parseBody(BridgeRespondBody, {}), /result is required/);
    expect(parseBody(BridgeRespondBody, { result: { a: 1 } }).result).toEqual({ a: 1 });
  });
});

describe('sprint handlers reject a bad body before any write (#190)', () => {
  it('create blocker / bug / retro finding', () => {
    expect400(() => apiCreateBlocker(db, sprintId, {}), /description required/);
    expect400(
      () => apiCreateBlocker(db, sprintId, { description: 'd', ticket_id: '7' }),
      /^ticket_id: /,
    );
    expect400(
      () => apiCreateBug(db, sprintId, { description: 'd' }),
      /description and severity required/,
    );
    expect400(
      () => createRetroFinding(db, sprintId, { category: 'x' }),
      /category and finding required/,
    );
    expect400(() => updateRetroFinding(db, 1, { linked_ticket_id: 'x' }), /^linked_ticket_id: /);
    expect(count('blockers')).toBe(0);
    expect(count('bugs')).toBe(0);
    expect(count('retro_findings')).toBe(0);
  });

  it('create ticket and plan sprint', () => {
    expect400(() => apiCreateTicket(db, { title: '' }), /title is required/);
    expect400(() => apiCreateTicket(db, { title: 'x', story_points: '3' }), /^story_points: /);
    expect400(() => apiPlanSprint(db, { name: 'n', ticket_ids: ['a'] }), /^ticket_ids\.0: /);
    expect(count('tickets')).toBe(1);
    expect(count('sprints')).toBe(1);
  });

  it('update sprint / ticket / patch ticket', () => {
    expect400(
      () => apiSprintUpdate(db, sprintId, { velocity_committed: '5' }),
      /^velocity_committed: /,
    );
    expect400(() => apiUpdateTicket(db, ticketId, { status: 3 }), /^status: /);
    expect400(() => apiPatchTicket(db, ticketId, null), /request body must be a JSON object/);
    const row = db.prepare('SELECT status, change_seq FROM tickets WHERE id = ?').get(ticketId);
    expect(row).toEqual({ status: 'TODO', change_seq: 0 });
  });

  it('valid bodies from the dashboard app still work', () => {
    apiCreateBlocker(db, sprintId, { description: 'd', ticket_id: ticketId, reported_by: null });
    apiCreateBug(db, sprintId, { description: 'd', severity: 'HIGH' });
    createRetroFinding(db, sprintId, { category: 'went_well', finding: 'f' });
    const created = apiCreateTicket(db, {
      title: 'new',
      priority: 'P2',
      story_points: 3,
      milestone_id: null,
    });
    expect(created.title).toBe('new');
    const planned = apiPlanSprint(db, {
      name: 's2',
      startDate: '2026-10-13',
      endDate: '2026-10-20',
      targetVelocity: 8,
      ticketIds: [ticketId],
      goal: 'g',
    });
    expect(planned.tickets_assigned).toBe(1);
    expect(apiUpdateTicket(db, ticketId, { qa_verified: true, review_status: null })).toEqual({
      id: ticketId,
      updated: true,
    });
    expect(apiSprintUpdate(db, sprintId, { goal: 'new goal' }).result).toEqual({
      id: sprintId,
      updated: true,
    });
    expect(count('blockers')).toBe(1);
    expect(count('bugs')).toBe(1);
    expect(count('retro_findings')).toBe(1);
  });
});
