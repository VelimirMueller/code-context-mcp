#!/usr/bin/env node
import http from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import type { z } from 'zod';
import chokidar from 'chokidar';
import { indexDirectory } from '../server/indexer.js';
import { initSchema } from '../server/schema.js';
import {
  initScrumSchema,
  runMigrations,
  LATEST_SCHEMA_VERSION,
  peekSchemaVersion,
} from '../scrum/schema.js';
import { archiveEntity, unarchiveEntity, type ArchivableEntity } from '../scrum/archive.js';
import { seedDefaults } from '../scrum/defaults.js';
import { resolveDashboardToken, isAuthorized, isAllowedHost, isAllowedOrigin } from './auth.js';
import { makeWatchIgnorePredicate, WATCH_DIR_WARN_THRESHOLD } from '../shared/ignore.js';
import { codeHandlers, sprintHandlers, benchHandlers } from './handlers/index.js';
import { log as slog, errorClass, logThrottled } from '../sessionlog.js';

/** Rejected-request breadcrumb, at most one per status+path per minute (anyone local can trigger these). */
function logRejected(
  status: number,
  reason: string,
  method: string | undefined,
  pathname: string,
): void {
  const p = pathname.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 120);
  logThrottled(
    `${status} ${p}`,
    'WARN',
    `dashboard: rejected request status=${status} reason=${reason} method=${method} path=${p}`,
  );
}
// Shared validators live in handlers/validation.ts so the migrated scrum
// handlers (handlers/sprint.ts) and the remaining inline handlers share one copy.
import {
  validateEnum,
  validateColor,
  ALLOWED_AGENT_MODELS,
  DEFAULT_AGENT_MODEL,
} from './handlers/validation.js';
import {
  parseBody,
  AgentCreateBody,
  AgentUpdateBody,
  DiscoveryLinkBody,
  DiscoveryUpdateBody,
  EpicCreateBody,
  EpicUpdateBody,
  MilestoneLinkBody,
  EpicLinkBody,
  BridgeActionBody,
  BridgeRespondBody,
  MilestoneCreateBody,
  MilestoneUpdateBody,
  VisionBody,
  RestoreBody,
  SprintProcessBody,
} from './handlers/schemas.js';
import type { DiscoveryRow, MilestoneRow } from '../scrum/rows.js';

// Read version from package.json
const PKG_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'),
        'utf8',
      ),
    ).version;
  } catch {
    return '2.0.0';
  }
})();
const TOOL_COUNT = 98;

const DB_PATH = process.argv[2] ?? './context.db';
const PORT = Number(process.argv[3] ?? process.env.DASHBOARD_PORT ?? 3333);
const WATCH_DIR = process.argv[4] ?? null;

const dbPath = path.resolve(DB_PATH);
console.log(`[db] Database path: ${dbPath}`);

// Single read-write connection for all queries and writes
// (A read-only connection cannot see WAL changes from external processes like the MCP server)
const isFreshDb = !fs.existsSync(dbPath);

// Refuse a downgrade BEFORE the read-write open — same groomed two-line error
// as the MCP server entry; avoids WAL litter next to a refused DB (discovery #28).
let stampedBefore = 0;
if (!isFreshDb) {
  const stamped = peekSchemaVersion(dbPath);
  stampedBefore = stamped;
  if (stamped > LATEST_SCHEMA_VERSION) {
    console.error(
      `ERROR: Database is at schema v${stamped}, but this code-context version only knows v${LATEST_SCHEMA_VERSION}.`,
    );
    console.error(
      `  It was created by a newer code-context version — update the package (npm i -g vlm-code-context-mcp@latest).`,
    );
    process.exit(1);
  }
}

let writeDb: Database.Database;
try {
  writeDb = new Database(dbPath);
  writeDb.pragma('journal_mode = WAL');
  writeDb.pragma('foreign_keys = ON');

  // Ensure schemas exist
  initSchema(writeDb);
  initScrumSchema(writeDb);
  runMigrations(writeDb, { freshDb: isFreshDb });
} catch (err) {
  slog(
    'CRITICAL',
    `dashboard: db open/migration failed db=${path.basename(dbPath)} error=${errorClass(err)}`,
  );
  throw err;
}
if (!isFreshDb && stampedBefore < LATEST_SCHEMA_VERSION) {
  slog(
    'WARN',
    `dashboard: migrations applied db=${path.basename(dbPath)} schema v${stampedBefore}→v${LATEST_SCHEMA_VERSION}`,
  );
}
const db = writeDb; // alias for backward compat — all queries use the same connection

// Seed factory defaults into empty tables (never overwrites existing data)
const seeded = seedDefaults(writeDb);
if (seeded.agents + seeded.skills > 0) {
  console.log(
    `[seed] Seeded ${seeded.agents} agents, ${seeded.skills} skills from factory defaults`,
  );
}
// Rebuild marketing stats on startup so cached values are fresh
try {
  rebuildMarketingStats();
} catch {}

/** Bench source inputs; the package root is two levels up from src|dist/dashboard. */
function benchOpts() {
  return {
    dbPath,
    packageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  };
}

// SSE clients
const sseClients = new Set<http.ServerResponse>();

function notifyClients(event?: {
  type: string;
  entityType?: string;
  entityId?: number | string;
  change?: any;
  stepProgress?: any;
  claudeOutput?: any;
  claudeStep?: any;
}) {
  const payload = event
    ? JSON.stringify({ ...event, timestamp: new Date().toISOString() })
    : JSON.stringify({ type: 'updated', timestamp: new Date().toISOString() });
  for (const res of sseClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// Watch for external DB changes (e.g. MCP tool writes)
// Use chokidar for reliable cross-platform file watching (fs.watchFile polling misses changes on some systems)
let dbWalDebounce: ReturnType<typeof setTimeout> | null = null;
const walPath = dbPath + '-wal';
{
  const dbWatcher = chokidar.watch([walPath, dbPath], {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 150,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 },
  });
  dbWatcher.on('change', () => {
    if (dbWalDebounce) clearTimeout(dbWalDebounce);
    dbWalDebounce = setTimeout(() => {
      notifyClients();
    }, 100);
  });
  // Also detect WAL file creation (first write after checkpoint)
  dbWatcher.on('add', (p) => {
    if (p.endsWith('-wal')) {
      if (dbWalDebounce) clearTimeout(dbWalDebounce);
      dbWalDebounce = setTimeout(() => {
        notifyClients();
      }, 100);
    }
  });
}

// ─── File watcher ───────────────────────────────────────────────────────────
function startWatcher(dir: string) {
  const resolved = path.resolve(dir);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = chokidar.watch(resolved, {
    ignored: [
      // The context database itself lives inside the watched tree in some
      // setups, and its -wal churns on every write.
      /\.db$/,
      /\.db-shm$/,
      /\.db-wal$/,
      // Directory policy lives in shared/ignore.ts — see the two EMFILE
      // incidents documented there before adding a pattern here.
      makeWatchIgnorePredicate(),
    ],
    ignoreInitial: true,
    persistent: true,
  });

  function scheduleReindex() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const stats = indexDirectory(writeDb, resolved);
        notifyClients();
      } catch (err: any) {
        console.error(`[watch] Re-index error: ${err.message}`);
      }
    }, 500);
  }

  watcher.on('add', scheduleReindex);
  watcher.on('change', scheduleReindex);
  watcher.on('unlink', scheduleReindex);

  watcher.on('error', (err: unknown) => {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EMFILE') {
      console.error(
        `[watch] EMFILE: too many open files. The watcher is descending into a ` +
          `directory type that src/shared/ignore.ts does not skip — most likely a ` +
          `nested checkout or a dependency directory for an ecosystem not listed there.`,
      );
    } else {
      console.error(`[watch] Watcher error: ${e?.message ?? String(err)}`);
    }
  });

  // EMFILE gives no useful stack and reads like a clean exit, so say the number
  // out loud. If the process dies right after this line, the count is the
  // diagnosis. Registered after the error handler, because an EMFILE during the
  // initial scan arrives on "error" and 'ready' never fires at all.
  watcher.on('ready', () => {
    const dirCount = Object.keys(watcher.getWatched()).length;
    if (dirCount > WATCH_DIR_WARN_THRESHOLD) {
      console.warn(
        `[watch] ${dirCount} directories watched (over ${WATCH_DIR_WARN_THRESHOLD}) — ` +
          `on macOS each one costs a kernel watch handle and EMFILE kills the process. ` +
          `Check for a directory type missing from src/shared/ignore.ts.`,
      );
    } else {
      console.log(`[watch] ${dirCount} directories watched`);
    }
  });

  console.log(`[watch] Watching ${resolved} for changes`);
}

// ─── API ─────────────────────────────────────────────────────────────────────
// Code-intel handlers (files, file-context, graph, changes, directories) live in
// ./handlers/code.ts (T-277) and are called via codeHandlers.* in the router.

function apiStats() {
  const files = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as any).c;
  const exports = (db.prepare(`SELECT COUNT(*) as c FROM exports`).get() as any).c;
  const deps = (db.prepare(`SELECT COUNT(*) as c FROM dependencies`).get() as any).c;
  const totalLines = (db.prepare(`SELECT COALESCE(SUM(line_count),0) as c FROM files`).get() as any)
    .c;
  const totalSize = (db.prepare(`SELECT COALESCE(SUM(size_bytes),0) as c FROM files`).get() as any)
    .c;
  const languages = db
    .prepare(`SELECT language, COUNT(*) as c FROM files GROUP BY language ORDER BY c DESC`)
    .all();
  const extensions = db
    .prepare(
      `SELECT extension, COUNT(*) as c FROM files GROUP BY extension ORDER BY c DESC LIMIT 15`,
    )
    .all();
  return { files, exports, deps, totalLines, totalSize, languages, extensions };
}

// ─── Skills & Agents API ────────────────────────────────────────────────────
function apiSkills() {
  try {
    return writeDb
      .prepare(`SELECT name, content, owner_role, updated_at FROM skills ORDER BY name`)
      .all();
  } catch {
    return [];
  }
}

function apiSkill(name: string) {
  try {
    return writeDb.prepare(`SELECT * FROM skills WHERE name = ?`).get(name);
  } catch {
    return null;
  }
}

// ─── Sprint Process Config API ──────────────────────────────────────────────
interface SprintPhase {
  name: string;
  criteria: string[];
  actions: string[];
  duration: string;
}

const DEFAULT_SPRINT_PHASES: SprintPhase[] = [
  {
    name: 'Planning',
    criteria: ['Sprint goal defined', 'Tickets assigned'],
    actions: ['Commit velocity'],
    duration: '1 day',
  },
  {
    name: 'Implementation',
    criteria: ['Sprint active'],
    actions: ['Start tickets', 'QA verification', 'Code reviews'],
    duration: '3-4 days',
  },
  {
    name: 'Done',
    criteria: ['Results reviewed'],
    actions: ['Sprint summary', 'Retro findings', 'Velocity review'],
    duration: '0.5 day',
  },
  { name: 'Rest', criteria: [], actions: ['Team recovery'], duration: '0.5 day' },
];

function parseSprintPhasesMarkdown(md: string): SprintPhase[] {
  const phases: SprintPhase[] = [];
  const sections = md.split(/^## /m).filter(Boolean);
  for (const section of sections) {
    const lines = section.trim().split('\n');
    const name = lines[0]?.trim() ?? '';
    if (!name) continue;
    let criteria: string[] = [];
    let actions: string[] = [];
    let duration = '';
    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      const criteriaMatch = trimmed.match(/^\*\*Entry Criteria:\*\*\s*(.+)/);
      if (criteriaMatch) {
        criteria = criteriaMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        continue;
      }
      const actionsMatch = trimmed.match(/^\*\*Auto Actions:\*\*\s*(.+)/);
      if (actionsMatch) {
        actions = actionsMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        continue;
      }
      const durationMatch = trimmed.match(/^\*\*Duration:\*\*\s*(.+)/);
      if (durationMatch) {
        duration = durationMatch[1].trim();
        continue;
      }
    }
    phases.push({ name, criteria, actions, duration });
  }
  return phases;
}

function serializeSprintPhasesToMarkdown(phases: SprintPhase[]): string {
  return phases
    .map(
      (p) =>
        `## ${p.name}\n**Entry Criteria:** ${p.criteria.join(', ')}\n**Auto Actions:** ${p.actions.join(', ')}\n**Duration:** ${p.duration}`,
    )
    .join('\n\n');
}

function apiGetSprintProcess(): { phases: any[] } {
  try {
    const jsonRow = writeDb
      .prepare(`SELECT content FROM skills WHERE name = 'SPRINT_PROCESS_JSON'`)
      .get() as { content: string } | undefined;
    if (jsonRow?.content) {
      const parsed = JSON.parse(jsonRow.content);
      if (parsed.phases?.length > 0) return parsed;
    }
    const row = writeDb.prepare(`SELECT content FROM skills WHERE name = 'SPRINT_PHASES'`).get() as
      | { content: string }
      | undefined;
    if (row?.content) {
      const phases = parseSprintPhasesMarkdown(row.content);
      if (phases.length > 0) return { phases };
    }
  } catch {}
  return { phases: DEFAULT_SPRINT_PHASES };
}

function apiPutSprintProcess(raw: unknown): { ok: boolean } {
  const phases: SprintPhase[] = parseBody(SprintProcessBody, raw).phases;
  const md = serializeSprintPhasesToMarkdown(phases);
  writeDb
    .prepare(
      `INSERT INTO skills (name, content, owner_role) VALUES ('SPRINT_PHASES', ?, 'scrum-master') ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
    )
    .run(md);
  return { ok: true };
}

function apiAgentsHealth() {
  try {
    const agents = writeDb
      .prepare(
        `
      SELECT a.role, a.name, a.description, a.model, a.department,
        (SELECT COUNT(*) FROM tickets WHERE assigned_to = a.role AND status = 'DONE' AND deleted_at IS NULL) as done_tickets,
        (SELECT COUNT(*) FROM tickets WHERE assigned_to = a.role AND status IN ('TODO','IN_PROGRESS') AND deleted_at IS NULL) as active_tickets,
        (SELECT COUNT(*) FROM tickets WHERE assigned_to = a.role AND status = 'BLOCKED' AND deleted_at IS NULL) as blocked_tickets,
        (SELECT COALESCE(SUM(story_points),0) FROM tickets WHERE assigned_to = a.role AND status IN ('TODO','IN_PROGRESS') AND deleted_at IS NULL) as active_points
      FROM agents a ORDER BY a.role
    `,
      )
      .all() as any[];
    // Compute mood: 0-100 scale from tickets + retro sentiment
    // Check if any sprint is currently active
    const hasActiveSprint = (() => {
      try {
        const row = writeDb
          .prepare(
            `SELECT 1 FROM sprints WHERE status IN ('active','in_progress') AND deleted_at IS NULL LIMIT 1`,
          )
          .get();
        return !!row;
      } catch {
        return false;
      }
    })();
    return agents.map((a: any) => {
      let mood = 50;
      if (a.done_tickets > 0) mood += Math.min(a.done_tickets * 5, 30);
      if (a.blocked_tickets > 0) mood -= a.blocked_tickets * 20;
      if (a.active_points > 8) mood -= (a.active_points - 8) * 5;
      if (hasActiveSprint && a.done_tickets === 0 && a.active_tickets === 0) mood -= 15;
      // Factor in retro sentiment — recent sprints weighted higher
      try {
        const retroPositive =
          (
            writeDb
              .prepare(
                `SELECT COUNT(*) as c FROM retro_findings WHERE role = ? AND category = 'went_well'`,
              )
              .get(a.role) as any
          )?.c || 0;
        const retroNegative =
          (
            writeDb
              .prepare(
                `SELECT COUNT(*) as c FROM retro_findings WHERE role = ? AND category = 'went_wrong'`,
              )
              .get(a.role) as any
          )?.c || 0;
        mood += Math.min(retroPositive * 2, 10); // positive retros boost mood
        mood -= Math.min(retroNegative * 3, 15); // negative retros decrease mood more
      } catch {}
      mood = Math.max(0, Math.min(100, mood));
      const emoji =
        mood >= 80 ? '😊' : mood >= 60 ? '🙂' : mood >= 40 ? '😐' : mood >= 20 ? '😟' : '😫';
      const mood_label =
        mood >= 80
          ? 'thriving'
          : mood >= 60
            ? 'good'
            : mood >= 40
              ? 'neutral'
              : mood >= 20
                ? 'stressed'
                : 'burnout';
      return { ...a, mood, mood_emoji: emoji, mood_label };
    });
  } catch {
    return [];
  }
}

// ─── Scrum API ──────────────────────────────────────────────────────────────
// Sprint/ticket/blocker/bug/retro CRUD + burndown live in ./handlers/sprint.ts
// (T-278) and are called via sprintHandlers.* in the router. They take the shared
// `db` connection (which owns the scrum schema + data) and return plain data.

// ─── Agent CRUD ────────────────────────────────────────────────────────────

function apiCreateAgent(raw: unknown) {
  const body = parseBody(AgentCreateBody, raw);
  if (body.model) validateEnum(body.model, ALLOWED_AGENT_MODELS, 'model');
  const existing = writeDb.prepare('SELECT role FROM agents WHERE role = ?').get(body.role);
  if (existing)
    throw Object.assign(new Error('agent with this role already exists'), { status: 409 });
  writeDb
    .prepare('INSERT INTO agents (role, name, description, model) VALUES (?, ?, ?, ?)')
    .run(body.role, body.name, body.description || null, body.model || DEFAULT_AGENT_MODEL);
  return {
    role: body.role,
    name: body.name,
    description: body.description || null,
    model: body.model || DEFAULT_AGENT_MODEL,
  };
}

function apiUpdateAgent(role: string, raw: unknown) {
  const body = parseBody(AgentUpdateBody, raw);
  if (body.model) validateEnum(body.model, ALLOWED_AGENT_MODELS, 'model');
  const existing = writeDb.prepare('SELECT role FROM agents WHERE role = ?').get(role);
  if (!existing) throw Object.assign(new Error('agent not found'), { status: 404 });
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (body.name !== undefined) {
    sets.push('name=?');
    vals.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push('description=?');
    vals.push(body.description);
  }
  if (body.model !== undefined) {
    sets.push('model=?');
    vals.push(body.model);
  }
  if (sets.length === 0) throw Object.assign(new Error('nothing to update'), { status: 400 });
  sets.push("updated_at=datetime('now')");
  vals.push(role);
  writeDb.prepare(`UPDATE agents SET ${sets.join(',')} WHERE role=?`).run(...vals);
  return writeDb
    .prepare('SELECT role, name, description, model FROM agents WHERE role = ?')
    .get(role);
}

function apiDeleteAgent(role: string) {
  const existing = writeDb.prepare('SELECT role FROM agents WHERE role = ?').get(role);
  if (!existing) throw Object.assign(new Error('agent not found'), { status: 404 });
  writeDb.prepare('DELETE FROM agents WHERE role = ?').run(role);
  return { ok: true };
}

// ─── Discovery CRUD ────────────────────────────────────────────────────────

function apiLinkDiscoveryToTicket(discoveryId: number, raw: unknown) {
  const body = parseBody(DiscoveryLinkBody, raw);
  const discovery = writeDb.prepare('SELECT * FROM discoveries WHERE id = ?').get(discoveryId) as
    | DiscoveryRow
    | undefined;
  if (!discovery) throw Object.assign(new Error('discovery not found'), { status: 404 });
  const ticket = writeDb
    .prepare('SELECT id, title, status FROM tickets WHERE id = ?')
    .get(body.ticket_id) as { id: number; title: string; status: string } | undefined;
  if (!ticket) throw Object.assign(new Error('ticket not found'), { status: 404 });
  const newStatus = ticket.status === 'DONE' ? 'implemented' : 'planned';
  writeDb
    .prepare(
      "UPDATE discoveries SET implementation_ticket_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(body.ticket_id, newStatus, discoveryId);
  return {
    ...discovery,
    implementation_ticket_id: body.ticket_id,
    status: newStatus,
    ticket_title: ticket.title,
  };
}

function apiUpdateDiscovery(discoveryId: number, raw: unknown) {
  const body = parseBody(DiscoveryUpdateBody, raw);
  const existing = writeDb.prepare('SELECT * FROM discoveries WHERE id = ?').get(discoveryId) as
    | DiscoveryRow
    | undefined;
  if (!existing) throw Object.assign(new Error('discovery not found'), { status: 404 });
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (body.status) {
    sets.push('status = ?');
    vals.push(body.status);
  }
  if (body.priority) {
    sets.push('priority = ?');
    vals.push(body.priority);
  }
  if (body.drop_reason) {
    sets.push('drop_reason = ?');
    vals.push(body.drop_reason);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(discoveryId);
  writeDb.prepare(`UPDATE discoveries SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return writeDb.prepare('SELECT * FROM discoveries WHERE id = ?').get(discoveryId);
}

// ─── Sprint stuck / Blocker / Bug CRUD ─────────────────────────────────────
// Migrated to ./handlers/sprint.ts (T-278): apiReportSprintStuck, apiCreateBlocker,
// apiUpdateBlocker, apiCreateBug, apiUpdateBug.

// ─── Sprint / Milestone / Epic / Ticket helpers ────────────────────────────
// Sprint lifecycle (apiDeleteSprint, apiArchiveSprint, apiUnarchiveSprint,
// apiArchiveCompletedSprints) and apiUpdateTicketMilestone migrated to
// ./handlers/sprint.ts (T-278).

function apiCreateEpic(raw: unknown) {
  const body = parseBody(EpicCreateBody, raw);
  if (body.status) validateEnum(body.status, ['planned', 'active', 'completed'], 'epic status');
  if (body.color) validateColor(body.color);
  const result = writeDb
    .prepare(
      `INSERT INTO epics (name, description, milestone_id, priority, status) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      body.name,
      body.description || null,
      body.milestone_id || null,
      body.priority ?? 0,
      body.status || 'planned',
    );
  return { id: result.lastInsertRowid, name: body.name };
}

function apiUpdateEpic(epicId: number, raw: unknown) {
  const body = parseBody(EpicUpdateBody, raw);
  if (body.status) validateEnum(body.status, ['planned', 'active', 'completed'], 'epic status');
  if (body.color) validateColor(body.color);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (body.name) {
    sets.push('name=?');
    vals.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push('description=?');
    vals.push(body.description);
  }
  if (body.milestone_id !== undefined) {
    sets.push('milestone_id=?');
    vals.push(body.milestone_id);
  }
  if (body.priority) {
    sets.push('priority=?');
    vals.push(body.priority);
  }
  if (body.status) {
    sets.push('status=?');
    vals.push(body.status);
  }
  if (sets.length === 0) throw Object.assign(new Error('nothing to update'), { status: 400 });
  sets.push("updated_at=datetime('now')");
  vals.push(epicId);
  writeDb.prepare(`UPDATE epics SET ${sets.join(',')} WHERE id=?`).run(...vals);
  return { id: epicId, updated: true };
}

function apiUpdateSprintMilestone(sprintId: number, raw: unknown) {
  const body = parseBody(MilestoneLinkBody, raw);
  writeDb
    .prepare("UPDATE sprints SET milestone_id=?, updated_at=datetime('now') WHERE id=?")
    .run(body.milestone_id ?? null, sprintId);
  return { ok: true };
}

function apiUpdateTicketEpic(ticketId: number, raw: unknown) {
  const body = parseBody(EpicLinkBody, raw);
  writeDb
    .prepare("UPDATE tickets SET epic_id=?, updated_at=datetime('now') WHERE id=?")
    .run(body.epic_id ?? null, ticketId);
  return { ok: true };
}

function apiDeleteMilestone(milestoneId: number) {
  const existing = writeDb
    .prepare('SELECT id FROM milestones WHERE id = ? AND deleted_at IS NULL')
    .get(milestoneId);
  if (!existing) throw Object.assign(new Error('milestone not found'), { status: 404 });
  writeDb
    .prepare("UPDATE milestones SET deleted_at = datetime('now') WHERE id = ?")
    .run(milestoneId);
  return { ok: true };
}

function apiDeleteEpic(epicId: number) {
  const existing = writeDb
    .prepare('SELECT id FROM epics WHERE id = ? AND deleted_at IS NULL')
    .get(epicId);
  if (!existing) throw Object.assign(new Error('epic not found'), { status: 404 });
  writeDb.prepare("UPDATE epics SET deleted_at = datetime('now') WHERE id = ?").run(epicId);
  return { ok: true };
}

function apiTrash() {
  return {
    milestones: writeDb.prepare('SELECT * FROM milestones WHERE deleted_at IS NOT NULL').all(),
    sprints: writeDb.prepare('SELECT * FROM sprints WHERE deleted_at IS NOT NULL').all(),
    epics: writeDb.prepare('SELECT * FROM epics WHERE deleted_at IS NOT NULL').all(),
    tickets: writeDb.prepare('SELECT * FROM tickets WHERE deleted_at IS NOT NULL').all(),
  };
}

function apiActivity() {
  try {
    return writeDb.prepare(`SELECT * FROM event_log ORDER BY created_at DESC LIMIT 50`).all();
  } catch {
    return [];
  }
}

function apiHealth() {
  const agentCount = (writeDb.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c;
  const skillCount = (writeDb.prepare('SELECT COUNT(*) as c FROM skills').get() as any).c;

  // Get build hash from git or package.json version
  let buildHash = 'unknown';
  let lastBuildTime: string | null = null;

  try {
    // Try to get git commit hash
    try {
      buildHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      // Fallback to package.json version
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        buildHash = pkg.version || 'unknown';
      }
    }
  } catch {
    // If all else fails, use "unknown"
  }

  // Try to get last build time from dist directory
  try {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      const stats = fs.statSync(distPath);
      lastBuildTime = stats.mtime.toISOString();
    }
  } catch {
    // Ignore if dist doesn't exist
  }

  return {
    agentCount,
    skillCount,
    buildHash,
    lastBuildTime,
  };
}

// ─── Bridge API helpers ────────────────────────────────────────────────────

function apiBridgeActions(status: string) {
  return writeDb
    .prepare('SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at DESC LIMIT 50')
    .all(status);
}

// Ceremony actions (run_kickoff, run_retro, run_review) remain in this allow list so the
// dashboard UI can queue them. However, the terminal bridge hook (src/bridge/hook.ts) filters
// them out — ceremonies are UI-only and never forwarded to the CLI.
const ALLOWED_BRIDGE_ACTIONS = [
  'advance_sprint',
  'assign_ticket',
  'update_ticket',
  'create_ticket',
  'run_retro',
  'run_review',
  'run_kickoff',
  'plan_sprint',
  'custom',
  'request_input',
];

function apiCreateBridgeAction(body: z.infer<typeof BridgeActionBody>) {
  if (!ALLOWED_BRIDGE_ACTIONS.includes(body.action)) {
    throw Object.assign(
      new Error(`unknown action. Allowed: ${ALLOWED_BRIDGE_ACTIONS.join(', ')}`),
      { status: 400 },
    );
  }
  const result = writeDb
    .prepare(
      `INSERT INTO pending_actions (action, entity_type, entity_id, payload, source) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      body.action,
      body.entity_type ?? null,
      body.entity_id ?? null,
      body.payload ? JSON.stringify(body.payload) : null,
      body.source ?? 'dashboard',
    );
  return { ok: true, id: result.lastInsertRowid };
}

function apiBridgeStatus() {
  return {
    pending: (
      writeDb
        .prepare("SELECT COUNT(*) as c FROM pending_actions WHERE status = 'pending'")
        .get() as any
    ).c,
    claimed: (
      writeDb
        .prepare("SELECT COUNT(*) as c FROM pending_actions WHERE status = 'claimed'")
        .get() as any
    ).c,
    completed: (
      writeDb
        .prepare("SELECT COUNT(*) as c FROM pending_actions WHERE status = 'completed'")
        .get() as any
    ).c,
    failed: (
      writeDb
        .prepare("SELECT COUNT(*) as c FROM pending_actions WHERE status = 'failed'")
        .get() as any
    ).c,
  };
}

// ─── Sprint process & gates ────────────────────────────────────────────────

function apiSprintProcessMarkdown() {
  const processRow = writeDb
    .prepare("SELECT content FROM skills WHERE name = 'SPRINT_PROCESS_JSON'")
    .get() as any;
  if (!processRow?.content)
    return { markdown: 'No sprint process config found. Use reset_sprint_process MCP tool.' };
  try {
    const config = JSON.parse(processRow.content);
    const lines = ['# Sprint Process (Auto-Generated from DB)\n'];
    for (const phase of config.phases || []) {
      lines.push(`## ${phase.name} (${phase.duration || 'TBD'})`);
      if (phase.ceremonies?.length) lines.push(`**Ceremonies:** ${phase.ceremonies.join(', ')}`);
      if (phase.criteria?.length) {
        lines.push('**Gate Criteria:**');
        phase.criteria.forEach((c: string) => lines.push(`- ${c}`));
      }
      lines.push('');
    }
    return { markdown: lines.join('\n') };
  } catch {
    return { markdown: 'Error parsing sprint process config' };
  }
}

function apiSprintGates(sprintId: number) {
  const sprint = writeDb
    .prepare('SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL')
    .get(sprintId) as any;
  if (!sprint) throw Object.assign(new Error('sprint not found'), { status: 404 });
  const tickets = writeDb
    .prepare('SELECT * FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL')
    .all(sprintId) as any[];
  const retroCount = (
    writeDb
      .prepare('SELECT COUNT(*) as c FROM retro_findings WHERE sprint_id = ?')
      .get(sprintId) as any
  ).c;

  const TRANSITIONS: Record<string, string> = {
    preparation: 'kickoff',
    kickoff: 'planning',
    planning: 'implementation',
    implementation: 'qa',
    qa: 'retro',
    refactoring: 'retro',
    retro: 'review',
    review: 'closed',
    closed: 'rest',
  };
  const nextPhase = TRANSITIONS[sprint.status] || null;
  const gates: { gate: string; passed: boolean; detail: string }[] = [];

  if (nextPhase === 'implementation') {
    gates.push({
      gate: 'tickets_assigned',
      passed: tickets.length > 0,
      detail: `${tickets.length} tickets`,
    });
  }
  if (nextPhase === 'qa' || sprint.status === 'implementation') {
    const undone = tickets.filter((t: any) => !['DONE', 'BLOCKED', 'NOT_DONE'].includes(t.status));
    gates.push({
      gate: 'all_tickets_done',
      passed: undone.length === 0,
      detail: `${undone.length} undone`,
    });
  }
  if (nextPhase === 'closed' || sprint.status === 'review') {
    const noQA = tickets.filter((t: any) => t.status === 'DONE' && !t.qa_verified);
    gates.push({
      gate: 'qa_verified',
      passed: noQA.length === 0,
      detail: `${noQA.length} unverified`,
    });
    gates.push({
      gate: 'velocity_set',
      passed: !!sprint.velocity_completed,
      detail: sprint.velocity_completed ? `${sprint.velocity_completed}pt` : 'not set',
    });
  }
  if (nextPhase === 'rest' || sprint.status === 'closed') {
    gates.push({
      gate: 'retro_findings',
      passed: retroCount > 0,
      detail: `${retroCount} findings`,
    });
  }

  return {
    sprint_id: sprintId,
    phase: sprint.status,
    next_phase: nextPhase,
    gates,
    all_passed: gates.every((g) => g.passed),
  };
}

// ─── Discoveries ───────────────────────────────────────────────────────────

function apiDiscoveries(
  sprintId?: number,
  status?: string,
  category?: string,
  excludeStatus?: string,
) {
  try {
    let sql = `SELECT d.*, s.name as sprint_name, s.status as sprint_status, t.title as ticket_title, t.status as ticket_status
      FROM discoveries d
      JOIN sprints s ON d.discovery_sprint_id = s.id
      LEFT JOIN tickets t ON d.implementation_ticket_id = t.id
      WHERE 1=1`;
    const params: any[] = [];
    if (sprintId) {
      sql += ' AND d.discovery_sprint_id = ?';
      params.push(sprintId);
    }
    if (status) {
      sql += ' AND d.status = ?';
      params.push(status);
    }
    if (excludeStatus) {
      const excluded = excludeStatus
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      sql += ` AND d.status NOT IN (${excluded.map(() => '?').join(',')})`;
      params.push(...excluded);
    }
    if (category) {
      sql += ' AND d.category = ?';
      params.push(category);
    }
    sql += ' ORDER BY s.created_at DESC, d.priority, d.created_at';
    return writeDb.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function apiDiscoveryCoverage(sprintId?: number) {
  try {
    let sql = `SELECT status, COUNT(*) as count FROM discoveries WHERE 1=1`;
    const params: any[] = [];
    if (sprintId) {
      sql += ' AND discovery_sprint_id = ?';
      params.push(sprintId);
    }
    sql += ' GROUP BY status';
    const rows = writeDb.prepare(sql).all(...params) as any[];
    const total = rows.reduce((sum: number, r: any) => sum + r.count, 0);
    const counts: Record<string, number> = {
      discovered: 0,
      planned: 0,
      implemented: 0,
      dropped: 0,
    };
    rows.forEach((r: any) => {
      counts[r.status] = r.count;
    });
    return { total, ...counts };
  } catch {
    return { total: 0, discovered: 0, planned: 0, implemented: 0, dropped: 0 };
  }
}

function apiDiscoverySprintList() {
  try {
    return writeDb
      .prepare(
        `
      SELECT DISTINCT s.id, s.name FROM sprints s
      JOIN discoveries d ON d.discovery_sprint_id = s.id
      ORDER BY s.created_at DESC
    `,
      )
      .all();
  } catch {
    return [];
  }
}

function apiSprintsGroupedByMilestone() {
  try {
    const milestones = writeDb
      .prepare(
        `
      SELECT m.*,
        (SELECT COUNT(*) FROM tickets WHERE milestone_id = m.id AND deleted_at IS NULL) as ticket_count,
        (SELECT COUNT(*) FROM tickets WHERE milestone_id = m.id AND status = 'DONE' AND deleted_at IS NULL) as done_count
      FROM milestones m WHERE m.deleted_at IS NULL
      ORDER BY CASE m.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, m.created_at DESC
    `,
      )
      .all() as any[];

    const sprintQuery = writeDb.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND deleted_at IS NULL) as ticket_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE' AND deleted_at IS NULL) as done_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND qa_verified = 1 AND deleted_at IS NULL) as qa_count,
        (SELECT COUNT(*) FROM retro_findings WHERE sprint_id = s.id) as retro_count,
        (SELECT COUNT(*) FROM blockers WHERE sprint_id = s.id AND status = 'open') as open_blockers
      FROM sprints s
      WHERE s.milestone_id = ? AND s.deleted_at IS NULL
      ORDER BY CASE s.status WHEN 'implementation' THEN 0 WHEN 'planning' THEN 1 WHEN 'qa' THEN 2 WHEN 'retro' THEN 3 ELSE 4 END, s.created_at DESC
    `);

    const unassignedQuery = writeDb.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND deleted_at IS NULL) as ticket_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE' AND deleted_at IS NULL) as done_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND qa_verified = 1 AND deleted_at IS NULL) as qa_count,
        (SELECT COUNT(*) FROM retro_findings WHERE sprint_id = s.id) as retro_count,
        (SELECT COUNT(*) FROM blockers WHERE sprint_id = s.id AND status = 'open') as open_blockers
      FROM sprints s
      WHERE s.milestone_id IS NULL AND s.deleted_at IS NULL
      ORDER BY CASE s.status WHEN 'implementation' THEN 0 WHEN 'planning' THEN 1 WHEN 'qa' THEN 2 WHEN 'retro' THEN 3 ELSE 4 END, s.created_at DESC
    `);

    const groups = milestones.map((m: any) => ({
      milestone: m,
      sprints: sprintQuery.all(m.id),
    }));

    const unassigned = unassignedQuery.all();
    if (unassigned.length > 0) {
      groups.push({ milestone: null, sprints: unassigned });
    }

    return groups;
  } catch {
    return [];
  }
}

// ─── Milestones, Vision, Backlog, Sprint Planning API ────────────────────────
function apiMilestones() {
  try {
    const milestones = writeDb
      .prepare(
        `
      SELECT m.*,
        (SELECT COUNT(*) FROM tickets WHERE milestone_id = m.id AND deleted_at IS NULL) as ticket_count,
        (SELECT COUNT(*) FROM tickets WHERE milestone_id = m.id AND status = 'DONE' AND deleted_at IS NULL) as done_count
      FROM milestones m WHERE m.deleted_at IS NULL ORDER BY m.id ASC
    `,
      )
      .all() as any[];

    const sprintQuery = writeDb.prepare(`
      SELECT DISTINCT s.id, s.name, s.status, s.velocity_committed, s.velocity_completed,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id) as ticket_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE') as done_count
      FROM sprints s INNER JOIN tickets t ON t.sprint_id = s.id AND t.milestone_id = ?
      ORDER BY s.created_at ASC
    `);

    return milestones.map((m: any) => ({
      ...m,
      sprints: sprintQuery.all(m.id),
    }));
  } catch (e) {
    console.error('[api] apiMilestones error:', e);
    return [];
  }
}

function apiCreateMilestone(raw: unknown) {
  const { name, description, target_date, status } = parseBody(MilestoneCreateBody, raw);
  if (status) validateEnum(status, ['planned', 'active', 'completed'], 'milestone status');
  const result = writeDb
    .prepare(`INSERT INTO milestones (name, description, target_date, status) VALUES (?, ?, ?, ?)`)
    .run(name, description || null, target_date || null, status || 'planned');
  // The saved row (#199); `id` and `name` keep the old response keys.
  return writeDb
    .prepare(`SELECT * FROM milestones WHERE id = ?`)
    .get(result.lastInsertRowid) as MilestoneRow;
}

function apiMilestoneUpdate(id: number, raw: unknown) {
  const body = parseBody(MilestoneUpdateBody, raw);
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (body.status) {
    validateEnum(body.status, ['planned', 'active', 'completed'], 'milestone status');
    sets.push('status=?');
    vals.push(body.status);
  }
  if (body.description) {
    sets.push('description=?');
    vals.push(body.description);
  }
  if (body.progress !== undefined) {
    sets.push('progress=?');
    vals.push(body.progress);
  }
  if (body.target_date) {
    sets.push('target_date=?');
    vals.push(body.target_date);
  }
  if (sets.length === 0) throw new Error('nothing to update');
  sets.push("updated_at=datetime('now')");
  vals.push(id);
  writeDb.prepare(`UPDATE milestones SET ${sets.join(',')} WHERE id=?`).run(...vals);
  return { id, updated: true };
}

function apiVisionUpdate(raw: unknown) {
  const { content } = parseBody(VisionBody, raw);
  writeDb
    .prepare(
      `INSERT INTO skills (name, content, owner_role) VALUES ('PRODUCT_VISION', ?, 'product-owner') ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
    )
    .run(content);
  return { updated: true };
}

function apiBacklog() {
  try {
    return writeDb
      .prepare(
        `
      SELECT t.id, t.ticket_ref, t.title, t.priority, t.status, t.story_points, t.assigned_to, t.milestone, t.milestone_id,
        m.name as milestone_name
      FROM tickets t
      LEFT JOIN milestones m ON t.milestone_id = m.id
      WHERE t.deleted_at IS NULL
        AND (t.sprint_id IS NULL
          OR (t.status IN ('TODO','NOT_DONE') AND t.sprint_id IN (SELECT id FROM sprints WHERE status IN ('closed','rest'))))
      ORDER BY t.priority, t.created_at
    `,
      )
      .all();
  } catch {
    return [];
  }
}

function apiEpics(milestoneId?: number) {
  try {
    let sql = `SELECT e.*,
      (SELECT COUNT(*) FROM tickets WHERE epic_id = e.id AND deleted_at IS NULL) as ticket_count,
      (SELECT COUNT(*) FROM tickets WHERE epic_id = e.id AND status = 'DONE' AND deleted_at IS NULL) as done_count
    FROM epics e WHERE e.deleted_at IS NULL`;
    if (milestoneId) {
      sql += ` AND e.milestone_id = ?`;
      return writeDb.prepare(sql + ' ORDER BY e.priority, e.name').all(milestoneId);
    }
    return writeDb.prepare(sql + ' ORDER BY e.priority, e.name').all();
  } catch {
    return [];
  }
}

// ─── Sprint planning / advance / update + Ticket CRUD ───────────────────────
// Migrated to ./handlers/sprint.ts (T-278): apiPlanSprint, apiAdvanceSprint,
// verifyPhaseGate, apiSprintUpdate, apiCreateTicket, apiUpdateTicket, and the
// full-field PATCH family (apiPatchTicket + assignment helpers). The router
// rebuilds marketing stats after apiSprintUpdate when it reports marketingDirty.

function rebuildMarketingStats() {
  try {
    const closedSprints = (
      writeDb
        .prepare(
          "SELECT COUNT(*) as c FROM sprints WHERE status IN ('closed','rest') AND deleted_at IS NULL",
        )
        .get() as any
    ).c;
    const doneTickets = (
      writeDb
        .prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'DONE' AND deleted_at IS NULL")
        .get() as any
    ).c;
    const totalVelocity = (
      writeDb
        .prepare(
          "SELECT COALESCE(SUM(velocity_completed), 0) as c FROM sprints WHERE status IN ('closed','rest') AND deleted_at IS NULL",
        )
        .get() as any
    ).c;
    const agentCount = (writeDb.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c;
    const milestoneCount = (writeDb.prepare('SELECT COUNT(*) as c FROM milestones').get() as any).c;
    const toolCount = TOOL_COUNT;

    // Enhanced stats: velocity trend for last 10 closed sprints
    const velocityTrendRows = writeDb
      .prepare(
        `SELECT name, velocity_completed FROM sprints WHERE status IN ('closed','rest') ORDER BY created_at DESC LIMIT 10`,
      )
      .all() as any[];
    const velocity_trend = velocityTrendRows.reverse().map((r: any) => ({
      sprint_name: r.name,
      velocity: r.velocity_completed ?? 0,
    }));

    // Enhanced stats: avg completion rate across closed sprints
    const completionRows = writeDb
      .prepare(
        `
      SELECT s.id,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE') as done_c,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id) as total_c
      FROM sprints s WHERE s.status IN ('closed','rest')
    `,
      )
      .all() as any[];
    const completionRates = completionRows
      .filter((r: any) => r.total_c > 0)
      .map((r: any) => (r.done_c / r.total_c) * 100);
    const avg_completion_rate =
      completionRates.length > 0
        ? Math.round(
            (completionRates.reduce((a: number, b: number) => a + b, 0) / completionRates.length) *
              10,
          ) / 10
        : 0;

    // Enhanced stats: peak and average velocity
    const velocityRows = writeDb
      .prepare(
        `SELECT velocity_completed FROM sprints WHERE status IN ('closed','rest') AND velocity_completed IS NOT NULL`,
      )
      .all() as any[];
    const velocities = velocityRows.map((r: any) => r.velocity_completed ?? 0);
    const peak_velocity = velocities.length > 0 ? Math.max(...velocities) : 0;
    const avg_velocity =
      velocities.length > 0
        ? Math.round(
            (velocities.reduce((a: number, b: number) => a + b, 0) / velocities.length) * 10,
          ) / 10
        : 0;

    const stats = JSON.stringify({
      closed_sprints: closedSprints,
      done_tickets: doneTickets,
      total_velocity: totalVelocity,
      agent_count: agentCount,
      milestone_count: milestoneCount,
      tool_count: toolCount,
      velocity_trend,
      avg_completion_rate,
      peak_velocity,
      avg_velocity,
      version: PKG_VERSION,
      updated_at: new Date().toISOString(),
    });

    writeDb
      .prepare(
        `INSERT INTO skills (name, content, owner_role) VALUES ('MARKETING_STATS', ?, 'scrum-master')
       ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
      )
      .run(stats);
  } catch (err: any) {
    console.error(`[marketing] Failed to rebuild stats: ${err.message}`);
  }
}

// ─── Dump / Restore / Project Status API ────────────────────────────────────
function apiDump() {
  const allTables = [
    'agents',
    'sprints',
    'tickets',
    'subtasks',
    'retro_findings',
    'blockers',
    'bugs',
    'skills',
    'processes',
    'milestones',
    'epics',
    'files',
    'exports',
    'dependencies',
    'directories',
    'changes',
  ];
  const dump: Record<string, any[]> = {};
  for (const table of allTables) {
    try {
      if (table === 'files') {
        dump[table] = writeDb
          .prepare(
            `SELECT id, path, language, extension, size_bytes, line_count, summary, description, external_imports, created_at, modified_at, indexed_at FROM files`,
          )
          .all();
      } else {
        dump[table] = writeDb.prepare(`SELECT * FROM ${table}`).all();
      }
    } catch {}
  }
  return { version: PKG_VERSION, exported_at: new Date().toISOString(), tables: dump };
}

async function apiRestore(raw: unknown) {
  const parsed = RestoreBody.safeParse(raw);
  if (!parsed.success || !parsed.data.version) return { error: 'Invalid dump format' };
  const body = parsed.data;

  const order = [
    'milestones',
    'epics',
    'agents',
    'skills',
    'processes',
    'sprints',
    'tickets',
    'subtasks',
    'retro_findings',
    'blockers',
    'bugs',
    'files',
    'exports',
    'dependencies',
    'directories',
    'changes',
  ];

  // Build column whitelist per table from schema
  const schemaColumns = new Map<string, Set<string>>();
  for (const table of order) {
    const info = writeDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    schemaColumns.set(table, new Set(info.map((c) => c.name)));
  }

  const results: Record<string, number> = {};
  const transaction = writeDb.transaction(() => {
    for (const table of order) {
      const rows = body.tables[table];
      if (!rows || !Array.isArray(rows) || rows.length === 0) continue;
      if (
        !rows.every(
          (r): r is Record<string, unknown> =>
            r !== null && typeof r === 'object' && !Array.isArray(r),
        )
      ) {
        throw Object.assign(new Error(`restore: every row of ${table} must be an object`), {
          status: 400,
        });
      }
      const validCols = schemaColumns.get(table);
      if (!validCols) continue;
      // Only accept columns that exist in the schema
      const cols = Object.keys(rows[0]).filter((c) => validCols.has(c));
      if (cols.length === 0) continue;
      const stmt = writeDb.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      );
      let count = 0;
      for (const row of rows) {
        stmt.run(
          ...cols.map((c: string) => (row[c] ?? null) as string | number | bigint | Buffer | null),
        );
        count++;
      }
      results[table] = count;
    }
  });
  transaction();

  return { ok: true, restored: results };
}

function apiProjectStatus() {
  const fileCount = (writeDb.prepare('SELECT COUNT(*) as c FROM files').get() as any).c;
  const agentCount = (writeDb.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c;
  const sprintCount = (writeDb.prepare('SELECT COUNT(*) as c FROM sprints').get() as any).c;
  const ticketCount = (writeDb.prepare('SELECT COUNT(*) as c FROM tickets').get() as any).c;
  const skillCount = (writeDb.prepare('SELECT COUNT(*) as c FROM skills').get() as any).c;
  const milestoneCount = (writeDb.prepare('SELECT COUNT(*) as c FROM milestones').get() as any).c;

  // Read cached marketing stats for tool count + version
  let toolCount = TOOL_COUNT;
  let version = PKG_VERSION;
  try {
    const mktg = writeDb
      .prepare("SELECT content FROM skills WHERE name = 'MARKETING_STATS'")
      .get() as any;
    if (mktg?.content) {
      const parsed = JSON.parse(mktg.content);
      if (parsed.tool_count) toolCount = parsed.tool_count;
      if (parsed.version) version = parsed.version;
    }
  } catch {}

  return {
    initialized: fileCount > 0,
    files: fileCount,
    agents: agentCount,
    sprints: sprintCount,
    tickets: ticketCount,
    skills: skillCount,
    milestones: milestoneCount,
    toolCount,
    version,
  };
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

/** Body read error with the HTTP status to answer (400 bad JSON, 413 too large). */
class BodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        // Stop reading; the caller answers 413 and closes the connection.
        done = true;
        req.pause();
        reject(new BodyError('Request body too large', 413));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new BodyError('Invalid JSON body', 400));
      }
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

/** Read a JSON body that must be an object (not null, an array or a scalar). */
async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body: unknown = await readBody(req);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BodyError('JSON body must be an object', 400);
  }
  return body as Record<string, unknown>;
}

/**
 * Answer a failed request without stopping the process. A BodyError gets its
 * 400/413; anything else is a 500. After a 413 the unread rest of the upload
 * is not drained, so the connection is closed once the answer is sent (or
 * after 5 s when the peer never takes the answer).
 */
function sendRequestError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  e: unknown,
  pathname: string,
): void {
  const status = e instanceof BodyError ? e.status : 500;
  const routePath = pathname.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 120);
  slog(
    status >= 500 ? 'CRITICAL' : 'WARN',
    `dashboard: request failed status=${status} method=${req.method} path=${routePath} error=${errorClass(e)}`,
  );
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
  if (status === 413) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(
    JSON.stringify({ ok: false, error: e instanceof BodyError ? e.message : 'internal error' }),
  );
  if (status === 413) {
    // Close once the answer is sent; a peer that never reads it is cut off after 5 s.
    const timer = setTimeout(() => req.socket.destroy(), 5000);
    timer.unref();
    res.on('finish', () => {
      clearTimeout(timer);
      req.socket.destroy();
    });
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────
// Shared bearer token for /api/* (#15b). Auto-generated + persisted if unset.
const DASHBOARD_TOKEN = resolveDashboardToken();

/** Inject the dashboard token into served HTML so the same-origin app can read it. */
function injectToken(html: string): string {
  const tag = `<script>window.__DASHBOARD_TOKEN__=${JSON.stringify(DASHBOARD_TOKEN)};</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
}

const server = http.createServer((req, res) => {
  // Outer guard (#188): an async handler error must answer the request, never
  // become an unhandled rejection that stops the dashboard for every client.
  handleRequest(req, res).catch((e) => {
    try {
      sendRequestError(req, res, e, (req.url ?? '/').split('?')[0]);
    } catch {
      res.destroy();
    }
  });
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // DNS-rebinding guard: the server binds 127.0.0.1, so every peer is local —
  // what matters is the hostname the browser thinks it is talking to.
  if (!isAllowedHost(req.headers.host, req.socket.localPort ?? PORT)) {
    logRejected(421, 'host-not-loopback', req.method, url.pathname);
    res.writeHead(421, { 'Content-Type': 'application/json' });
    res.end('{"error":"misdirected request: Host must be localhost"}');
    return;
  }
  if (!isAllowedOrigin(req.method, req.headers.origin)) {
    logRejected(403, 'cross-origin-write', req.method, url.pathname);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"forbidden: cross-origin write"}');
    return;
  }

  // Security headers on all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:' + PORT);

  // Bearer-token auth on all /api/* routes (#15b); page + assets stay public so
  // the browser can load the app and read the injected token.
  if (!isAuthorized(req, url, DASHBOARD_TOKEN)) {
    // Path only — never the query string (EventSource sends ?token=).
    logRejected(401, 'missing-or-invalid-token', req.method, url.pathname);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"unauthorized: missing or invalid dashboard token"}');
    return;
  }

  // MCP→Dashboard notification endpoint (called by MCP tools after DB writes)
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    notifyClients();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // MCP→Dashboard typed event endpoint (sends specific SSE event like input_requested)
  if (url.pathname === '/api/notify/event' && req.method === 'POST') {
    let body: Record<string, any>;
    try {
      body = await readJsonObject(req);
    } catch (e) {
      sendRequestError(req, res, e, url.pathname);
      return;
    }
    if (body.type) {
      notifyClients({
        type: body.type,
        entityType: body.entityType,
        entityId: body.entityId,
        change: body.change,
        stepProgress: body.stepProgress,
        claudeOutput: body.claudeOutput,
        claudeStep: body.claudeStep,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // SSE endpoint for live updates
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send a JSON 'updated' event immediately so the frontend triggers a full data refresh on connect.
    // (Plain text 'connected' was ignored by the frontend, causing stale data on initial load.)
    const connectPayload = JSON.stringify({ type: 'updated', timestamp: new Date().toISOString() });
    res.write(`data: ${connectPayload}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Claude output streaming endpoint — MCP tools POST text chunks here to stream into the wizard
  if (url.pathname === '/api/claude-output' && req.method === 'POST') {
    let body: Record<string, any>;
    try {
      body = await readJsonObject(req);
    } catch (e) {
      sendRequestError(req, res, e, url.pathname);
      return;
    }
    if (body.text) {
      notifyClients({
        type: 'claude_output',
        claudeOutput: {
          text: String(body.text).slice(0, 5000),
          type: body.lineType || 'text',
          step: body.step || undefined,
        },
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Claude step status endpoint — MCP tools POST step transitions here
  if (url.pathname === '/api/claude-step' && req.method === 'POST') {
    let body: Record<string, any>;
    try {
      body = await readJsonObject(req);
    } catch (e) {
      sendRequestError(req, res, e, url.pathname);
      return;
    }
    if (body.name) {
      notifyClients({
        type: 'claude_step',
        claudeStep: {
          name: String(body.name),
          status: body.status || 'in_progress',
          title: body.title || undefined,
          description: body.description || undefined,
        },
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Health check endpoint (no auth required for monitoring)
  if (url.pathname === '/health' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const data = apiHealth();
    res.writeHead(200);
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    try {
      let data: any;
      if (url.pathname === '/api/files') data = codeHandlers.apiFiles(db);
      else if (url.pathname === '/api/directories') data = codeHandlers.apiDirectories(db);
      else if (url.pathname === '/api/stats') data = apiStats();
      else if (url.pathname === '/api/graph') data = codeHandlers.apiGraph(db);
      else if (url.pathname === '/api/changes')
        data = codeHandlers.apiChanges(db, Number(url.searchParams.get('limit') ?? 100));
      else if (url.pathname === '/api/skills') data = apiSkills();
      else if (url.pathname.startsWith('/api/skill/')) {
        const skillName = decodeURIComponent(url.pathname.slice('/api/skill/'.length));
        data = apiSkill(skillName);
        if (!data) {
          res.writeHead(404);
          res.end('{"error":"skill not found"}');
          return;
        }
      } else if (url.pathname === '/api/agents' && req.method === 'POST') {
        const body = await readBody(req);
        data = apiCreateAgent(body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/agent\/[^/]+$/) && req.method === 'PUT') {
        const role = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
        const body = await readBody(req);
        data = apiUpdateAgent(role, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/agent\/[^/]+$/) && req.method === 'DELETE') {
        const role = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
        data = apiDeleteAgent(role);
        notifyClients();
      } else if (url.pathname === '/api/agents') data = apiAgentsHealth();
      else if (url.pathname === '/api/milestones' && req.method === 'POST') {
        const body = await readBody(req);
        data = apiCreateMilestone(body);
        notifyClients();
      } else if (url.pathname === '/api/milestones') data = apiMilestones();
      // Milestone / epic archive (v24) — same eligibility + audit as MCP update_milestone/update_epic
      else if (
        url.pathname.match(/^\/api\/(milestone|epic)\/\d+\/(archive|unarchive)$/) &&
        req.method === 'POST'
      ) {
        const [, , kind, idStr, verb] = url.pathname.split('/');
        const entity = kind as ArchivableEntity;
        const id = Number(idStr);
        data =
          verb === 'archive'
            ? archiveEntity(db, entity, id, { actor: 'dashboard' })
            : unarchiveEntity(db, entity, id, { actor: 'dashboard' });
        slog(
          'INFO',
          `dashboard: ${verb}d ${entity}=${id} changed=${(data as { changed: boolean }).changed}`,
        );
        notifyClients();
      } else if (url.pathname.match(/^\/api\/milestone\/\d+$/) && req.method === 'PUT') {
        const mid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = apiMilestoneUpdate(mid, body);
        notifyClients();
      } else if (url.pathname === '/api/vision' && req.method === 'PUT') {
        const body = await readBody(req);
        data = apiVisionUpdate(body);
        notifyClients();
      } else if (url.pathname === '/api/activity') data = apiActivity();
      else if (url.pathname === '/api/comparison') {
        const compPath = path.join(path.dirname(dbPath), 'comparison.json');
        const bundledPath = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../comparison.json',
        );
        try {
          const filePath = fs.existsSync(compPath) ? compPath : bundledPath;
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
          data = { meta: null, tasks: [] };
        }
      } else if (url.pathname === '/api/benchmark') {
        const projDir = path.dirname(dbPath);
        const benchPath = path.join(projDir, 'benchmark-results.json');
        const bundledBench = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../benchmark-results.json',
        );
        try {
          const filePath = fs.existsSync(benchPath) ? benchPath : bundledBench;
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
          data = null;
        }
      } else if (url.pathname === '/api/benchmark-stochastic') {
        const projDir = path.dirname(dbPath);
        const stochPath = path.join(projDir, 'benchmark-stochastic-results.json');
        const bundledStoch = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../benchmark-stochastic-results.json',
        );
        try {
          const filePath = fs.existsSync(stochPath) ? stochPath : bundledStoch;
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
          data = null;
        }
      }
      // Real bench runs (ccc-bench/1); source resolution lives in handlers/bench.ts.
      else if (url.pathname === '/api/bench/index') {
        data = await benchHandlers.apiBenchIndex(benchOpts());
      } else if (url.pathname.startsWith('/api/bench/run/')) {
        let runId: string;
        try {
          runId = decodeURIComponent(url.pathname.slice('/api/bench/run/'.length));
        } catch {
          throw new benchHandlers.BenchError('invalid run id', 400);
        }
        // ?suite=<key> selects a private suite dir (CODE_CONTEXT_BENCH_PRIVATE_DIRS).
        data = await benchHandlers.apiBenchRun(benchOpts(), runId, url.searchParams.get('suite'));
      } else if (url.pathname === '/api/token-usage') {
        try {
          data = writeDb
            .prepare(`SELECT * FROM token_usage ORDER BY created_at DESC LIMIT 100`)
            .all();
        } catch {
          data = [];
        }
      } else if (url.pathname === '/api/backlog') data = apiBacklog();
      else if (url.pathname === '/api/sprints/plan' && req.method === 'POST') {
        const body = await readBody(req);
        data = sprintHandlers.apiPlanSprint(db, body);
        notifyClients();
      } else if (url.pathname === '/api/sprints/archive-completed' && req.method === 'POST') {
        data = sprintHandlers.apiArchiveCompletedSprints(db);
        slog(
          'INFO',
          `dashboard: archived completed sprints count=${(data as { archived?: number }).archived ?? 0}`,
        );
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/advance$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiAdvanceSprint(db, sid);
        slog(
          'INFO',
          `dashboard: sprint=${sid} phase ${(data as { from?: string }).from ?? '?'}→${(data as { to?: string }).to ?? '?'}`,
        );
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/archive$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiArchiveSprint(db, sid);
        slog('INFO', `dashboard: archived sprint=${sid} count=1`);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/unarchive$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiUnarchiveSprint(db, sid);
        notifyClients();
      } else if (url.pathname === '/api/retro/all') data = sprintHandlers.apiAllRetroFindings(db);
      else if (url.pathname === '/api/discoveries/coverage') {
        const sid = url.searchParams.get('sprint_id');
        data = apiDiscoveryCoverage(sid ? Number(sid) : undefined);
      } else if (url.pathname === '/api/discoveries/sprints') data = apiDiscoverySprintList();
      else if (url.pathname === '/api/discoveries') {
        const sid = url.searchParams.get('sprint_id');
        const st = url.searchParams.get('status');
        const cat = url.searchParams.get('category');
        const excl = url.searchParams.get('exclude_status');
        data = apiDiscoveries(
          sid ? Number(sid) : undefined,
          st || undefined,
          cat || undefined,
          excl || undefined,
        );
      } else if (url.pathname.match(/^\/api\/discovery\/\d+\/link$/) && req.method === 'POST') {
        const did = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = apiLinkDiscoveryToTicket(did, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/discovery\/\d+$/) && req.method === 'PATCH') {
        const did = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = apiUpdateDiscovery(did, body);
        notifyClients();
      } else if (url.pathname === '/api/sprints/grouped') data = apiSprintsGroupedByMilestone();
      else if (url.pathname === '/api/sprints') data = sprintHandlers.apiSprints(db);
      else if (url.pathname.match(/^\/api\/sprint\/\d+\/stuck$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiReportSprintStuck(db, sid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/burndown$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiBurndown(db, sid);
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/blockers$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiCreateBlocker(db, sid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/blocker\/\d+$/) && req.method === 'PATCH') {
        const bid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiUpdateBlocker(db, bid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/blockers$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiSprintBlockers(db, sid);
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/bugs$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiCreateBug(db, sid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/bug\/\d+$/) && req.method === 'PATCH') {
        const bid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiUpdateBug(db, bid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/bugs$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiSprintBugs(db, sid);
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/tickets$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiSprintTickets(db, sid);
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/retro$/) && req.method === 'POST') {
        const sid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        sprintHandlers.createRetroFinding(db, sid, body);
        data = { ok: true };
        notifyClients();
      } else if (url.pathname.match(/^\/api\/retro\/\d+$/) && req.method === 'PATCH') {
        const rid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        sprintHandlers.updateRetroFinding(db, rid, body);
        data = { ok: true };
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/retro$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiSprintRetro(db, sid);
      } else if (url.pathname.match(/^\/api\/sprint\/\d+$/) && req.method === 'PUT') {
        const sid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        const { result, marketingDirty } = sprintHandlers.apiSprintUpdate(db, sid, body);
        data = result;
        // Marketing-stats rebuild is a router-side side-effect (sprint closed).
        if (marketingDirty) rebuildMarketingStats();
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+$/) && req.method === 'DELETE') {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiDeleteSprint(db, sid);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = sprintHandlers.apiSprintDetail(db, sid);
        if (!data) {
          res.writeHead(404);
          res.end('{"error":"sprint not found"}');
          return;
        }
      } else if (url.pathname.match(/^\/api\/ticket\/\d+\/milestone$/) && req.method === 'PATCH') {
        const tid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiUpdateTicketMilestone(db, tid, body);
        notifyClients();
      } else if (url.pathname === '/api/epics' && req.method === 'POST') {
        const body = await readBody(req);
        data = apiCreateEpic(body);
        notifyClients();
      } else if (url.pathname === '/api/epics') {
        const mid = url.searchParams.get('milestone_id');
        data = apiEpics(mid ? Number(mid) : undefined);
      } else if (url.pathname.match(/^\/api\/epic\/\d+$/) && req.method === 'PUT') {
        const eid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = apiUpdateEpic(eid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/milestone$/) && req.method === 'PATCH') {
        const sid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = apiUpdateSprintMilestone(sid, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/ticket\/\d+\/epic$/) && req.method === 'PATCH') {
        const tid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = apiUpdateTicketEpic(tid, body);
        notifyClients();
      }
      // ── Ticket CRUD endpoints ──────────────────────────────────────────
      else if (url.pathname === '/api/tickets' && req.method === 'POST') {
        const body = await readBody(req);
        data = sprintHandlers.apiCreateTicket(db, body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/ticket\/\d+$/) && req.method === 'PUT') {
        const tid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        data = sprintHandlers.apiUpdateTicket(db, tid, body);
        notifyClients();
      }
      // D1b (T-248): full-field UI ticket edit with revision trail + change flags
      else if (url.pathname.match(/^\/api\/ticket\/\d+$/) && req.method === 'PATCH') {
        const tid = Number(url.pathname.split('/')[3]);
        const body = await readBody(req);
        const { result, changedFields } = sprintHandlers.apiPatchTicket(db, tid, body);
        data = result;
        if (changedFields.length > 0) {
          notifyClients({
            type: 'ticket_changed',
            entityType: 'ticket',
            entityId: tid,
            change: { changed_fields: changedFields },
          });
        }
      }
      // ── DELETE endpoints ─────────────────────────────────────────────
      else if (url.pathname.match(/^\/api\/milestone\/\d+$/) && req.method === 'DELETE') {
        const mid = Number(url.pathname.split('/')[3]);
        data = apiDeleteMilestone(mid);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/epic\/\d+$/) && req.method === 'DELETE') {
        const eid = Number(url.pathname.split('/')[3]);
        data = apiDeleteEpic(eid);
        notifyClients();
      } else if (url.pathname === '/api/trash') data = apiTrash();
      else if (url.pathname === '/api/dump') data = apiDump();
      else if (url.pathname === '/api/restore' && req.method === 'POST') {
        const body = await readBody(req);
        data = await apiRestore(body);
        notifyClients();
      } else if (url.pathname === '/api/project/status') data = apiProjectStatus();
      else if (url.pathname.match(/^\/api\/file\/\d+\/changes$/)) {
        const id = Number(url.pathname.split('/')[3]);
        data = codeHandlers.apiFileChanges(db, id, Number(url.searchParams.get('limit') ?? 50));
        if (!data) {
          res.writeHead(404);
          res.end('{"error":"not found"}');
          return;
        }
      } else if (url.pathname.startsWith('/api/file/')) {
        const id = Number(url.pathname.split('/')[3]);
        data = codeHandlers.apiFileContext(db, id);
        if (!data) {
          res.writeHead(404);
          res.end('{"error":"not found"}');
          return;
        }
      }
      // ── Bridge API (pending_actions) ──────────────────────────────────
      else if (url.pathname === '/api/bridge/actions' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? 'pending';
        data = apiBridgeActions(status);
      } else if (url.pathname === '/api/bridge/actions' && req.method === 'POST') {
        const body = parseBody(BridgeActionBody, await readBody(req));
        const created = apiCreateBridgeAction(body);
        data = created;
        const eventType = body.action === 'request_input' ? 'input_requested' : 'bridge_action';
        notifyClients({
          type: eventType,
          entityType: 'pending_action',
          entityId: Number(created.id),
          change: { action: body.action, payload: body.payload },
        });
      } else if (
        url.pathname.match(/^\/api\/bridge\/actions\/\d+\/respond$/) &&
        req.method === 'PATCH'
      ) {
        const actionId = Number(url.pathname.split('/')[4]);
        const body = parseBody(BridgeRespondBody, await readBody(req));
        const existing = writeDb
          .prepare('SELECT id FROM pending_actions WHERE id = ?')
          .get(actionId);
        if (!existing) {
          res.writeHead(404);
          res.end('{"error":"action not found"}');
          return;
        }
        writeDb
          .prepare(
            "UPDATE pending_actions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?",
          )
          .run(
            typeof body.result === 'string' ? body.result : JSON.stringify(body.result),
            actionId,
          );
        data = { ok: true, id: actionId };
        notifyClients({
          type: 'response_ready',
          entityType: 'pending_action',
          entityId: actionId,
          change: { result: body.result },
        });
      } else if (url.pathname === '/api/bridge/status') data = apiBridgeStatus();
      else if (url.pathname === '/api/sprint-process/markdown') data = apiSprintProcessMarkdown();
      else if (url.pathname.match(/^\/api\/sprint\/\d+\/gates$/)) {
        const sid = Number(url.pathname.split('/')[3]);
        data = apiSprintGates(sid);
      } else if (url.pathname === '/api/sprint-process' && req.method === 'GET') {
        data = apiGetSprintProcess();
      } else if (url.pathname === '/api/sprint-process' && req.method === 'PUT') {
        const body = await readBody(req);
        data = apiPutSprintProcess(body);
        notifyClients();
      } else if (url.pathname.match(/^\/api\/sprint\/\d+\/gate\/[a-z]+$/) && req.method === 'GET') {
        const parts = url.pathname.split('/');
        const sid = Number(parts[3]);
        const phase = parts[5];
        data = sprintHandlers.verifyPhaseGate(db, sid, phase);
      } else {
        res.writeHead(404);
        res.end('{"ok":false,"error":"unknown endpoint"}');
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e: any) {
      if (e instanceof BodyError) {
        sendRequestError(req, res, e, url.pathname);
        return;
      }
      const payload: any = { ok: false, error: e.message };
      if (e.gate) payload.gate = e.gate;
      const status = Number(e?.status ?? 500);
      const routePath = url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 120);
      if (status >= 500) {
        slog(
          'CRITICAL',
          `dashboard: route error status=${status} method=${req.method} path=${routePath} error=${errorClass(e)}`,
        );
      } else {
        slog(
          'WARN',
          `dashboard: route rejected status=${status} method=${req.method} path=${routePath} error=${errorClass(e)}`,
        );
      }
      res.writeHead(e.status ?? 500);
      res.end(JSON.stringify(payload));
    }
    return;
  }

  // Serve static assets from Vite build output
  const distDir = path.join(__dirname, '../../dist/dashboard');
  if (url.pathname.startsWith('/assets/')) {
    const filePath = path.join(distDir, url.pathname);
    const safePath = path.resolve(filePath);
    if (!safePath.startsWith(path.resolve(distDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const data = fs.readFileSync(safePath);
      const ext = path.extname(safePath);
      const mimeTypes: Record<string, string> = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.json': 'application/json',
      };
      res.setHeader('Content-Type', mimeTypes[ext] ?? 'application/octet-stream');
      res.writeHead(200);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // SPA fallback: serve index.html for all non-API routes
  try {
    const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(injectToken(indexHtml));
  } catch {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(injectToken(HTML));
  }
}

function startServer(port: number, maxRetries = 10): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && maxRetries > 0) {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      server.removeAllListeners('error');
      startServer(port + 1, maxRetries - 1);
    } else {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    // Write actual port to DB so MCP tools can find the dashboard
    try {
      writeDb
        .prepare(
          "INSERT OR REPLACE INTO skills (name, content, owner_role) VALUES ('_dashboard_port', ?, 'system')",
        )
        .run(String(port));
    } catch {}
    // Write port to .env.local so Vite dev proxy auto-configures on next start
    try {
      const envLocalPath = path.join(__dirname, 'app', '.env.local');
      fs.writeFileSync(
        envLocalPath,
        `VITE_DASHBOARD_PORT=${port}\nVITE_DASHBOARD_TOKEN=${DASHBOARD_TOKEN}\n`,
      );
    } catch {}
    console.log(`VLM Code Context | AI Virtual IT Department — http://localhost:${port}`);
    slog(
      'INFO',
      `dashboard: started version=${PKG_VERSION} port=${port} db=${path.basename(dbPath)}`,
    );

    // Auto-detect watch directory from indexed files, or use CLI arg
    const watchDir =
      WATCH_DIR ??
      (() => {
        const row = db.prepare(`SELECT path FROM files ORDER BY path LIMIT 1`).get() as
          | { path: string }
          | undefined;
        if (!row) return null;
        // Walk up to find the common root (shortest path prefix of all indexed files)
        const allPaths = db.prepare(`SELECT path FROM files`).all() as { path: string }[];
        if (allPaths.length === 0) return null;
        let common = path.dirname(allPaths[0].path);
        for (const p of allPaths) {
          while (!p.path.startsWith(common + '/') && common !== '/') {
            common = path.dirname(common);
          }
        }
        return common;
      })();

    if (watchDir) {
      startWatcher(watchDir);
    } else {
      console.log(
        '[watch] No indexed files found. Pass a directory as 4th arg or index files first.',
      );
    }
  });
}

startServer(PORT);

// ─── HTML ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
