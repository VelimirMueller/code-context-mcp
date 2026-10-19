import { describe, it, expect, beforeEach } from 'vitest';
import { KNOWN_AGENT_MODELS } from '../src/scrum/agent-model.js';
import Database from 'better-sqlite3';
import { initScrumSchema } from '../src/scrum/schema.js';
import {
  AGENT_DEFAULTS,
  SKILL_DEFAULTS,
  seedDefaults,
  SPRINT_PROCESS_DEFAULT,
} from '../src/scrum/defaults.js';

const EXPECTED_AGENT_ROLES = [
  'architect',
  'be-engineer',
  'developer',
  'devops',
  'fe-engineer',
  'product-owner',
  'qa',
  'security',
  'team-lead',
] as const;

describe('Agent & Skill Seeding (T-45)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initScrumSchema(db);
  });

  describe('Agent creation', () => {
    it('creates exactly 9 agents', () => {
      seedDefaults(db);
      const result = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
      expect(result.c).toBe(9);
    });

    it('assigns correct roles to all 9 agents', () => {
      seedDefaults(db);
      const rows = db.prepare('SELECT role FROM agents ORDER BY role').all() as { role: string }[];
      const actualRoles = rows.map((r) => r.role as const);
      expect(actualRoles).toEqual(EXPECTED_AGENT_ROLES);
    });

    it('each agent has required fields populated', () => {
      seedDefaults(db);
      const agents = db.prepare('SELECT * FROM agents').all() as any[];
      expect(agents).toHaveLength(9);

      for (const agent of agents) {
        expect(agent.role).toBeTruthy();
        expect(agent.name).toBeTruthy();
        expect(agent.description).toBeTruthy();
        expect(KNOWN_AGENT_MODELS).toContain(agent.model);
        expect(agent.tools).toBeNull();
        expect(agent.system_prompt).toBe('');
      }
    });

    it('assigns the strongest model (claude-fable-5-1) to dev roles', () => {
      seedDefaults(db);
      const strong = db
        .prepare("SELECT role FROM agents WHERE model = 'claude-fable-5-1' ORDER BY role")
        .all() as { role: string }[];
      expect(strong.map((r) => r.role)).toEqual(['be-engineer', 'developer', 'fe-engineer']);
    });

    it('keeps qa on claude-opus-5-5', () => {
      seedDefaults(db);
      const qa = db.prepare("SELECT model FROM agents WHERE role = 'qa'").get() as {
        model: string;
      };
      expect(qa.model).toBe('claude-opus-5-5');
    });

    it('be-engineer has correct description', () => {
      seedDefaults(db);
      const be = db.prepare("SELECT description FROM agents WHERE role = 'be-engineer'").get() as {
        description: string;
      };
      expect(be.description).toContain('backend');
    });

    it('fe-engineer has correct description', () => {
      seedDefaults(db);
      const fe = db.prepare("SELECT description FROM agents WHERE role = 'fe-engineer'").get() as {
        description: string;
      };
      expect(fe.description).toContain('frontend');
    });

    it('developer has correct description', () => {
      seedDefaults(db);
      const dev = db.prepare("SELECT description FROM agents WHERE role = 'developer'").get() as {
        description: string;
      };
      expect(dev.description).toContain('Full-stack');
    });

    it('devops has correct description', () => {
      seedDefaults(db);
      const devops = db.prepare("SELECT description FROM agents WHERE role = 'devops'").get() as {
        description: string;
      };
      expect(devops.description).toContain('CI/CD');
    });

    it('product-owner has correct description', () => {
      seedDefaults(db);
      const po = db
        .prepare("SELECT description FROM agents WHERE role = 'product-owner'")
        .get() as { description: string };
      expect(po.description).toContain('requirements');
    });

    it('qa has correct description', () => {
      seedDefaults(db);
      const qa = db.prepare("SELECT description FROM agents WHERE role = 'qa'").get() as {
        description: string;
      };
      expect(qa.description).toContain('Tests');
    });

    it('team-lead has correct description', () => {
      seedDefaults(db);
      const tl = db.prepare("SELECT description FROM agents WHERE role = 'team-lead'").get() as {
        description: string;
      };
      expect(tl.description).toContain('Coordinates');
    });

    it('no duplicate roles exist', () => {
      seedDefaults(db);
      const rows = db.prepare('SELECT role FROM agents').all() as { role: string }[];
      const roles = rows.map((r) => r.role);
      expect(new Set(roles).size).toBe(roles.length);
    });
  });

  describe('Skills presence', () => {
    it('creates exactly 5 structural skills from defaults', () => {
      seedDefaults(db);
      const result = db
        .prepare(
          "SELECT COUNT(*) as c FROM skills WHERE name NOT LIKE 'fe:%' AND name NOT LIKE 'la:%' AND name NOT LIKE 'wf:%'",
        )
        .get() as { c: number };
      expect(result.c).toBe(5);
    });

    it('also seeds frontend skills', () => {
      seedDefaults(db);
      const fe = db.prepare("SELECT COUNT(*) as c FROM skills WHERE name LIKE 'fe:%'").get() as {
        c: number;
      };
      expect(fe.c).toBeGreaterThan(0);
    });

    it('has SPRINT_PROCESS_JSON skill', () => {
      seedDefaults(db);
      const skill = db
        .prepare("SELECT content FROM skills WHERE name = 'SPRINT_PROCESS_JSON'")
        .get() as { content: string } | undefined;
      expect(skill).toBeDefined();
      expect(skill?.content).toContain('Planning');
      expect(skill?.content).toContain('Implementation');
      expect(skill?.content).toContain('Done');
      expect(skill?.content).toContain('Rest');
    });

    it('has SPRINT_PHASES skill', () => {
      seedDefaults(db);
      const skill = db.prepare("SELECT content FROM skills WHERE name = 'SPRINT_PHASES'").get() as
        | { content: string }
        | undefined;
      expect(skill).toBeDefined();
      expect(skill?.content).toContain('planning');
      expect(skill?.content).toContain('implementation');
      expect(skill?.content).toContain('done');
      expect(skill?.content).toContain('rest');
    });

    it('SKILL_DEFAULTS array has 5 entries', () => {
      expect(SKILL_DEFAULTS).toHaveLength(5);
      const skillNames = SKILL_DEFAULTS.map((s) => s.name);
      expect(skillNames).toContain('SPRINT_PROCESS_JSON');
      expect(skillNames).toContain('SPRINT_PHASES');
      expect(skillNames).toContain('SPRINT_ROLES');
      expect(skillNames).toContain('CODE_QUALITY_STANDARDS');
      expect(skillNames).toContain('DEPLOYMENT_CHECKLIST');
    });
  });

  describe('Config validation', () => {
    it('AGENT_DEFAULTS constant matches expected roles', () => {
      expect(AGENT_DEFAULTS).toHaveLength(9);
      const roles = AGENT_DEFAULTS.map((a) => a.role).sort();
      expect(roles).toEqual([...EXPECTED_AGENT_ROLES].sort());
    });

    it('all agent models are valid Claude models', () => {
      const validModels = KNOWN_AGENT_MODELS;
      for (const agent of AGENT_DEFAULTS) {
        expect(validModels).toContain(agent.model);
      }
    });

    it('seed models are current generation (no superseded defaults)', () => {
      for (const agent of AGENT_DEFAULTS) {
        expect(agent.model).not.toBe('claude-sonnet-4-6');
      }
    });

    it('SPRINT_PROCESS_DEFAULT has all required phases', () => {
      const phaseNames = SPRINT_PROCESS_DEFAULT.phases.map((p: any) => p.name);
      expect(phaseNames).toContain('Planning');
      expect(phaseNames).toContain('Implementation');
      expect(phaseNames).toContain('Done');
      expect(phaseNames).toContain('Rest');
    });

    it('SPRINT_PROCESS_DEFAULT has proper transitions', () => {
      expect(SPRINT_PROCESS_DEFAULT.transitions.planning).toBe('implementation');
      expect(SPRINT_PROCESS_DEFAULT.transitions.implementation).toBe('done');
      expect(SPRINT_PROCESS_DEFAULT.transitions.done).toBe('rest');
      expect(SPRINT_PROCESS_DEFAULT.transitions.rest).toBe('planning');
    });
  });

  describe('Idempotency', () => {
    it('seedDefaults is idempotent — second call does nothing', () => {
      const first = seedDefaults(db);
      expect(first.agents).toBe(9);

      const second = seedDefaults(db);
      expect(second.agents).toBe(0);
      expect(second.skills).toBe(0);
    });

    it('modifying an agent then reseeding preserves modification', () => {
      seedDefaults(db);
      db.prepare("UPDATE agents SET model = 'custom-model' WHERE role = 'qa'").run();

      seedDefaults(db);

      const qa = db.prepare("SELECT model FROM agents WHERE role = 'qa'").get() as {
        model: string;
      };
      expect(qa.model).toBe('custom-model');
    });
  });
});
