/**
 * #214: PUT /api/milestone/:id (planningHandlers.apiMilestoneUpdate) checks
 * and writes in one statement. A milestone deleted after the existence check
 * gets 404, never a 200 for an update that changed nothing.
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { apiMilestoneUpdate } from '../src/dashboard/handlers/planning.js';

function setup() {
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  const id = Number(
    db.prepare(`INSERT INTO milestones (name, status) VALUES ('M-214', 'planned')`).run()
      .lastInsertRowid,
  );
  return { db, id };
}

/**
 * The same connection, but `onCheck` runs right after the handler's existence
 * check (the SELECT on milestones) returns: the gap the old code had.
 */
function deleteAfterCheck(db: Database.Database, onCheck: () => void): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!/^\s*SELECT id FROM milestones/i.test(sql)) return stmt;
        return {
          get: (...args: unknown[]) => {
            const row = stmt.get(...args);
            onCheck();
            return row;
          },
        };
      };
    },
  });
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status;
  }
}

describe('PUT /api/milestone/:id — milestone deleted during the update (#214)', () => {
  it('returns the saved row when the milestone stays', () => {
    const { db, id } = setup();
    const row = apiMilestoneUpdate(db, id, { status: 'active', target_date: '2026-12-15' });
    expect(row).toMatchObject({ id, status: 'active', target_date: '2026-12-15' });
  });

  it('answers 404 when the milestone is soft-deleted between check and update', () => {
    const { db, id } = setup();
    const racing = deleteAfterCheck(db, () => {
      db.prepare(`UPDATE milestones SET deleted_at = datetime('now') WHERE id = ?`).run(id);
    });
    expect(statusOf(() => apiMilestoneUpdate(racing, id, { status: 'active' }))).toBe(404);
    // The deleted row keeps its old values.
    expect(db.prepare('SELECT status FROM milestones WHERE id = ?').get(id)).toEqual({
      status: 'planned',
    });
  });

  it('answers 404 when the milestone row is removed between check and update', () => {
    const { db, id } = setup();
    const racing = deleteAfterCheck(db, () => {
      db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
    });
    expect(statusOf(() => apiMilestoneUpdate(racing, id, { status: 'active' }))).toBe(404);
  });

  it('keeps 404 for a missing milestone and 400 for an empty body', () => {
    const { db, id } = setup();
    expect(statusOf(() => apiMilestoneUpdate(db, 9999999, { status: 'active' }))).toBe(404);
    expect(statusOf(() => apiMilestoneUpdate(db, id, {}))).toBe(400);
  });
});
