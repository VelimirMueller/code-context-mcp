/**
 * #188 — a bad POST body must answer 400/413 and never stop the dashboard.
 *
 * Spawns the real dashboard (tsx src/dashboard/dashboard.ts <tempDb> <port>)
 * against a throwaway temp DB, posts malformed bodies to the notify endpoints,
 * and checks that /health still answers after each one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
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

const TOKEN = 'test-body-errors-token-0123456789abcdef';
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const ENDPOINTS = ['/api/notify/event', '/api/claude-output', '/api/claude-step'];

let proc: ChildProcess;
let tmpRoot: string;
let dbPath: string;
let serverLog = '';

function ourDbHasSchema(): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sprints'")
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
      const res = await fetch(`${BASE}/health`);
      if (res.ok && ourDbHasSchema()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard did not become ready in ${timeoutMs}ms:\n${serverLog}`);
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-body-'));
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

function post(pathname: string, body: string): Promise<Response> {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });
}

async function expectAlive(): Promise<void> {
  expect(proc.exitCode, serverLog).toBeNull();
  const res = await fetch(`${BASE}/health`);
  expect(res.status).toBe(200);
}

/** Post `bytes` of payload with http.request; resolve the status, or null on a reset. */
function postLarge(pathname: string, bytes: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request(
      `${BASE}${pathname}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': bytes,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('error', () => resolve(null));
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = (): void => {
      while (sent < bytes) {
        const n = Math.min(chunk.length, bytes - sent);
        sent += n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

describe('dashboard notify endpoints reject bad bodies (#188)', () => {
  for (const ep of ENDPOINTS) {
    describe(ep, () => {
      it('answers 400 on invalid JSON and stays up', async () => {
        const res = await post(ep, '{not json');
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, error: 'Invalid JSON body' });
        await expectAlive();
      });

      it('answers 400 on an empty body and stays up', async () => {
        const res = await post(ep, '');
        expect(res.status).toBe(400);
        await expectAlive();
      });

      it('answers 400 on a null body and stays up', async () => {
        const res = await post(ep, 'null');
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, error: 'JSON body must be an object' });
        await expectAlive();
      });

      it('answers 400 on an array body and stays up', async () => {
        const res = await post(ep, '[1,2]');
        expect(res.status).toBe(400);
        await expectAlive();
      });

      it('still accepts a valid object body', async () => {
        const res = await post(ep, JSON.stringify({ type: 'updated', text: 'hi', name: 'step' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      });
    });
  }

  it('answers 413 on a body over 5 MB and stays up', async () => {
    const status = await postLarge('/api/notify/event', 6 * 1024 * 1024);
    // The server answers 413 and then closes the socket; a client that is still
    // writing can see the reset first. Either way the process must stay up.
    if (status !== null) expect(status).toBe(413);
    await expectAlive();
  }, 20000);

  it('answers 400 on invalid JSON for a general /api write route and stays up', async () => {
    const res = await post('/api/agents', '{oops');
    expect(res.status).toBe(400);
    await expectAlive();
  });
});

describe('dashboard write routes parse the body with zod (#190)', () => {
  function send(method: string, pathname: string, body: unknown): Promise<Response> {
    return fetch(`${BASE}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers 400 with the field name on a wrong type', async () => {
    const cases: Array<[string, string, unknown, RegExp]> = [
      ['POST', '/api/agents', { role: 1, name: 'x' }, /^role: /],
      ['POST', '/api/agents', { name: 'x' }, /role and name are required/],
      ['PUT', '/api/milestone/1', { progress: '50' }, /^progress: /],
      ['POST', '/api/epics', { name: 'e', priority: 'high' }, /^priority: /],
      ['PUT', '/api/sprint-process', { phases: [] }, /phases array is required/],
      ['POST', '/api/bridge/actions', { entity_id: 'x', action: 'custom' }, /^entity_id: /],
      ['PATCH', '/api/bridge/actions/1/respond', {}, /result is required/],
      ['POST', '/api/sprints/plan', { name: 's' }, /ticket_ids array is required/],
    ];
    for (const [method, pathname, body, msg] of cases) {
      const res = await send(method, pathname, body);
      expect(res.status, `${method} ${pathname}`).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error, `${method} ${pathname}`).toMatch(msg);
    }
    await expectAlive();
  });

  it('still accepts the bodies the dashboard app sends', async () => {
    const created = await send('POST', '/api/agents', {
      role: 'zod-qa',
      name: 'Zod QA',
      description: null,
      model: 'claude-sonnet-5',
    });
    expect(created.status).toBe(200);
    const updated = await send('PUT', '/api/agent/zod-qa', {
      name: 'Zod QA 2',
      description: null,
      model: 'claude-sonnet-5',
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ role: 'zod-qa', name: 'Zod QA 2' });
  });
});
