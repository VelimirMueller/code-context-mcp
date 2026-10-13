/**
 * T-248 (D1b): PATCH /api/ticket/:id — dashboard full-field ticket edit with
 * revisions + change flags (spec §D1/§D2, 2026-06-11 loop-gates design).
 *
 * Spawns the real dashboard (tsx src/dashboard/dashboard.ts <tempDb> <port>) with a
 * known CODE_CONTEXT_DASHBOARD_TOKEN and a throwaway temp DB, then drives it over
 * HTTP (harness pattern: test/sprint-archive.test.ts). The repo root context.db is
 * never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.js';
import { DEFAULT_TICKET_PRIORITY } from '../src/dashboard/handlers/sprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_ENTRY = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');

const TOKEN = 'test-ticket-patch-token-0123456789abcdef';
// OS-assigned free port (helpers/free-port.ts); waitForServer additionally checks our
// own temp DB.
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess;
let tmpRoot: string;
let dbPath: string;
let serverLog = '';

// Resolve the tsx CLI from node_modules and run it under the current node binary.
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

/** Direct connection to the same temp DB the server uses, for seeding + assertions. */
function seedDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extra };
}

/** True once OUR spawned server has initialised the schema in OUR temp DB. */
function ourDbHasSchema(): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ticket_revisions'")
        .get();
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`dashboard process exited early (code ${proc.exitCode}):\n${serverLog}`);
    }
    try {
      const res = await fetch(`${BASE}/api/sprints`, { headers: authHeaders() });
      // A 200 alone could come from an unrelated server; require our own temp DB to be
      // schema-initialised too, so a port collision can never give a false ready signal.
      if (res.ok && ourDbHasSchema()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard server did not become ready in ${timeoutMs}ms:\n${serverLog}`);
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-ticket-patch-'));
  dbPath = path.join(tmpRoot, 'context.db');
  proc = spawn(process.execPath, [TSX_CLI, DASHBOARD_ENTRY, dbPath, String(PORT)], {
    cwd: tmpRoot, // token file + .env.local land in the throwaway dir, never the repo
    env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN, DASHBOARD_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so teardown can kill any children
  });
  proc.stdout?.on('data', (d) => {
    serverLog += String(d);
  });
  proc.stderr?.on('data', (d) => {
    serverLog += String(d);
  });
  proc.on('error', (e) => {
    serverLog += `[spawn error] ${e.message}\n`;
  });
  await waitForServer();

  // Test-owned agents so role validation does not depend on factory seed contents.
  const db = seedDb();
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO agents (role, name) VALUES (?, ?)');
    ins.run('patch-dev', 'Patch Dev');
    ins.run('patch-sec', 'Patch Sec');
  } finally {
    db.close();
  }
}, 40000);

afterAll(() => {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  proc?.kill('SIGKILL');
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Seeding + assertion helpers ─────────────────────────────────────────────

let refCounter = 0;

function insertTicket(overrides: Record<string, unknown> = {}): number {
  const db = seedDb();
  try {
    const row = {
      ticket_ref: `TP-${++refCounter}`,
      title: 'Original title',
      description: 'Original description',
      priority: 'P2',
      status: 'TODO',
      story_points: 3,
      assigned_to: null,
      ...overrides,
    } as Record<string, unknown>;
    const r = db
      .prepare(
        `INSERT INTO tickets (ticket_ref, title, description, priority, status, story_points, assigned_to)
       VALUES (@ticket_ref, @title, @description, @priority, @status, @story_points, @assigned_to)`,
      )
      .run(row);
    return Number(r.lastInsertRowid);
  } finally {
    db.close();
  }
}

function insertAssignment(
  ticketId: number,
  role: string,
  isLead: number,
  model: string | null = null,
): void {
  const db = seedDb();
  try {
    db.prepare(
      'INSERT INTO ticket_assignments (ticket_id, role, model, is_lead) VALUES (?, ?, ?, ?)',
    ).run(ticketId, role, model, isLead);
    db.prepare('UPDATE tickets SET assigned_to = ? WHERE id = ?').run(role, ticketId);
  } finally {
    db.close();
  }
}

function getTicketRow(id: number): any {
  const db = seedDb();
  try {
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

function revisionRows(id: number): any[] {
  const db = seedDb();
  try {
    return db
      .prepare('SELECT * FROM ticket_revisions WHERE ticket_id = ? ORDER BY id')
      .all(id) as any[];
  } finally {
    db.close();
  }
}

function pendingActionRows(id: number): any[] {
  const db = seedDb();
  try {
    return db
      .prepare(
        "SELECT * FROM pending_actions WHERE action = 'ticket_changed' AND entity_type = 'ticket' AND entity_id = ? ORDER BY id",
      )
      .all(id) as any[];
  } finally {
    db.close();
  }
}

function eventRows(id: number): any[] {
  const db = seedDb();
  try {
    return db
      .prepare("SELECT * FROM event_log WHERE entity_type = 'ticket' AND entity_id = ? ORDER BY id")
      .all(id) as any[];
  } finally {
    db.close();
  }
}

function assignmentRows(id: number): any[] {
  const db = seedDb();
  try {
    return db
      .prepare(
        'SELECT role, model, is_lead FROM ticket_assignments WHERE ticket_id = ? ORDER BY is_lead DESC, role',
      )
      .all(id) as any[];
  } finally {
    db.close();
  }
}

async function patchTicket(
  id: number,
  body: unknown,
  headers: Record<string, string> = authHeaders(),
) {
  return fetch(`${BASE}/api/ticket/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

// ── Happy path: single-field edit ───────────────────────────────────────────

describe('PATCH /api/ticket/:id — single-field edit', () => {
  it('updates the field, bumps change_seq, sets pending_change, writes revision + pending_action + event_log in one go', async () => {
    const id = insertTicket();
    const before = getTicketRow(id);

    const res = await patchTicket(id, { title: 'Renamed from the board' });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Frozen response shape: { ok: true, ticket: <full row + assignments> }
    expect(body.ok).toBe(true);
    expect(body.ticket.id).toBe(id);
    expect(body.ticket.title).toBe('Renamed from the board');
    expect(body.ticket.change_seq).toBe(before.change_seq + 1);
    expect(body.ticket.pending_change).toBe(1);
    expect(Array.isArray(body.ticket.assignments)).toBe(true);

    // DB state
    const after = getTicketRow(id);
    expect(after.title).toBe('Renamed from the board');
    expect(after.change_seq).toBe(before.change_seq + 1);
    expect(after.pending_change).toBe(1);

    // Exactly one revision row with the correct field-level diff
    const revisions = revisionRows(id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].source).toBe('ui');
    expect(JSON.parse(revisions[0].changed_fields)).toEqual(['title']);
    expect(JSON.parse(revisions[0].old_values)).toEqual({ title: 'Original title' });
    expect(JSON.parse(revisions[0].new_values)).toEqual({ title: 'Renamed from the board' });

    // One pending_action 'ticket_changed' with the same diff payload
    const actions = pendingActionRows(id);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('pending');
    expect(actions[0].source).toBe('dashboard');
    const payload = JSON.parse(actions[0].payload);
    expect(payload.changed_fields).toEqual(['title']);
    expect(payload.old_values).toEqual({ title: 'Original title' });
    expect(payload.new_values).toEqual({ title: 'Renamed from the board' });

    // One event_log row for the changed scalar field
    const events = eventRows(id);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('updated');
    expect(events[0].field_name).toBe('title');
    expect(events[0].old_value).toBe('Original title');
    expect(events[0].new_value).toBe('Renamed from the board');
    expect(events[0].actor).toBe('dashboard');
  });

  it('is a 200 no-op (no change_seq bump, no revision) when the value is unchanged', async () => {
    const id = insertTicket({ title: 'Same title' });
    const before = getTicketRow(id);

    const res = await patchTicket(id, { title: 'Same title' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ticket.change_seq).toBe(before.change_seq);

    expect(getTicketRow(id).pending_change).toBe(0);
    expect(revisionRows(id)).toHaveLength(0);
    expect(pendingActionRows(id)).toHaveLength(0);
  });
});

// ── Multi-field edit: one transaction, one revision ─────────────────────────

describe('PATCH /api/ticket/:id — multi-field edit', () => {
  it('writes ONE revision row listing all changed fields and one event per scalar', async () => {
    const id = insertTicket();
    const before = getTicketRow(id);

    const res = await patchTicket(id, { title: 'Multi edit', story_points: 8, priority: 'P0' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.story_points).toBe(8);
    expect(body.ticket.priority).toBe('P0');

    // One transaction → exactly one change_seq bump and one revision row
    const after = getTicketRow(id);
    expect(after.change_seq).toBe(before.change_seq + 1);

    const revisions = revisionRows(id);
    expect(revisions).toHaveLength(1);
    const changed = JSON.parse(revisions[0].changed_fields);
    expect([...changed].sort()).toEqual(['priority', 'story_points', 'title']);
    const oldValues = JSON.parse(revisions[0].old_values);
    const newValues = JSON.parse(revisions[0].new_values);
    expect(oldValues).toEqual({ title: 'Original title', story_points: 3, priority: 'P2' });
    expect(newValues).toEqual({ title: 'Multi edit', story_points: 8, priority: 'P0' });

    expect(pendingActionRows(id)).toHaveLength(1);
    expect(eventRows(id)).toHaveLength(3); // one per changed scalar field
  });
});

// ── Status guardrails ────────────────────────────────────────────────────────

describe('PATCH /api/ticket/:id — notes (#197)', () => {
  it('saves notes, returns the updated row and records the change', async () => {
    const id = insertTicket();

    const res = await patchTicket(id, { notes: 'Check the retry path' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ticket.id).toBe(id);
    expect(body.ticket.notes).toBe('Check the retry path');

    expect(getTicketRow(id).notes).toBe('Check the retry path');
    const revisions = revisionRows(id);
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0].changed_fields)).toEqual(['notes']);
    expect(eventRows(id).map((e) => e.field_name)).toEqual(['notes']);
  });

  it('clears notes with null and logs a null new value', async () => {
    const id = insertTicket();
    await patchTicket(id, { notes: 'temporary' });

    const res = await patchTicket(id, { notes: null });
    expect(res.status).toBe(200);
    expect((await res.json()).ticket.notes).toBeNull();
    expect(getTicketRow(id).notes).toBeNull();
    const events = eventRows(id);
    expect(events[events.length - 1].new_value).toBeNull();
  });

  it('rejects notes that are not a string or null with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, { notes: 42 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/notes must be a string or null/);
    expect(getTicketRow(id).notes).toBeNull();
  });
});

describe('PATCH /api/ticket/:id — description (#206)', () => {
  it('clears the description with null, returns the row and records the change', async () => {
    const id = insertTicket();

    const res = await patchTicket(id, { description: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ticket.id).toBe(id);
    expect(body.ticket.description).toBeNull();

    expect(getTicketRow(id).description).toBeNull();
    const revisions = revisionRows(id);
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0].changed_fields)).toEqual(['description']);
    const events = eventRows(id);
    expect(events.map((e) => e.field_name)).toEqual(['description']);
    expect(events[0].old_value).toBe('Original description');
    expect(events[0].new_value).toBeNull();
  });

  it('is a 200 no-op when the description is already null', async () => {
    const id = insertTicket({ description: null });
    const res = await patchTicket(id, { description: null });
    expect(res.status).toBe(200);
    expect(revisionRows(id)).toHaveLength(0);
  });

  it('rejects a description that is not a string or null with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, { description: 42 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/description must be a string or null/);
    expect(getTicketRow(id).description).toBe('Original description');
  });
});

describe('POST /api/tickets — default priority (#204)', () => {
  async function createTicket(body: unknown) {
    return fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  }

  it('uses the same default as the tickets.priority column', () => {
    const db = seedDb();
    try {
      const cols = db.prepare('PRAGMA table_info(tickets)').all() as {
        name: string;
        dflt_value: string | null;
      }[];
      const col = cols.find((c) => c.name === 'priority');
      expect(col?.dflt_value).toBe(`'${DEFAULT_TICKET_PRIORITY}'`);
    } finally {
      db.close();
    }
  });

  it('saves a ticket without a priority as P2 and returns the saved row', async () => {
    const res = await createTicket({ title: 'No priority given' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toEqual(expect.any(Number));
    expect(body.ticket_ref).toMatch(/^T-\d+$/);
    expect(body.title).toBe('No priority given');
    expect(body.priority).toBe('P2');
    expect(body.status).toBe('TODO');

    const row = getTicketRow(body.id);
    expect(row.title).toBe('No priority given');
    expect(row.priority).toBe('P2');
  });

  it('uses P2 for a null priority', async () => {
    const res = await createTicket({ title: 'Null priority', priority: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priority).toBe('P2');
    expect(getTicketRow(body.id).priority).toBe('P2');
  });

  it('keeps a given priority', async () => {
    const res = await createTicket({ title: 'Urgent', priority: 'P0' });
    expect(res.status).toBe(200);
    expect(getTicketRow((await res.json()).id).priority).toBe('P0');
  });

  it('rejects an empty or unknown priority with 400', async () => {
    for (const priority of ['', 'P9']) {
      const res = await createTicket({ title: 'Bad priority', priority });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Invalid priority/);
    }
  });
});

describe('POST /api/tickets — ticket ref of a deleted ticket (#210)', () => {
  async function createTicket(body: unknown) {
    return fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  }

  /** A sprint of its own, because UNIQUE(sprint_id, ticket_ref) treats NULL sprints as distinct. */
  function insertSprint(name: string): number {
    const db = seedDb();
    try {
      return Number(db.prepare('INSERT INTO sprints (name) VALUES (?)').run(name).lastInsertRowid);
    } finally {
      db.close();
    }
  }

  function softDelete(id: number) {
    const db = seedDb();
    try {
      db.prepare("UPDATE tickets SET deleted_at = datetime('now') WHERE id = ?").run(id);
    } finally {
      db.close();
    }
  }

  it('gives a new ref when the newest ticket is soft-deleted', async () => {
    const sprint_id = insertSprint('ref-210-deleted');
    const first = await createTicket({ title: 'Newest, then deleted', sprint_id });
    expect(first.status).toBe(200);
    const deleted = await first.json();
    softDelete(deleted.id);

    const res = await createTicket({ title: 'After the delete', sprint_id });
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.ticket_ref).toMatch(/^T-\d+$/);
    expect(created.ticket_ref).not.toBe(deleted.ticket_ref);
    expect(getTicketRow(created.id).sprint_id).toBe(sprint_id);
  });

  it('skips a ref that another row already has', async () => {
    const sprint_id = insertSprint('ref-210-taken');
    const db = seedDb();
    let taken: string;
    try {
      const maxId = (db.prepare('SELECT MAX(id) AS m FROM tickets').get() as { m: number }).m;
      // The ref the old rule would pick next, set by hand (as the MCP create_ticket tool can).
      taken = `T-${maxId + 2}`;
      db.prepare('INSERT INTO tickets (sprint_id, ticket_ref, title) VALUES (?, ?, ?)').run(
        sprint_id,
        taken,
        'Hand-set ref',
      );
    } finally {
      db.close();
    }

    const res = await createTicket({ title: 'Must not reuse the hand-set ref', sprint_id });
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.ticket_ref).not.toBe(taken);
    expect(created.ticket_ref).toMatch(/^T-\d+$/);
  });
});

describe('PATCH /api/ticket/:id — status rules', () => {
  it('allows TODO → IN_PROGRESS', async () => {
    const id = insertTicket({ status: 'TODO' });
    const res = await patchTicket(id, { status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(getTicketRow(id).status).toBe('IN_PROGRESS');
    expect(JSON.parse(revisionRows(id)[0].changed_fields)).toEqual(['status']);
  });

  it('saves a Kanban drop (#198) and returns the updated row', async () => {
    const id = insertTicket({ status: 'IN_PROGRESS' });
    for (const status of ['BLOCKED', 'TODO']) {
      const res = await patchTicket(id, { status });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.ticket.id).toBe(id);
      expect(body.ticket.status).toBe(status);
      expect(getTicketRow(id).status).toBe(status);
    }
    expect(revisionRows(id)).toHaveLength(2);
  });

  it.each(['DONE', 'PARTIAL', 'NOT_DONE'])(
    'rejects process-controlled status %s with 400',
    async (status) => {
      const id = insertTicket({ status: 'IN_PROGRESS' });
      const res = await patchTicket(id, { status });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toContain(status);
      // Untouched: no status change, no flags, no revision
      const row = getTicketRow(id);
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.pending_change).toBe(0);
      expect(revisionRows(id)).toHaveLength(0);
    },
  );

  it('rejects a transition out of a non-UI status (DONE → TODO) with 400', async () => {
    const id = insertTicket({ status: 'DONE' });
    const res = await patchTicket(id, { status: 'TODO' });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/transition/i);
    expect(getTicketRow(id).status).toBe('DONE');
  });

  it('rejects qa_verified in the body with 400 naming the violation', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, { qa_verified: 1 });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('qa_verified');
    expect(getTicketRow(id).qa_verified).toBe(0);
    expect(revisionRows(id)).toHaveLength(0);
  });

  it.each(['sprint_id', 'totally_bogus'])(
    'rejects unknown field %s with 400 naming it',
    async (field) => {
      const id = insertTicket();
      const res = await patchTicket(id, { [field]: 1 });
      expect(res.status).toBe(400);
      expect(String((await res.json()).error)).toContain(field);
      expect(revisionRows(id)).toHaveLength(0);
    },
  );

  it('rejects an empty body with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, {});
    expect(res.status).toBe(400);
  });
});

// ── Assignments (D2): replace-set + lead invariant + model validation ───────

describe('PATCH /api/ticket/:id — assignments', () => {
  it('replaces all assignment rows, mirrors the lead into assigned_to, persists model override and null model', async () => {
    const id = insertTicket();
    insertAssignment(id, 'patch-dev', 1); // pre-existing set to be replaced

    const res = await patchTicket(id, {
      assignments: [
        { role: 'patch-sec', lead: true, model: 'claude-opus-4-8' },
        { role: 'patch-dev' }, // no model → inherit agent default (NULL)
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Replace-set: exactly the two new rows, old row gone
    const rows = assignmentRows(id);
    expect(rows).toEqual([
      { role: 'patch-sec', model: 'claude-opus-4-8', is_lead: 1 },
      { role: 'patch-dev', model: null, is_lead: 0 },
    ]);

    // Lead mirrored into tickets.assigned_to (compat)
    expect(getTicketRow(id).assigned_to).toBe('patch-sec');

    // Response carries the assignments in the frozen shape
    expect(body.ticket.assignments).toEqual(rows);
    expect(body.ticket.assigned_to).toBe('patch-sec');

    // Revision serializes the full old array vs full new array
    const revisions = revisionRows(id);
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0].changed_fields)).toEqual(['assignments']);
    expect(JSON.parse(revisions[0].old_values).assignments).toEqual([
      { role: 'patch-dev', model: null, is_lead: 1 },
    ]);
    expect(JSON.parse(revisions[0].new_values).assignments).toEqual(rows);

    // assignments is not a scalar field → no event_log row, but the pending_action carries the diff
    expect(eventRows(id)).toHaveLength(0);
    const actions = pendingActionRows(id);
    expect(actions).toHaveLength(1);
    expect(JSON.parse(actions[0].payload).changed_fields).toEqual(['assignments']);
  });

  it('accepts an explicit null model', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, {
      assignments: [{ role: 'patch-dev', lead: true, model: null }],
    });
    expect(res.status).toBe(200);
    expect(assignmentRows(id)).toEqual([{ role: 'patch-dev', model: null, is_lead: 1 }]);
    expect(getTicketRow(id).assigned_to).toBe('patch-dev');
  });

  it('rejects zero leads with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, {
      assignments: [{ role: 'patch-dev' }, { role: 'patch-sec' }],
    });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/lead/i);
    expect(assignmentRows(id)).toHaveLength(0);
  });

  it('rejects two leads with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, {
      assignments: [
        { role: 'patch-dev', lead: true },
        { role: 'patch-sec', lead: true },
      ],
    });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/lead/i);
  });

  it('rejects a role that is not in the agents table with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, { assignments: [{ role: 'ghost-role', lead: true }] });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('ghost-role');
  });

  it('rejects a model outside the allowed list with 400', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, {
      assignments: [{ role: 'patch-dev', lead: true, model: 'gpt-5' }],
    });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/model/i);
  });
});

// ── Auth + 404 ───────────────────────────────────────────────────────────────

describe('PATCH /api/ticket/:id — auth and missing tickets', () => {
  it('rejects a request without a bearer token (401, house behavior)', async () => {
    const id = insertTicket();
    const res = await patchTicket(id, { title: 'nope' }, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
    expect(getTicketRow(id).title).toBe('Original title');
  });

  it('rejects a wrong bearer token (401, house behavior)', async () => {
    const id = insertTicket();
    const res = await patchTicket(
      id,
      { title: 'nope' },
      {
        Authorization: 'Bearer wrong-token',
        'Content-Type': 'application/json',
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown ticket id', async () => {
    const res = await patchTicket(9999999, { title: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted ticket', async () => {
    const id = insertTicket();
    const db = seedDb();
    try {
      db.prepare("UPDATE tickets SET deleted_at = datetime('now') WHERE id = ?").run(id);
    } finally {
      db.close();
    }
    const res = await patchTicket(id, { title: 'ghost' });
    expect(res.status).toBe(404);
  });
});

// ── SSE: ticket_changed emitted after commit ────────────────────────────────

describe('PATCH /api/ticket/:id — SSE notification', () => {
  it("emits a 'ticket_changed' event with the ticket's entityId", async () => {
    const id = insertTicket();

    const controller = new AbortController();
    const stream = await fetch(`${BASE}/api/events?token=${TOKEN}`, { signal: controller.signal });
    expect(stream.ok).toBe(true);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();

    try {
      const res = await patchTicket(id, { title: 'SSE edit' });
      expect(res.status).toBe(200);

      // Scan the stream until our typed event arrives (DB-watcher 'updated'
      // events may interleave); fail after a deadline.
      const deadline = Date.now() + 10000;
      let buffer = '';
      let found: any = null;
      while (!found && Date.now() < deadline) {
        const next = reader.read();
        const timeout = new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error('SSE read timed out')),
            Math.max(1, deadline - Date.now()),
          ),
        );
        const { value, done } = await Promise.race([next, timeout]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice('data: '.length));
            if (evt.type === 'ticket_changed' && evt.entityId === id) {
              found = evt;
              break;
            }
          } catch {
            /* partial line — keep reading */
          }
        }
      }
      expect(found).toBeTruthy();
      expect(found.entityType).toBe('ticket');
      expect(found.change.changed_fields).toEqual(['title']);
    } finally {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* stream already aborted */
      }
    }
  }, 20000);
});
