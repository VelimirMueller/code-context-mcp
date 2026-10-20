/**
 * Browser login on the real dashboard server (#243, TM-01/TM-02): the page
 * never carries the token, a single-use launch URL sets an HttpOnly cookie,
 * SSE works with the cookie and refuses ?token=, cookie writes need the exact
 * dashboard Origin, and the bearer header keeps working for the MCP server.
 * Harness: spawned dashboard on a temp DB (pattern: dashboard-rebinding.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { freePort } from './helpers/free-port.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_ENTRY = path.join(REPO_ROOT, 'src/dashboard/dashboard.ts');
const LAUNCH_SCRIPT = path.join(REPO_ROOT, 'scripts/dashboard-launch-url.mjs');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const TOKEN = 'test-cookie-auth-token-0123456789abcdef';
const PORT = freePort();
const LOCAL_HOST = `localhost:${PORT}`;
const ORIGIN = `http://${LOCAL_HOST}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

let proc: ChildProcess;
let tmpRoot: string;
let serverLog = '';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Raw HTTP to 127.0.0.1; `firstChunk` returns on the first body chunk (SSE
 * never ends). Rejects on a socket error or after 5 s, so a dead server fails fast.
 */
function request(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  opts: { firstChunk?: boolean } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: pathname,
        headers: { Host: LOCAL_HOST, ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (opts.firstChunk) {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
            req.destroy();
          }
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    // reject() after resolve() is a no-op, so the destroy() above is harmless.
    req.setTimeout(5000, () => req.destroy(new Error(`timeout: ${method} ${pathname}`)));
    req.on('error', reject);
    req.end();
  });
}

async function mintLaunchPath(): Promise<string> {
  const res = await request('POST', '/api/auth/launch', auth);
  expect(res.status).toBe(200);
  const { url, expiresAt } = JSON.parse(res.body) as { url: string; expiresAt: string };
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  const u = new URL(url);
  expect(u.host).toBe(LOCAL_HOST);
  return u.pathname + u.search;
}

/** Cookie header value ("name=value") from a launch response. */
async function login(): Promise<string> {
  const res = await request('GET', await mintLaunchPath());
  expect(res.status).toBe(303);
  return String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cc-cookie-auth-'));
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
      if ((await request('GET', '/api/sprints', auth)).status === 200) return;
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

describe('dashboard browser login (#243)', () => {
  it('GET / without a session returns the login page, never the token', async () => {
    const res = await request('GET', '/');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/ccui');
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain('__DASHBOARD_TOKEN__');
  });

  it('prints a one-time launch URL at startup', () => {
    expect(serverLog).toMatch(
      new RegExp(`http://localhost:${PORT}/auth/launch\\?code=[0-9a-f]{64}`),
    );
  });

  it('a launch code sets an HttpOnly, SameSite=Strict cookie once, then is dead', async () => {
    const launch = await mintLaunchPath();
    const first = await request('GET', launch);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/');
    const cookie = String(first.headers['set-cookie']?.[0] ?? '');
    expect(cookie).toMatch(
      new RegExp(
        `^cc_dashboard_session_${PORT}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200$`,
      ),
    );
    expect(cookie).not.toContain(TOKEN);

    const again = await request('GET', launch);
    expect(again.status).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect((await request('GET', '/auth/launch?code=' + 'a'.repeat(64))).status).toBe(401);
  });

  it('each launch gets its own random session', async () => {
    const a = await login();
    const b = await login();
    expect(a).not.toBe(b);
    expect((await request('GET', '/api/sprints', { Cookie: a })).status).toBe(200);
    expect((await request('GET', '/api/sprints', { Cookie: b })).status).toBe(200);
  });

  it('an unknown session id or the cookie name of another port is refused', async () => {
    const unknown = `cc_dashboard_session_${PORT}=${'b'.repeat(64)}`;
    expect((await request('GET', '/api/sprints', { Cookie: unknown })).status).toBe(401);
    const id = (await login()).split('=')[1];
    const otherPort = `cc_dashboard_session_${PORT + 1}=${id}`;
    expect((await request('GET', '/api/sprints', { Cookie: otherPort })).status).toBe(401);
  });

  it('logout ends the session and clears the cookie', async () => {
    const cookie = await login();
    const out = await request('POST', '/api/auth/logout', { Cookie: cookie, Origin: ORIGIN });
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie']?.[0])).toContain('Max-Age=0');
    expect((await request('GET', '/api/sprints', { Cookie: cookie })).status).toBe(401);
  });

  it('the cookie opens the page, without the token in it', async () => {
    const res = await request('GET', '/', { Cookie: await login() });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(TOKEN);
  });

  it('SSE works with the cookie and no ?token=', async () => {
    const res = await request(
      'GET',
      '/api/events',
      { Cookie: await login() },
      { firstChunk: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('"type":"updated"');
  });

  it('SSE with ?token= is refused', async () => {
    const res = await request('GET', `/api/events?token=${TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('?token= is no longer accepted');
  });

  it('a cookie write from the dashboard origin passes; from another origin or none it is refused', async () => {
    const cookie = await login();
    expect((await request('POST', '/api/notify', { Cookie: cookie, Origin: ORIGIN })).status).toBe(
      200,
    );
    // Another loopback port passes the generic Origin check but not the cookie check.
    expect(
      (await request('POST', '/api/notify', { Cookie: cookie, Origin: 'http://localhost:5173' }))
        .status,
    ).toBe(403);
    expect((await request('POST', '/api/notify', { Cookie: cookie })).status).toBe(403);
    expect(
      (await request('GET', '/api/sprints', { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' }))
        .status,
    ).toBe(403);
  });

  it('only a bearer holder can mint a launch URL', async () => {
    const res = await request('POST', '/api/auth/launch', {
      Cookie: await login(),
      Origin: ORIGIN,
    });
    expect(res.status).toBe(403);
    expect((await request('POST', '/api/auth/launch')).status).toBe(401);
  });

  it('the bearer header still works for /api and SSE (MCP server, hooks, scripts)', async () => {
    expect((await request('GET', '/api/sprints', auth)).status).toBe(200);
    expect((await request('POST', '/api/notify', auth)).status).toBe(200);
    const sse = await request('GET', '/api/events', auth, { firstChunk: true });
    expect(sse.status).toBe(200);
  });

  it('scripts/dashboard-launch-url.mjs verifies the listener and prints a working launch URL', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [LAUNCH_SCRIPT, path.join(tmpRoot, 'context.db')],
      {
        env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN },
      },
    );
    const u = new URL(stdout.trim());
    expect(u.host).toBe(LOCAL_HOST);
    expect((await request('GET', u.pathname + u.search)).status).toBe(303);
  });
});
