/**
 * #246 (TM-05): the MCP notify client must never leak the dashboard bearer
 * token to a listener an untrusted db writer can point it at.
 *
 * 1. The notify port comes from `.code-context/dashboard.port` (0600, beside
 *    the db) — rewriting the `_dashboard_port` skills row through the db does
 *    not change where the token is sent.
 * 2. A listener on the configured port whose /health answers the wrong
 *    fingerprint never receives the Authorization header.
 * 3. A listener with the correct fingerprint (server + sha256 prefix of the
 *    token) receives the authenticated notify — and the verification is
 *    cached for 60 s, so a second notify skips the /health probe.
 *
 * All requests go to 127.0.0.1 only; the Host header the listener sees proves it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
  tokenFingerprint,
} from '../src/dashboard/auth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENV = 'CODE_CONTEXT_DASHBOARD_TOKEN';
const TOKEN = 'notify-test-token-246';
const FINGERPRINT = tokenFingerprint(TOKEN);

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

/** A tiny capturing dashboard: /health answers `health`, everything else 200 ok. */
async function startListener(health: Record<string, unknown>): Promise<Listener> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host,
        authorization: req.headers.authorization,
      });
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
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

describe('dashboard notify port + listener verification (#246)', () => {
  it('ignores the `_dashboard_port` db row and uses the port file beside the db', async () => {
    const fileListener = await startListener({
      server: 'code-context-dashboard',
      token_fingerprint: FINGERPRINT,
    });
    const rowListener = await startListener({
      server: 'code-context-dashboard',
      token_fingerprint: FINGERPRINT, // correct too: proves the choice is the file, not the row
    });
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
    expect(rowListener.requests.filter((r) => r.url !== '/health')).toEqual([]);
    expect(rowListener.requests.some((r) => r.authorization)).toBe(false);
  });

  it('never sends the Authorization header to a listener with the wrong fingerprint', async () => {
    const wrongListener = await startListener({
      server: 'code-context-dashboard',
      token_fingerprint: tokenFingerprint('attacker-token'), // holds a different token
    });
    listeners.push(wrongListener);

    const db = pointClientAt(wrongListener.port);
    notifyDashboard(db, { type: 'ticket_created', entityType: 'ticket', entityId: 1 });

    // The client must probe /health (without auth) and then stop.
    expect(await waitFor(() => wrongListener.requests.some((r) => r.url === '/health'))).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(wrongListener.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(wrongListener.requests.some((r) => r.authorization)).toBe(false);
  });

  it('sends the authenticated notify to a verified listener and caches the check for 60 s', async () => {
    const goodListener = await startListener({
      server: 'code-context-dashboard',
      token_fingerprint: FINGERPRINT,
    });
    listeners.push(goodListener);

    const db = pointClientAt(goodListener.port);
    notifyDashboard(db);
    // First notify must land before the second is issued: the second then runs
    // entirely on the cached verification (no second /health probe).
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
    // Second notify reused the cached verification: exactly one /health probe.
    expect(goodListener.requests.filter((r) => r.url === '/health')).toHaveLength(1);
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

  it('answers /health without auth with the server identity and the token fingerprint', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      server: 'code-context-dashboard',
      token_fingerprint: FINGERPRINT,
    });
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
});
