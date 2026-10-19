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
    allowed("UPDATE milestones SET status = 'active' WHERE id = 1");
    allowed("UPDATE projects SET repo = 'o/r' WHERE id = 1");
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
    allowed('DELETE FROM milestones WHERE id = 1');
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
