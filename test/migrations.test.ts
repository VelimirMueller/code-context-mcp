/**
 * Migration engine guarantees (spec 2026-06-11-lightweight-migration-mode):
 *  - LATEST_SCHEMA_VERSION is the single source of truth
 *  - downgrade guard: newer DB → clear throw
 *  - fresh-DB baseline stamps versions without replaying migrations
 *  - canonical initScrumSchema == full migration replay (schema parity)
 *  - legacy fixtures (pre-versioning / v1.2.1 / v1.3.1 / v2.5.1) migrate with data intact
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/server/schema.js';
import { initScrumSchema, runMigrations, LATEST_SCHEMA_VERSION } from '../src/scrum/schema.js';

function freshDb(opts: { freshDb?: boolean } = {}): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  initScrumSchema(db);
  runMigrations(db, opts);
  return db;
}

describe('LATEST_SCHEMA_VERSION', () => {
  it('is exported and matches the applied max version', () => {
    const db = freshDb();
    const v = (db.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v;
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(23);
    expect(v).toBe(LATEST_SCHEMA_VERSION);
  });
});

describe('downgrade guard', () => {
  it('throws a clear error when the DB is newer than the binary', () => {
    const db = freshDb();
    db.prepare('INSERT INTO schema_versions (version, name) VALUES (?, ?)').run(
      LATEST_SCHEMA_VERSION + 1,
      'from_the_future',
    );
    expect(() => runMigrations(db)).toThrow(/newer code-context version/i);
  });

  it('is idempotent at the current version (running twice is a no-op)', () => {
    const db = freshDb();
    expect(() => runMigrations(db)).not.toThrow();
    const v = (db.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v;
    expect(v).toBe(LATEST_SCHEMA_VERSION);
  });
});

type ColInfo = { name: string; type: string; notnull: number; dflt_value: unknown };

/** Structural snapshot: tables, per-table columns (sorted by name — ALTER appends
 *  while CREATE inlines, so order must not matter), named indexes, views.
 *  (CHECK constraints excluded: inline vs ALTER syntax differs textually.) */
export function schemaSnapshot(db: Database.Database) {
  const objs = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ type: string; name: string }>;
  const tables = objs
    .filter((o) => o.type === 'table')
    .map((o) => o.name)
    .sort();
  const columns: Record<
    string,
    Array<{ name: string; type: string; notnull: number; dflt: string }>
  > = {};
  for (const t of tables) {
    columns[t] = (db.pragma(`table_info(${t})`) as ColInfo[])
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: String(c.dflt_value) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const indexes = objs
    .filter((o) => o.type === 'index')
    .map((o) => o.name)
    .sort();
  const views = objs
    .filter((o) => o.type === 'view')
    .map((o) => o.name)
    .sort();
  return { tables, columns, indexes, views };
}

describe('fresh-DB baseline', () => {
  it('stamps all versions without replaying, and matches the replay path structurally', () => {
    const baseline = freshDb({ freshDb: true });
    const replayed = freshDb();
    const count = (baseline.prepare('SELECT COUNT(*) c FROM schema_versions').get() as any).c;
    expect(count).toBe(LATEST_SCHEMA_VERSION);
    const v = (baseline.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v;
    expect(v).toBe(LATEST_SCHEMA_VERSION);
    // count + MAX already cover completeness — no redundant hardcoded range check needed
    expect(schemaSnapshot(baseline)).toEqual(schemaSnapshot(replayed));
  });

  it('ignores freshDb on an already-versioned DB (no double-stamping)', () => {
    const db = freshDb();
    runMigrations(db, { freshDb: true }); // wrong flag on existing DB must be harmless
    const count = (db.prepare('SELECT COUNT(*) c FROM schema_versions').get() as any).c;
    expect(count).toBe(LATEST_SCHEMA_VERSION);
  });

  it("baseline path keeps initScrumSchema's table definitions (no rebuild executed)", () => {
    const baseline = freshDb({ freshDb: true });
    const initOnly = new Database(':memory:');
    initSchema(initOnly);
    initScrumSchema(initOnly);
    const sqlOf = (db: Database.Database) =>
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sprints'")
          .get() as any
      ).sql;
    expect(sqlOf(baseline)).toBe(sqlOf(initOnly));
  });
});

describe('canonical schema parity', () => {
  it('initScrumSchema alone matches init + full migration replay', () => {
    const replayed = freshDb(); // init + replay (current behavior)
    const initOnly = new Database(':memory:');
    initSchema(initOnly);
    initScrumSchema(initOnly);
    expect(schemaSnapshot(initOnly)).toEqual(schemaSnapshot(replayed));
  });

  it('fresh init seeds the default tags (absorbed migration v8)', () => {
    const initOnly = new Database(':memory:');
    initScrumSchema(initOnly);
    const names = (initOnly.prepare('SELECT name FROM tags ORDER BY name').all() as any[]).map(
      (r) => r.name,
    );
    expect(names).toEqual(['bug', 'documentation', 'performance', 'security', 'tech-debt', 'ux']);
  });
});

// ---------------------------------------------------------------------------
// Legacy fixture migration suite
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/legacy-dbs',
);
const FIXTURES = ['pre-versioning', 'v1.2.1', 'v1.3.1', 'v2.5.1'] as const;

function loadFixture(name: string): Database.Database {
  const sql = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.sql`), 'utf-8');
  const db = new Database(':memory:');
  db.exec(sql); // dump sets PRAGMA foreign_keys=OFF internally
  return db;
}

describe.each([...FIXTURES])('legacy fixture: %s', (name) => {
  it('migrates to LATEST_SCHEMA_VERSION without errors', () => {
    const db = loadFixture(name);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    initScrumSchema(db);
    expect(() => runMigrations(db)).not.toThrow();
    const v = (db.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v;
    expect(v).toBe(LATEST_SCHEMA_VERSION);
  });

  it('preserves the seeded data', () => {
    const db = loadFixture(name);
    db.pragma('foreign_keys = ON'); // production FK config — v5 rebuild must not cascade-delete
    initSchema(db);
    initScrumSchema(db);
    runMigrations(db);
    const sprint = db.prepare('SELECT name, goal FROM sprints WHERE id = 1').get() as any;
    expect(sprint).toMatchObject({ name: 'Fixture Sprint 1', goal: 'Legacy fixture goal' });
    const tickets = db
      .prepare('SELECT ticket_ref, title, status, story_points FROM tickets ORDER BY id')
      .all() as any[];
    expect(tickets).toEqual([
      { ticket_ref: 'T-1', title: 'Legacy ticket one', status: 'DONE', story_points: 3 },
      { ticket_ref: 'T-2', title: 'Legacy ticket two', status: 'TODO', story_points: 5 },
    ]);
    const finding = db
      .prepare('SELECT finding, status FROM retro_findings WHERE sprint_id = 1')
      .get() as any;
    expect(finding.finding).toBe('Legacy try-next finding');
    expect(finding.status).toBe('open'); // v21 default applied to legacy rows
    expect(
      (db.prepare("SELECT name FROM skills WHERE name='LEGACY_SKILL'").get() as any).name,
    ).toBe('LEGACY_SKILL');
  });

  it('reaches structural parity with a fresh baseline DB', () => {
    const db = loadFixture(name);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    initScrumSchema(db);
    runMigrations(db);
    const baseline = freshDb({ freshDb: true });
    expect(schemaSnapshot(db)).toEqual(schemaSnapshot(baseline));
  });

  it('is idempotent — second runMigrations changes nothing', () => {
    const db = loadFixture(name);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    initScrumSchema(db);
    runMigrations(db);
    const before = schemaSnapshot(db);
    const rowsBefore = (db.prepare('SELECT COUNT(*) c FROM tickets').get() as any).c;
    runMigrations(db);
    expect(schemaSnapshot(db)).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) c FROM tickets').get() as any).c).toBe(rowsBefore);
  });
});

// ---------------------------------------------------------------------------
// v24: archived_at on milestones + epics — upgrade from a DB created by v2.5.1
// ---------------------------------------------------------------------------

describe('v24 milestone/epic archived_at — upgrade from v2.5.1', () => {
  function migratedFixture(): Database.Database {
    const db = loadFixture('v2.5.1');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    initScrumSchema(db);
    runMigrations(db);
    return db;
  }

  it('starts at v23 without archived_at on milestones/epics (fixture sanity)', () => {
    const db = loadFixture('v2.5.1');
    expect((db.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v).toBe(23);
    for (const t of ['milestones', 'epics']) {
      const cols = (db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name);
      expect(cols).not.toContain('archived_at');
    }
  });

  it('adds archived_at (NULL) + index to both tables and keeps existing rows', () => {
    const db = migratedFixture();
    expect((db.prepare('SELECT MAX(version) v FROM schema_versions').get() as any).v).toBe(
      LATEST_SCHEMA_VERSION,
    );
    expect(db.prepare('SELECT version FROM schema_versions WHERE version = 24').all()).toHaveLength(
      1,
    );
    expect(db.prepare('SELECT name, status, archived_at FROM milestones').all()).toEqual([
      { name: 'Legacy milestone', status: 'completed', archived_at: null },
    ]);
    expect(db.prepare('SELECT name, status, milestone_id, archived_at FROM epics').all()).toEqual([
      { name: 'Legacy epic', status: 'completed', milestone_id: 1, archived_at: null },
    ]);
    for (const idx of ['idx_milestones_archived', 'idx_epics_archived']) {
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx),
      ).toBeTruthy();
    }
  });

  it('is idempotent — re-running migrations leaves one archived_at column and keeps values', () => {
    const db = migratedFixture();
    db.prepare("UPDATE milestones SET archived_at = '2026-10-09 10:00:00' WHERE id = 1").run();
    runMigrations(db);
    initScrumSchema(db);
    runMigrations(db);
    for (const t of ['milestones', 'epics']) {
      const cols = (db.pragma(`table_info(${t})`) as Array<{ name: string }>).filter(
        (c) => c.name === 'archived_at',
      );
      expect(cols).toHaveLength(1);
    }
    expect(
      (db.prepare('SELECT archived_at FROM milestones WHERE id = 1').get() as any).archived_at,
    ).toBe('2026-10-09 10:00:00');
  });
});

// ---------------------------------------------------------------------------
// v27 (#222): ticket_ref unique across the database — shared refs are renamed
// ---------------------------------------------------------------------------

describe('v27 unique ticket refs', () => {
  /** A DB at v26: no unique ref index yet, so refs can be shared. */
  function v26Db(): Database.Database {
    const db = freshDb({ freshDb: true });
    db.exec('DROP INDEX idx_tickets_ticket_ref_unique');
    db.prepare('DELETE FROM schema_versions WHERE version >= 27').run();
    return db;
  }
  const sprint = (db: Database.Database, name: string) =>
    Number(db.prepare('INSERT INTO sprints (name) VALUES (?)').run(name).lastInsertRowid);
  const refsById = (db: Database.Database) =>
    db.prepare('SELECT id, ticket_ref FROM tickets ORDER BY id').all();
  const refHistory = (db: Database.Database) =>
    db
      .prepare(
        "SELECT entity_id, old_value, new_value, actor FROM event_log WHERE entity_type = 'ticket' AND field_name = 'ticket_ref' ORDER BY id",
      )
      .all();

  function seedDuplicates(db: Database.Database) {
    const a = sprint(db, 'A');
    const b = sprint(db, 'B');
    const ins = db.prepare(
      'INSERT INTO tickets (sprint_id, ticket_ref, title, deleted_at) VALUES (?, ?, ?, ?)',
    );
    ins.run(null, 'T-1', 'no sprint, first', null); // id 1 keeps T-1
    ins.run(null, 'T-1', 'no sprint, second', null); // id 2
    ins.run(a, 'T-2', 'sprint A', null); // id 3 keeps T-2
    ins.run(b, 'T-2', 'sprint B, deleted', '2026-10-01 10:00:00'); // id 4
    ins.run(b, 'T-1', 'sprint B', null); // id 5
    ins.run(null, 'T-9', 'unique ref', null); // id 6
    ins.run(null, null, 'no ref', null); // id 7
  }

  it('renames shared refs deterministically: the lowest id keeps the ref', () => {
    const db = v26Db();
    seedDuplicates(db);
    runMigrations(db);
    // Next free refs start at MAX(id) + 1 = 8, in ref then id order: T-1 (ids 2, 5),
    // then T-2 (id 4). T-9 is taken by id 6, so it is skipped.
    expect(refsById(db)).toEqual([
      { id: 1, ticket_ref: 'T-1' },
      { id: 2, ticket_ref: 'T-8' },
      { id: 3, ticket_ref: 'T-2' },
      { id: 4, ticket_ref: 'T-11' },
      { id: 5, ticket_ref: 'T-10' },
      { id: 6, ticket_ref: 'T-9' },
      { id: 7, ticket_ref: null },
    ]);
  });

  it('records each old ref in the ticket history', () => {
    const db = v26Db();
    seedDuplicates(db);
    runMigrations(db);
    expect(refHistory(db)).toEqual([
      { entity_id: 2, old_value: 'T-1', new_value: 'T-8', actor: 'migration' },
      { entity_id: 5, old_value: 'T-1', new_value: 'T-10', actor: 'migration' },
      { entity_id: 4, old_value: 'T-2', new_value: 'T-11', actor: 'migration' },
    ]);
  });

  it('stamps v27, creates the unique index, and then refuses a shared ref', () => {
    const db = v26Db();
    seedDuplicates(db);
    runMigrations(db);
    expect(db.prepare('SELECT name FROM schema_versions WHERE version = 27').get()).toEqual({
      name: 'unique_ticket_refs',
    });
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_tickets_ticket_ref_unique'",
        )
        .get(),
    ).toBeTruthy();
    expect(() =>
      db.prepare("INSERT INTO tickets (ticket_ref, title) VALUES ('T-1', 'again')").run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('is idempotent: a second run renames nothing and writes no history', () => {
    const db = v26Db();
    seedDuplicates(db);
    runMigrations(db);
    const refs = refsById(db);
    const history = refHistory(db);
    runMigrations(db);
    expect(refsById(db)).toEqual(refs);
    expect(refHistory(db)).toEqual(history);
  });

  it('leaves a DB with unique refs unchanged', () => {
    const db = v26Db();
    db.prepare("INSERT INTO tickets (ticket_ref, title) VALUES ('T-1', 'a'), ('T-2', 'b')").run();
    runMigrations(db);
    expect(refsById(db)).toEqual([
      { id: 1, ticket_ref: 'T-1' },
      { id: 2, ticket_ref: 'T-2' },
    ]);
    expect(refHistory(db)).toEqual([]);
  });

  it('migrates a legacy v2.5.1 DB whose refs are shared (initScrumSchema runs first)', () => {
    const db = loadFixture('v2.5.1');
    // The fixture has T-1 and T-2 in sprint 1; a backlog ticket shares T-2.
    db.prepare(
      "INSERT INTO tickets (sprint_id, ticket_ref, title) VALUES (NULL, 'T-2', 'Backlog twin')",
    ).run();
    db.pragma('foreign_keys = ON');
    initSchema(db);
    expect(() => initScrumSchema(db)).not.toThrow();
    runMigrations(db);
    expect(db.prepare('SELECT ticket_ref, title FROM tickets ORDER BY id').all()).toEqual([
      { ticket_ref: 'T-1', title: 'Legacy ticket one' },
      { ticket_ref: 'T-2', title: 'Legacy ticket two' },
      { ticket_ref: 'T-4', title: 'Backlog twin' },
    ]);
    expect(refHistory(db)).toEqual([
      { entity_id: 3, old_value: 'T-2', new_value: 'T-4', actor: 'migration' },
    ]);
    expect(schemaSnapshot(db)).toEqual(schemaSnapshot(freshDb({ freshDb: true })));
  });
});
