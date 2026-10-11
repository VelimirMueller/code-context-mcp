/**
 * CCA-01 (#116): the index stores realpaths, tools print project-relative paths.
 *
 * On macOS os.tmpdir() is /var/folders/… → /private/var/folders/…; agents
 * resolve their cwd to the realpath and refuse /var/… as outside the
 * workspace. Every root here is reached through an explicit symlink, so the
 * test means the same on Linux.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestDb } from "./helpers/db.js";
import { initSchema } from "../src/server/schema.js";
import { indexDirectory, migrateUnresolvedRoots } from "../src/server/indexer.js";
import { resolveToolPath, pathDisplay, canonicalPath } from "../src/server/path-resolve.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "test/fixtures/sample-project");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

let base: string; // realpath of a fresh temp dir
let real: string; // the project, by realpath
let link: string; // a symlink to it
let savedRoots: string | undefined;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca01-")));
  real = path.join(base, "real-project");
  fs.cpSync(FIXTURE, real, { recursive: true });
  link = path.join(base, "link-project");
  fs.symlinkSync(real, link, "dir");
  savedRoots = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
});

afterEach(() => {
  if (savedRoots === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  else process.env.CODE_CONTEXT_ALLOWED_ROOTS = savedRoots;
  fs.rmSync(base, { recursive: true, force: true });
});

const allPaths = (db: Database.Database): string[] =>
  (db.prepare(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]).map((r) => r.path);

describe("storage: realpath", () => {
  it("a symlinked root and its target index identically, one row per file", () => {
    const db = createTestDb();
    const viaLink = indexDirectory(db, link);
    expect(viaLink.root).toBe(real);
    const first = allPaths(db);
    expect(first.length).toBe(viaLink.files);
    expect(first.every((p) => p.startsWith(real + path.sep))).toBe(true);
    expect(first).toContain(path.join(real, "src/utils/helpers.ts"));

    indexDirectory(db, real);
    expect(allPaths(db)).toEqual(first);
    const roots = db.prepare(`SELECT root FROM indexed_repos`).all() as { root: string }[];
    expect(roots).toEqual([{ root: real }]);
    db.close();
  });

  it("rebases rows an older version stored under the symlinked spelling", () => {
    const db = createTestDb();
    indexDirectory(db, real);
    const expected = allPaths(db);
    // Simulate a pre-2.12 database: every row keyed by the symlinked root.
    db.exec(`UPDATE files SET path = '${link}' || substr(path, ${real.length + 1})`);
    db.exec(`UPDATE directories SET path = '${link}' || substr(path, ${real.length + 1}),
               parent_path = CASE WHEN parent_path IS NULL THEN NULL ELSE '${link}' || substr(parent_path, ${real.length + 1}) END`);
    db.exec(`UPDATE changes SET file_path = '${link}' || substr(file_path, ${real.length + 1})`);
    db.exec(`UPDATE indexed_repos SET root = '${link}'`);
    db.prepare(`UPDATE files SET description = 'manual' WHERE path = ?`).run(path.join(link, "src/types.ts"));

    // Lookups by either spelling still work before the migration (dual lookup).
    const legacy = path.join(link, "src/types.ts");
    expect(resolveToolPath(db, path.join(real, "src/types.ts"), "/elsewhere")).toEqual({ kind: "path", path: legacy });

    const moved = migrateUnresolvedRoots(db);
    expect(moved.roots).toBe(1);
    expect(allPaths(db)).toEqual(expected);
    expect((db.prepare(`SELECT description FROM files WHERE path = ?`).get(path.join(real, "src/types.ts")) as any).description).toBe("manual");
    expect(db.prepare(`SELECT COUNT(*) c FROM changes WHERE file_path LIKE ?`).get(`${link}%`)).toEqual({ c: 0 });
    expect(db.prepare(`SELECT COUNT(*) c FROM directories WHERE path LIKE ? OR parent_path LIKE ?`).get(`${link}%`, `${link}%`)).toEqual({ c: 0 });

    // A re-index through the link writes no second, differently-spelled row.
    indexDirectory(db, link);
    expect(allPaths(db)).toEqual(expected);
    db.close();
  });

  it("index_directory through the link rebases old rows itself (no boot migration)", () => {
    const db = createTestDb();
    indexDirectory(db, real);
    const expected = allPaths(db);
    db.exec(`UPDATE files SET path = '${link}' || substr(path, ${real.length + 1})`);
    db.exec(`UPDATE indexed_repos SET root = '${link}'`);
    indexDirectory(db, link);
    expect(allPaths(db)).toEqual(expected);
    db.close();
  });
});

describe("display and input", () => {
  it("prints relative paths under the root containing cwd; accepts every spelling back", () => {
    const db = createTestDb();
    indexDirectory(db, link);
    const file = path.join(real, "src/utils/helpers.ts");
    const show = pathDisplay(db, { cwd: link, absolute: false });
    expect(show(file)).toBe("src/utils/helpers.ts");
    expect(pathDisplay(db, { cwd: link, absolute: true })(file)).toBe(file);

    for (const input of ["src/utils/helpers.ts", "./src/utils/helpers.ts", file, path.join(link, "src/utils/helpers.ts")]) {
      expect(resolveToolPath(db, input, link)).toEqual({ kind: "path", path: file });
    }
    // From a subdirectory of the root, the printed (root-relative) path still resolves.
    expect(resolveToolPath(db, "src/utils/helpers.ts", path.join(link, "src/utils"))).toEqual({ kind: "path", path: file });
    db.close();
  });

  it("several roots in one db: files outside the cwd root stay absolute, so relative output is never ambiguous", () => {
    const other = path.join(base, "other-project");
    fs.cpSync(FIXTURE, other, { recursive: true });
    const db = createTestDb();
    indexDirectory(db, link);
    indexDirectory(db, other);
    const show = pathDisplay(db, { cwd: link, absolute: false });
    const mine = path.join(real, "src/types.ts");
    const theirs = path.join(other, "src/types.ts");
    expect(show(mine)).toBe("src/types.ts");
    expect(show(theirs)).toBe(theirs);
    expect(resolveToolPath(db, show(mine), link)).toEqual({ kind: "path", path: mine });
    expect(resolveToolPath(db, show(theirs), link)).toEqual({ kind: "path", path: theirs });

    // cwd above both roots (shared db over a workspace folder): relative to cwd.
    const fromBase = pathDisplay(db, { cwd: base, absolute: false });
    expect(fromBase(theirs)).toBe("other-project/src/types.ts");
    expect(resolveToolPath(db, fromBase(theirs), base)).toEqual({ kind: "path", path: theirs });

    // cwd unrelated to either root: absolute.
    const unrelated = fs.mkdtempSync(path.join(base, "elsewhere-"));
    expect(pathDisplay(db, { cwd: unrelated, absolute: false })(theirs)).toBe(theirs);
    expect(pathDisplay(db, { cwd: "/", absolute: false })(theirs)).toBe(theirs);
    db.close();
  });

  it("canonicalPath resolves a missing file under a symlinked dir", () => {
    expect(canonicalPath(path.join(link, "src/not-there.ts"))).toBe(path.join(real, "src/not-there.ts"));
  });
});

// ─── End to end over MCP stdio ───────────────────────────────────────────────
type Text = { content: { type: string; text: string }[]; isError?: boolean };

async function withServer<T>(dbPath: string, cwd: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY, dbPath],
    cwd,
    env: { ...(process.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: "code", CODE_CONTEXT_ALLOWED_ROOTS: base, OVERDRIVE_FLAIR: "0", CODE_CONTEXT_ABSOLUTE_PATHS: "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "cca01-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const text = (r: unknown): string => (r as Text).content.map((c) => c.text).join("\n");

describe("MCP stdio: get_file_context / find_symbol through a symlinked workspace", () => {
  it("prints relative paths and resolves relative, realpath and symlink input to the same file", async () => {
    const dbPath = path.join(link, "context.db");
    const db = new Database(dbPath);
    initSchema(db);
    indexDirectory(db, link);
    db.close();

    await withServer(dbPath, link, async (c) => {
      const viaRel = text(await c.callTool({ name: "get_file_context", arguments: { path: "src/utils/helpers.ts" } }));
      expect(viaRel.split("\n")[0]).toBe("# src/utils/helpers.ts");
      expect(fs.existsSync(path.join(real, "src/utils/helpers.ts"))).toBe(true);
      expect(viaRel).not.toContain(base);

      const viaReal = text(await c.callTool({ name: "get_file_context", arguments: { path: path.join(real, "src/utils/helpers.ts") } }));
      const viaLink = text(await c.callTool({ name: "get_file_context", arguments: { path: path.join(link, "src/utils/helpers.ts") } }));
      expect(viaReal).toBe(viaRel);
      expect(viaLink).toBe(viaRel);

      const api = text(await c.callTool({ name: "get_file_context", arguments: { path: "src/services/api.ts" } }));
      expect(api).toMatch(/^- src\/types\.ts \[/m);

      const sym = text(await c.callTool({ name: "find_symbol", arguments: { name: "formatDate" } }));
      expect(sym).toContain("formatDate (function) — src/utils/helpers.ts");

      const abs = text(await c.callTool({ name: "find_symbol", arguments: { name: "formatDate", absolute_paths: true } }));
      expect(abs).toContain(`— ${path.join(real, "src/utils/helpers.ts")}`);

      const found = text(await c.callTool({ name: "search_files", arguments: { query: "helpers" } }));
      expect(found.startsWith("src/utils/helpers.ts (")).toBe(true);
    });
  }, 60_000);
});
