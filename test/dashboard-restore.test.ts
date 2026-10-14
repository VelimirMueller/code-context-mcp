/**
 * #230: POST /api/restore never replaces an existing row. A clash answers
 * 409 and writes nothing, unless the body says on_conflict "skip"; dry_run
 * only reports. Spawns the real dashboard on a temp DB (as in
 * test/dashboard-route-parity.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_ENTRY = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const TOKEN = 'test-dashboard-restore-token-0123456789ab';
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess;
let tmpRoot: string;
let dbPath: string;
let serverLog = '';

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

function ourDbHasSchema(): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tickets'")
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
    if (proc.exitCode !== null) throw new Error(`dashboard exited early:\n${serverLog}`);
    try {
      const res = await fetch(`${BASE}/api/sprints`, { headers });
      if (res.ok && ourDbHasSchema()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard did not become ready in ${timeoutMs}ms:\n${serverLog}`);
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-restore-api-'));
  dbPath = path.join(tmpRoot, 'context.db');
  proc = spawn(process.execPath, [TSX_CLI, DASHBOARD_ENTRY, dbPath, String(PORT)], {
    cwd: tmpRoot,
    env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN, DASHBOARD_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.stdout?.on('data', (d) => (serverLog += String(d)));
  proc.stderr?.on('data', (d) => (serverLog += String(d)));
  await waitForServer();
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

const post = (pathname: string, body: unknown) =>
  fetch(`${BASE}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('POST /api/restore (#230)', () => {
  it('answers 409 for a clashing ticket, keeps the row, and restores with skip', async () => {
    const created = await post('/api/tickets', { title: 'Existing ticket', priority: 'P2' });
    expect(created.ok, await created.clone().text()).toBe(true);
    const { id } = (await created.json()) as { id: number };
    const dump = (await (await fetch(`${BASE}/api/dump`, { headers })).json()) as {
      version: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    const row = dump.tables.tickets.find((t) => t.id === id)!;
    const tables = {
      tickets: [
        { ...row, title: 'Title from the dump' },
        { ...row, id: id + 100, ticket_ref: 'T-900', title: 'New ticket from dump' },
      ],
    };

    const refused = await post('/api/restore', { version: dump.version, tables });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Restore refused');
    expect(body.error).toContain(`tickets id=${id}`);

    const dry = await post('/api/restore', { version: dump.version, tables, dry_run: true });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({
      ok: true,
      dry_run: true,
      tables: { tickets: { inserted: 1, unchanged: 0, clashes: 1 } },
    });

    const skipped = await post('/api/restore', {
      version: dump.version,
      tables,
      on_conflict: 'skip',
    });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ ok: true, restored: { tickets: 1 } });

    const db = new Database(dbPath, { readonly: true });
    try {
      const kept = db.prepare('SELECT title FROM tickets WHERE id = ?').get(id) as {
        title: string;
      };
      expect(kept.title).toBe('Existing ticket');
      const added = db.prepare('SELECT title FROM tickets WHERE id = ?').get(id + 100) as {
        title: string;
      };
      expect(added.title).toBe('New ticket from dump');
    } finally {
      db.close();
    }
  });
});
