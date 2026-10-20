/**
 * #246 (TM-05): the MCP notify client must never leak the dashboard bearer
 * token to a listener an untrusted db writer can point it at.
 *
 * 1. The notify port comes from `.code-context/dashboard.port` (0600, beside
 *    the db) — rewriting the `_dashboard_port` skills row through the db does
 *    not change where the token is sent.
 * 2. Before any token is sent the client challenges the listener with a fresh
 *    16-byte nonce on /health; only a listener that answers the HMAC-SHA256
 *    proof of that nonce under the shared token ever receives the header. A
 *    listener that replays a captured /health value, or that cannot compute
 *    the HMAC, never does.
 * 3. There is no verification cache: every authenticated notify is preceded
 *    by its own challenge.
 * 4. On clean shutdown the dashboard removes the port file, so the client
 *    treats it as "no dashboard".
 *
 * All requests go to 127.0.0.1 only; the Host header the listener sees proves it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { freePort } from './helpers/free-port.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { notifyDashboard, setDashboardDbPath } from '../src/scrum/tools.js';
import {
  writeDashboardPort,
  readDashboardPort,
  dashboardPortFile,
  dashboardProof,
} from '../src/dashboard/auth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENV = 'CODE_CONTEXT_DASHBOARD_TOKEN';
const TOKEN = 'notify-test-token-246';
const SERVER_NAME = 'code-context-dashboard';

interface Captured {
  method: string;
  url: string;
  host: string | undefined;
  authorization: string | undefined;
}

interface Listener {
  port: number;
  requests: Captured[];
  close(): Promise<void>;
}

/**
 * A tiny capturing dashboard. `health(url)` builds the /health answer (it sees
 * the request URL, so it can compute a proof from the challenge nonce); every
 * other path answers 200 ok.
 */
async function startListener(health: (url: URL) => Record<string, unknown>): Promise<Listener> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host,
        authorization: req.headers.authorization,
      });
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health(url)));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
    req.resume();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

/** A temp db root whose port file points at `port`; the client reads both beside it. */
function pointClientAt(port: number): Database.Database {
  const root = mkdtempSync(path.join(tmpdir(), 'cc-notify-'));
  roots.push(root);
  writeDashboardPort(root, port);
  setDashboardDbPath(path.join(root, 'context.db'));
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  return db;
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

const listeners: Listener[] = [];
const roots: string[] = [];
const prevEnv = process.env[ENV];

beforeAll(() => {
  process.env[ENV] = TOKEN;
});

afterAll(async () => {
  setDashboardDbPath(null);
  if (prevEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = prevEnv;
  await Promise.all(listeners.map((l) => l.close()));
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A listener that holds the token and computes the correct HMAC proof per nonce. */
const goodHealth = (url: URL) => ({
  server: SERVER_NAME,
  proof: dashboardProof(TOKEN, url.searchParams.get('nonce') ?? ''),
});

/** A listener that replays a proof captured once from a real /health answer. */
const CAPTURED_PROOF = dashboardProof(TOKEN, 'deadbeefdeadbeefdeadbeefdeadbeef');
const replayHealth = () => ({ server: SERVER_NAME, proof: CAPTURED_PROOF });

/** A listener that holds a different token, so its HMAC proof never matches. */
const wrongHealth = (url: URL) => ({
  server: SERVER_NAME,
  proof: dashboardProof('attacker-token', url.searchParams.get('nonce') ?? ''),
});

describe('dashboard notify port + listener verification (#246)', () => {
  it('ignores the `_dashboard_port` db row and uses the port file beside the db', async () => {
    const fileListener = await startListener(goodHealth);
    const rowListener = await startListener(goodHealth); // correct too: proves the choice is the file
    listeners.push(fileListener, rowListener);

    const db = pointClientAt(fileListener.port);
    // Rewrite the row the way any db writer (execute, import, restore) can.
    db.prepare(
      "INSERT OR REPLACE INTO skills (name, content, owner_role) VALUES ('_dashboard_port', ?, 'system')",
    ).run(String(rowListener.port));

    notifyDashboard(db);

    const notify = () =>
      fileListener.requests.some(
        (r) =>
          r.method === 'POST' && r.url === '/api/notify' && r.authorization === `Bearer ${TOKEN}`,
      );
    expect(await waitFor(notify)).toBe(true);

    // The notify went to the port file's listener, on 127.0.0.1 only.
    const post = fileListener.requests.find((r) => r.method === 'POST')!;
    expect(post.host).toBe(`127.0.0.1:${fileListener.port}`);
    // The row's listener saw nothing but (at most) its own probe.
    expect(rowListener.requests.filter((r) => !r.url.startsWith('/health'))).toEqual([]);
    expect(rowListener.requests.some((r) => r.authorization)).toBe(false);
  });

  it('never sends the Authorization header to a listener that replays a captured proof', async () => {
    const replayListener = await startListener(replayHealth);
    listeners.push(replayListener);

    const db = pointClientAt(replayListener.port);
    notifyDashboard(db, { type: 'ticket_created', entityType: 'ticket', entityId: 1 });

    // The client must challenge /health (without auth) and then stop: a static
    // proof can never match the fresh nonce it sent.
    expect(
      await waitFor(() => replayListener.requests.some((r) => r.url.startsWith('/health'))),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(replayListener.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(replayListener.requests.some((r) => r.authorization)).toBe(false);
  });

  it('never sends the Authorization header to a listener that cannot compute the HMAC', async () => {
    const wrongListener = await startListener(wrongHealth);
    listeners.push(wrongListener);

    const db = pointClientAt(wrongListener.port);
    notifyDashboard(db, { type: 'ticket_created', entityType: 'ticket', entityId: 1 });

    expect(
      await waitFor(() => wrongListener.requests.some((r) => r.url.startsWith('/health'))),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(wrongListener.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(wrongListener.requests.some((r) => r.authorization)).toBe(false);
  });

  it('sends the authenticated notify to a verified listener and re-challenges every notify', async () => {
    const goodListener = await startListener(goodHealth);
    listeners.push(goodListener);

    const db = pointClientAt(goodListener.port);
    notifyDashboard(db);
    // First notify must land before the second is issued: the second then runs
    // its own challenge (there is no cache).
    const firstLanded = () =>
      goodListener.requests.some((r) => r.method === 'POST' && r.url === '/api/notify');
    expect(await waitFor(firstLanded)).toBe(true);
    notifyDashboard(db, { type: 'ticket_created', entityType: 'ticket', entityId: 2 });
    expect(
      await waitFor(() => goodListener.requests.some((r) => r.url === '/api/notify/event')),
    ).toBe(true);

    for (const r of goodListener.requests.filter((x) => x.method === 'POST')) {
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.host).toBe(`127.0.0.1:${goodListener.port}`);
    }
    // No cache: every notify is preceded by its own /health challenge.
    expect(goodListener.requests.filter((r) => r.url.startsWith('/health'))).toHaveLength(2);
  });
});

describe('dashboard /health + port file (spawned dashboard, #246)', () => {
  const PORT = freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  let proc: ChildProcess;
  let tmpRoot: string;
  let dbPath: string;
  let serverLog = '';

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-notify-spawn-'));
    roots.push(tmpRoot);
    dbPath = path.join(tmpRoot, 'context.db');
    const tsx = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
    const entry = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');
    proc = spawn(process.execPath, [tsx, entry, dbPath, String(PORT)], {
      cwd: tmpRoot,
      env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    proc.stdout?.on('data', (d) => (serverLog += String(d)));
    proc.stderr?.on('data', (d) => (serverLog += String(d)));

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new Error(`dashboard exited early (code ${proc.exitCode}):\n${serverLog}`);
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok && readDashboardPort(tmpRoot) === String(PORT)) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`dashboard did not become ready:\n${serverLog}`);
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
  });

  it('answers /health without auth with the server identity and a valid proof for the nonce', async () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    const res = await fetch(`${BASE}/health?nonce=${nonce}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      server: SERVER_NAME,
      proof: dashboardProof(TOKEN, nonce),
    });
  });

  it('never publishes a static hash: /health without a nonce has no proof field', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.server).toBe(SERVER_NAME);
    expect(body).not.toHaveProperty('proof');
    expect(body).not.toHaveProperty('token_fingerprint');
  });

  it('writes the 0600 port file beside the db, and still the row for the UI', () => {
    expect(readDashboardPort(tmpRoot)).toBe(String(PORT));
    if (process.platform !== 'win32') {
      expect(statSync(dashboardPortFile(tmpRoot)).mode & 0o777).toBe(0o600);
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT content FROM skills WHERE name = '_dashboard_port'").get() as
        | { content: string }
        | undefined;
      expect(row?.content).toBe(String(PORT));
    } finally {
      db.close();
    }
  });

  it('removes the port file on clean shutdown', async () => {
    const file = dashboardPortFile(tmpRoot);
    expect(existsSync(file)).toBe(true);
    proc.kill('SIGTERM');
    expect(await waitFor(() => !existsSync(file), 5000)).toBe(true);
    expect(readDashboardPort(tmpRoot)).toBeNull();
  });
});
