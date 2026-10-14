import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { ensureTicketRefIndex, renameDuplicateTicketRefs } from './ticket-ref.js';

/**
 * Initialize the SQLite schema for the Scrum system.
 * Tables: agents, sprints, tickets, subtasks, retro_findings, blockers, bugs, skills, processes, milestones, decisions
 */
export function initScrumSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      model TEXT,
      tools TEXT,
      system_prompt TEXT,
      department TEXT DEFAULT 'development',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      goal TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('preparation', 'kickoff', 'planning', 'implementation', 'qa', 'refactoring', 'retro', 'review', 'closed', 'rest', 'done')),
      velocity_committed INTEGER DEFAULT 0,
      velocity_completed INTEGER DEFAULT 0,
      milestone_id INTEGER REFERENCES milestones(id),
      deleted_at TEXT DEFAULT NULL,
      archived_at TEXT DEFAULT NULL,
      project TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      ticket_ref TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
      status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'PARTIAL', 'NOT_DONE')),
      assigned_to TEXT,
      story_points INTEGER,
      milestone TEXT,
      milestone_id INTEGER,
      epic_id INTEGER REFERENCES epics(id) ON DELETE SET NULL,
      estimated_hours REAL,
      actual_hours REAL,
      review_status TEXT DEFAULT NULL CHECK(review_status IS NULL OR review_status IN ('pending','approved','rejected')),
      change_seq INTEGER NOT NULL DEFAULT 0,
      pending_change INTEGER NOT NULL DEFAULT 0,
      qa_verified INTEGER NOT NULL DEFAULT 0,
      verified_by TEXT,
      acceptance_criteria TEXT,
      dependencies TEXT,
      notes TEXT,
      deleted_at TEXT DEFAULT NULL,
      project TEXT DEFAULT NULL,
      type TEXT DEFAULT NULL CHECK (type IS NULL OR type IN ('feat', 'fix', 'chore', 'infra', 'improvement')),
      origin TEXT DEFAULT NULL CHECK (origin IS NULL OR origin IN ('ai', 'human')),
      github_issue INTEGER DEFAULT NULL,
      github_repo TEXT DEFAULT NULL,
      github_node_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
      FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE SET NULL,
      -- Kept for existing DBs; idx_tickets_ticket_ref_unique (#222) makes the ref unique across the database.
      UNIQUE(sprint_id, ticket_ref)
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      assigned_to TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS retro_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      role TEXT,
      category TEXT NOT NULL CHECK (category IN ('went_well', 'went_wrong', 'try_next', 'auto_analysis')),
      finding TEXT NOT NULL,
      action_owner TEXT,
      action_applied INTEGER NOT NULL DEFAULT 0,
      linked_ticket_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'adopted', 'dropped')),
      dropped_reason TEXT,
      deferred_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
      FOREIGN KEY (linked_ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS blockers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      ticket_id INTEGER,
      description TEXT NOT NULL,
      reported_by TEXT,
      escalated_to TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS bugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      ticket_id INTEGER,
      severity TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
      description TEXT NOT NULL,
      steps_to_reproduce TEXT,
      expected TEXT,
      actual TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'deferred')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      content TEXT,
      owner_role TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      content TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
      target_date TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT DEFAULT NULL,
      archived_at TEXT DEFAULT NULL,
      project TEXT DEFAULT NULL,
      github_milestone INTEGER DEFAULT NULL,
      github_node_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      rationale TEXT,
      alternatives TEXT,
      outcome TEXT,
      category TEXT DEFAULT 'technical',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS epics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
      milestone_id INTEGER REFERENCES milestones(id),
      color TEXT DEFAULT '#3b82f6',
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
      deleted_at TEXT DEFAULT NULL,
      archived_at TEXT DEFAULT NULL,
      project TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sprint_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      remaining_points INTEGER NOT NULL DEFAULT 0,
      completed_points INTEGER NOT NULL DEFAULT 0,
      added_points INTEGER NOT NULL DEFAULT 0,
      removed_points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
      UNIQUE(sprint_id, date)
    );

    CREATE TABLE IF NOT EXISTS ticket_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_ticket_id INTEGER NOT NULL,
      target_ticket_id INTEGER NOT NULL,
      dependency_type TEXT NOT NULL DEFAULT 'blocks' CHECK (dependency_type IN ('blocks', 'blocked_by', 'related')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (target_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      UNIQUE(source_ticket_id, target_ticket_id, dependency_type)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6b7280',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_tags (
      ticket_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ticket_id, tag_id),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_mood_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      sprint_id INTEGER NOT NULL,
      mood INTEGER NOT NULL CHECK (mood BETWEEN 1 AND 5),
      workload_points INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE,
      UNIQUE(agent_id, sprint_id)
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('ticket', 'sprint', 'epic', 'milestone', 'agent', 'blocker', 'bug', 'discovery', 'retro_finding')),
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'status_changed', 'triaged')),
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status);
    CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
    CREATE INDEX IF NOT EXISTS idx_epics_milestone ON epics(milestone_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_sprint_id ON tickets(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_subtasks_ticket_id ON subtasks(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_retro_findings_sprint_id ON retro_findings(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_blockers_sprint_id ON blockers(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_bugs_sprint_id ON bugs(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
    CREATE INDEX IF NOT EXISTS idx_sprint_metrics_sprint ON sprint_metrics(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_deps_source ON ticket_dependencies(source_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_deps_target ON ticket_dependencies(target_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_mood_history_agent ON agent_mood_history(agent_id);
    CREATE INDEX IF NOT EXISTS idx_mood_history_sprint ON agent_mood_history(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_entity ON event_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      sprint_id INTEGER,
      ticket_id INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      duration_sec INTEGER,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discovery_sprint_id INTEGER NOT NULL REFERENCES sprints(id),
      finding TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('architecture', 'ux', 'performance', 'testing', 'integration', 'general')),
      status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'planned', 'implemented', 'dropped')),
      priority TEXT DEFAULT 'P1' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
      implementation_ticket_id INTEGER REFERENCES tickets(id),
      resolution_plan TEXT,
      drop_reason TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_discoveries_sprint ON discoveries(discovery_sprint_id);
    CREATE INDEX IF NOT EXISTS idx_discoveries_status ON discoveries(status);

    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'expired')),
      source TEXT NOT NULL DEFAULT 'dashboard',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, created_at);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'awaiting_agent', 'paused', 'completed', 'failed')),
      context TEXT,
      trigger_action_id INTEGER REFERENCES pending_actions(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

    CREATE TABLE IF NOT EXISTS workflow_step_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES workflow_runs(id),
      step_index INTEGER NOT NULL,
      agent_role TEXT,
      action TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
      input TEXT,
      output TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_step_log_workflow ON workflow_step_log(workflow_id);

    CREATE TABLE IF NOT EXISTS ticket_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('ui', 'mcp')),
      changed_fields TEXT NOT NULL,
      old_values TEXT NOT NULL,
      new_values TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_revisions_ticket ON ticket_revisions(ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      model TEXT,
      is_lead INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ticket_id, role),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_assignments_ticket ON ticket_assignments(ticket_id);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      repo TEXT,
      github_project_owner TEXT,
      github_project_number INTEGER,
      github_assignee TEXT,
      github_project_id TEXT,
      github_status_field_id TEXT,
      github_status_options TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIEW IF NOT EXISTS velocity_trends AS
    SELECT
      s.id as sprint_id, s.name as sprint_name, s.status,
      s.velocity_committed as committed, s.velocity_completed as completed,
      CASE WHEN s.velocity_committed > 0 THEN ROUND(CAST(s.velocity_completed AS REAL) / s.velocity_committed * 100, 1) ELSE 0 END as completion_rate,
      (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE' AND deleted_at IS NULL) as tickets_done,
      (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND deleted_at IS NULL) as tickets_total,
      (SELECT COUNT(*) FROM bugs WHERE sprint_id = s.id) as bugs_found,
      (SELECT COUNT(*) FROM bugs WHERE sprint_id = s.id AND status = 'fixed') as bugs_fixed,
      s.start_date, s.end_date, s.created_at
    FROM sprints s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC;

    INSERT OR IGNORE INTO tags (name, color) VALUES ('tech-debt', '#ef4444');
    INSERT OR IGNORE INTO tags (name, color) VALUES ('security', '#f59e0b');
    INSERT OR IGNORE INTO tags (name, color) VALUES ('ux', '#8b5cf6');
    INSERT OR IGNORE INTO tags (name, color) VALUES ('bug', '#dc2626');
    INSERT OR IGNORE INTO tags (name, color) VALUES ('performance', '#10b981');
    INSERT OR IGNORE INTO tags (name, color) VALUES ('documentation', '#6366f1');
  `);

  // Migrate existing databases: add milestone_id column if missing
  const cols = db.pragma('table_info(tickets)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'milestone_id')) {
    db.exec(
      'ALTER TABLE tickets ADD COLUMN milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL',
    );
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_milestone_id ON tickets(milestone_id);');

  // Migrate: add epic_id to tickets if missing
  if (!cols.some((c) => c.name === 'epic_id')) {
    db.exec(
      'ALTER TABLE tickets ADD COLUMN epic_id INTEGER REFERENCES epics(id) ON DELETE SET NULL',
    );
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_epic_id ON tickets(epic_id);');

  // add milestone_id column and idx_sprints_archived index to sprints if missing (legacy DBs)
  const sprintCols = db.pragma('table_info(sprints)') as Array<{ name: string }>;
  if (!sprintCols.some((c) => c.name === 'milestone_id')) {
    db.exec('ALTER TABLE sprints ADD COLUMN milestone_id INTEGER REFERENCES milestones(id)');
  }
  if (sprintCols.some((c) => c.name === 'archived_at')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sprints_archived ON sprints(archived_at);');
  }
  // archived_at indexes on milestones/epics (v24) — legacy tables gain the column in
  // runMigrations' idempotent section, so only index it here when it already exists.
  for (const table of ['milestones', 'epics']) {
    const tCols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (tCols.some((c) => c.name === 'archived_at')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_archived ON ${table}(archived_at);`);
    }
  }

  // v26 project indexes — legacy tables gain `project` in runMigrations' idempotent
  // section, so only index it here when the column already exists.
  createProjectIndexes(db);

  // v27 (#222): ticket_ref is unique across the database. A legacy DB with shared
  // refs gets the index in runMigrations, after the refs are renamed.
  ensureTicketRefIndex(db);

  // idx_tickets_sprint_deleted and idx_sprints_status_deleted reference deleted_at columns
  // that may not exist on legacy DBs — create them only when the columns are present.
  // For fresh DBs the columns exist in the canonical CREATE TABLE above; for legacy DBs
  // runMigrations' idempotent section ALTERs them in before creating these indexes.
  const ticketColsNow = db.pragma('table_info(tickets)') as Array<{ name: string }>;
  if (ticketColsNow.some((c) => c.name === 'deleted_at')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tickets_sprint_deleted ON tickets(sprint_id, deleted_at);',
    );
  }
  const sprintColsNow = db.pragma('table_info(sprints)') as Array<{ name: string }>;
  if (sprintColsNow.some((c) => c.name === 'deleted_at')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sprints_status_deleted ON sprints(status, deleted_at);',
    );
  }

  // Schema version tracking table
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

/** Tables that carry the v26 `project` key (CCA-13). */
const PROJECT_TABLES = ['milestones', 'sprints', 'epics', 'tickets'] as const;

/** Index `project` on every table that has the column (idempotent). */
function createProjectIndexes(db: Database.Database): void {
  for (const table of PROJECT_TABLES) {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'project')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project);`);
    }
  }
}

/** `GitHub: owner/repo#123` as the CCA tickets store it in `notes`. */
const GITHUB_NOTE_RE = /GitHub:\s*([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)/;

/**
 * One-off backfill (v26): tickets whose `notes` hold `GitHub: owner/repo#N` get
 * `github_issue = N` and `github_repo = owner/repo`. Only rows with no stored
 * issue number change; `project` is never set here (never guessed).
 * Returns the number of tickets updated.
 */
export function backfillGithubIssues(db: Database.Database): number {
  const rows = db
    .prepare("SELECT id, notes FROM tickets WHERE github_issue IS NULL AND notes LIKE '%GitHub:%'")
    .all() as Array<{ id: number; notes: string }>;
  const upd = db.prepare(
    'UPDATE tickets SET github_issue = ?, github_repo = ? WHERE id = ? AND github_issue IS NULL',
  );
  let n = 0;
  for (const r of rows) {
    const m = GITHUB_NOTE_RE.exec(r.notes);
    if (!m) continue;
    n += upd.run(Number(m[2]), m[1], r.id).changes;
  }
  return n;
}

/** Single source of truth for the schema version. Must equal the max version in
 *  runMigrations' array — runMigrations asserts this at every call. */
export const LATEST_SCHEMA_VERSION = 27;

/**
 * Read the stamped schema version of an on-disk DB without opening it
 * read-write — a WAL-mode open litters empty -wal/-shm siblings next to a DB
 * the caller may be about to refuse (discovery #28). Returns 0 for missing,
 * unreadable, or pre-versioning DBs; the normal boot path decides those.
 */
export function peekSchemaVersion(dbPath: string): number {
  let peekDb: Database.Database | null = null;
  try {
    peekDb = new BetterSqlite3(dbPath, { readonly: true });
    const row = peekDb.prepare('SELECT MAX(version) v FROM schema_versions').get() as {
      v: number | null;
    };
    return row?.v ?? 0;
  } catch {
    return 0;
  } finally {
    if (peekDb) {
      try {
        peekDb.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export function runMigrations(db: Database.Database, opts: { freshDb?: boolean } = {}): void {
  const current =
    (
      db.prepare('SELECT MAX(version) as v FROM schema_versions').get() as
        | { v: number | null }
        | undefined
    )?.v ?? 0;
  // IMPORTANT: new columns/tables must ALSO be added to initScrumSchema above — enforced by migrations.test.ts "canonical schema parity".
  const migrations = [
    { version: 1, name: 'add_epic_id_to_tickets', sql: 'SELECT 1' }, // already done
    { version: 2, name: 'add_milestone_id_to_sprints', sql: 'SELECT 1' }, // already done
    { version: 3, name: 'add_decisions_table', sql: 'SELECT 1' }, // already done
    { version: 4, name: 'sprint_phases_v2', sql: 'SELECT 1' }, // already done
    {
      version: 5,
      name: 'sprint_10_phases',
      sql: `
      CREATE TABLE IF NOT EXISTS sprints_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        goal TEXT,
        start_date TEXT,
        end_date TEXT,
        status TEXT NOT NULL DEFAULT 'preparation' CHECK (status IN ('preparation', 'kickoff', 'planning', 'implementation', 'qa', 'refactoring', 'retro', 'review', 'closed', 'rest')),
        velocity_committed INTEGER DEFAULT 0,
        velocity_completed INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        milestone_id INTEGER REFERENCES milestones(id)
      );
      INSERT OR IGNORE INTO sprints_new SELECT id, name, goal, start_date, end_date, status, velocity_committed, velocity_completed, created_at, updated_at, milestone_id FROM sprints;
      DROP VIEW IF EXISTS velocity_trends;
      DROP TABLE sprints;
      ALTER TABLE sprints_new RENAME TO sprints;
      CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
    `,
    },
    // estimated/actual_hours now canonical in initScrumSchema + idempotent patch below
    { version: 6, name: 'add_time_tracking_to_tickets', sql: `SELECT 1` },
    {
      version: 7,
      name: 'add_review_status_to_tickets',
      sql: `
      SELECT 1
    `,
    }, // review_status applied in the idempotent section below (was dashboard-only before 2026-06-11)
    {
      version: 8,
      name: 'seed_default_tags',
      sql: `
      INSERT OR IGNORE INTO tags (name, color) VALUES ('tech-debt', '#ef4444');
      INSERT OR IGNORE INTO tags (name, color) VALUES ('security', '#f59e0b');
      INSERT OR IGNORE INTO tags (name, color) VALUES ('ux', '#8b5cf6');
      INSERT OR IGNORE INTO tags (name, color) VALUES ('bug', '#dc2626');
      INSERT OR IGNORE INTO tags (name, color) VALUES ('performance', '#10b981');
      INSERT OR IGNORE INTO tags (name, color) VALUES ('documentation', '#6366f1');
    `,
    },
    {
      version: 9,
      name: 'create_velocity_trends_view',
      sql: `
      CREATE VIEW IF NOT EXISTS velocity_trends AS
      SELECT
        s.id as sprint_id,
        s.name as sprint_name,
        s.status,
        s.velocity_committed as committed,
        s.velocity_completed as completed,
        CASE WHEN s.velocity_committed > 0 THEN ROUND(CAST(s.velocity_completed AS REAL) / s.velocity_committed * 100, 1) ELSE 0 END as completion_rate,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE' AND deleted_at IS NULL) as tickets_done,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND deleted_at IS NULL) as tickets_total,
        (SELECT COUNT(*) FROM bugs WHERE sprint_id = s.id) as bugs_found,
        (SELECT COUNT(*) FROM bugs WHERE sprint_id = s.id AND status = 'fixed') as bugs_fixed,
        s.start_date,
        s.end_date,
        s.created_at
      FROM sprints s
      WHERE s.deleted_at IS NULL
      ORDER BY s.created_at DESC;
    `,
    },
    { version: 10, name: 'create_linear_normalized_tables', sql: `SELECT 1` }, // tables created in initScrumSchema
    {
      version: 11,
      name: 'create_discoveries_table',
      sql: `
      CREATE TABLE IF NOT EXISTS discoveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discovery_sprint_id INTEGER NOT NULL REFERENCES sprints(id),
        finding TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('architecture', 'ux', 'performance', 'testing', 'integration', 'general')),
        status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'planned', 'implemented', 'dropped')),
        priority TEXT DEFAULT 'P1' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
        implementation_ticket_id INTEGER REFERENCES tickets(id),
        drop_reason TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_discoveries_sprint ON discoveries(discovery_sprint_id);
      CREATE INDEX IF NOT EXISTS idx_discoveries_status ON discoveries(status);
    `,
    },
    {
      version: 12,
      name: 'create_pending_actions_table',
      sql: `
      CREATE TABLE IF NOT EXISTS pending_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id INTEGER,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'expired')),
        source TEXT NOT NULL DEFAULT 'dashboard',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, created_at);
    `,
    },
    {
      version: 13,
      name: 'create_workflow_orchestration_tables',
      sql: `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        steps TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'awaiting_agent', 'paused', 'completed', 'failed')),
        context TEXT,
        trigger_action_id INTEGER REFERENCES pending_actions(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

      CREATE TABLE IF NOT EXISTS workflow_step_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER NOT NULL REFERENCES workflow_runs(id),
        step_index INTEGER NOT NULL,
        agent_role TEXT,
        action TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        input TEXT,
        output TEXT,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_step_log_workflow ON workflow_step_log(workflow_id);
    `,
    },
    { version: 14, name: 'add_retro_linked_ticket_id', sql: `SELECT 1` },
    { version: 15, name: 'add_resolution_plan_to_discoveries', sql: `SELECT 1` },
    {
      version: 16,
      name: 'drop_linear_tables',
      sql: `
      DROP TABLE IF EXISTS linear_cache;
      DROP TABLE IF EXISTS linear_issues;
      DROP TABLE IF EXISTS linear_states;
      DROP TABLE IF EXISTS linear_labels;
    `,
    },
    { version: 17, name: 'simplify_sprint_phases_add_done', sql: `SELECT 1` },
    {
      version: 18,
      name: 'add_department_to_agents',
      sql: `
      UPDATE agents SET department = 'quality' WHERE role IN ('qa', 'security-specialist', 'scrum-master');
      UPDATE agents SET department = 'business' WHERE role IN ('product-owner', 'team-lead', 'manager', 'marketing-lead', 'growth-strategist', 'ux-designer');
    `,
    },
    // Index creation is deferred to the idempotent section below (after deleted_at is guaranteed)
    { version: 19, name: 'add_ticket_composite_index', sql: `SELECT 1` },
    // archived_at column + index are applied in the idempotent post-rebuild section below
    // (the v17 sprints rebuild copies a fixed column list and would otherwise drop a column
    // added here on legacy DBs). This entry only records the version.
    { version: 20, name: 'add_sprint_archived_at', sql: `SELECT 1` },
    // try_next lifecycle columns (status/dropped_reason/deferred_at) are applied in the
    // idempotent post-migration section below — same pattern as v14/v20.
    { version: 21, name: 'add_retro_finding_lifecycle', sql: `SELECT 1` },
    // event_log CHECK rebuild (retro_finding entity + triaged action) happens in the
    // idempotent post-migration section below — CHECK constraints can't be ALTERed.
    { version: 22, name: 'extend_event_log_check', sql: `SELECT 1` },
    // D1/D2 live-board + multi-agent schema — columns/tables/backfill applied in the
    // idempotent post-migration section below.
    { version: 23, name: 'add_ticket_revisions_and_assignments', sql: `SELECT 1` },
    // archived_at on milestones + epics (mirrors v20 for sprints) — column + index are
    // applied in the idempotent post-migration section below; this entry records the version.
    { version: 24, name: 'add_milestone_epic_archived_at', sql: `SELECT 1` },
    // exports.signature/line + files.import_lines (CCA-04) — columns are added by
    // initSchema's upgradeCodeIndexColumns (src/server/schema.ts), which every
    // opener runs before this; this entry records the version.
    { version: 25, name: 'add_export_signatures_and_import_lines', sql: `SELECT 1` },
    // CCA-13: projects table, `project` key on milestones/sprints/epics/tickets,
    // tickets.type/origin/github_issue/github_repo, milestones.github_milestone.
    // Columns, indexes and the notes backfill are applied in the idempotent
    // post-migration section below (after the v17 sprints rebuild); this entry
    // records the version.
    { version: 26, name: 'add_projects_and_github_sync', sql: `SELECT 1` },
    // #222: ticket_ref unique across the database (was per sprint). Shared refs are
    // renamed and the unique index is created in the idempotent post-migration
    // section below; this entry records the version.
    { version: 27, name: 'unique_ticket_refs', sql: `SELECT 1` },
  ];

  const maxDefined = Math.max(...migrations.map((m) => m.version));
  if (maxDefined !== LATEST_SCHEMA_VERSION) {
    throw new Error(
      `LATEST_SCHEMA_VERSION (${LATEST_SCHEMA_VERSION}) is out of sync with the migrations array (max ${maxDefined}) — update the constant when adding a migration.`,
    );
  }
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `context.db schema is v${current}, but this code-context version only knows v${LATEST_SCHEMA_VERSION}. ` +
        `It was created by a newer code-context version — update the package (npm i -g vlm-code-context-mcp@latest) or open it with a matching version.`,
    );
  }

  // Wrap all migrations in a single transaction — partial failure rolls back cleanly
  const migrate = db.transaction(() => {
    if (opts.freshDb && current === 0) {
      // Brand-new DB: initScrumSchema already created the canonical schema.
      // Stamp all versions instead of replaying (avoids the v5/v17 rebuild dance).
      const stamp = db.prepare('INSERT INTO schema_versions (version, name) VALUES (?, ?)');
      for (const m of migrations) stamp.run(m.version, m.name);
    } else {
      // Safe column additions that migrations depend on (must run before versioned migrations)
      const agentCols = db.pragma('table_info(agents)') as Array<{ name: string }>;
      if (!agentCols.some((c) => c.name === 'department')) {
        db.exec("ALTER TABLE agents ADD COLUMN department TEXT DEFAULT 'development'");
      }

      for (const m of migrations) {
        if (m.version > current) {
          db.exec(m.sql);
          db.prepare('INSERT INTO schema_versions (version, name) VALUES (?, ?)').run(
            m.version,
            m.name,
          );
        }
      }
    }

    // Safe column additions (idempotent — no-op if column already exists)
    const retroCols = db.pragma('table_info(retro_findings)') as Array<{ name: string }>;
    if (!retroCols.some((c) => c.name === 'linked_ticket_id')) {
      db.exec(
        'ALTER TABLE retro_findings ADD COLUMN linked_ticket_id INTEGER REFERENCES tickets(id)',
      );
    }
    // v21: try_next lifecycle — existing rows default to 'open' (the un-triaged state)
    if (!retroCols.some((c) => c.name === 'status')) {
      db.exec(
        "ALTER TABLE retro_findings ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'adopted', 'dropped'))",
      );
    }

    // v23 (D1): ticket change flags — UI edits set pending_change, sessions acknowledge
    // Absorbed from dashboard.ts ad-hoc patches + v6 (legacy DBs created before these
    // columns were canonical). Fresh DBs get them via initScrumSchema's CREATE TABLE.
    const ticketCols = db.pragma('table_info(tickets)') as Array<{ name: string }>;
    if (!ticketCols.some((c) => c.name === 'estimated_hours')) {
      db.exec('ALTER TABLE tickets ADD COLUMN estimated_hours REAL');
    }
    if (!ticketCols.some((c) => c.name === 'actual_hours')) {
      db.exec('ALTER TABLE tickets ADD COLUMN actual_hours REAL');
    }
    if (!ticketCols.some((c) => c.name === 'review_status')) {
      db.exec(
        "ALTER TABLE tickets ADD COLUMN review_status TEXT DEFAULT NULL CHECK(review_status IS NULL OR review_status IN ('pending','approved','rejected'))",
      );
    }
    if (!ticketCols.some((c) => c.name === 'change_seq')) {
      db.exec('ALTER TABLE tickets ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0');
    }
    if (!ticketCols.some((c) => c.name === 'pending_change')) {
      db.exec('ALTER TABLE tickets ADD COLUMN pending_change INTEGER NOT NULL DEFAULT 0');
    }
    // deleted_at safety net for all four soft-delete tables (was dashboard-only)
    for (const table of ['milestones', 'sprints', 'epics', 'tickets']) {
      const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'deleted_at')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT DEFAULT NULL`);
      }
    }
    // Composite soft-delete indexes — created here (not in migrations) so deleted_at is
    // guaranteed to exist on both legacy and fresh paths before the index is built.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tickets_sprint_deleted ON tickets(sprint_id, deleted_at);`,
    );

    // v23 (D1): field-level revision trail for UI/MCP ticket edits
    db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('ui', 'mcp')),
      changed_fields TEXT NOT NULL,
      old_values TEXT NOT NULL,
      new_values TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_revisions_ticket ON ticket_revisions(ticket_id);
  `);

    // v23 (D2): multi-agent assignments — lead implements, supporters verify (decision #4)
    db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      model TEXT,
      is_lead INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ticket_id, role),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_assignments_ticket ON ticket_assignments(ticket_id);
  `);
    // Backfill: every assigned ticket gets its agent as the lead assignment (idempotent)
    db.exec(`
    INSERT OR IGNORE INTO ticket_assignments (ticket_id, role, is_lead)
    SELECT id, assigned_to, 1 FROM tickets
    WHERE assigned_to IS NOT NULL AND assigned_to != ''
      AND id NOT IN (SELECT ticket_id FROM ticket_assignments WHERE is_lead = 1)
  `);

    // v22: rebuild event_log with extended CHECKs (retro_finding entity, triaged action) —
    // idempotent: skip when the current constraint already allows retro_finding.
    const eventLogSql =
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_log'")
          .get() as { sql: string } | undefined
      )?.sql ?? '';
    if (eventLogSql && !eventLogSql.includes("'retro_finding'")) {
      db.exec(`
      CREATE TABLE event_log_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('ticket', 'sprint', 'epic', 'milestone', 'agent', 'blocker', 'bug', 'discovery', 'retro_finding')),
        entity_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'status_changed', 'triaged')),
        field_name TEXT,
        old_value TEXT,
        new_value TEXT,
        actor TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO event_log_v2 (id, entity_type, entity_id, action, field_name, old_value, new_value, actor, created_at)
        SELECT id, entity_type, entity_id, action, field_name, old_value, new_value, actor, created_at FROM event_log;
      DROP TABLE event_log;
      ALTER TABLE event_log_v2 RENAME TO event_log;
      CREATE INDEX IF NOT EXISTS idx_event_log_entity ON event_log(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);
    `);
    }
    if (!retroCols.some((c) => c.name === 'dropped_reason')) {
      db.exec('ALTER TABLE retro_findings ADD COLUMN dropped_reason TEXT');
    }
    if (!retroCols.some((c) => c.name === 'deferred_at')) {
      db.exec('ALTER TABLE retro_findings ADD COLUMN deferred_at TEXT');
    }

    const discoveryCols = db.pragma('table_info(discoveries)') as Array<{ name: string }>;
    if (!discoveryCols.some((c) => c.name === 'resolution_plan')) {
      db.exec('ALTER TABLE discoveries ADD COLUMN resolution_plan TEXT');
    }

    // Migration 17: Rebuild sprints table with 'done' in CHECK constraint (idempotent)
    // Check if the current sprints CHECK constraint already includes 'done'
    const sprintTableSql =
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sprints'").get() as
          | { sql: string }
          | undefined
      )?.sql ?? '';
    if (!sprintTableSql.includes("'done'")) {
      const sprintCols = db.pragma('table_info(sprints)') as Array<{ name: string }>;
      const hasDeletedAt = sprintCols.some((c) => c.name === 'deleted_at');
      const colList = hasDeletedAt
        ? 'id, name, goal, start_date, end_date, status, velocity_committed, velocity_completed, created_at, updated_at, milestone_id, deleted_at'
        : 'id, name, goal, start_date, end_date, status, velocity_committed, velocity_completed, created_at, updated_at, milestone_id';
      // Always include deleted_at in rebuilt table — migration 5 may have dropped it
      const deletedAtCol = ',\n        deleted_at TEXT DEFAULT NULL';
      db.exec(`
      CREATE TABLE IF NOT EXISTS sprints_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        goal TEXT,
        start_date TEXT,
        end_date TEXT,
        status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('preparation', 'kickoff', 'planning', 'implementation', 'qa', 'refactoring', 'retro', 'review', 'closed', 'rest', 'done')),
        velocity_committed INTEGER DEFAULT 0,
        velocity_completed INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        milestone_id INTEGER REFERENCES milestones(id)${deletedAtCol}
      );
    `);
      // If source has deleted_at, copy it; otherwise let it default to NULL
      if (hasDeletedAt) {
        db.exec(`INSERT OR IGNORE INTO sprints_v3 (${colList}) SELECT ${colList} FROM sprints;`);
      } else {
        db.exec(
          `INSERT OR IGNORE INTO sprints_v3 (id, name, goal, start_date, end_date, status, velocity_committed, velocity_completed, created_at, updated_at, milestone_id) SELECT id, name, goal, start_date, end_date, status, velocity_committed, velocity_completed, created_at, updated_at, milestone_id FROM sprints;`,
        );
      }
      db.exec(`DROP VIEW IF EXISTS velocity_trends;`);
      db.exec(`DROP TABLE sprints;`);
      db.exec(`ALTER TABLE sprints_v3 RENAME TO sprints;`);
      // Recreate velocity_trends view
      db.exec(`
      CREATE VIEW IF NOT EXISTS velocity_trends AS
      SELECT
        s.id as sprint_id, s.name as sprint_name, s.status,
        s.velocity_committed as committed, s.velocity_completed as completed,
        CASE WHEN s.velocity_committed > 0 THEN ROUND(CAST(s.velocity_completed AS REAL) / s.velocity_committed * 100, 1) ELSE 0 END as completion_rate,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE' AND deleted_at IS NULL) as tickets_done,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND deleted_at IS NULL) as tickets_total,
        (SELECT COUNT(*) FROM bugs WHERE sprint_id = s.id) as bugs_found,
        (SELECT COUNT(*) FROM bugs WHERE sprint_id = s.id AND status = 'fixed') as bugs_fixed,
        s.start_date, s.end_date, s.created_at
      FROM sprints s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC;
    `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);`);
    }

    // Composite index on sprints — must run after sprints_v3 rebuild guarantees deleted_at exists
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sprints_status_deleted ON sprints(status, deleted_at);`,
    );

    // Migration 20: add archived_at to sprints (idempotent; must run after the v17 rebuild,
    // which copies a fixed column list and would otherwise drop a column added earlier).
    const sprintCols20 = db.pragma('table_info(sprints)') as Array<{ name: string }>;
    if (!sprintCols20.some((c) => c.name === 'archived_at')) {
      db.exec('ALTER TABLE sprints ADD COLUMN archived_at TEXT DEFAULT NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_sprints_archived ON sprints(archived_at);');

    // Migration 24: add archived_at to milestones + epics (idempotent — no table rebuild
    // touches these tables, so a plain ALTER is safe on every legacy path).
    for (const table of ['milestones', 'epics']) {
      const tCols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!tCols.some((c) => c.name === 'archived_at')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN archived_at TEXT DEFAULT NULL`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_archived ON ${table}(archived_at);`);
    }

    // Migration 26 (CCA-13): project key + GitHub sync columns. Existing rows stay
    // NULL (unassigned) — the project is never guessed. Runs after the v17 rebuild.
    db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      repo TEXT,
      github_project_owner TEXT,
      github_project_number INTEGER,
      github_assignee TEXT,
      github_project_id TEXT,
      github_status_field_id TEXT,
      github_status_options TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
    const addCol = (table: string, col: string, ddl: string) => {
      const tCols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!tCols.some((c) => c.name === col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    };
    for (const table of PROJECT_TABLES) addCol(table, 'project', 'TEXT DEFAULT NULL');
    addCol(
      'tickets',
      'type',
      "TEXT DEFAULT NULL CHECK (type IS NULL OR type IN ('feat', 'fix', 'chore', 'infra', 'improvement'))",
    );
    addCol(
      'tickets',
      'origin',
      "TEXT DEFAULT NULL CHECK (origin IS NULL OR origin IN ('ai', 'human'))",
    );
    addCol('tickets', 'github_issue', 'INTEGER DEFAULT NULL');
    addCol('tickets', 'github_repo', 'TEXT DEFAULT NULL');
    addCol('milestones', 'github_milestone', 'INTEGER DEFAULT NULL');
    // CCA-14: GitHub node id of the issue / milestone the sync created or adopted.
    // A stored number is written only while the remote node id still matches.
    addCol('tickets', 'github_node_id', 'TEXT DEFAULT NULL');
    addCol('milestones', 'github_node_id', 'TEXT DEFAULT NULL');
    createProjectIndexes(db);
    // One-off: parse `GitHub: owner/repo#N` notes into github_issue (only on the
    // upgrade to v26, so a number cleared later is not re-filled on every boot).
    if (current < 26) backfillGithubIssues(db);

    // Migration 27 (#222): one ticket per ref across the database. Per shared ref the
    // lowest id keeps it; the other rows get the next free ref, and the old ref goes
    // to the ticket history (event_log). Idempotent: unique refs change nothing.
    renameDuplicateTicketRefs(db);
    if (!ensureTicketRefIndex(db)) {
      throw new Error('migration 27: ticket refs are still shared after the rename');
    }
  });

  // SQLite table rebuilds (DROP + RENAME) under FK enforcement fire ON DELETE CASCADE
  // into referencing tables — e.g. the v5 sprints rebuild would silently delete all
  // tickets and retro_findings on pre-versioning DBs. FK must be OFF during migration
  // (PRAGMA foreign_keys is a no-op inside an open transaction, so toggle outside)
  // and restored afterwards. Canonical pattern from the SQLite docs.
  const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    migrate();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}
