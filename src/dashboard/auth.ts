// Dashboard authentication (#15b). The dashboard, the MCP server (which POSTs
// notifications to /api/*), and the browser frontend share a single bearer
// token. Secure by default: if CODE_CONTEXT_DASHBOARD_TOKEN is unset, a random
// token is generated and persisted to <root>/.code-context/dashboard.token
// (gitignored) so all three parties can read the same value.
//
// Only /api/* is protected — the HTML page and /assets/* stay public so the
// browser can load the app and read the token injected into the page. A
// cross-origin attacker cannot read that injected token (same-origin policy)
// nor call /api/* without it.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export type AuthHeaders = { headers: http.IncomingHttpHeaders };

const TOKEN_DIR = '.code-context';
const TOKEN_FILE = 'dashboard.token';

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
