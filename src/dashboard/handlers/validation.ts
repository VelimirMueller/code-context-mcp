/**
 * Shared request-validation helpers + constants.
 *
 * Extracted from ../dashboard.ts (T-278) so the migrated scrum handlers
 * (./sprint.ts) and the remaining inline handlers in dashboard.ts share one
 * copy instead of duplicating the validators. Every function here is pure
 * (no DB, no module state) and byte-identical to the originals — a 400 thrown
 * here carries the same `{ status: 400 }` shape the router already serialises.
 */

import { KNOWN_AGENT_MODELS, DEFAULT_AGENT_MODEL } from '../../scrum/agent-model.js';

/** Throw a 400 unless `value` is in `allowed`. */
export function validateEnum(value: string, allowed: string[], name: string) {
  if (!allowed.includes(value))
    throw Object.assign(new Error(`Invalid ${name}: ${value}. Allowed: ${allowed.join(', ')}`), {
      status: 400,
    });
}

/** Throw a 400 unless `hex` is a 6-digit `#rrggbb` colour. */
export function validateColor(hex: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex))
    throw Object.assign(new Error('Invalid hex color'), { status: 400 });
}

/** Throw a 400 unless `current → next` is a permitted sprint phase transition. */
export function validateSprintTransition(current: string, next: string) {
  const allowed: Record<string, string[]> = {
    planning: ['implementation'],
    implementation: ['done', 'qa'],
    done: ['rest'],
    rest: ['planning'],
    // Legacy phases — map to nearest simplified transition
    preparation: ['kickoff', 'implementation', 'planning'],
    kickoff: ['planning', 'implementation'],
    qa: ['refactoring', 'implementation', 'done', 'retro'],
    refactoring: ['retro', 'done'],
    retro: ['review', 'done', 'rest'],
    review: ['closed', 'rest', 'done'],
    closed: ['rest'],
  };
  if (!allowed[current]?.includes(next))
    throw Object.assign(new Error(`Cannot transition ${current} → ${next}`), { status: 400 });
}

/** A 400 error with the given message (used by the ticket-PATCH field validators). */
export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

// Single allowed-model list shared by the /api/agent routes, per-assignment
// model overrides on PATCH /api/ticket/:id (D2) and the MCP `update_agent`
// tool — owned by src/scrum/agent-model.ts so the server and the dashboard
// can never drift. Superseded ids (claude-opus-4-8, claude-sonnet-4-6) stay
// accepted so agents created on them remain editable.
export const ALLOWED_AGENT_MODELS: string[] = [...KNOWN_AGENT_MODELS];

// Model applied when an agent is created without one (also the seed tier for
// non-dev roles in src/scrum/defaults.ts — keep the two in sync).
export { DEFAULT_AGENT_MODEL };
