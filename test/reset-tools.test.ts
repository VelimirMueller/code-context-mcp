/**
 * #187 — reset_agents / reset_skills must never spawn a process in the user's
 * project, and the delete + re-seed must be one transaction.
 *
 * The old code ran `npm run build` in process.cwd() (skipped only when VITEST
 * was set). These tests unset VITEST, chdir to an empty temp dir outside the
 * repo, and spy on every node:child_process entry point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cp = vi.hoisted(() => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  fork: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  ...cp,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  ...cp,
}));

import Database from 'better-sqlite3';
import { initScrumSchema } from '../src/scrum/schema.js';
import { AGENT_DEFAULTS, SKILL_DEFAULTS, resetAgents, resetSkills } from '../src/scrum/defaults.js';
import { registerSkillsTools } from '../src/scrum/tools/skills.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

const count = (db: Database.Database, table: 'agents' | 'skills'): number =>
  (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;

let db: Database.Database;
let tools: Map<string, Handler>;
let outside: string;
const origCwd = process.cwd();
const origVitest = process.env.VITEST;

beforeEach(() => {
  for (const fn of Object.values(cp)) fn.mockReset();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initScrumSchema(db);
  const server = new FakeServer();
  registerSkillsTools(server as never, db);
  tools = server.tools;
  // A project dir without package.json, outside the repo.
  outside = mkdtempSync(join(tmpdir(), 'cc-reset-'));
  process.chdir(outside);
  delete process.env.VITEST;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});

afterEach(() => {
  process.chdir(origCwd);
  if (origVitest !== undefined) process.env.VITEST = origVitest;
  rmSync(outside, { recursive: true, force: true });
  vi.unstubAllGlobals();
  db.close();
});

function expectNoSpawn(): void {
  for (const [name, fn] of Object.entries(cp)) {
    expect(fn, `child_process.${name} must not be called`).not.toHaveBeenCalled();
  }
}

describe('reset tools outside the repo (#187)', () => {
  it('reset_agents restores the factory team and spawns no process', async () => {
    db.prepare("INSERT INTO agents (role, name) VALUES ('custom', 'Custom')").run();
    const res = await tools.get('reset_agents')!({});
    expect(res.content[0].text).toBe(
      `Reset complete: ${AGENT_DEFAULTS.length} agents restored to factory defaults.`,
    );
    expect(count(db, 'agents')).toBe(AGENT_DEFAULTS.length);
    expectNoSpawn();
  });

  it('reset_skills restores the factory skills and spawns no process', async () => {
    db.prepare("INSERT INTO skills (name, content) VALUES ('OLD', 'x')").run();
    const res = await tools.get('reset_skills')!({});
    const total = count(db, 'skills');
    expect(total).toBeGreaterThan(SKILL_DEFAULTS.length);
    expect(res.content[0].text).toBe(
      `Reset complete: ${total} skills restored to factory defaults.`,
    );
    expect(db.prepare("SELECT 1 FROM skills WHERE name = 'OLD'").get()).toBeUndefined();
    expectNoSpawn();
  });
});

describe('reset is transactional (#187)', () => {
  it('resetAgents rolls back the DELETE when a re-seed insert fails', () => {
    db.prepare("INSERT INTO agents (role, name) VALUES ('custom', 'Custom')").run();
    db.exec(`CREATE TRIGGER fail_seed BEFORE INSERT ON agents WHEN NEW.role = '${AGENT_DEFAULTS[3].role}'
             BEGIN SELECT RAISE(ABORT, 'seed failed'); END`);
    expect(() => resetAgents(db)).toThrow(/seed failed/);
    expect(count(db, 'agents')).toBe(1);
    expect(db.prepare("SELECT 1 FROM agents WHERE role = 'custom'").get()).toBeDefined();
  });

  it('resetSkills rolls back the DELETE when a re-seed insert fails', () => {
    db.prepare("INSERT INTO skills (name, content) VALUES ('MINE', 'x')").run();
    db.exec(`CREATE TRIGGER fail_seed BEFORE INSERT ON skills WHEN NEW.name = '${SKILL_DEFAULTS[2].name}'
             BEGIN SELECT RAISE(ABORT, 'seed failed'); END`);
    expect(() => resetSkills(db)).toThrow(/seed failed/);
    expect(count(db, 'skills')).toBe(1);
    expect(db.prepare("SELECT 1 FROM skills WHERE name = 'MINE'").get()).toBeDefined();
  });
});
