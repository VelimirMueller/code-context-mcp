/**
 * Dashboard HTTP Handlers — Module Registry
 *
 * Handlers are being incrementally migrated from ../dashboard.ts:
 *
 *   handlers/code.ts     — files, file-context, graph, changes, directories
 *   handlers/sprint.ts   — sprints, tickets, retro, burndown, blockers, bugs
 *   handlers/planning.ts — milestones, epics, backlog, discoveries, vision
 *   handlers/team.ts     — agents, skills, mood, sprint-process
 *   handlers/bridge.ts   — pending-actions, wizard, claude output
 *   handlers/bench.ts    — real bench runs (index + run files, source resolution)
 *
 * Each handler module exports functions that take (db: Database) and return data.
 * The router in dashboard.ts calls these instead of inline query logic.
 *
 * During migration, existing inline handlers in dashboard.ts remain functional.
 * New handlers are registered here and called from the router.
 */
import type Database from "better-sqlite3";

export interface HandlerContext {
  db: Database.Database;
}

// Import domain handlers as they're extracted
export * as codeHandlers from "./code.js";
export * as sprintHandlers from "./sprint.js";
export * as benchHandlers from "./bench.js";
export * as planningHandlers from "./planning.js";
// export { teamHandlers } from "./team.js";
// export { bridgeHandlers } from "./bridge.js";
