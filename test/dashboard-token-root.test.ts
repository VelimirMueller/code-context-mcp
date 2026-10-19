import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dashboardTokenRoot, resolveDashboardToken } from '../src/dashboard/auth.js';

const ENV = 'CODE_CONTEXT_DASHBOARD_TOKEN';
const prevEnv = process.env[ENV];
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'cc-token-root-'));
  dirs.push(d);
  return d;
}

/** Resolve the token the way a process started in `cwd` with `dbArg` does. */
function resolveFrom(cwd: string, dbArg: string): string {
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    const dbPath = path.resolve(cwd, dbArg);
    return resolveDashboardToken(dashboardTokenRoot(dbPath));
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = prevEnv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dashboard token root (#235)', () => {
  it('gives two callers with different cwds and the same db path the same token', () => {
    delete process.env[ENV];
    const project = tmp();
    const dbPath = path.join(project, 'context.db');
    const dashboardCwd = tmp();
    const serverCwd = tmp();

    const dashboardToken = resolveFrom(dashboardCwd, dbPath);
    const serverToken = resolveFrom(serverCwd, path.relative(serverCwd, dbPath));

    expect(serverToken).toBe(dashboardToken);
    expect(existsSync(path.join(project, '.code-context/dashboard.token'))).toBe(true);
    expect(existsSync(path.join(dashboardCwd, '.code-context'))).toBe(false);
    expect(existsSync(path.join(serverCwd, '.code-context'))).toBe(false);
  });

  it('ignores an old token file beside the cwd', () => {
    delete process.env[ENV];
    const project = tmp();
    const launcherCwd = tmp();
    mkdirSync(path.join(launcherCwd, '.code-context'));
    writeFileSync(path.join(launcherCwd, '.code-context/dashboard.token'), 'stale-cwd-token\n');

    const token = resolveFrom(launcherCwd, path.join(project, 'context.db'));

    expect(token).not.toBe('stale-cwd-token');
    expect(resolveDashboardToken(project)).toBe(token);
  });

  it('prefers the env var over the token file beside the db', () => {
    delete process.env[ENV];
    const project = tmp();
    const dbPath = path.join(project, 'context.db');
    const fileToken = resolveFrom(tmp(), dbPath);

    process.env[ENV] = 'env-token-235';
    expect(resolveFrom(tmp(), dbPath)).toBe('env-token-235');
    expect(resolveFrom(tmp(), dbPath)).not.toBe(fileToken);
  });

  it('falls back to the cwd when no db path is known', () => {
    const cwd = tmp();
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      expect(dashboardTokenRoot()).toBe(cwd);
      expect(dashboardTokenRoot(null)).toBe(cwd);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the directory of the resolved db path', () => {
    const project = tmp();
    expect(dashboardTokenRoot(path.join(project, 'sub', 'context.db'))).toBe(
      path.join(project, 'sub'),
    );
  });
});
