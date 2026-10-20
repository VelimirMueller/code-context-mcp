// Dashboard authentication (#15b). The dashboard, the MCP server (which POSTs
// notifications to /api/*), and the browser frontend share a single bearer
// token. Secure by default: if CODE_CONTEXT_DASHBOARD_TOKEN is unset, a random
// token is generated and persisted to <root>/.code-context/dashboard.token
// (gitignored) so all three parties can read the same value. <root> is the
// directory of the context.db in use (#235): the dashboard and the MCP server
// start from different cwds, but they always open the same database.
//
// The browser never sees the token (#243, TM-01/TM-02): it logs in once
// through a single-use launch URL and then sends an HttpOnly session cookie.
// Only /health, /assets/* and /auth/launch are public; the page and /api/*
// need the bearer header or the cookie.

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export type AuthHeaders = { headers: http.IncomingHttpHeaders };

const TOKEN_DIR = '.code-context';
const TOKEN_FILE = 'dashboard.token';
const PORT_FILE = 'dashboard.port';

/**
 * Directory that holds the persisted token: the directory of the db file when
 * one is known, otherwise the cwd (#235). Both processes must call this with
 * the same db path to share one token.
 */
export function dashboardTokenRoot(dbPath?: string | null): string {
  return dbPath ? path.dirname(path.resolve(dbPath)) : process.cwd();
}

/** Env var wins; otherwise read the persisted token, else generate + persist it. */
export function resolveDashboardToken(root: string = process.cwd()): string {
  const env = process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
  if (env && env.trim()) return env.trim();

  const dir = path.join(root, TOKEN_DIR);
  const file = path.join(dir, TOKEN_FILE);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  const gitignore = path.join(dir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n'); // never commit the secret
  return token;
}

// ─── Port file + challenge-response listener proof (#246, TM-05) ────────────
// The port a client may send the bearer token to comes from a 0600 file beside
// the db (written by the dashboard at startup), never from the `_dashboard_port`
// db row: any db writer (execute, import, restore) can change that row and
// redirect the token to a listener it controls. Before any token leaves, the
// client sends a fresh nonce on /health and checks the HMAC-SHA256 proof the
// dashboard answers with, so a wrong listener never sees the Authorization
// header. The dashboard removes the port file on clean shutdown, so a client
// never trusts a stale port.

/** File the dashboard writes its actual port to at startup (beside the token). */
export function dashboardPortFile(root: string = process.cwd()): string {
  return path.join(root, TOKEN_DIR, PORT_FILE);
}

/** The dashboard persists its listening port here (mode 0600, like the token). */
export function writeDashboardPort(root: string, port: number | string): void {
  mkdirSync(path.join(root, TOKEN_DIR), { recursive: true });
  const file = dashboardPortFile(root);
  writeFileSync(file, `${port}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // umask-independent, like secure-file.ts
  } catch {
    // Windows: modes are meaningless there.
  }
}

/** Port the dashboard last started on, or null when it never wrote the file. */
export function readDashboardPort(root: string = process.cwd()): string | null {
  try {
    const raw = readFileSync(dashboardPortFile(root), 'utf-8').trim();
    return /^\d{1,5}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 proof for a challenge nonce (#246, TM-05). The client sends a
 * fresh 16-byte nonce on /health; the dashboard answers with this proof, so a
 * listener that cannot recompute it (it does not hold the token) never sees
 * the bearer token. The message mixes the client nonce with a fixed domain
 * string, so a captured proof never matches a new challenge.
 */
export function dashboardProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`${nonce}\ncode-context-dashboard`).digest('hex');
}

/** Remove the port file so a client treats the dashboard as gone (never a stale port). */
export function removeDashboardPort(root: string = process.cwd()): void {
  try {
    const file = dashboardPortFile(root);
    if (existsSync(file)) rmSync(file);
  } catch {
    /* best effort — a missing file already reads as "no dashboard" */
  }
}

/** Token from the Authorization: Bearer header. `?token=` is not read (#243). */
export function extractRequestToken(req: AuthHeaders): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t) return t;
  }
  return null;
}

/** Public: the health probe, the static assets and the launch URL. Everything else needs auth. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/health' || pathname === LAUNCH_PATH || pathname.startsWith('/assets/');
}

/** Length-checked, constant-time-ish comparison to avoid timing leaks. */
export function tokensMatch(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** How a request proved itself: the bearer header (MCP server, hooks, scripts) or the browser cookie. */
export type AuthMethod = 'bearer' | 'cookie';

export function authenticate(req: AuthHeaders, expected: string): AuthMethod | null {
  if (tokensMatch(extractRequestToken(req), expected)) return 'bearer';
  if (tokensMatch(readCookie(req, SESSION_COOKIE), dashboardSessionValue(expected))) {
    return 'cookie';
  }
  return null;
}

export function isAuthorized(req: AuthHeaders, url: URL, expected: string): boolean {
  if (isPublicPath(url.pathname)) return true;
  return authenticate(req, expected) !== null;
}

// ─── Browser session: one-time launch URL + HttpOnly cookie (#243) ──────────
// A launch code is random, single use and expires after LAUNCH_CODE_TTL_MS.
// Only a bearer holder can mint one (POST /api/auth/launch; the dashboard also
// prints one at startup). GET /auth/launch?code= burns the code, sets the
// cookie and redirects to /. The cookie value is an HMAC of the token, so it
// survives a dashboard restart, is useless as a bearer token, and changes when
// the token rotates. Cookies are not port-scoped: a page on another localhost
// port is same-site, so cookie-authed writes must also pass
// isAllowedCookieRequest (exact dashboard Origin).

export const SESSION_COOKIE = 'cc_dashboard_session';
export const LAUNCH_PATH = '/auth/launch';
export const LAUNCH_CODE_TTL_MS = 5 * 60_000;
const MAX_OPEN_LAUNCH_CODES = 32;

/** Cookie value for a token: HMAC, so the cookie never equals the bearer token. */
export function dashboardSessionValue(token: string): string {
  return createHmac('sha256', token).update('code-context-dashboard-session').digest('hex');
}

/** Set-Cookie header for the browser session. No Max-Age: it ends with the browser session. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${dashboardSessionValue(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Value of one cookie from the Cookie header, or null. */
export function readCookie(req: AuthHeaders, name: string): string | null {
  const header = req.headers['cookie'];
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** Single-use, short-lived launch codes, held in memory only. */
export class LaunchCodes {
  private codes = new Map<string, number>();

  constructor(private ttlMs = LAUNCH_CODE_TTL_MS) {}

  mint(now = Date.now()): { code: string; expiresAt: number } {
    for (const [c, exp] of this.codes) if (exp <= now) this.codes.delete(c);
    // Bounded: the oldest open code goes first.
    while (this.codes.size >= MAX_OPEN_LAUNCH_CODES) {
      this.codes.delete(this.codes.keys().next().value as string);
    }
    const code = randomBytes(32).toString('hex');
    const expiresAt = now + this.ttlMs;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** True once per valid code; the code is gone afterwards either way. */
  consume(code: string | null, now = Date.now()): boolean {
    if (!code) return false;
    const exp = this.codes.get(code);
    if (exp === undefined) return false;
    this.codes.delete(code);
    return exp > now;
  }
}

/**
 * CSRF guard for cookie-authed requests. SameSite=Strict does not separate
 * ports, so a page on another localhost port still sends the cookie: a write
 * must carry the exact dashboard Origin, and a fetch the browser marks as
 * cross-site or same-site (Sec-Fetch-Site) is refused for every method.
 */
export function isAllowedCookieRequest(
  method: string | undefined,
  headers: http.IncomingHttpHeaders,
): boolean {
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET')) return true;
  const origin = headers['origin'];
  return typeof origin === 'string' && origin === `http://${String(headers['host']).toLowerCase()}`;
}

// ─── DNS-rebinding guard ─────────────────────────────────────────────────────
// Auth alone does not stop DNS rebinding: a hostile page whose hostname
// re-resolves to 127.0.0.1 becomes "same-origin" with the dashboard and can
// probe every route, incl. the public ones (/auth/launch, /health). The
// browser still sends the attacker's hostname in Host, so allowlisting
// loopback names closes it.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Host must name a loopback host on the port we actually listen on. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // Round-trip check rejects userinfo, paths and other smuggling in the header.
  if (parsed.host !== host.toLowerCase()) return false;
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  return Number(parsed.port || 80) === port;
}

/**
 * Writes must come from a loopback origin (any port — the Vite dev server on
 * :5173 proxies to us) or from a non-browser client that sends no Origin
 * (the MCP server's notify calls, curl). "null" origins are refused.
 */
export function isAllowedOrigin(method: string | undefined, origin: string | undefined): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET')) return true;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
