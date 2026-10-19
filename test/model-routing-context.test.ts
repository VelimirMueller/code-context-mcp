import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initScrumSchema } from '../src/scrum/schema.js';
import { seedDefaults } from '../src/scrum/defaults.js';
import { formatModelRouting } from '../src/scrum/agent-model.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initScrumSchema(db);
  seedDefaults(db);
});

/** Mirrors the lookup load_phase_context / get_ticket perform for an assigned ticket. */
function routingFor(assignedRole: string): string {
  const ag = db.prepare('SELECT model FROM agents WHERE role = ?').get(assignedRole) as
    | { model: string }
    | undefined;
  return formatModelRouting(assignedRole, ag?.model ?? null);
}

describe('ticket model routing (DB join → tier)', () => {
  it('routes an fe-engineer ticket to the fable tier', () => {
    expect(routingFor('fe-engineer')).toContain('model: "fable"'); // fe-engineer defaults to claude-fable-5
  });
  it('routes a qa ticket to the opus tier', () => {
    expect(routingFor('qa')).toContain('model: "opus"'); // qa defaults to claude-opus-4-8
  });
  it('routes a devops ticket to the sonnet tier', () => {
    expect(routingFor('devops')).toContain('model: "sonnet"'); // devops stays claude-sonnet-4-6
  });
});
