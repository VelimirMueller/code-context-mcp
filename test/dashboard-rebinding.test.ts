/**
 * DNS-rebinding guard on the real dashboard server: a request whose Host names
 * another hostname gets 421 before the page, the launch URL or any /api route,
 * and a write from a foreign Origin gets 403 even with a valid token.
 * Harness: spawned dashboard on a temp DB (pattern: dashboard-route-parity.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_ENTRY = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const TOKEN = 'test-rebinding-token-0123456789abcdef';
const PORT = freePort();

let proc: ChildProcess;
let tmpRoot: string;
let serverLog = '';

/** fetch() forbids overriding Host, so talk raw HTTP to 127.0.0.1 with any Host. */
function request(
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path: pathname, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const LOCAL_HOST = `localhost:${PORT}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-rebinding-'));
  proc = spawn(
    process.execPath,
    [TSX_CLI, DASHBOARD_ENTRY, path.join(tmpRoot, 'context.db'), String(PORT)],
    {
      cwd: tmpRoot,
      env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN, DASHBOARD_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  proc.stdout?.on('data', (d) => {
    serverLog += String(d);
  });
  proc.stderr?.on('data', (d) => {
    serverLog += String(d);
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`dashboard exited early:\n${serverLog}`);
    try {
      if ((await request('GET', '/api/sprints', { Host: LOCAL_HOST, ...auth })).status === 200)
        return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard did not start:\n${serverLog}`);
}, 40000);

afterAll(() => {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('dashboard DNS-rebinding guard', () => {
  it('serves the page and API to a localhost Host', async () => {
    const page = await request('GET', '/', { Host: LOCAL_HOST, ...auth });
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(TOKEN);
    expect(
      (await request('GET', '/api/sprints', { Host: `127.0.0.1:${PORT}`, ...auth })).status,
    ).toBe(200);
  });

  it('refuses the page to a rebound hostname', async () => {
    const page = await request('GET', '/', { Host: `attacker.example:${PORT}` });
    expect(page.status).toBe(421);
    expect(page.body).not.toContain(TOKEN);
  });

  it('refuses the bridge action queue to a rebound hostname even with the token', async () => {
    const res = await request(
      'POST',
      '/api/bridge/actions',
      { Host: `attacker.example:${PORT}`, 'Content-Type': 'application/json', ...auth },
      JSON.stringify({ action: 'x' }),
    );
    expect(res.status).toBe(421);
  });

  it('refuses a write from a foreign Origin even with the token', async () => {
    const res = await request('POST', '/api/notify', {
      Host: LOCAL_HOST,
      Origin: 'http://attacker.example',
      ...auth,
    });
    expect(res.status).toBe(403);
  });

  it('accepts a write without Origin (MCP server notify) and from the Vite dev origin', async () => {
    expect((await request('POST', '/api/notify', { Host: LOCAL_HOST, ...auth })).status).toBe(200);
    expect(
      (
        await request('POST', '/api/notify', {
          Host: LOCAL_HOST,
          Origin: 'http://localhost:5173',
          ...auth,
        })
      ).status,
    ).toBe(200);
  });
});
