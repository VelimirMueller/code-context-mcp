/**
 * Factory defaults for the scrum system.
 *
 * These TypeScript constants seed empty DB tables on first startup.
 * They are never read at runtime — the DB is the sole source of truth.
 * Use reset_* MCP tools to re-seed from these defaults.
 */
import {
  FRONTEND_SKILL_DEFAULTS,
  LANDING_SKILL_DEFAULTS,
  WORKFLOW_SKILL_DEFAULTS,
} from './frontend-skill-defaults.generated.js';

// ─── Agent Defaults ─────────────────────────────────────────────────────────

export interface AgentDefault {
  role: string;
  name: string;
  description: string;
  model: string;
  tools: string | null;
  system_prompt: string;
  department: string;
}

export const AGENT_DEFAULTS: AgentDefault[] = [
  {
    role: 'fe-engineer',
    name: 'FE Engineer',
    description: 'Builds frontend UI components, pages, and client-side logic',
    model: 'claude-fable-5-1',
    tools: null,
    system_prompt: '',
    department: 'development',
  },
  {
    role: 'be-engineer',
    name: 'BE Engineer',
    description: 'Builds backend APIs, database models, and server-side logic',
    model: 'claude-fable-5-1',
    tools: null,
    system_prompt: '',
    department: 'development',
  },
  {
    role: 'developer',
    name: 'Developer',
    description: 'Full-stack developer building features across frontend and backend',
    model: 'claude-fable-5-1',
    tools: null,
    system_prompt: '',
    department: 'development',
  },
  {
    role: 'devops',
    name: 'DevOps',
    description: 'Manages CI/CD, deployment, and infrastructure',
    model: 'claude-sonnet-5-5',
    tools: null,
    system_prompt: '',
    department: 'development',
  },
  {
    role: 'qa',
    name: 'QA Engineer',
    description: 'Tests and verifies functionality',
    model: 'claude-opus-5-5',
    tools: null,
    system_prompt: '',
    department: 'quality',
  },
  {
    role: 'security',
    name: 'Security Engineer',
    description:
      'Reviews code for vulnerabilities, enforces security best practices, and manages threat modeling',
    model: 'claude-sonnet-5-5',
    tools: null,
    system_prompt: '',
    department: 'quality',
  },
  {
    role: 'architect',
    name: 'Architect',
    description:
      'Designs system architecture, makes technology decisions, and ensures structural integrity',
    model: 'claude-sonnet-5-5',
    tools: null,
    system_prompt: '',
    department: 'development',
  },
  {
    role: 'team-lead',
    name: 'Team Lead',
    description: 'Coordinates the team, reviews code, and ensures quality',
    model: 'claude-sonnet-5-5',
    tools: null,
    system_prompt: '',
    department: 'business',
  },
  {
    role: 'product-owner',
    name: 'Product Owner',
    description: 'Manages requirements, priorities, and stakeholder communication',
    model: 'claude-sonnet-5-5',
    tools: null,
    system_prompt: '',
    department: 'business',
  },
];

// ─── Sprint Process Default ────────────────────────────────────────────────

export const SPRINT_PROCESS_DEFAULT = {
  phases: [
    {
      name: 'Planning',
      duration: '1 day',
      mandatory: true,
      ceremonies: ['Sprint Planning', 'Goal Setting', 'Ticket Assignment'],
      criteria: ['Sprint goal defined', 'Tickets assigned', 'Velocity committed'],
    },
    {
      name: 'Implementation',
      duration: '3-4 days',
      mandatory: true,
      ceremonies: ['Daily Standups', 'Code Reviews', 'QA Verification'],
      criteria: ['All tickets IN_PROGRESS or DONE', 'No stale tickets'],
    },
    {
      name: 'Done',
      duration: '0.5 day',
      mandatory: true,
      ceremonies: ['Sprint Summary', 'Retro Findings', 'Velocity Review'],
      criteria: ['Results reviewed', 'Retro findings logged'],
    },
    {
      name: 'Rest',
      duration: '0.5 day',
      mandatory: false,
      ceremonies: ['Team Recovery'],
      criteria: [],
    },
  ],
  transitions: {
    planning: 'implementation',
    implementation: 'done',
    done: 'rest',
    rest: 'planning',
  },
};

// ─── Skill Defaults (only structural ones — project-specific skills are not factory defaults) ───

export interface SkillDefault {
  name: string;
  content: string;
  owner_role: string | null;
}

export const SKILL_DEFAULTS: SkillDefault[] = [
  {
    name: 'SPRINT_PROCESS_JSON',
    content: JSON.stringify(SPRINT_PROCESS_DEFAULT, null, 2),
    owner_role: null,
  },
  {
    name: 'SPRINT_PHASES',
    content: 'planning → implementation → done → rest',
    owner_role: null,
  },
  {
    name: 'SPRINT_ROLES',
    content: JSON.stringify(
      [
        'fe-engineer',
        'be-engineer',
        'developer',
        'devops',
        'qa',
        'security',
        'architect',
        'team-lead',
        'product-owner',
      ],
      null,
      2,
    ),
    owner_role: null,
  },
  {
    name: 'CODE_QUALITY_STANDARDS',
    content: 'All code must be reviewed, tested, and pass linting before merging.',
    owner_role: 'team-lead',
  },
  {
    name: 'DEPLOYMENT_CHECKLIST',
    content:
      '1. All tests pass\n2. No critical bugs\n3. Documentation updated\n4. Stakeholder approval',
    owner_role: 'devops',
  },
];

// fe:_house-style — leading underscore marks it as the meta/primer entry, not a normal skill
export const FE_PRIMER_NAME = 'fe:_house-style';

export const FRONTEND_HOUSE_STYLE_PRIMER = `# Frontend House Style — Preferred Ways of Working

Applies to all \`fe-engineer\` work. Load any referenced skill with \`get_skill({ name })\`.

## Stack
- Build: Vite. Framework: React 19 (function components + hooks only).
- Routing: TanStack Router (typed, file-based). Server state: TanStack Query.
- Client state: minimal — prefer URL + Query cache over global stores.
- Styling: Tailwind v4 with \`@theme\` tokens. No inline hex; use tokens.
- Forms: React Hook Form + Zod resolver. Validate at the edge.
- Lint/format: Biome. TypeScript strict.
- Tests: Vitest + Testing Library. Test behavior, not implementation.

## Conventions
- Atomic-design folders: atoms → molecules → organisms → templates → pages.
- Treat the current user as server state (fetched), never duplicated into client state.
- Accessibility is non-negotiable: semantic HTML, labelled controls, Biome a11y rules on.
- Env vars validated via a typed schema (\`import.meta.env\`) — fail fast on missing.
- Error boundaries at the app shell + per route; report via the \`captureError\` seam.

## How to use these skills
When you start a task, pull the matching skill's full guidance with
\`get_skill({ name: "fe:<slug>" })\`. A skill body may reference companions and shared docs by relative path:
\`./x.md\` → \`get_skill({ name: "fe:<slug>/x.md" })\`; \`../other-skill/SKILL.md\` → \`get_skill({ name: "fe:other-skill" })\`;
\`../_shared/x.md\` → \`get_skill({ name: "fe:_shared/x.md" })\`.`;

// ─── Seed Function ──────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';

/** Idempotently insert any missing frontend skills + primer. Returns count inserted. */
export function seedFrontendSkills(db: Database.Database): number {
  const insert = db.prepare(
    `INSERT INTO skills (name, content, owner_role) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`,
  );
  const rows: SkillDefault[] = [
    { name: FE_PRIMER_NAME, content: FRONTEND_HOUSE_STYLE_PRIMER, owner_role: 'fe-engineer' },
    ...FRONTEND_SKILL_DEFAULTS,
  ];
  let inserted = 0;
  for (const s of rows) {
    if (insert.run(s.name, s.content, s.owner_role).changes > 0) inserted++;
  }
  return inserted;
}

/**
 * Idempotently insert any missing skills from EVERY vendored set (frontend
 * incl. primer, landing, workflow). Content is always present in the DB;
 * whether a set is served is the separate enablement flag in skill-sets.ts.
 */
export function seedSkillSets(db: Database.Database): number {
  let inserted = seedFrontendSkills(db);
  const insert = db.prepare(
    `INSERT INTO skills (name, content, owner_role) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`,
  );
  for (const s of [...LANDING_SKILL_DEFAULTS, ...WORKFLOW_SKILL_DEFAULTS]) {
    if (insert.run(s.name, s.content, s.owner_role).changes > 0) inserted++;
  }
  return inserted;
}

/**
 * Seed factory defaults into empty tables. Never overwrites existing data.
 * Call this on startup to seed empty tables.
 */
export function seedDefaults(db: Database.Database): { agents: number; skills: number } {
  let agentCount = 0;
  let skillCount = 0;

  // Seed agents if table is empty, or migrate from old factory defaults
  const agentRows = (db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c;
  const OLD_15_AGENT_COUNT = 15;
  const OLD_4_AGENT_COUNT = 4;
  const OLD_6_AGENT_COUNT = 6;

  const OLD_7_AGENT_COUNT = 7;

  const isOld15 =
    agentRows === OLD_15_AGENT_COUNT &&
    db.prepare("SELECT 1 FROM agents WHERE role = 'architect'").get() != null;
  // Old 4-agent set had a 'developer' role; new 6-agent set uses 'fe-engineer'/'be-engineer'
  const isOld4 =
    agentRows === OLD_4_AGENT_COUNT &&
    db.prepare("SELECT 1 FROM agents WHERE role = 'developer'").get() != null &&
    db.prepare("SELECT 1 FROM agents WHERE role = 'fe-engineer'").get() == null;
  // Old 6-agent set is missing the generic 'developer' role
  const isOld6 =
    agentRows === OLD_6_AGENT_COUNT &&
    db.prepare("SELECT 1 FROM agents WHERE role = 'fe-engineer'").get() != null &&
    db.prepare("SELECT 1 FROM agents WHERE role = 'developer'").get() == null;
  // Old 7-agent set is missing security and architect roles
  const isOld7 =
    agentRows === OLD_7_AGENT_COUNT &&
    db.prepare("SELECT 1 FROM agents WHERE role = 'security'").get() == null;

  if (agentRows === 0 || isOld15 || isOld4 || isOld6 || isOld7) {
    if (agentRows > 0) db.prepare('DELETE FROM agents').run();
    const stmt = db.prepare(
      `INSERT INTO agents (role, name, description, model, tools, system_prompt, department) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of AGENT_DEFAULTS) {
      stmt.run(a.role, a.name, a.description, a.model, a.tools, a.system_prompt, a.department);
      agentCount++;
    }
  }

  // Seed skills only if table is empty
  const skillRows = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number }).c;
  if (skillRows === 0) {
    const stmt = db.prepare(`INSERT INTO skills (name, content, owner_role) VALUES (?, ?, ?)`);
    for (const s of SKILL_DEFAULTS) {
      stmt.run(s.name, s.content, s.owner_role);
      skillCount++;
    }
  }

  // Vendored skill sets (fe/la/wf): additive, idempotent (independent of the structural-skills guard)
  skillCount += seedSkillSets(db);

  // Seed mood data if table is empty and agents + sprints exist
  try {
    const moodRows = (
      db.prepare('SELECT COUNT(*) as c FROM agent_mood_history').get() as { c: number }
    ).c;
    if (moodRows === 0) {
      const agents = db.prepare('SELECT id, role FROM agents').all() as {
        id: number;
        role: string;
      }[];
      const sprints = db
        .prepare(
          "SELECT id FROM sprints WHERE status IN ('rest', 'closed', 'done') AND deleted_at IS NULL ORDER BY created_at",
        )
        .all() as { id: number }[];
      if (agents.length > 0 && sprints.length > 0) {
        const stmt = db.prepare(
          'INSERT INTO agent_mood_history (agent_id, sprint_id, mood, workload_points) VALUES (?, ?, ?, ?)',
        );
        for (const sprint of sprints) {
          for (const agent of agents) {
            const baseMood = agent.role === 'qa' ? 3 : 4;
            const mood = Math.max(1, Math.min(5, baseMood + (Math.floor(Math.random() * 3) - 1)));
            const pts = Math.floor(Math.random() * 8) + 3;
            stmt.run(agent.id, sprint.id, mood, pts);
          }
        }
      }
    }
  } catch {}

  return { agents: agentCount, skills: skillCount };
}

/**
 * Reset agents table to factory defaults. Truncates and re-seeds in one
 * transaction: a failed insert or a failed count check rolls back the DELETE,
 * so the table is never left empty. Spawns no process (#187): the MCP server's
 * cwd is the user's project, and its stdout is the JSON-RPC channel.
 */
export function resetAgents(db: Database.Database): number {
  const run = db.transaction((): number => {
    db.prepare('DELETE FROM agents').run();
    const stmt = db.prepare(
      `INSERT INTO agents (role, name, description, model, tools, system_prompt, department) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of AGENT_DEFAULTS) {
      stmt.run(a.role, a.name, a.description, a.model, a.tools, a.system_prompt, a.department);
    }

    // Validation: ensure agent count is exactly 9
    const count = (db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c;
    if (count !== 9) {
      throw new Error(`Agent validation failed: expected 9 agents, got ${count}`);
    }
    return AGENT_DEFAULTS.length;
  });
  return run();
}

/**
 * Reset skills table to factory defaults. Truncates and re-seeds in one
 * transaction (see resetAgents). Spawns no process (#187).
 * Returns the total number of skills restored (structural + frontend).
 */
export function resetSkills(db: Database.Database): number {
  const run = db.transaction((): number => {
    db.prepare('DELETE FROM skills').run();
    const stmt = db.prepare(`INSERT INTO skills (name, content, owner_role) VALUES (?, ?, ?)`);
    for (const s of SKILL_DEFAULTS) {
      stmt.run(s.name, s.content, s.owner_role);
    }

    // Validation: exactly 5 structural skills (frontend skills are seeded separately)
    const structural = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM skills WHERE name NOT LIKE 'fe:%' AND name NOT LIKE 'la:%' AND name NOT LIKE 'wf:%'",
        )
        .get() as { c: number }
    ).c;
    if (structural !== 5) {
      throw new Error(`Skill validation failed: expected 5 structural skills, got ${structural}`);
    }

    // Factory reset restores every vendored skill set too (the DELETE above cleared
    // them) — including the enablement row, so the project returns to fe-only defaults.
    const setsRestored = seedSkillSets(db);

    return SKILL_DEFAULTS.length + setsRestored;
  });
  return run();
}

/**
 * Reset sprint process to factory default.
 */
export function resetSprintProcess(db: Database.Database): void {
  db.prepare("DELETE FROM skills WHERE name = 'SPRINT_PROCESS_JSON'").run();
  db.prepare("DELETE FROM skills WHERE name = 'SPRINT_PHASES'").run();
  const stmt = db.prepare(`INSERT INTO skills (name, content, owner_role) VALUES (?, ?, ?)`);
  for (const s of SKILL_DEFAULTS) {
    stmt.run(s.name, s.content, s.owner_role);
  }
}
