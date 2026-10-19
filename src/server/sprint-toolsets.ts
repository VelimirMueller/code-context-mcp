/**
 * The toolset registration file for the sprint process (#179).
 *
 * The index entry (src/server/index.ts) loads this module with a dynamic
 * `import()` only when a sprint toolset (`scrum`, `fun`, `stream`) is on: the
 * `code-context-sprint` bin, `CODE_CONTEXT_PROFILE=full|all`, or
 * `CODE_CONTEXT_TOOLSETS` naming one of them. Under the default `code`
 * profile the scrum, dashboard and bridge code is never loaded.
 *
 * Together with src/server/sprint.ts, this is the only file in src/server
 * that the server reaches src/scrum through (test/boundary.test.ts).
 *
 * Shared context.db: the index entry owns the code-index tables (files,
 * exports, dependencies, directories, changes, indexed_repos; src/server/schema.ts).
 * This module owns the scrum tables and the `schema_versions` stamp.
 */
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'path';
import { initScrumSchema, runMigrations, LATEST_SCHEMA_VERSION } from '../scrum/schema.js';
import { registerScrumTools, setDashboardDbPath } from '../scrum/tools.js';
import { seedDefaults } from '../scrum/defaults.js';
import { syncSkillsFromUpstream } from '../scrum/skill-sync.js';
import { log as slog, errorClass } from '../sessionlog.js';

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/**
 * Create and migrate the scrum tables, then seed the factory defaults.
 *
 * A database the index entry created has the code tables but no scrum tables
 * and no `schema_versions`: it counts as fresh here, so the canonical schema
 * is stamped instead of replaying every migration.
 */
export function prepareSprintDb(db: Database.Database, dbPath: string): void {
  const freshScrum = !hasTable(db, 'schema_versions') && !hasTable(db, 'sprints');
  let preMigrationVersion: number;
  try {
    initScrumSchema(db);
    preMigrationVersion =
      (db.prepare('SELECT MAX(version) v FROM schema_versions').get() as { v: number | null })?.v ??
      0;
    runMigrations(db, { freshDb: freshScrum });
  } catch (err) {
    slog(
      'CRITICAL',
      `server: scrum migration failed db=${path.basename(dbPath)} error=${errorClass(err)}`,
    );
    throw err;
  }
  if (!freshScrum && preMigrationVersion < LATEST_SCHEMA_VERSION) {
    slog(
      'WARN',
      `server: migrations applied db=${path.basename(dbPath)} schema v${preMigrationVersion}→v${LATEST_SCHEMA_VERSION}`,
    );
  }
  console.error(
    freshScrum
      ? `[schema] v${LATEST_SCHEMA_VERSION} (new scrum tables)`
      : preMigrationVersion < LATEST_SCHEMA_VERSION
        ? `[schema] migrated v${preMigrationVersion} → v${LATEST_SCHEMA_VERSION}`
        : `[schema] v${LATEST_SCHEMA_VERSION} (up to date)`,
  );

  // Seed factory defaults into empty tables (never overwrites existing data)
  const seeded = seedDefaults(db);
  if (seeded.agents + seeded.skills > 0) {
    console.error(
      `[seed] Seeded ${seeded.agents} agents, ${seeded.skills} skills from factory defaults`,
    );
  }

  // Best-effort refresh of fe:* skills from the latest upstream release.
  // Non-blocking and offline-safe; baked defaults remain the fallback.
  // Opt-in with CODE_CONTEXT_SKILLS_AUTOSYNC=1: synced skills land in agent
  // prompts, so pulling remote content on every boot must be the user's choice.
  if (process.env.CODE_CONTEXT_SKILLS_AUTOSYNC === '1') {
    void syncSkillsFromUpstream(db).then((r) => {
      if (r.ok && !r.skipped) {
        console.error(
          `[skills] Synced to ${r.tag}: ${r.inserted} new, ${r.updated} updated, ${r.preserved} user-edited preserved`,
        );
      }
    });
  }
}

/** Register the sprint process tools: scrum, bridge, dump/restore, fun, stream. */
export function registerSprintToolsets(
  server: McpServer,
  db: Database.Database,
  dbPath: string,
): void {
  // Notify calls read the dashboard token beside this db, not beside the cwd (#235).
  setDashboardDbPath(dbPath);
  registerScrumTools(server, db);
}
