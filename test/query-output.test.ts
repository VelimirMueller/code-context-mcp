/**
 * CCA-03 (#118): the `query` tool output is bounded — row cap, char cap,
 * long-cell cut — and files.content leaves only when the SELECT list names it.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/server/schema.js";
import {
  runBoundedQuery,
  namedInSelectList,
  QUERY_DESCRIPTION,
  QUERY_MAX_ROWS,
  QUERY_MAX_CHARS,
  QUERY_MAX_CELL_CHARS,
} from "../src/server/query-output.js";

function codeDb(files = 3, contentChars = 100): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  const ins = db.prepare("INSERT INTO files (path, language, line_count, summary, content) VALUES (?, 'ts', 1, ?, ?)");
  for (let i = 0; i < files; i++) ins.run(`/repo/src/f${i}.ts`, `file ${i}`, "x".repeat(contentChars));
  return db;
}

function ok(r: ReturnType<typeof runBoundedQuery>): string {
  expect(r.ok).toBe(true);
  return r.ok ? r.text : "";
}

/** The JSON array before any notes. */
function rows(text: string): Record<string, unknown>[] {
  return JSON.parse(text.split("\n\n")[0]);
}

describe("query description (CCA-03)", () => {
  it("carries the real column names of the code-index tables, without content", () => {
    for (const col of ["path", "language", "size_bytes", "line_count", "summary", "external_imports", "indexed_at"]) {
      expect(QUERY_DESCRIPTION).toContain(col);
    }
    expect(QUERY_DESCRIPTION).toContain("exports(id, file_id, name, kind, description, signature, line)");
    expect(QUERY_DESCRIPTION).toContain("dependencies(id, source_id, target_id, symbols)");
    expect(QUERY_DESCRIPTION).toMatch(/Who imports X/);
    expect(QUERY_DESCRIPTION).not.toMatch(/\bcontent\b/);
  });

  it("matches schema.ts: every listed files column exists", () => {
    const db = codeDb(0);
    try {
      const cols = (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name);
      const listed = /files\(([^)]*)\)/.exec(QUERY_DESCRIPTION)![1].split(",").map((s) => s.trim());
      for (const c of listed) expect(cols).toContain(c);
      expect(listed.sort()).toEqual(cols.filter((c) => c !== "content").sort());
    } finally {
      db.close();
    }
  });
});

describe("query output caps (CCA-03)", () => {
  it("returns plain JSON when nothing is cut", () => {
    const db = codeDb(3);
    try {
      const text = ok(runBoundedQuery(db, "SELECT path, line_count FROM files ORDER BY path"));
      expect(JSON.parse(text)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("caps rows at QUERY_MAX_ROWS with a shown/total note", () => {
    const db = codeDb(QUERY_MAX_ROWS + 20, 1);
    try {
      const text = ok(runBoundedQuery(db, "SELECT id FROM files"));
      expect(rows(text)).toHaveLength(QUERY_MAX_ROWS);
      expect(text).toContain(`Truncated: ${QUERY_MAX_ROWS} of ${QUERY_MAX_ROWS + 20} rows shown (${QUERY_MAX_ROWS}-row cap)`);
      expect(text).toMatch(/add WHERE or LIMIT, or select fewer columns/);
    } finally {
      db.close();
    }
  });

  it("caps output at about QUERY_MAX_CHARS with a note", () => {
    const db = codeDb(40);
    try {
      db.prepare("UPDATE files SET summary = ?").run("s".repeat(900));
      const text = ok(runBoundedQuery(db, "SELECT path, summary FROM files"));
      const shown = rows(text);
      expect(shown.length).toBeLessThan(40);
      expect(text.split("\n\n")[0].length).toBeLessThanOrEqual(QUERY_MAX_CHARS + 10);
      expect(text).toContain(`Truncated: ${shown.length} of 40 rows shown (${QUERY_MAX_CHARS / 1000} KB output cap)`);
    } finally {
      db.close();
    }
  });

  it("cuts long cell values with a marker and a substr hint", () => {
    const db = codeDb(1);
    try {
      db.prepare("UPDATE files SET summary = ?").run("y".repeat(QUERY_MAX_CELL_CHARS + 234));
      const text = ok(runBoundedQuery(db, "SELECT summary FROM files"));
      const summary = rows(text)[0].summary as string;
      expect(summary).toBe(`${"y".repeat(QUERY_MAX_CELL_CHARS)}…[+234 chars]`);
      expect(text).toMatch(/use substr\(col, start, len\)/);
    } finally {
      db.close();
    }
  });

  it("points at the schema when a column name is guessed", () => {
    const db = codeDb(1);
    try {
      const r = runBoundedQuery(db, "SELECT from_file FROM dependencies");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no such column.*PRAGMA table_info/);
    } finally {
      db.close();
    }
  });

  it("runs PRAGMA table_info through the tool path", () => {
    const db = codeDb(0);
    try {
      const names = rows(ok(runBoundedQuery(db, "PRAGMA table_info(dependencies)"))).map((r) => r.name);
      expect(names).toEqual(["id", "source_id", "target_id", "symbols"]);
    } finally {
      db.close();
    }
  });

  it("bounds a sqlite_master dump", () => {
    const db = codeDb(0);
    try {
      const text = ok(runBoundedQuery(db, "SELECT * FROM sqlite_master"));
      expect(text.split("\n\n")[0].length).toBeLessThanOrEqual(QUERY_MAX_CHARS + QUERY_MAX_CELL_CHARS * 5);
    } finally {
      db.close();
    }
  });
});

describe("files.content only when named (CCA-03)", () => {
  it("SELECT * FROM files omits content, with a note", () => {
    const db = codeDb(2);
    try {
      const text = ok(runBoundedQuery(db, "SELECT * FROM files"));
      const r = rows(text);
      expect(r[0]).toHaveProperty("path");
      expect(r[0]).not.toHaveProperty("content");
      expect(text).toMatch(/files\.content \(whole file text\) omitted/);
    } finally {
      db.close();
    }
  });

  it("omits it through f.*, CTEs and subqueries, and when only WHERE uses it", () => {
    const db = codeDb(2);
    try {
      for (const sql of [
        "SELECT f.* FROM files f",
        "WITH x AS (SELECT * FROM files) SELECT * FROM x",
        "SELECT * FROM (SELECT * FROM files)",
        "SELECT * FROM files WHERE content LIKE '%x%'",
      ]) {
        expect(rows(ok(runBoundedQuery(db, sql)))[0], sql).not.toHaveProperty("content");
      }
    } finally {
      db.close();
    }
  });

  it("SELECT content FROM files returns it, cut to the cell cap", () => {
    const db = codeDb(1, QUERY_MAX_CELL_CHARS + 50);
    try {
      const text = ok(runBoundedQuery(db, "SELECT path, content FROM files"));
      expect(rows(text)[0].content).toBe(`${"x".repeat(QUERY_MAX_CELL_CHARS)}…[+50 chars]`);
      expect(text).not.toMatch(/omitted/);
      expect(rows(ok(runBoundedQuery(db, "SELECT f.content AS c FROM files f")))[0].c).toMatch(/^x+…/);
    } finally {
      db.close();
    }
  });

  it("namedInSelectList ignores strings, WHERE and inner FROMs", () => {
    expect(namedInSelectList("SELECT content FROM files", "content")).toBe(true);
    expect(namedInSelectList("SELECT substr(f.content, 1, 99) FROM files f", "content")).toBe(true);
    expect(namedInSelectList("SELECT (SELECT 1 FROM t), content FROM files", "content")).toBe(true);
    expect(namedInSelectList("SELECT * FROM files WHERE content LIKE '%x%'", "content")).toBe(false);
    expect(namedInSelectList("SELECT 'content' FROM files", "content")).toBe(false);
    expect(namedInSelectList("SELECT * FROM files", "content")).toBe(false);
  });
});
