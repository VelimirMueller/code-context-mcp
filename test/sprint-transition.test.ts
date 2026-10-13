/**
 * #189 — one transactional function runs a sprint phase transition and its
 * automation, for the MCP tools and the dashboard handlers alike.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';
import { apiAdvanceSprint, apiSprintUpdate } from '../src/dashboard/handlers/sprint.js';
import { SprintTransitionError, transitionSprint } from '../src/scrum/sprint-transition.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

interface Fixture {
  db: Database.Database;
  tools: Map<string, Handler>;
  sprintId: number;
  milestoneId: number;
  epicId: number;
}

/** A sprint in implementation: 2 DONE tickets (3 + 5 pt), 1 TODO (2 pt), 2 planned discoveries. */
function setup(): Fixture {
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  const milestoneId = Number(
    db.prepare(`INSERT INTO milestones (name, status) VALUES ('M', 'active')`).run()
      .lastInsertRowid,
  );
  const epicId = Number(
    db
      .prepare(`INSERT INTO epics (name, status, milestone_id) VALUES ('E', 'active', ?)`)
      .run(milestoneId).lastInsertRowid,
  );
  const sprintId = Number(
    db
      .prepare(
        `INSERT INTO sprints (name, status, velocity_committed, milestone_id) VALUES ('S1', 'implementation', 10, ?)`,
      )
      .run(milestoneId).lastInsertRowid,
  );
  const ticket = db.prepare(
    `INSERT INTO tickets (sprint_id, ticket_ref, title, priority, status, story_points, epic_id) VALUES (?, ?, ?, 'P1', ?, ?, ?)`,
  );
  const done1 = Number(ticket.run(sprintId, 'T-1', 'a', 'DONE', 3, epicId).lastInsertRowid);
  ticket.run(sprintId, 'T-2', 'b', 'DONE', 5, epicId);
  const todo = Number(ticket.run(sprintId, 'T-3', 'c', 'TODO', 2, null).lastInsertRowid);
  const disc = db.prepare(
    `INSERT INTO discoveries (discovery_sprint_id, finding, status, implementation_ticket_id) VALUES (?, ?, 'planned', ?)`,
  );
  disc.run(sprintId, 'd-done', done1);
  disc.run(sprintId, 'd-todo', todo);
  const server = new FakeServer();
  registerScrumTools(server as never, db);
  return { db, tools: server.tools, sprintId, milestoneId, epicId };
}

type Entry = 'mcp advance_sprint' | 'mcp update_sprint' | 'dashboard advance' | 'dashboard update';

async function moveTo(
  f: Fixture,
  entry: Entry,
  to: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (entry === 'mcp advance_sprint') {
      const r = await f.tools.get('advance_sprint')!({ sprint_id: f.sprintId });
      return { ok: !r.isError, message: r.content.map((c) => c.text).join('\n') };
    }
    if (entry === 'mcp update_sprint') {
      const r = await f.tools.get('update_sprint')!({ sprint_id: f.sprintId, status: to });
      return { ok: !r.isError, message: r.content.map((c) => c.text).join('\n') };
    }
    if (entry === 'dashboard advance') {
      apiAdvanceSprint(f.db, f.sprintId);
      return { ok: true, message: '' };
    }
    apiSprintUpdate(f.db, f.sprintId, { status: to });
    return { ok: true, message: '' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Everything the transition automation writes, without timestamps. */
function snapshot(f: Fixture) {
  const db = f.db;
  return {
    sprint: db
      .prepare(`SELECT status, velocity_committed, velocity_completed FROM sprints WHERE id = ?`)
      .get(f.sprintId),
    findings: db
      .prepare(`SELECT category, role FROM retro_findings WHERE sprint_id = ? ORDER BY id`)
      .all(f.sprintId),
    discoveries: db
      .prepare(`SELECT finding, status, drop_reason FROM discoveries ORDER BY id`)
      .all(),
    epic: db.prepare(`SELECT status FROM epics WHERE id = ?`).get(f.epicId),
    milestone: db
      .prepare(`SELECT progress, status FROM milestones WHERE id = ?`)
      .get(f.milestoneId),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transitionSprint: MCP and dashboard paths write the same automation (#189)', () => {
  const ENTRIES: Entry[] = [
    'mcp advance_sprint',
    'mcp update_sprint',
    'dashboard advance',
    'dashboard update',
  ];

  it('implementation → done: one auto-analysis (role system), discoveries implemented / dropped, velocity from DONE tickets', async () => {
    const outcomes = [];
    for (const entry of ENTRIES) {
      const f = setup();
      const r = await moveTo(f, entry, 'done');
      expect(r.ok, `${entry}: ${r.message}`).toBe(true);
      outcomes.push(snapshot(f));
    }
    for (const o of outcomes.slice(1)) expect(o).toEqual(outcomes[0]);
    expect(outcomes[0]).toEqual({
      sprint: { status: 'done', velocity_committed: 10, velocity_completed: 8 },
      findings: [{ category: 'auto_analysis', role: 'system' }],
      discoveries: [
        { finding: 'd-done', status: 'implemented', drop_reason: null },
        { finding: 'd-todo', status: 'dropped', drop_reason: 'Sprint closed without completion' },
      ],
      epic: { status: 'active' },
      milestone: { progress: 0, status: 'active' },
    });
  });

  it('done → rest completes the epic and updates the milestone on every path', async () => {
    const outcomes = [];
    for (const entry of ENTRIES) {
      const f = setup();
      f.db.prepare(`UPDATE tickets SET status = 'DONE' WHERE ticket_ref = 'T-3'`).run();
      f.db.prepare(`UPDATE sprints SET status = 'done' WHERE id = ?`).run(f.sprintId);
      const r = await moveTo(f, entry, 'rest');
      expect(r.ok, `${entry}: ${r.message}`).toBe(true);
      outcomes.push(snapshot(f));
    }
    for (const o of outcomes.slice(1)) expect(o).toEqual(outcomes[0]);
    expect(outcomes[0].epic).toEqual({ status: 'completed' });
    expect(outcomes[0].milestone).toEqual({ progress: 100, status: 'completed' });
  });

  it('a second close-out phase replaces the auto-analysis instead of adding one', () => {
    const f = setup();
    transitionSprint(f.db, f.sprintId, 'done', { actor: 'mcp', source: 'test' });
    transitionSprint(f.db, f.sprintId, 'closed', { actor: 'mcp', source: 'test' });
    expect(
      f.db
        .prepare(`SELECT COUNT(*) as c FROM retro_findings WHERE category = 'auto_analysis'`)
        .get(),
    ).toEqual({ c: 1 });
  });

  it('a missing sprint is a 404 SprintTransitionError', () => {
    const f = setup();
    expect(() =>
      transitionSprint(f.db, 999, 'done', { actor: 'dashboard', source: 'test' }),
    ).toThrow(SprintTransitionError);
    try {
      transitionSprint(f.db, 999, 'done', { actor: 'dashboard', source: 'test' });
    } catch (e) {
      expect((e as SprintTransitionError).status).toBe(404);
    }
  });
});

describe('transitionSprint: a failing step rolls the whole transition back (#189)', () => {
  for (const entry of [
    'mcp advance_sprint',
    'mcp update_sprint',
    'dashboard advance',
    'dashboard update',
  ] as Entry[]) {
    it(`${entry}: status, velocity and discoveries stay unchanged, and the error names the step`, async () => {
      const f = setup();
      const before = snapshot(f);
      // Fail the discovery archive step, after the status and the auto-analysis were written.
      f.db.exec(`CREATE TRIGGER fail_archive BEFORE UPDATE OF status ON discoveries
                 BEGIN SELECT RAISE(ABORT, 'archive exploded'); END`);
      const r = await moveTo(f, entry, 'done');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/step "archive_discoveries" failed: archive exploded/);
      expect(snapshot(f)).toEqual(before);
    });
  }

  it('the dashboard answers 500 for a failed step', () => {
    const f = setup();
    f.db.exec(
      `CREATE TRIGGER fail_retro BEFORE INSERT ON retro_findings BEGIN SELECT RAISE(ABORT, 'no'); END`,
    );
    let err: unknown;
    try {
      apiAdvanceSprint(f.db, f.sprintId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SprintTransitionError);
    expect((err as SprintTransitionError).status).toBe(500);
    expect((err as SprintTransitionError).step).toBe('auto_analysis');
  });
});

describe('get_discovery_coverage is read-only (#189)', () => {
  it('counts a planned discovery with a DONE ticket as implemented, but writes nothing', async () => {
    const f = setup();
    const before = f.db.prepare(`SELECT id, status, updated_at FROM discoveries ORDER BY id`).all();
    const r = await f.tools.get('get_discovery_coverage')!({ sprint_id: f.sprintId });
    const text = r.content.map((c) => c.text).join('\n');
    expect(text).toMatch(/\| Implemented \| 1 \| 50% \|/);
    expect(text).toMatch(/\| Planned \| 1 \| 50% \|/);
    expect(
      f.db.prepare(`SELECT id, status, updated_at FROM discoveries ORDER BY id`).all(),
    ).toEqual(before);
  });
});
