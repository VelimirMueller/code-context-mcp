/**
 * Sprint Statusline HUD — T-232 (B3).
 *
 * buildStatusline / findDb / applyStatuslineSetting are imported directly —
 * the bin guards main() behind an argv check, so importing never executes it.
 * Fixture DBs are real files in temp dirs (pattern: sprint-archive.test.ts)
 * because buildStatusline opens with { readonly: true, fileMustExist: true }.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initScrumSchema, runMigrations } from "../src/scrum/schema.js";
import { buildStatusline, findDb, applyStatuslineSetting } from "../src/server/statusline.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "statusline-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A NO_COLOR leaking in from the host environment would flip color expectations.
const savedNoColor = process.env.NO_COLOR;
beforeEach(() => {
  delete process.env.NO_COLOR;
});
afterAll(() => {
  if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
  else delete process.env.NO_COLOR;
});

const ESC = String.fromCharCode(27); // avoids a control char in a regex literal (no-control-regex)
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "");
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

function freshProjectDb(dir: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, "context.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initScrumSchema(db);
  runMigrations(db);
  return { db, dbPath };
}

function seedSprint(
  db: Database.Database,
  opts: { name?: string; status?: string; startDate?: string | null } = {}
): number {
  const result = db
    .prepare(`INSERT INTO sprints (name, status, start_date) VALUES (?, ?, ?)`)
    .run(
      opts.name ?? "Sprint 22 — Close the Loop & Light the Cockpit",
      opts.status ?? "implementation",
      opts.startDate === undefined ? daysAgo(1.5) : opts.startDate
    );
  return Number(result.lastInsertRowid);
}

/**
 * Mixed-status fixture: ✓2 (5pt done) ⚙1 ○2 ✗1, 12pt total, one open blocker,
 * mood 4 + 5 → ☀ 4.5. Started 1.5 days ago → day 2 of the default 5.
 */
function seedFullFixture(db: Database.Database): number {
  const sprintId = seedSprint(db);
  const ticket = db.prepare(
    `INSERT INTO tickets (sprint_id, title, status, story_points) VALUES (?, ?, ?, ?)`
  );
  ticket.run(sprintId, "done-a", "DONE", 3);
  ticket.run(sprintId, "done-b", "DONE", 2);
  ticket.run(sprintId, "wip-a", "IN_PROGRESS", 3);
  ticket.run(sprintId, "todo-a", "TODO", 1);
  ticket.run(sprintId, "todo-b", "TODO", 1);
  ticket.run(sprintId, "blocked-a", "BLOCKED", 2);
  db.prepare(`INSERT INTO blockers (sprint_id, description, status) VALUES (?, ?, 'open')`).run(
    sprintId,
    "external dependency"
  );
  const agent = db.prepare(`INSERT INTO agents (role, name) VALUES (?, ?)`);
  const dev = Number(agent.run("developer", "Dev").lastInsertRowid);
  const qa = Number(agent.run("qa", "QA").lastInsertRowid);
  const mood = db.prepare(
    `INSERT INTO agent_mood_history (agent_id, sprint_id, mood) VALUES (?, ?, ?)`
  );
  mood.run(dev, sprintId, 4);
  mood.run(qa, sprintId, 5);
  return sprintId;
}

/** Pre-v20 DB: no archived_at column, no skills/mood/discoveries tables. */
function legacyDb(dir: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, "context.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      start_date TEXT,
      deleted_at TEXT DEFAULT NULL
    );
    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      title TEXT,
      status TEXT NOT NULL,
      story_points INTEGER,
      deleted_at TEXT DEFAULT NULL
    );
    CREATE TABLE blockers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );
  `);
  return { db, dbPath };
}

// ── buildStatusline: active sprint ─────────────────────────────────────────

describe("buildStatusline — active sprint", () => {
  it("renders the full HUD line (plain, color: false)", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    seedFullFixture(db);
    db.close();

    const project = path.basename(dir);
    expect(buildStatusline(dbPath, { color: false })).toBe(
      `◆ ${project} ▸ S22 implementation · day 2/5  ▰▰▰▱▱▱▱▱ 5/12pt  ✓2 ⚙1 ○2 ✗1  ⛔1  ☀ 4.5`
    );
  });

  it("honors NO_COLOR (no escape codes, same text)", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    seedFullFixture(db);
    db.close();

    process.env.NO_COLOR = "1";
    const line = buildStatusline(dbPath);
    expect(line.includes(ESC)).toBe(false);
    expect(line).toBe(buildStatusline(dbPath, { color: false }));
  });

  it("colors the line by default and strips back to the plain text", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    seedFullFixture(db);
    db.close();

    const colored = buildStatusline(dbPath);
    expect(colored.includes(`${ESC}[36m`)).toBe(true); // cyan ◆/project
    expect(colored.includes(`${ESC}[1m`)).toBe(true); // bold short-name
    expect(colored.includes(`${ESC}[32m`)).toBe(true); // green ✓/done
    expect(colored.includes(`${ESC}[33m`)).toBe(true); // yellow ⚙
    expect(colored.includes(`${ESC}[31m`)).toBe(true); // red ✗/⛔ (counts > 0)
    expect(colored.includes(`${ESC}[2m`)).toBe(true); // dim separators
    expect(stripAnsi(colored)).toBe(buildStatusline(dbPath, { color: false }));
  });

  it("clamps the day to the sprint length", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    seedSprint(db, { startDate: daysAgo(30) });
    db.close();
    expect(buildStatusline(dbPath, { color: false })).toContain("day 5/5");
  });

  it("falls back to day 1 when start_date is missing or in the future", () => {
    const dirMissing = makeTempDir();
    const missing = freshProjectDb(dirMissing);
    seedSprint(missing.db, { startDate: null });
    missing.db.close();
    expect(buildStatusline(missing.dbPath, { color: false })).toContain("day 1/5");

    const dirFuture = makeTempDir();
    const future = freshProjectDb(dirFuture);
    seedSprint(future.db, { startDate: daysAgo(-3) });
    future.db.close();
    expect(buildStatusline(future.dbPath, { color: false })).toContain("day 1/5");
  });

  it("reads the sprint length from SPRINT_PROCESS_JSON (sprint_length_days or duration_days)", () => {
    const dirA = makeTempDir();
    const a = freshProjectDb(dirA);
    seedSprint(a.db, { startDate: daysAgo(6.5) });
    a.db.prepare(`INSERT INTO skills (name, content) VALUES ('SPRINT_PROCESS_JSON', ?)`).run(
      JSON.stringify({ sprint_length_days: 10 })
    );
    a.db.close();
    expect(buildStatusline(a.dbPath, { color: false })).toContain("day 7/10");

    const dirB = makeTempDir();
    const b = freshProjectDb(dirB);
    seedSprint(b.db, { startDate: daysAgo(6.5) });
    b.db.prepare(`INSERT INTO skills (name, content) VALUES ('SPRINT_PROCESS_JSON', ?)`).run(
      JSON.stringify({ duration_days: 8 })
    );
    b.db.close();
    expect(buildStatusline(b.dbPath, { color: false })).toContain("day 7/8");
  });

  it("defaults the sprint length to 5 when the config is unparseable", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    seedSprint(db, { startDate: daysAgo(30) });
    db.prepare(`INSERT INTO skills (name, content) VALUES ('SPRINT_PROCESS_JSON', ?)`).run(
      "{ not json"
    );
    db.close();
    expect(buildStatusline(dbPath, { color: false })).toContain("day 5/5");
  });

  it("renders the progress bar at the empty, partial, and full extremes", () => {
    const dirEmpty = makeTempDir();
    const empty = freshProjectDb(dirEmpty);
    seedSprint(empty.db);
    empty.db.close();
    expect(buildStatusline(empty.dbPath, { color: false })).toContain("▱▱▱▱▱▱▱▱ 0/0pt");

    const dirFull = makeTempDir();
    const full = freshProjectDb(dirFull);
    const sid = seedSprint(full.db);
    full.db
      .prepare(`INSERT INTO tickets (sprint_id, title, status, story_points) VALUES (?, 'x', 'DONE', 7)`)
      .run(sid);
    full.db.close();
    expect(buildStatusline(full.dbPath, { color: false })).toContain("▰▰▰▰▰▰▰▰ 7/7pt");
  });

  it("omits the ⛔ segment when no blocker is open and ☀ when no mood is recorded", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    const sid = seedSprint(db);
    db.prepare(
      `INSERT INTO blockers (sprint_id, description, status, resolved_at) VALUES (?, 'fixed', 'resolved', datetime('now'))`
    ).run(sid);
    db.close();

    const line = buildStatusline(dbPath, { color: false });
    expect(line.includes("⛔")).toBe(false);
    expect(line.includes("☀")).toBe(false);
  });

  it("truncates names without a sprint number to 18 chars", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    seedSprint(db, { name: "Hardening & Polish Marathon Q3" });
    db.close();
    expect(buildStatusline(dbPath, { color: false })).toContain("▸ Hardening & Polish implementation");
  });

  it("falls back to the no-archived_at query on pre-v20 databases", () => {
    const dir = makeTempDir();
    const { db, dbPath } = legacyDb(dir);
    db.prepare(`INSERT INTO sprints (name, status) VALUES ('Sprint 7', 'implementation')`).run();
    const ticket = db.prepare(
      `INSERT INTO tickets (sprint_id, title, status, story_points) VALUES (1, ?, ?, ?)`
    );
    ticket.run("done", "DONE", 2);
    ticket.run("todo", "TODO", 2);
    db.close();

    const project = path.basename(dir);
    expect(buildStatusline(dbPath, { color: false })).toBe(
      `◆ ${project} ▸ S7 implementation · day 1/5  ▰▰▰▰▱▱▱▱ 2/4pt  ✓1 ⚙0 ○1 ✗0`
    );
  });
});

// ── buildStatusline: no active sprint ──────────────────────────────────────

describe("buildStatusline — no active sprint", () => {
  it("shows the open-discoveries count between sprints", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    const closed = seedSprint(db, { name: "Sprint 1", status: "closed" });
    seedSprint(db, { name: "Sprint 2", status: "rest" });
    const discovery = db.prepare(
      `INSERT INTO discoveries (discovery_sprint_id, finding, status) VALUES (?, ?, ?)`
    );
    discovery.run(closed, "open one", "discovered");
    discovery.run(closed, "open two", "discovered");
    discovery.run(closed, "already planned", "planned");
    db.close();

    const project = path.basename(dir);
    expect(buildStatusline(dbPath, { color: false })).toBe(
      `◆ ${project} ▸ no active sprint · 2 open discoveries`
    );
  });

  it("ignores archived and deleted sprints", () => {
    const dir = makeTempDir();
    const { db, dbPath } = freshProjectDb(dir);
    const archived = seedSprint(db, { name: "Sprint 3" });
    db.prepare(`UPDATE sprints SET archived_at = datetime('now') WHERE id = ?`).run(archived);
    const deleted = seedSprint(db, { name: "Sprint 4" });
    db.prepare(`UPDATE sprints SET deleted_at = datetime('now') WHERE id = ?`).run(deleted);
    db.close();

    const project = path.basename(dir);
    expect(buildStatusline(dbPath, { color: false })).toBe(
      `◆ ${project} ▸ no active sprint · 0 open discoveries`
    );
  });

  it("omits the discovery segment when the discoveries table is missing", () => {
    const dir = makeTempDir();
    const { db, dbPath } = legacyDb(dir);
    db.prepare(`INSERT INTO sprints (name, status) VALUES ('Sprint 1', 'closed')`).run();
    db.close();

    const project = path.basename(dir);
    expect(buildStatusline(dbPath, { color: false })).toBe(`◆ ${project} ▸ no active sprint`);
  });
});

// ── findDb ─────────────────────────────────────────────────────────────────

describe("findDb", () => {
  it("walks up from a nested directory to the context.db", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "context.db");
    fs.writeFileSync(dbPath, "");
    const nested = path.join(dir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    expect(findDb(nested)).toBe(dbPath);
  });

  it("returns null when no context.db exists within 10 levels", () => {
    // 12-deep chain with no DB anywhere: the walk stops well inside the temp
    // tree, so a stray context.db higher up on the host can never interfere.
    const dir = makeTempDir();
    const deep = path.join(dir, ...Array.from({ length: 12 }, (_, i) => `d${i}`));
    fs.mkdirSync(deep, { recursive: true });
    expect(findDb(deep)).toBeNull();
  });
});

// ── applyStatuslineSetting (setup step merge-safety) ───────────────────────

describe("applyStatuslineSetting", () => {
  // Isolate from the developer's real ~/.claude/settings.json.
  const noUserDir = path.join(tmpdir(), "statusline-no-user-config");

  it("merges statusLine into existing settings, preserving every key", () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const existing = {
      model: "opus",
      hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node hook.js" }] }] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

    expect(applyStatuslineSetting(dir, noUserDir)).toBe("written");

    const raw = fs.readFileSync(settingsPath, "utf-8");
    const merged = JSON.parse(raw);
    expect(merged.model).toBe("opus");
    expect(merged.hooks).toEqual(existing.hooks);
    expect(merged.statusLine).toEqual({ type: "command", command: "code-context-statusline" });
    expect(raw).toContain('  "statusLine"'); // 2-space indent
  });

  it("never clobbers an existing statusLine", () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "my-custom-line" } }, null, 2) + "\n"
    );
    const before = fs.readFileSync(settingsPath, "utf-8");

    expect(applyStatuslineSetting(dir, noUserDir)).toBe("kept-existing");
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("creates .claude/settings.json when missing", () => {
    const dir = makeTempDir();
    expect(applyStatuslineSetting(dir, noUserDir)).toBe("written");
    const merged = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf-8"));
    expect(merged).toEqual({ statusLine: { type: "command", command: "code-context-statusline" } });
  });

  it("keeps a user-level statusLine and writes nothing to the project", () => {
    const dir = makeTempDir();
    const userDir = makeTempDir();
    fs.writeFileSync(
      path.join(userDir, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "my-user-line" } })
    );

    expect(applyStatuslineSetting(dir, userDir)).toBe("kept-user");
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  it("keeps a statusLine from the project's settings.local.json", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude", "settings.local.json"),
      JSON.stringify({ statusLine: { type: "command", command: "my-local-line" } })
    );

    expect(applyStatuslineSetting(dir, noUserDir)).toBe("kept-user");
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  it("ignores an unreadable user settings file", () => {
    const dir = makeTempDir();
    const userDir = makeTempDir();
    fs.writeFileSync(path.join(userDir, "settings.json"), "{ not json");

    expect(applyStatuslineSetting(dir, userDir)).toBe("written");
  });
});
