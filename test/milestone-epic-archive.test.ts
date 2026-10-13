/**
 * Milestone + epic archiving (schema v24, v2.6.0).
 *
 * 1. src/scrum/archive.ts — eligibility, force, idempotence, audit (in-memory DB)
 * 2. MCP tools — update_milestone / update_epic `archived` + `force`, list_milestones,
 *    list_epics `include_archived`, resume-state filtering (FakeServer pattern from
 *    roster-guard.test.ts; notifications are pointed at a dead port)
 * 3. Dashboard routes — POST /api/{milestone,epic}/:id/{archive,unarchive} against a
 *    spawned dashboard + temp DB (harness from sprint-archive.test.ts), including the
 *    existing Host / Origin / bearer-token gates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { archiveEntity, unarchiveEntity } from '../src/scrum/archive.js';
import { registerScrumTools } from '../src/scrum/tools.js';
import { freePort } from './helpers/free-port.js';

// MCP tools resolve a bearer token for their dashboard notify call — never let that
// generate a token file in the repo during tests.
process.env.CODE_CONTEXT_DASHBOARD_TOKEN ??= 'test-token-unused-by-fake-server';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

function memDb(): Database.Database {
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  // Point notifyDashboard at a closed port so tests never reach a running dashboard.
  db.prepare("INSERT INTO skills (name, content) VALUES ('_dashboard_port', '9')").run();
  return db;
}

function setup() {
  const db = memDb();
  const server = new FakeServer();
  registerScrumTools(server as never, db);
  return { db, tools: server.tools };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

function addMilestone(db: Database.Database, name: string, status = 'completed'): number {
  return Number(
    db.prepare('INSERT INTO milestones (name, status) VALUES (?, ?)').run(name, status)
      .lastInsertRowid,
  );
}
function addEpic(
  db: Database.Database,
  name: string,
  status = 'completed',
  milestoneId: number | null = null,
): number {
  return Number(
    db
      .prepare('INSERT INTO epics (name, status, milestone_id) VALUES (?, ?, ?)')
      .run(name, status, milestoneId).lastInsertRowid,
  );
}
const archivedAt = (db: Database.Database, table: string, id: number) =>
  (
    db.prepare(`SELECT archived_at FROM ${table} WHERE id = ?`).get(id) as {
      archived_at: string | null;
    }
  ).archived_at;
const events = (db: Database.Database, entity: string, id: number) =>
  db
    .prepare(
      "SELECT * FROM event_log WHERE entity_type = ? AND entity_id = ? AND field_name = 'archived_at' ORDER BY id",
    )
    .all(entity, id) as any[];

// ── 1. archive module ─────────────────────────────────────────────────────

describe('archiveEntity / unarchiveEntity', () => {
  it.each([
    ['milestone', 'milestones'],
    ['epic', 'epics'],
  ] as const)('archives a completed %s, audits it, and round-trips', (entity, table) => {
    const db = memDb();
    const id = entity === 'milestone' ? addMilestone(db, 'm') : addEpic(db, 'e');
    const r = archiveEntity(db, entity, id, { actor: 'test' });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(archivedAt(db, table, id)).toBe(r.archived_at);
    const u = unarchiveEntity(db, entity, id, { actor: 'test' });
    expect(u).toEqual({ ok: true, archived_at: null, changed: true });
    expect(archivedAt(db, table, id)).toBeNull();
    const ev = events(db, entity, id);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ action: 'updated', old_value: null, actor: 'test' });
    expect(ev[0].new_value).not.toBeNull();
    expect(ev[1]).toMatchObject({ new_value: null, old_value: ev[0].new_value });
  });

  it('rejects a non-completed row with 400 unless force', () => {
    const db = memDb();
    const id = addMilestone(db, 'active-m', 'active');
    expect(() => archiveEntity(db, 'milestone', id, { actor: 't' })).toThrow(
      /only completed milestones/,
    );
    try {
      archiveEntity(db, 'milestone', id, { actor: 't' });
    } catch (e: any) {
      expect(e.status).toBe(400);
    }
    expect(archivedAt(db, 'milestones', id)).toBeNull();
    expect(archiveEntity(db, 'milestone', id, { actor: 't', force: true }).changed).toBe(true);
  });

  it('404s on missing and soft-deleted rows', () => {
    const db = memDb();
    const id = addEpic(db, 'gone');
    db.prepare("UPDATE epics SET deleted_at = datetime('now') WHERE id = ?").run(id);
    for (const target of [id, 999999]) {
      try {
        archiveEntity(db, 'epic', target, { actor: 't' });
        expect.unreachable();
      } catch (e: any) {
        expect(e.status).toBe(404);
      }
      expect(() => unarchiveEntity(db, 'epic', target, { actor: 't' })).toThrow(/epic not found/);
    }
  });

  it('is idempotent: re-archive keeps the original timestamp and writes no extra audit row', () => {
    const db = memDb();
    const id = addEpic(db, 'e');
    db.prepare("UPDATE epics SET archived_at = '2026-01-01 00:00:00' WHERE id = ?").run(id);
    expect(archiveEntity(db, 'epic', id, { actor: 't' })).toEqual({
      ok: true,
      archived_at: '2026-01-01 00:00:00',
      changed: false,
    });
    const fresh = addEpic(db, 'f');
    expect(unarchiveEntity(db, 'epic', fresh, { actor: 't' }).changed).toBe(false);
    expect(events(db, 'epic', id)).toHaveLength(0);
    expect(events(db, 'epic', fresh)).toHaveLength(0);
  });
});

// ── 2. MCP tools ──────────────────────────────────────────────────────────

describe('update_milestone archived/force', () => {
  it('refuses to archive a planned milestone without force and changes nothing', async () => {
    const { db, tools } = setup();
    const id = addMilestone(db, 'planned-m', 'planned');
    const r = await tools.get('update_milestone')!({
      milestone_id: id,
      archived: true,
      progress: 50,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/only completed milestones/);
    // The progress change in the same call was rolled back with the failed archive.
    expect(db.prepare('SELECT progress, archived_at FROM milestones WHERE id = ?').get(id)).toEqual(
      { progress: 0, archived_at: null },
    );
  });

  it('archives with force=true regardless of status', async () => {
    const { db, tools } = setup();
    const id = addMilestone(db, 'active-m', 'active');
    const r = await tools.get('update_milestone')!({
      milestone_id: id,
      archived: true,
      force: true,
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Archived.');
    expect(archivedAt(db, 'milestones', id)).not.toBeNull();
    expect(events(db, 'milestone', id)[0].actor).toBe('mcp');
  });

  it('completes and archives in one call, then unarchives', async () => {
    const { db, tools } = setup();
    const id = addMilestone(db, 'closing', 'active');
    const r = await tools.get('update_milestone')!({
      milestone_id: id,
      status: 'completed',
      archived: true,
    });
    expect(r.isError).toBeFalsy();
    expect(db.prepare('SELECT status FROM milestones WHERE id = ?').get(id)).toEqual({
      status: 'completed',
    });
    expect(archivedAt(db, 'milestones', id)).not.toBeNull();
    const u = await tools.get('update_milestone')!({ milestone_id: id, archived: false });
    expect(text(u)).toContain('Unarchived.');
    expect(archivedAt(db, 'milestones', id)).toBeNull();
  });

  it('reports a missing milestone as an error when archiving', async () => {
    const { tools } = setup();
    const r = await tools.get('update_milestone')!({ milestone_id: 424242, archived: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/milestone not found/);
  });
});

describe('list_milestones', () => {
  it('hides archived milestones by default and shows them with include_archived', async () => {
    const { db, tools } = setup();
    addMilestone(db, 'Visible', 'active');
    const gone = addMilestone(db, 'Shelved', 'completed');
    const deleted = addMilestone(db, 'Trashed', 'completed');
    db.prepare("UPDATE milestones SET deleted_at = datetime('now') WHERE id = ?").run(deleted);
    archiveEntity(db, 'milestone', gone, { actor: 't' });

    const def = text(await tools.get('list_milestones')!({}));
    expect(def).toContain('Visible');
    expect(def).not.toContain('Shelved');
    expect(def).not.toContain('Trashed');

    const all = text(
      await tools.get('list_milestones')!({ include_archived: true, compact: true }),
    );
    expect(all).toContain(`#${gone} Shelved [completed] (archived)`);
    expect(all).not.toContain('Trashed');
  });
});

describe('update_epic / list_epics archive', () => {
  it('archives a completed epic, hides it from list_epics, include_archived brings it back', async () => {
    const { db, tools } = setup();
    const done = addEpic(db, 'Done epic', 'completed');
    addEpic(db, 'Live epic', 'active');

    const r = await tools.get('update_epic')!({ epic_id: done, archived: true });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Archived.');

    for (const compact of [true, false]) {
      const def = text(await tools.get('list_epics')!({ compact }));
      expect(def).toContain('Live epic');
      expect(def).not.toContain('Done epic');
      const all = text(await tools.get('list_epics')!({ compact, include_archived: true }));
      expect(all).toContain('Done epic');
      expect(all).toContain('(archived)');
    }
  });

  it('refuses an active epic without force; force archives it', async () => {
    const { db, tools } = setup();
    const id = addEpic(db, 'WIP', 'active');
    const r = await tools.get('update_epic')!({ epic_id: id, archived: true });
    expect(r.isError).toBe(true);
    expect(archivedAt(db, 'epics', id)).toBeNull();
    const f = await tools.get('update_epic')!({ epic_id: id, archived: true, force: true });
    expect(f.isError).toBeFalsy();
    expect(archivedAt(db, 'epics', id)).not.toBeNull();
    const u = await tools.get('update_epic')!({ epic_id: id, archived: false });
    expect(text(u)).toContain('Unarchived.');
  });

  it('keeps the old not-found message for plain field updates', async () => {
    const { tools } = setup();
    const r = await tools.get('update_epic')!({ epic_id: 31337, name: 'x' });
    expect(text(r)).toBe('Epic 31337 not found.');
  });
});

describe('resume state ignores force-archived work', () => {
  it('does not report an archived active milestone or epic as current', async () => {
    const { db, tools } = setup();
    const m = addMilestone(db, 'Abandoned milestone', 'active');
    const e = addEpic(db, 'Abandoned epic', 'active');
    archiveEntity(db, 'milestone', m, { actor: 't', force: true });
    archiveEntity(db, 'epic', e, { actor: 't', force: true });
    const out = text(await tools.get('get_resume_state')!({}));
    expect(out).toContain('milestone: none');
    expect(out).toContain('epics: 0 active');
    const phase = text(await tools.get('load_phase_context')!({ phase: 'epics' }));
    expect(phase).not.toContain('Abandoned epic');
  });
});

// ── 3. Dashboard routes (spawned server, temp DB) ─────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_ENTRY = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const TOKEN = 'test-me-archive-token-0123456789abcdef';
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess;
let tmpRoot: string;
let dbPath: string;
let serverLog = '';

const auth = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function ourDbHasSchema(): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='milestones'")
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
    if (proc.exitCode !== null)
      throw new Error(`dashboard exited early (code ${proc.exitCode}):\n${serverLog}`);
    try {
      const res = await fetch(`${BASE}/api/milestones`, { headers: auth() });
      if (res.ok && ourDbHasSchema()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard did not become ready in ${timeoutMs}ms:\n${serverLog}`);
}

/** Raw request so the Host header can be forged (fetch forbids overriding it). */
function rawPost(p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('dashboard archive routes', () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-me-archive-'));
    dbPath = path.join(tmpRoot, 'context.db');
    proc = spawn(process.execPath, [TSX_CLI, DASHBOARD_ENTRY, dbPath, String(PORT)], {
      cwd: tmpRoot,
      env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN, DASHBOARD_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    proc.stdout?.on('data', (d) => {
      serverLog += String(d);
    });
    proc.stderr?.on('data', (d) => {
      serverLog += String(d);
    });
    await waitForServer();
  }, 40000);

  afterAll(() => {
    if (proc?.pid) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    proc?.kill('SIGKILL');
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.each([
    ['milestone', 'milestones'],
    ['epic', 'epics'],
  ] as const)('archives + unarchives a completed %s with an audit trail', async (entity, table) => {
    const id = withDb((db) =>
      entity === 'milestone' ? addMilestone(db, `api-${entity}`) : addEpic(db, `api-${entity}`),
    );
    const a = await fetch(`${BASE}/api/${entity}/${id}/archive`, {
      method: 'POST',
      headers: auth(),
    });
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ ok: true, changed: true });
    expect(withDb((db) => archivedAt(db, table, id))).not.toBeNull();

    const u = await fetch(`${BASE}/api/${entity}/${id}/unarchive`, {
      method: 'POST',
      headers: auth(),
    });
    expect(u.status).toBe(200);
    expect(withDb((db) => archivedAt(db, table, id))).toBeNull();
    const ev = withDb((db) => events(db, entity, id));
    expect(ev.map((e) => e.actor)).toEqual(['dashboard', 'dashboard']);
  });

  it('returns 400 for a non-completed milestone (no force over HTTP)', async () => {
    const id = withDb((db) => addMilestone(db, 'api-active', 'active'));
    const r = await fetch(`${BASE}/api/milestone/${id}/archive`, {
      method: 'POST',
      headers: auth(),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/only completed milestones/);
    expect(withDb((db) => archivedAt(db, 'milestones', id))).toBeNull();
  });

  it('returns 404 for missing and soft-deleted epics', async () => {
    const id = withDb((db) => {
      const e = addEpic(db, 'api-deleted');
      db.prepare("UPDATE epics SET deleted_at = datetime('now') WHERE id = ?").run(e);
      return e;
    });
    for (const target of [id, 9999999]) {
      const r = await fetch(`${BASE}/api/epic/${target}/archive`, {
        method: 'POST',
        headers: auth(),
      });
      expect(r.status).toBe(404);
    }
  });

  it('GET /api/milestones and /api/epics expose archived_at so the UI can filter', async () => {
    for (const p of ['/api/milestones', '/api/epics']) {
      const rows = (await (await fetch(`${BASE}${p}`, { headers: auth() })).json()) as any[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows)
        expect(Object.prototype.hasOwnProperty.call(r, 'archived_at')).toBe(true);
    }
  });

  it('POST /api/milestones saves the body the dashboard sends and returns the saved row (#199)', async () => {
    const res = await fetch(`${BASE}/api/milestones`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'api-created', target_date: '2026-12-01' }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as any;
    expect(row.id).toEqual(expect.any(Number));
    expect(row).toMatchObject({
      name: 'api-created',
      target_date: '2026-12-01',
      status: 'planned',
      description: null,
    });
    const saved = withDb((db) =>
      db.prepare('SELECT name, target_date, status FROM milestones WHERE id = ?').get(row.id),
    );
    expect(saved).toEqual({ name: 'api-created', target_date: '2026-12-01', status: 'planned' });
  });

  it('POST /api/milestones still answers 400 for a body without name (old `title` field)', async () => {
    const res = await fetch(`${BASE}/api/milestones`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'wrong-field' }),
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as any).error)).toContain('name is required');
  });

  const putMilestone = (id: number, body: unknown) =>
    fetch(`${BASE}/api/milestone/${id}`, {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const milestoneRow = (id: number) =>
    withDb((db) =>
      db.prepare('SELECT status, target_date, description FROM milestones WHERE id = ?').get(id),
    );

  it('PUT /api/milestone/:id saves status and target_date and returns the saved row (#205)', async () => {
    const id = withDb((db) => addMilestone(db, 'api-edit', 'planned'));
    const res = await putMilestone(id, { status: 'active', target_date: '2026-12-15' });
    expect(res.status).toBe(200);
    const row = (await res.json()) as any;
    expect(row).toMatchObject({
      id,
      name: 'api-edit',
      status: 'active',
      target_date: '2026-12-15',
    });
    expect(milestoneRow(id)).toMatchObject({ status: 'active', target_date: '2026-12-15' });
  });

  it('PUT /api/milestone/:id clears target_date and description with null (#205)', async () => {
    const id = withDb((db) => addMilestone(db, 'api-clear', 'planned'));
    await putMilestone(id, { target_date: '2026-12-15', description: 'temporary' });
    const res = await putMilestone(id, { target_date: null, description: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ target_date: null, description: null });
    expect(milestoneRow(id)).toMatchObject({ target_date: null, description: null });
  });

  it('PUT /api/milestone/:id answers 400 for in_progress and changes nothing (#205)', async () => {
    const id = withDb((db) => addMilestone(db, 'api-bad-status', 'planned'));
    const res = await putMilestone(id, { status: 'in_progress' });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as any).error)).toMatch(/Invalid milestone status/);
    expect(milestoneRow(id)).toMatchObject({ status: 'planned' });
  });

  it('PUT /api/milestone/:id answers 400 for an empty body and 404 for a missing milestone (#205)', async () => {
    const id = withDb((db) => addMilestone(db, 'api-empty', 'planned'));
    const empty = await putMilestone(id, {});
    expect(empty.status).toBe(400);
    expect(String(((await empty.json()) as any).error)).toContain('nothing to update');
    const missing = await putMilestone(9999999, { status: 'active' });
    expect(missing.status).toBe(404);
  });

  it('keeps the existing gates: no token → 401, foreign Host → 421, cross-origin write → 403', async () => {
    const id = withDb((db) => addMilestone(db, 'api-gated'));
    const noAuth = await fetch(`${BASE}/api/milestone/${id}/archive`, { method: 'POST' });
    expect(noAuth.status).toBe(401);
    expect(
      await rawPost(`/api/milestone/${id}/archive`, {
        Host: `evil.example:${PORT}`,
        Authorization: `Bearer ${TOKEN}`,
      }),
    ).toBe(421);
    expect(
      await rawPost(`/api/milestone/${id}/archive`, {
        Host: `127.0.0.1:${PORT}`,
        Origin: 'http://evil.example',
        Authorization: `Bearer ${TOKEN}`,
      }),
    ).toBe(403);
    expect(withDb((db) => archivedAt(db, 'milestones', id))).toBeNull();
  });
});
