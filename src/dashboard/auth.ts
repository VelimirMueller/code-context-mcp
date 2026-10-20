// Dashboard authentication (#15b). The dashboard, the MCP server (which POSTs
// notifications to /api/*), and the browser frontend share a single bearer
// token. Secure by default: if CODE_CONTEXT_DASHBOARD_TOKEN is unset, a random
// token is generated and persisted to <root>/.code-context/dashboard.token
// (gitignored) so all three parties can read the same value. <root> is the
// directory of the context.db in use (#235): the dashboard and the MCP server
// start from different cwds, but they always open the same database.
//
// Only /api/* is protected — the HTML page and /assets/* stay public so the
// browser can load the app and read the token injected into the page. A
// cross-origin attacker cannot read that injected token (same-origin policy)
// nor call /api/* without it.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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

// ─── Port file + listener proof (#246, TM-05) ────────────────────────────────
// The port a client may send the bearer token to comes from a 0600 file beside
// the db (written by the dashboard at startup), never from the `_dashboard_port`
// db row: any db writer (execute, import, restore) can change that row and
// redirect the token to a listener it controls. Before any token leaves, the
// client also checks /health: the dashboard answers with its identity and a
// token fingerprint, so a wrong listener never sees the Authorization header.

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
 * First 8 hex chars of sha256(token) — the listener publishes this on /health
 * so a client can prove it talks to the dashboard that holds the same token.
 * The prefix reveals nothing usable about the token itself.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** Token from the Authorization: Bearer header, falling back to ?token= (EventSource). */
export function extractRequestToken(req: AuthHeaders, url: URL): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t) return t;
  }
  const q = url.searchParams.get('token');
  return q && q.trim() ? q.trim() : null;
}

/** Only /api/* is protected; the page, SPA routes, and assets are public. */
export function isPublicPath(pathname: string): boolean {
  return !pathname.startsWith('/api/');
}

/** Length-checked, constant-time-ish comparison to avoid timing leaks. */
export function tokensMatch(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorized(req: AuthHeaders, url: URL, expected: string): boolean {
  if (isPublicPath(url.pathname)) return true;
  return tokensMatch(extractRequestToken(req, url), expected);
}

// ─── DNS-rebinding guard ─────────────────────────────────────────────────────
// The token alone does not stop DNS rebinding: a hostile page whose hostname
// re-resolves to 127.0.0.1 becomes "same-origin" with the dashboard, can GET /
// and read the injected token, then call /api/* (incl. /api/bridge/actions,
// which the PreToolUse hook feeds into the agent). The browser still sends the
// attacker's hostname in Host, so allowlisting loopback names closes it.

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
