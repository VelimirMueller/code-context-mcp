import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveDashboardToken,
  extractRequestToken,
  isPublicPath,
  tokensMatch,
  isAuthorized,
  isAllowedHost,
  isAllowedOrigin,
  authenticate,
  Sessions,
  sessionCookieName,
  clearSessionCookieHeader,
  sessionCookieHeader,
  readCookie,
  LaunchCodes,
  isAllowedCookieRequest,
  SESSION_TTL_MS,
} from '../src/dashboard/auth.js';

const ENV = 'CODE_CONTEXT_DASHBOARD_TOKEN';
const prevEnv = process.env[ENV];
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = prevEnv;
});

describe('dashboard auth: resolveDashboardToken (#15b)', () => {
  it('returns the env token when set, without writing a file', () => {
    process.env[ENV] = 'env-token-123';
    const root = mkdtempSync(path.join(tmpdir(), 'cc-auth-'));
    try {
      expect(resolveDashboardToken(root)).toBe('env-token-123');
      expect(existsSync(path.join(root, '.code-context/dashboard.token'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('generates and persists a token (gitignored) when none exists', () => {
    delete process.env[ENV];
    const root = mkdtempSync(path.join(tmpdir(), 'cc-auth-'));
    try {
      const t = resolveDashboardToken(root);
      expect(t.length).toBeGreaterThanOrEqual(32);
      const file = path.join(root, '.code-context/dashboard.token');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8').trim()).toBe(t);
      expect(existsSync(path.join(root, '.code-context/.gitignore'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the same persisted token on a second call', () => {
    delete process.env[ENV];
    const root = mkdtempSync(path.join(tmpdir(), 'cc-auth-'));
    try {
      expect(resolveDashboardToken(root)).toBe(resolveDashboardToken(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dashboard auth: token extraction + matching', () => {
  it('extracts a Bearer token from the Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' } };
    expect(extractRequestToken(req)).toBe('abc123');
  });
  it('returns null when no token is present', () => {
    expect(extractRequestToken({ headers: {} })).toBeNull();
  });
  it('matches equal tokens and rejects mismatches and length differences', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch(null, 'abc')).toBe(false);
  });
});

describe('dashboard auth: authorization decisions', () => {
  const TOKEN = 'secret-token';
  it('keeps only /health, /assets/* and the launch URL public (#243)', () => {
    expect(isPublicPath('/health')).toBe(true);
    expect(isPublicPath('/assets/index-abc.js')).toBe(true);
    expect(isPublicPath('/auth/launch')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/some/spa/route')).toBe(false);
    expect(isPublicPath('/api/sprints')).toBe(false);
    expect(isPublicPath('/api/events')).toBe(false);
  });
  it('allows public paths without a token and refuses the page without one', () => {
    expect(isAuthorized({ headers: {} }, new URL('http://localhost/health'), TOKEN)).toBe(true);
    expect(isAuthorized({ headers: {} }, new URL('http://localhost/'), TOKEN)).toBe(false);
  });
  it('rejects /api without a token', () => {
    expect(isAuthorized({ headers: {} }, new URL('http://localhost/api/sprints'), TOKEN)).toBe(
      false,
    );
  });
  it('allows /api with the correct Bearer token', () => {
    const req = { headers: { authorization: `Bearer ${TOKEN}` } };
    expect(isAuthorized(req, new URL('http://localhost/api/sprints'), TOKEN)).toBe(true);
  });
  it('refuses /api/events with the correct ?token (#243)', () => {
    expect(
      isAuthorized({ headers: {} }, new URL(`http://localhost/api/events?token=${TOKEN}`), TOKEN),
    ).toBe(false);
  });
  it('allows /api with a live session cookie for this port', () => {
    const sessions = new Sessions();
    const { id } = sessions.create();
    const req = { headers: { cookie: `other=1; ${sessionCookieName(3333)}=${id}` } };
    const ctx = { sessions, port: 3333 };
    expect(isAuthorized(req, new URL('http://localhost/api/events'), TOKEN, ctx)).toBe(true);
    expect(authenticate(req, TOKEN, ctx)).toBe('cookie');
  });
  it('ignores the cookie of another port and an unknown or token-valued id', () => {
    const sessions = new Sessions();
    const { id } = sessions.create();
    const ctx = { sessions, port: 3333 };
    const other = { headers: { cookie: `${sessionCookieName(3334)}=${id}` } };
    expect(authenticate(other, TOKEN, ctx)).toBeNull();
    const unknown = { headers: { cookie: `${sessionCookieName(3333)}=${'a'.repeat(64)}` } };
    expect(authenticate(unknown, TOKEN, ctx)).toBeNull();
    const tokenAsCookie = { headers: { cookie: `${sessionCookieName(3333)}=${TOKEN}` } };
    expect(authenticate(tokenAsCookie, TOKEN, ctx)).toBeNull();
  });
  it('tells bearer from cookie', () => {
    expect(authenticate({ headers: { authorization: `Bearer ${TOKEN}` } }, TOKEN)).toBe('bearer');
    expect(authenticate({ headers: {} }, TOKEN)).toBeNull();
  });
  it('rejects /api with a wrong token', () => {
    const req = { headers: { authorization: 'Bearer nope' } };
    expect(isAuthorized(req, new URL('http://localhost/api/sprints'), TOKEN)).toBe(false);
  });
});

describe('dashboard auth: DNS-rebinding guard', () => {
  it('accepts loopback hostnames on the listening port', () => {
    expect(isAllowedHost('localhost:3333', 3333)).toBe(true);
    expect(isAllowedHost('127.0.0.1:3333', 3333)).toBe(true);
    expect(isAllowedHost('[::1]:3333', 3333)).toBe(true);
    expect(isAllowedHost('LOCALHOST:3333', 3333)).toBe(true);
  });
  it('rejects a rebound hostname, another port, smuggling and a missing Host', () => {
    expect(isAllowedHost('evil.example:3333', 3333)).toBe(false);
    expect(isAllowedHost('localhost.evil.example:3333', 3333)).toBe(false);
    expect(isAllowedHost('localhost:3334', 3333)).toBe(false);
    expect(isAllowedHost('localhost', 3333)).toBe(false);
    expect(isAllowedHost('evil.example@localhost:3333', 3333)).toBe(false);
    expect(isAllowedHost(undefined, 3333)).toBe(false);
  });
  it('lets reads through and gates writes on a loopback Origin', () => {
    expect(isAllowedOrigin('GET', 'http://evil.example')).toBe(true);
    expect(isAllowedOrigin('POST', undefined)).toBe(true); // MCP server, curl
    expect(isAllowedOrigin('POST', 'http://localhost:5173')).toBe(true); // Vite dev proxy
    expect(isAllowedOrigin('POST', 'http://127.0.0.1:3333')).toBe(true);
    expect(isAllowedOrigin('POST', 'http://evil.example')).toBe(false);
    expect(isAllowedOrigin('DELETE', 'null')).toBe(false);
  });
});

describe('dashboard auth: browser session (#243)', () => {
  it('issues a per-port HttpOnly, SameSite=Strict, Path=/ cookie with a 12 h Max-Age', () => {
    const header = sessionCookieHeader(3333, 'abc');
    expect(header).toBe(
      'cc_dashboard_session_3333=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200',
    );
    expect(SESSION_TTL_MS).toBe(43_200_000);
    expect(clearSessionCookieHeader(3333)).toContain('Max-Age=0');
  });
  it('mints a random id per session', () => {
    const sessions = new Sessions();
    const a = sessions.create().id;
    const b = sessions.create().id;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(sessions.isValid(a) && sessions.isValid(b)).toBe(true);
  });
  it('expires a session after its lifetime and ends it on logout', () => {
    const sessions = new Sessions(1000);
    const { id, expiresAt } = sessions.create(0);
    expect(expiresAt).toBe(1000);
    expect(sessions.isValid(id, 999)).toBe(true);
    expect(sessions.isValid(id, 1000)).toBe(false);
    const live = new Sessions();
    const s2 = live.create().id;
    live.end(s2);
    expect(live.isValid(s2)).toBe(false);
    expect(live.isValid(null)).toBe(false);
  });
  it('keeps at most 64 sessions, dropping the least recently created', () => {
    const sessions = new Sessions();
    const first = sessions.create().id;
    for (let i = 0; i < 64; i++) sessions.create();
    expect(sessions.isValid(first)).toBe(false);
  });
  it('reads one cookie out of the Cookie header', () => {
    expect(readCookie({ headers: { cookie: 'a=1; b=2' } }, 'b')).toBe('2');
    expect(readCookie({ headers: { cookie: 'ab=1' } }, 'b')).toBeNull();
    expect(readCookie({ headers: {} }, 'b')).toBeNull();
  });
  it('accepts a launch code once', () => {
    const codes = new LaunchCodes();
    const { code } = codes.mint();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(codes.consume(code)).toBe(true);
    expect(codes.consume(code)).toBe(false);
    expect(codes.consume('nope')).toBe(false);
    expect(codes.consume(null)).toBe(false);
  });
  it('refuses an expired launch code', () => {
    const codes = new LaunchCodes(1000);
    const { code, expiresAt } = codes.mint(0);
    expect(expiresAt).toBe(1000);
    expect(codes.consume(code, 1000)).toBe(false);
  });
  it('keeps at most 32 open codes, dropping the oldest', () => {
    const codes = new LaunchCodes();
    const first = codes.mint().code;
    for (let i = 0; i < 32; i++) codes.mint();
    expect(codes.consume(first)).toBe(false);
  });
  it('lets cookie writes through only from the exact dashboard origin', () => {
    const host = 'localhost:3333';
    expect(isAllowedCookieRequest('POST', { host, origin: 'http://localhost:3333' })).toBe(true);
    expect(
      isAllowedCookieRequest('POST', { host: 'LOCALHOST:3333', origin: 'http://localhost:3333' }),
    ).toBe(true);
    expect(isAllowedCookieRequest('POST', { host, origin: 'http://localhost:5173' })).toBe(false);
    expect(isAllowedCookieRequest('POST', { host, origin: 'http://evil.example' })).toBe(false);
    expect(isAllowedCookieRequest('POST', { host })).toBe(false);
    expect(isAllowedCookieRequest('GET', { host })).toBe(true);
  });
  it('refuses cookie requests the browser marks as cross-site or same-site', () => {
    const host = 'localhost:3333';
    expect(isAllowedCookieRequest('GET', { host, 'sec-fetch-site': 'same-site' })).toBe(false);
    expect(isAllowedCookieRequest('GET', { host, 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(isAllowedCookieRequest('GET', { host, 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(isAllowedCookieRequest('GET', { host, 'sec-fetch-site': 'none' })).toBe(true);
  });
});
