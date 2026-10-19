import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initScrumSchema } from '../src/scrum/schema.js';
import {
  AGENT_DEFAULTS,
  SKILL_DEFAULTS,
  seedDefaults,
  resetAgents,
  resetSkills,
  resetSprintProcess,
} from '../src/scrum/defaults.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initScrumSchema(db);
});

describe('seedDefaults', () => {
  it('populates empty agents table with all defaults', () => {
    const result = seedDefaults(db);
    expect(result.agents).toBe(AGENT_DEFAULTS.length);
    const rows = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
    expect(rows.c).toBe(AGENT_DEFAULTS.length);
  });

  it('populates empty skills table with defaults', () => {
    const result = seedDefaults(db);
    // structural skills (5) + frontend skills (primer + compiled entries)
    const structural = db
      .prepare(
        "SELECT COUNT(*) as c FROM skills WHERE name NOT LIKE 'fe:%' AND name NOT LIKE 'la:%' AND name NOT LIKE 'wf:%'",
      )
      .get() as { c: number };
    expect(structural.c).toBe(SKILL_DEFAULTS.length);
    expect(result.skills).toBeGreaterThanOrEqual(SKILL_DEFAULTS.length);
  });

  it('does NOT overwrite agents if table already has data', () => {
    db.prepare('INSERT INTO agents (role, name) VALUES (?, ?)').run('custom-agent', 'Custom');
    const result = seedDefaults(db);
    expect(result.agents).toBe(0);
    const rows = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
    expect(rows.c).toBe(1); // only the custom one
  });

  it('does NOT overwrite structural skills if table already has data', () => {
    db.prepare('INSERT INTO skills (name, content) VALUES (?, ?)').run('MY_SKILL', 'content');
    const result = seedDefaults(db);
    // Structural skills are not seeded when table is non-empty, but vendored skill sets are always seeded
    const structural = db
      .prepare(
        "SELECT COUNT(*) as c FROM skills WHERE name NOT LIKE 'fe:%' AND name NOT LIKE 'la:%' AND name NOT LIKE 'wf:%'",
      )
      .get() as { c: number };
    expect(structural.c).toBe(1); // only MY_SKILL
    const sets = db
      .prepare(
        "SELECT COUNT(*) as c FROM skills WHERE name LIKE 'fe:%' OR name LIKE 'la:%' OR name LIKE 'wf:%'",
      )
      .get() as { c: number };
    expect(sets.c).toBeGreaterThan(0); // skill sets always seeded
    expect(result.skills).toBe(sets.c); // returned count is just the set seeds
  });

  it('is idempotent — second call seeds nothing', () => {
    seedDefaults(db);
    const result = seedDefaults(db);
    expect(result.agents).toBe(0);
    expect(result.skills).toBe(0);
  });

  it('seeds all agent fields correctly', () => {
    seedDefaults(db);
    const dev = db.prepare("SELECT * FROM agents WHERE role = 'developer'").get() as any;
    expect(dev).toBeDefined();
    expect(dev.name).toBe('Developer');
    expect(dev.model).toBe('claude-fable-5-1');
    expect(dev.description).toContain('Full-stack');
  });
});

describe('resetAgents', () => {
  it('truncates and re-seeds agents', () => {
    // Add custom agents
    db.prepare('INSERT INTO agents (role, name) VALUES (?, ?)').run('custom-1', 'Custom 1');
    db.prepare('INSERT INTO agents (role, name) VALUES (?, ?)').run('custom-2', 'Custom 2');
    expect((db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c).toBe(2);

    const count = resetAgents(db);
    expect(count).toBe(AGENT_DEFAULTS.length);
    expect((db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c).toBe(
      AGENT_DEFAULTS.length,
    );

    // Custom agents gone
    const custom = db.prepare("SELECT * FROM agents WHERE role = 'custom-1'").get();
    expect(custom).toBeUndefined();

    // Factory agents present
    const dev = db.prepare("SELECT * FROM agents WHERE role = 'developer'").get();
    expect(dev).toBeDefined();
  });

  it('re-seeds departments (discovery #33 sibling fix — INSERT used to omit the column)', () => {
    resetAgents(db);
    const rows = db.prepare('SELECT role, department FROM agents').all() as {
      role: string;
      department: string;
    }[];
    for (const expected of AGENT_DEFAULTS) {
      const row = rows.find((r) => r.role === expected.role);
      expect(row, `agent ${expected.role} missing after reset`).toBeDefined();
      expect(row!.department).toBe(expected.department);
    }
  });
});

describe('ESM regression tripwire (discovery #33)', () => {
  // The live crash ("require is not defined") only reproduced OUTSIDE vitest.
  // Guard the source against a reintroduced lazy require().
  it('defaults.ts contains no CJS require() calls', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/scrum/defaults.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/[^.\w`]require\s*\(/);
  });
});

describe('resetSkills', () => {
  it('truncates and re-seeds skills (structural + frontend)', () => {
    db.prepare('INSERT INTO skills (name, content) VALUES (?, ?)').run('OLD_SKILL', 'old');
    const count = resetSkills(db);

    // Return value is the total restored: structural + frontend
    const total = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number }).c;
    expect(count).toBe(total);

    // Breakdown: 5 structural + the re-seeded vendored skill sets (fe/la/wf)
    const structural = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM skills WHERE name NOT LIKE 'fe:%' AND name NOT LIKE 'la:%' AND name NOT LIKE 'wf:%'",
        )
        .get() as { c: number }
    ).c;
    expect(structural).toBe(SKILL_DEFAULTS.length);
    const sets = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM skills WHERE name LIKE 'fe:%' OR name LIKE 'la:%' OR name LIKE 'wf:%'",
        )
        .get() as { c: number }
    ).c;
    expect(sets).toBeGreaterThan(0);
    expect(count).toBe(SKILL_DEFAULTS.length + sets);

    const old = db.prepare("SELECT * FROM skills WHERE name = 'OLD_SKILL'").get();
    expect(old).toBeUndefined();
  });
});

describe('resetSprintProcess', () => {
  it('resets process config skills', () => {
    db.prepare('INSERT INTO skills (name, content) VALUES (?, ?)').run(
      'SPRINT_PROCESS_JSON',
      'broken',
    );
    resetSprintProcess(db);
    const row = db
      .prepare("SELECT content FROM skills WHERE name = 'SPRINT_PROCESS_JSON'")
      .get() as { content: string };
    expect(row).toBeDefined();
    expect(row.content).toContain('Implementation');
    expect(row.content).not.toBe('broken');
  });
});

describe('AGENT_DEFAULTS integrity', () => {
  it('has 9 agents', () => {
    expect(AGENT_DEFAULTS.length).toBe(9);
  });

  it('all agents have required fields', () => {
    for (const a of AGENT_DEFAULTS) {
      expect(a.role).toBeTruthy();
      expect(a.name).toBeTruthy();
      expect(a.description).toBeTruthy();
      expect(a.model).toBeTruthy();
    }
  });

  it('has the 7 core roles', () => {
    const roles = AGENT_DEFAULTS.map((a) => a.role).sort();
    expect(roles).toEqual([
      'architect',
      'be-engineer',
      'developer',
      'devops',
      'fe-engineer',
      'product-owner',
      'qa',
      'security',
      'team-lead',
    ]);
  });

  it('no duplicate roles', () => {
    const roles = AGENT_DEFAULTS.map((a) => a.role);
    expect(new Set(roles).size).toBe(roles.length);
  });
});

describe('DB restart preserves data', () => {
  it('existing agents survive seedDefaults on fresh connection', () => {
    // Simulate: first startup seeds, second startup should not overwrite
    seedDefaults(db);
    // Modify an agent
    db.prepare("UPDATE agents SET model = 'custom-model' WHERE role = 'qa'").run();

    // Simulate restart — call seedDefaults again
    seedDefaults(db);

    const qa = db.prepare("SELECT model FROM agents WHERE role = 'qa'").get() as { model: string };
    expect(qa.model).toBe('custom-model'); // NOT overwritten
  });
});
