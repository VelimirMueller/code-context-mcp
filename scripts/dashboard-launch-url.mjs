#!/usr/bin/env node
// Print a fresh one-time launch URL for the running dashboard (#243).
//
// The browser logs in only through a launch URL: opening it sets the HttpOnly
// session cookie, then the code is gone. /ccui runs this script and opens the
// URL it prints. The script reads the token and the port beside the db (the
// same rule as dashboardTokenRoot in src/dashboard/auth.ts; nothing is
// generated), proves the listener holds the same token with the /health nonce
// challenge (#246), and only then sends the bearer header to
// POST /api/auth/launch.
//
// Usage: node scripts/dashboard-launch-url.mjs [db-path]   (default ./context.db)
// Exit 0 with the URL on stdout, 1 when the dashboard is not running or not
// verified, 2 when no token exists beside the db.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dbPath = process.argv[2] ?? './context.db';
const root = path.dirname(path.resolve(dbPath));

function readToken() {
  const env = process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
  if (env && env.trim()) return env.trim();
  const file = path.join(root, '.code-context', 'dashboard.token');
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() || null : null;
}

function readPort() {
  try {
    const raw = readFileSync(path.join(root, '.code-context', 'dashboard.port'), 'utf-8').trim();
    return /^\d{1,5}$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

function request(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: null });
        }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function fail(code, message) {
  console.error(`dashboard-launch-url: ${message}`);
  process.exit(code);
}

const token = readToken();
if (!token) fail(2, `no dashboard token beside ${path.resolve(dbPath)}; start the dashboard first`);
const port = readPort();
if (!port) fail(1, 'the dashboard is not running (no .code-context/dashboard.port)');

try {
  const nonce = randomBytes(16).toString('hex');
  const health = await request(port, 'GET', `/health?nonce=${nonce}`);
  const expected = createHmac('sha256', token).update(`${nonce}\ncode-context-dashboard`).digest();
  const proof = Buffer.from(String(health.json?.proof ?? ''), 'hex');
  if (
    health.json?.server !== 'code-context-dashboard' ||
    proof.length !== expected.length ||
    !timingSafeEqual(proof, expected)
  ) {
    fail(1, `127.0.0.1:${port} failed the listener check; the token was not sent`);
  }
  const minted = await request(port, 'POST', '/api/auth/launch', {
    Authorization: `Bearer ${token}`,
  });
  if (minted.status !== 200 || typeof minted.json?.url !== 'string') {
    fail(1, `minting a launch URL failed (status ${minted.status})`);
  }
  console.log(minted.json.url);
} catch (e) {
  fail(
    1,
    `cannot reach the dashboard on 127.0.0.1:${port} (${e instanceof Error ? e.message : e})`,
  );
}
