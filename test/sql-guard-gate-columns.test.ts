// CCA-37 (#181): `execute` cannot write the gate columns.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { checkGateColumns, tokenize } from '../src/server/sql-gate-columns.js';
import { runWriteStatement, validateWriteStatement } from '../src/server/sql-guard.js';

function scrumDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initScrumSchema(db);
  runMigrations(db, { freshDb: true });
  db.prepare("INSERT INTO sprints (id, name, status) VALUES (1, 'S1', 'planning')").run();
  db.prepare(
    "INSERT INTO tickets (id, sprint_id, ticket_ref, title, status) VALUES (1, 1, 'T-1', 'one', 'TODO')",
  ).run();
  db.prepare("INSERT INTO milestones (id, name) VALUES (1, 'M1')").run();
  db.prepare("INSERT INTO projects (id, name, repo) VALUES (1, 'p', 'o/r')").run();
  return db;
}

type Row = Record<string, unknown>;
const ticket = (db: Database.Database): Row =>
  db.prepare('SELECT * FROM tickets WHERE id = 1').get() as Row;

function denied(sql: string): string {
  const r = validateWriteStatement(sql);
  expect(r.ok, sql).toBe(false);
  return r.ok ? '' : r.error;
}

function allowed(sql: string): void {
  const r = validateWriteStatement(sql);
  expect(r.ok, `${sql} → ${r.ok ? '' : r.error}`).toBe(true);
}

describe('execute gate columns: UPDATE (#181)', () => {
  it('refuses tickets.status and names the column and update_ticket', () => {
    const err = denied("UPDATE tickets SET status = 'DONE' WHERE id = 1");
    expect(err).toContain('tickets.status');
    expect(err).toContain('update_ticket');
  });

  it('refuses tickets.qa_verified and tickets.verified_by', () => {
    expect(denied('UPDATE tickets SET qa_verified = 1 WHERE id = 1')).toContain(
      'tickets.qa_verified',
    );
    expect(denied("UPDATE tickets SET verified_by = 'qa' WHERE id = 1")).toContain(
      'tickets.verified_by',
    );
  });

  it('refuses the 2.12.0 bypass: pointing a ticket at a GitHub issue', () => {
    const err = denied('UPDATE tickets SET github_issue = 999 WHERE id = 1');
    expect(err).toContain('tickets.github_issue');
    expect(err).toContain('sync_github');
    expect(denied("UPDATE tickets SET github_repo = 'evil/repo' WHERE id = 1")).toContain(
      'tickets.github_repo',
    );
    expect(denied("UPDATE tickets SET github_node_id = 'I_x' WHERE id = 1")).toContain(
      'tickets.github_node_id',
    );
  });

  it('refuses a gate column after free columns in the SET list', () => {
    denied("UPDATE tickets SET title = 'x', notes = 'y', status = 'DONE' WHERE id = 1");
    denied("UPDATE tickets SET title = (SELECT 'a,b' FROM tickets LIMIT 1), status = 'DONE'");
    denied("UPDATE tickets SET title = CASE WHEN id = 1 THEN 'a' ELSE 'b' END, status = 'DONE'");
  });

  it('refuses quoted column names in every quote style', () => {
    for (const col of ['"status"', '`status`', '[status]', "'status'", 'STATUS', '"QA_Verified"']) {
      denied(`UPDATE tickets SET ${col} = 'DONE' WHERE id = 1`);
    }
  });

  it('refuses quoted, schema-qualified and aliased tables', () => {
    denied('UPDATE "tickets" SET status = \'DONE\'');
    denied("UPDATE [Tickets] SET status = 'DONE'");
    denied("UPDATE main.tickets SET status = 'DONE'");
    denied('UPDATE main."tickets" SET status = \'DONE\'');
    denied("UPDATE tickets AS t SET status = 'DONE' WHERE t.id = 1");
    denied("UPDATE tickets t SET status = 'DONE' WHERE t.id = 1");
    denied("UPDATE tickets AS t SET t.status = 'DONE'");
    denied("UPDATE tickets NOT INDEXED SET status = 'DONE'");
  });

  it('refuses row-value SET lists and UPDATE … FROM', () => {
    denied("UPDATE tickets SET (title, status) = ('x', 'DONE') WHERE id = 1");
    denied("UPDATE tickets SET status = s.v FROM (SELECT 'DONE' AS v) AS s WHERE tickets.id = 1");
  });

  it('refuses UPDATE OR REPLACE on a gated table', () => {
    expect(denied("UPDATE OR REPLACE tickets SET title = 'x' WHERE id = 1")).toContain('REPLACE');
  });

  it('refuses sprints.status and the github columns of milestones and projects', () => {
    expect(denied("UPDATE sprints SET status = 'done' WHERE id = 1")).toContain('advance_sprint');
    expect(denied('UPDATE milestones SET github_milestone = 3 WHERE id = 1')).toContain(
      'milestones.github_milestone',
    );
    denied("UPDATE milestones SET github_node_id = 'x' WHERE id = 1");
    expect(denied("UPDATE projects SET github_project_id = 'x' WHERE id = 1")).toContain(
      'set_project',
    );
  });

  it('allows writes to free columns of gated tables', () => {
    allowed("UPDATE tickets SET title = 'status', notes = 'qa_verified = 1' WHERE status = 'DONE'");
    allowed("UPDATE tickets SET assigned_to = 'dev' WHERE github_issue IS NULL");
    allowed("UPDATE sprints SET goal = 'g' WHERE status = 'planning'");
    allowed("UPDATE milestones SET description = 'd' WHERE status = 'active'");
    allowed("UPDATE projects SET updated_at = datetime('now') WHERE repo = 'o/r'");
  });

  it('allows a status column on a table without gates (the bridge statement)', () => {
    allowed(
      "UPDATE pending_actions SET status='completed', completed_at=datetime('now') WHERE id IN (1,2)",
    );
    allowed("UPDATE retro_findings SET status = 'adopted' WHERE id = 1");
  });
});

describe('execute gate columns: parser differentials and lifecycle columns (#181)', () => {
  it('reads IS [NOT] DISTINCT FROM as an expression, not the end of the SET list', () => {
    expect(
      denied("UPDATE tickets SET title = title IS DISTINCT FROM 'x', status = 'DONE' WHERE id = 1"),
    ).toContain('tickets.status');
    expect(
      denied(
        "UPDATE tickets SET title = title IS NOT DISTINCT FROM 'x', qa_verified = 1 WHERE id = 1",
      ),
    ).toContain('tickets.qa_verified');
    allowed("UPDATE tickets SET notes = title IS DISTINCT FROM 'x' WHERE id = 1");
  });

  it('refuses a SET item hidden after a FROM clause (fail-closed tail scan)', () => {
    denied("UPDATE tickets SET title = 1 FROM tags AS o, status = 'DONE'");
    denied("UPDATE tickets SET title = 1 FROM tags AS o status = 'DONE'");
    denied('UPDATE tickets SET title = o.name FROM tags AS o, tags AS p WHERE o.id = p.id');
    denied('UPDATE tickets SET title = o.name FROM tags o JOIN tags p ON o.id = p.id');
  });

  it('allows UPDATE … FROM on a gated table when the FROM clause holds no comma or assignment', () => {
    allowed(
      "UPDATE tickets SET notes = s.v FROM (SELECT 'n' AS v, 1 AS id) AS s WHERE tickets.id = s.id",
    );
  });

  it('refuses the soft-delete and archive columns of the gated tables', () => {
    expect(denied("UPDATE tickets SET deleted_at = datetime('now') WHERE id = 1")).toContain(
      'tickets.deleted_at',
    );
    expect(denied("UPDATE sprints SET deleted_at = datetime('now') WHERE id = 1")).toContain(
      'sprints.deleted_at',
    );
    expect(denied("UPDATE sprints SET archived_at = datetime('now') WHERE id = 1")).toContain(
      'sprints.archived_at',
    );
    expect(denied("UPDATE milestones SET archived_at = datetime('now') WHERE id = 1")).toContain(
      'update_milestone',
    );
    expect(denied("UPDATE epics SET archived_at = datetime('now') WHERE id = 1")).toContain(
      'update_epic',
    );
    denied("INSERT INTO tickets (title, deleted_at) VALUES ('x', datetime('now'))");
    allowed("UPDATE milestones SET deleted_at = datetime('now') WHERE id = 1");
    allowed("UPDATE epics SET description = 'e' WHERE id = 1");
  });

  it('the differential shapes it refuses are statements SQLite prepares', () => {
    const db = scrumDb();
    try {
      for (const sql of [
        "UPDATE tickets SET title = title IS DISTINCT FROM 'x', status = 'DONE' WHERE id = 1",
        "UPDATE tickets SET title = title IS NOT DISTINCT FROM 'x', qa_verified = 1 WHERE id = 1",
      ]) {
        expect(() => db.prepare(sql), sql).not.toThrow();
        expect(runWriteStatement(db, sql).ok, sql).toBe(false);
      }
      expect(ticket(db).status).toBe('TODO');
      expect(ticket(db).qa_verified).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('execute gate columns: keywords that SQLite also reads as names (#181)', () => {
  it('refuses a SET item after a word the parser could take for RETURNING', () => {
    expect(denied("UPDATE tickets SET title = returning, status = 'DONE' WHERE id = 1")).toMatch(
      /tickets\.status|shape not understood/,
    );
    // Invalid SQL, but the guard must refuse it on its own.
    denied("UPDATE tickets SET title = x RETURNING id, status = 'DONE'");
    denied("UPDATE tickets SET title = x AND returning, status = 'DONE'");
    denied("UPDATE tickets SET title = 1 WHERE id = 1, status = 'DONE'");
    denied("UPDATE tickets SET title = 1 ORDER BY id, status = 'DONE'");
  });

  it('refuses a hidden item after an upsert DO UPDATE SET stop word', () => {
    denied(
      "INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET title = x RETURNING id, status = 'DONE'",
    );
    allowed(
      "INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET title = excluded.title WHERE excluded.id = 1",
    );
  });

  it('still allows the common WHERE comparisons on gated tables', () => {
    allowed("UPDATE tickets SET notes = 'n' WHERE id = 1 AND sprint_id = 2 OR title = 'x'");
    allowed("UPDATE tickets SET notes = 'n' WHERE id IN (1, 2, 3)");
  });

  it('refuses 50 generated valid UPDATE shapes that write a gate column (fuzz)', () => {
    // Small deterministic PRNG (mulberry32) so failures reproduce.
    let seed = 0x181;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const quote = (n: string): string =>
      pick([n, n.toUpperCase(), `"${n}"`, `\`${n}\``, `[${n}]`, `'${n}'`]);

    const gated: Record<string, readonly string[]> = {
      tickets: [
        'status',
        'qa_verified',
        'verified_by',
        'github_issue',
        'github_repo',
        'deleted_at',
      ],
      sprints: ['status', 'deleted_at', 'archived_at'],
      milestones: ['status', 'archived_at', 'github_milestone'],
      epics: ['status', 'archived_at'],
      projects: ['name', 'repo', 'github_assignee', 'github_project_number'],
    };
    const free: Record<string, readonly string[]> = {
      tickets: ['title', 'notes', 'assigned_to', 'description'],
      sprints: ['goal', 'name'],
      milestones: ['description', 'target_date', 'progress'],
      epics: ['description', 'color', 'priority'],
      projects: ['updated_at'],
    };
    const exprs = [
      "'x'",
      '1',
      '?',
      "id || 'x'",
      "CASE WHEN id = 1 THEN 'a' ELSE 'b' END",
      '(SELECT name FROM tags LIMIT 1)',
      "id IS DISTINCT FROM 'x'",
      "id IS NOT DISTINCT FROM 'x'",
      "coalesce(NULL, 'n')",
      "lower('A') = 'a'",
      "'a,b' || 'returning'",
      'id BETWEEN 1 AND 2',
      "id IN (1, 2) AND 'from' = 'where'",
    ];
    const db = scrumDb();
    try {
      for (let k = 0; k < 50; k++) {
        const table = pick(['tickets', 'sprints', 'milestones', 'epics', 'projects'] as const);
        const tableRef = pick([table, `main.${table}`, `"${table}"`, `[${table}]`]);
        const alias = pick(['', ' AS t']);
        const items: string[] = [];
        for (let f = Math.floor(rnd() * 3); f > 0; f--) {
          items.push(`${quote(pick(free[table]))} = ${pick(exprs)}`);
        }
        const g = quote(pick(gated[table]));
        const gatedItem =
          rnd() < 0.25
            ? `(${quote(pick(free[table]))}, ${g}) = (${pick(exprs)}, ${pick(exprs)})`
            : `${g} = ${pick(exprs)}`;
        items.splice(Math.floor(rnd() * (items.length + 1)), 0, gatedItem);
        const where = pick(['', ' WHERE id = 1', ` WHERE ${pick(exprs)}`]);
        const sql = `UPDATE ${tableRef}${alias} SET ${items.join(', ')}${where}`;
        expect(() => db.prepare(sql), sql).not.toThrow();
        expect(validateWriteStatement(sql).ok, sql).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

describe('execute gate columns: INSERT, REPLACE and upsert (#181)', () => {
  it('refuses a gate column in the INSERT column list', () => {
    expect(denied("INSERT INTO tickets (title, status) VALUES ('x', 'DONE')")).toContain(
      'tickets.status',
    );
    denied('INSERT INTO tickets (title, "qa_verified") VALUES (\'x\', 1)');
    denied("INSERT INTO tickets (title, [github_issue]) VALUES ('x', 5)");
    denied("INSERT INTO sprints (name, status) VALUES ('s', 'done')");
  });

  it('refuses INSERT … SELECT that names a gate column', () => {
    denied('INSERT INTO tickets (title, status) SELECT title, status FROM tickets');
  });

  it('refuses INSERT without a column list on a gated table', () => {
    expect(denied('INSERT INTO tickets SELECT * FROM tickets')).toContain('column list');
    denied("INSERT INTO tickets VALUES (99, 1, 'T-9', 'x')");
  });

  it('refuses REPLACE and INSERT OR REPLACE on a gated table', () => {
    denied("REPLACE INTO tickets (id, title) VALUES (1, 'x')");
    expect(denied("INSERT OR REPLACE INTO tickets (id, title) VALUES (1, 'x')")).toContain(
      'REPLACE',
    );
    denied("INSERT OR REPLACE INTO sprints (id, name) VALUES (1, 'x')");
  });

  it('refuses an upsert whose DO UPDATE SET writes a gate column', () => {
    const err = denied(
      "INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET status = 'DONE'",
    );
    expect(err).toContain('tickets.status');
    denied(
      "INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET title = excluded.title WHERE 1 ON CONFLICT DO UPDATE SET qa_verified = 1",
    );
    denied(
      "INSERT INTO tickets AS t (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET (title, github_issue) = ('x', 5)",
    );
  });

  it('allows inserts and upserts that leave the gate columns alone', () => {
    allowed("INSERT INTO tickets (title, notes) VALUES ('status', 'DONE')");
    allowed(
      "INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET title = excluded.title",
    );
    allowed("INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT DO NOTHING");
    allowed("INSERT OR IGNORE INTO tickets (title) VALUES ('x')");
    allowed('INSERT INTO tags (name) VALUES (?)');
    allowed("INSERT OR REPLACE INTO tags (name) VALUES ('x')");
  });
});

describe('execute gate columns: DELETE and statement shapes (#181)', () => {
  it('refuses DELETE on tickets and sprints (delete-and-reinsert bypass)', () => {
    expect(denied('DELETE FROM tickets WHERE id = 1')).toContain('update_ticket');
    denied('DELETE FROM main."tickets"');
    denied('DELETE FROM sprints WHERE id = 1');
  });

  it('allows DELETE on tables without a delete gate', () => {
    allowed('DELETE FROM tags WHERE id = 1');
    allowed('DELETE FROM decisions WHERE id = 1');
  });

  it('rejects CTE-prefixed writes, stacked statements and comments before the gate', () => {
    denied("WITH x AS (SELECT 1) UPDATE tickets SET status = 'DONE'");
    denied("UPDATE tags SET name = 'x'; UPDATE tickets SET status = 'DONE'");
    denied("UPDATE tickets SET title = 'x' /* , status = 'DONE' */");
    denied("UPDATE tickets SET title = 'x' -- , status = 'DONE'");
  });

  it('refuses statements it cannot read on a gated table', () => {
    expect(denied('UPDATE tickets SET status')).toMatch(/could not be checked/);
    denied("UPDATE tickets SET title = 'unterminated");
  });

  it('checkGateColumns reads strings and quoted names without mixing them up', () => {
    expect(checkGateColumns("UPDATE tickets SET title = 'it''s status = 1'").ok).toBe(true);
    expect(tokenize('"a""b" [c] `d` \'e\'').map((t) => t.value)).toEqual(['a"b', 'c', 'd', 'e']);
    // Non-ASCII identifiers (BMP and astral) stay one word token.
    expect(tokenize('caf\u00e9_\u{1F600}x').map((t) => t.kind)).toEqual(['word']);
    // Comments never reach the gate (validateWriteStatement rejects them first); fail closed anyway.
    expect(checkGateColumns("UPDATE tickets SET title = 'x' /* open").ok).toBe(false);
  });
});

describe('execute gate columns: runWriteStatement on the real schema (#181)', () => {
  it('leaves the row unchanged when the 2.12.0 github bypass is refused', () => {
    const db = scrumDb();
    try {
      const r = runWriteStatement(
        db,
        'UPDATE tickets SET github_issue = ?, github_repo = ? WHERE id = 1',
        [42, 'evil/repo'],
      );
      expect(r.ok).toBe(false);
      expect(ticket(db).github_issue).toBeNull();
      expect(ticket(db).github_repo).toBeNull();
    } finally {
      db.close();
    }
  });

  it('cannot close a ticket or verify it through execute', () => {
    const db = scrumDb();
    try {
      for (const sql of [
        "UPDATE tickets SET status = 'DONE', qa_verified = 1 WHERE id = 1",
        "INSERT INTO tickets (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET status = 'DONE'",
        "INSERT OR REPLACE INTO tickets (id, sprint_id, ticket_ref, title) VALUES (1, 1, 'T-1', 'one')",
        'DELETE FROM tickets WHERE id = 1',
        "UPDATE sprints SET status = 'done' WHERE id = 1",
      ]) {
        expect(runWriteStatement(db, sql).ok, sql).toBe(false);
      }
      expect(ticket(db).status).toBe('TODO');
      expect(ticket(db).qa_verified).toBe(0);
      const sprint = db.prepare('SELECT status FROM sprints WHERE id = 1').get() as Row;
      expect(sprint.status).toBe('planning');
    } finally {
      db.close();
    }
  });

  it('still runs a free-column write on a gated table', () => {
    const db = scrumDb();
    try {
      const r = runWriteStatement(db, 'UPDATE tickets SET notes = ? WHERE id = 1', ['n']);
      expect(r.ok).toBe(true);
      expect(ticket(db).notes).toBe('n');
    } finally {
      db.close();
    }
  });

  it('every gate-column UPDATE the parser refuses is a statement the driver accepts', () => {
    // Guards against testing shapes SQLite itself would reject: each one must prepare.
    const db = scrumDb();
    try {
      for (const sql of [
        "UPDATE tickets SET 'status' = 'DONE'",
        "UPDATE tickets AS t SET status = 'DONE' WHERE t.id = 1",
        "UPDATE main.tickets SET (title, status) = ('x', 'DONE')",
        "UPDATE tickets SET status = s.v FROM (SELECT 'DONE' AS v) AS s WHERE tickets.id = 1",
        "INSERT INTO tickets AS t (id, title) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET (title, github_issue) = ('x', 5)",
      ]) {
        expect(() => db.prepare(sql), sql).not.toThrow();
        expect(validateWriteStatement(sql).ok, sql).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

describe('execute gate columns: archive preconditions, sync targets and deletes (#263)', () => {
  it('refuses milestones.status and epics.status (the archive check reads them)', () => {
    const m = denied("UPDATE milestones SET status = 'completed' WHERE id = 1");
    expect(m).toContain('milestones.status');
    expect(m).toContain('update_milestone');
    const e = denied("UPDATE epics SET status = 'completed' WHERE id = 1");
    expect(e).toContain('epics.status');
    expect(e).toContain('update_epic');
    denied('UPDATE milestones AS m SET "Status" = \'completed\'');
    denied("UPDATE epics SET (description, status) = ('d', 'completed')");
    denied("INSERT INTO milestones (name, status) VALUES ('m', 'completed')");
    denied(
      "INSERT INTO epics (id, name) VALUES (1, 'e') ON CONFLICT(id) DO UPDATE SET status = 'completed'",
    );
  });

  it('refuses projects.repo and projects.name, the columns sync_github resolves its target from', () => {
    const repo = denied("UPDATE projects SET repo = 'evil/repo' WHERE id = 1");
    expect(repo).toContain('projects.repo');
    expect(repo).toContain('set_project');
    const name = denied("UPDATE projects SET name = 'other' WHERE id = 1");
    expect(name).toContain('projects.name');
    expect(name).toContain('set_project');
    for (const col of [
      'github_project_owner',
      'github_project_number',
      'github_assignee',
      'github_project_id',
    ]) {
      expect(denied(`UPDATE projects SET ${col} = 'x' WHERE id = 1`)).toContain(`projects.${col}`);
    }
    denied("INSERT INTO projects (name, repo) VALUES ('p2', 'evil/repo')");
    denied("UPDATE main.[projects] SET 'repo' = 'evil/repo'");
  });

  it('refuses DELETE on projects, milestones and epics with the tool to use', () => {
    expect(denied('DELETE FROM projects WHERE id = 1')).toContain('set_project');
    expect(denied('DELETE FROM milestones WHERE id = 1')).toContain('update_milestone');
    expect(denied('DELETE FROM epics WHERE id = 1')).toContain('update_epic');
    denied('DELETE FROM main."Milestones"');
    denied('DELETE FROM [epics] WHERE 1');
  });

  it('still allows the free columns of milestones, epics and projects', () => {
    allowed("UPDATE milestones SET description = 'd', target_date = '2026-12-01' WHERE id = 1");
    allowed("UPDATE epics SET color = '#fff', priority = 2 WHERE status = 'active'");
    allowed("INSERT INTO epics (name, description) VALUES ('e', 'd')");
  });

  it('a refused milestone or epic DELETE leaves the ON DELETE SET NULL links of tickets alone', () => {
    const db = scrumDb();
    try {
      db.prepare("INSERT INTO epics (id, name) VALUES (1, 'E1')").run();
      db.prepare('UPDATE tickets SET milestone_id = 1, epic_id = 1 WHERE id = 1').run();
      // The cascade the gate prevents: on a copy, a DELETE nulls the ticket links.
      const probe = scrumDb();
      try {
        probe.prepare("INSERT INTO epics (id, name) VALUES (1, 'E1')").run();
        probe.prepare('UPDATE tickets SET milestone_id = 1, epic_id = 1 WHERE id = 1').run();
        probe.prepare('DELETE FROM epics WHERE id = 1').run();
        probe.prepare('DELETE FROM milestones WHERE id = 1').run();
        expect(ticket(probe).milestone_id).toBeNull();
        expect(ticket(probe).epic_id).toBeNull();
      } finally {
        probe.close();
      }
      for (const sql of [
        'DELETE FROM milestones WHERE id = 1',
        'DELETE FROM epics WHERE id = 1',
        'DELETE FROM projects WHERE id = 1',
        "UPDATE milestones SET status = 'completed' WHERE id = 1",
        "UPDATE projects SET repo = 'evil/repo' WHERE id = 1",
      ]) {
        expect(runWriteStatement(db, sql).ok, sql).toBe(false);
      }
      expect(ticket(db).milestone_id).toBe(1);
      expect(ticket(db).epic_id).toBe(1);
      const m = db.prepare('SELECT status FROM milestones WHERE id = 1').get() as Row;
      expect(m.status).toBe('planned');
      const p = db.prepare('SELECT repo FROM projects WHERE id = 1').get() as Row;
      expect(p.repo).toBe('o/r');
    } finally {
      db.close();
    }
  });
});

describe('execute gate columns over MCP stdio (#181)', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const SERVER_ENTRY = path.join(REPO_ROOT, 'src/server/index.ts');
  type ToolResult = { isError?: boolean; content: { text: string }[] };
  const text = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

  it('the execute tool refuses the github bypass with a tool error and leaves the row alone', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cca37-')));
    const env = { ...(process.env as Record<string, string>), CODE_CONTEXT_ALLOWED_ROOTS: base };
    const client = new Client({ name: 'cca37-test', version: '0.0.0' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [TSX_CLI, SERVER_ENTRY, path.join(base, 'context.db')],
          cwd: base,
          env,
          stderr: 'ignore',
        }),
      );
      const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
        (await client.callTool({ name, arguments: args })) as ToolResult;

      const { tools } = await client.listTools();
      const desc = tools.find((t) => t.name === 'execute')?.description ?? '';
      for (const word of ['milestones', 'projects.name/repo', 'update_milestone', 'set_project']) {
        expect(desc).toContain(word);
      }

      const insert = await call('execute', { sql: "INSERT INTO tickets (title) VALUES ('t')" });
      expect(insert.isError ?? false).toBe(false);

      const bypass = await call('execute', {
        sql: 'UPDATE tickets SET github_issue = ? WHERE title = ?',
        params: [7, 't'],
      });
      expect(bypass.isError).toBe(true);
      expect(text(bypass)).toContain('tickets.github_issue');
      expect(text(bypass)).toContain('sync_github');

      const done = await call('execute', { sql: "UPDATE tickets SET status = 'DONE'" });
      expect(done.isError).toBe(true);
      expect(text(done)).toContain('update_ticket');

      const row = await call('query', { sql: 'SELECT status, github_issue FROM tickets' });
      expect(text(row)).toContain('TODO');
      expect(text(row)).not.toMatch(/\b7\b/);
    } finally {
      await client.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
