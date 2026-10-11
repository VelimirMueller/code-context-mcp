import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createTestDb } from "./helpers/db.js";
import { indexDirectory } from "../src/server/indexer.js";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// The parseImports/parseExports functions are not exported from indexer.ts,
// so we test them through the indexing pipeline: write fixture files, index, query DB.

// createTempProject() builds fixtures under os.tmpdir(), which is outside cwd.
// indexDirectory() now sandboxes to cwd by default (#14), so allow tmpdir here.
const prevAllowedRoots = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
beforeAll(() => {
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = os.tmpdir();
});
afterAll(() => {
  if (prevAllowedRoots === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  else process.env.CODE_CONTEXT_ALLOWED_ROOTS = prevAllowedRoots;
});

function createTempProject(files: Record<string, string>): string {
  // realpath: the index stores realpaths (CCA-01); os.tmpdir() is a symlink on macOS.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parser-test-")));
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function getExports(db: Database.Database, filePath: string): { name: string; kind: string }[] {
  return db.prepare(`
    SELECT e.name, e.kind FROM exports e
    JOIN files f ON e.file_id = f.id
    WHERE f.path = ?
    ORDER BY e.name
  `).all(filePath) as { name: string; kind: string }[];
}

function getDeps(db: Database.Database, sourcePath: string): { target: string; symbols: string }[] {
  return db.prepare(`
    SELECT ft.path as target, d.symbols
    FROM dependencies d
    JOIN files fs ON d.source_id = fs.id
    JOIN files ft ON d.target_id = ft.id
    WHERE fs.path = ?
    ORDER BY ft.path
  `).all(sourcePath) as { target: string; symbols: string }[];
}

describe("Import Parsing", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
  });

  it("parses named imports", () => {
    tmpDir = createTempProject({
      "utils.ts": "export function foo() {}\nexport function bar() {}",
      "main.ts": "import { foo, bar } from './utils';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(1);
    expect(deps[0].symbols).toContain("foo");
    expect(deps[0].symbols).toContain("bar");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses default imports", () => {
    tmpDir = createTempProject({
      "utils.ts": "export default function helper() {}",
      "main.ts": "import helper from './utils';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(1);
    expect(deps[0].symbols).toBe("helper");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses namespace imports", () => {
    tmpDir = createTempProject({
      "utils.ts": "export function foo() {}",
      "main.ts": "import * as utils from './utils';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(1);
    expect(deps[0].symbols).toContain("* as utils");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses side-effect imports (no dependency link created since no symbols)", () => {
    tmpDir = createTempProject({
      "polyfill.ts": "console.log('loaded');",
      "main.ts": "import './polyfill';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    // Side-effect imports create a dependency with empty symbols
    expect(deps).toHaveLength(1);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses aliased imports", () => {
    tmpDir = createTempProject({
      "utils.ts": "export function originalName() {}",
      "main.ts": "import { originalName as alias } from './utils';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(1);
    expect(deps[0].symbols).toContain("originalName");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resolves index files for directory imports", () => {
    tmpDir = createTempProject({
      "lib/index.ts": "export function libFunc() {}",
      "main.ts": "import { libFunc } from './lib';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(1);
    expect(deps[0].target).toContain("lib/index.ts");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("skips external package imports (no dependency link)", () => {
    tmpDir = createTempProject({
      "main.ts": "import express from 'express';\nimport { z } from 'zod';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(0); // External imports don't create dependency links

    // But external imports are recorded in the files table
    const file = db.prepare("SELECT external_imports FROM files WHERE path = ?")
      .get(path.join(tmpDir, "main.ts")) as { external_imports: string };
    expect(file.external_imports).toContain("express");
    expect(file.external_imports).toContain("zod");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles scoped package imports (@org/pkg)", () => {
    tmpDir = createTempProject({
      "main.ts": "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    });
    indexDirectory(db, tmpDir);
    const file = db.prepare("SELECT external_imports FROM files WHERE path = ?")
      .get(path.join(tmpDir, "main.ts")) as { external_imports: string };
    expect(file.external_imports).toContain("@modelcontextprotocol/sdk");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles multiple imports from same module", () => {
    tmpDir = createTempProject({
      "utils.ts": "export function foo() {}\nexport function bar() {}",
      "main.ts": "import { foo } from './utils';\nimport { bar } from './utils';",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    // One edge per target (UNIQUE(source_id, target_id)) carrying both statements' symbols
    expect(deps).toHaveLength(1);
    expect(deps[0].symbols).toBe("foo, bar");
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("Export Parsing", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
  });

  it("parses exported functions", () => {
    tmpDir = createTempProject({
      "utils.ts": "export function myFunc() { return 1; }",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "utils.ts"));
    expect(exports).toContainEqual({ name: "myFunc", kind: "function" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses exported async functions (T-008 fix)", () => {
    tmpDir = createTempProject({
      "utils.ts": "export async function fetchData() { return []; }",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "utils.ts"));
    const funcExport = exports.find(e => e.name === "fetchData");
    expect(funcExport).toBeDefined();
    expect(funcExport!.kind).toBe("function");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses exported classes", () => {
    tmpDir = createTempProject({
      "api.ts": "export class ApiClient { fetch() {} }",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "api.ts"));
    expect(exports).toContainEqual({ name: "ApiClient", kind: "class" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses exported consts", () => {
    tmpDir = createTempProject({
      "config.ts": "export const MAX_SIZE = 1000;",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "config.ts"));
    expect(exports).toContainEqual({ name: "MAX_SIZE", kind: "const" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses exported types", () => {
    tmpDir = createTempProject({
      "types.ts": "export type UserId = string;",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "types.ts"));
    expect(exports).toContainEqual({ name: "UserId", kind: "type" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses exported interfaces", () => {
    tmpDir = createTempProject({
      "types.ts": "export interface User { id: string; name: string; }",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "types.ts"));
    expect(exports).toContainEqual({ name: "User", kind: "interface" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses exported enums", () => {
    tmpDir = createTempProject({
      "types.ts": "export enum Status { Active, Inactive }",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "types.ts"));
    expect(exports).toContainEqual({ name: "Status", kind: "enum" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses default function exports", () => {
    tmpDir = createTempProject({
      "handler.ts": "export default function handleRequest() {}",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "handler.ts"));
    expect(exports).toContainEqual({ name: "handleRequest", kind: "function" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses default class exports", () => {
    tmpDir = createTempProject({
      "service.ts": "export default class UserService {}",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "service.ts"));
    expect(exports).toContainEqual({ name: "UserService", kind: "class" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses re-exports (export { x })", () => {
    tmpDir = createTempProject({
      "internal.ts": "function hidden() {}\nconst secret = 42;",
      "public.ts": "const foo = 1;\nconst bar = 2;\nexport { foo, bar }",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "public.ts"));
    expect(exports).toContainEqual({ name: "foo", kind: "re-export" });
    expect(exports).toContainEqual({ name: "bar", kind: "re-export" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses let/var exports as const kind", () => {
    tmpDir = createTempProject({
      "state.ts": "export let counter = 0;\nexport var legacy = true;",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "state.ts"));
    expect(exports).toContainEqual({ name: "counter", kind: "const" });
    expect(exports).toContainEqual({ name: "legacy", kind: "const" });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles files with multiple export types", () => {
    tmpDir = createTempProject({
      "mixed.ts": [
        "export function doWork() {}",
        "export class Worker {}",
        "export type TaskId = string;",
        "export interface Task { id: TaskId; }",
        "export enum Priority { Low, High }",
        "export const DEFAULT_TIMEOUT = 5000;",
      ].join("\n"),
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "mixed.ts"));
    expect(exports.length).toBe(6);
    expect(exports.map(e => e.kind).sort()).toEqual(["class", "const", "enum", "function", "interface", "type"]);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles empty files (no exports)", () => {
    tmpDir = createTempProject({
      "empty.ts": "",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "empty.ts"));
    expect(exports).toHaveLength(0);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles files with only comments (no exports)", () => {
    tmpDir = createTempProject({
      "comments.ts": "// This file has no exports\n/* Just comments */",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "comments.ts"));
    expect(exports).toHaveLength(0);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("does not parse non-JS/TS files for exports", () => {
    tmpDir = createTempProject({
      "styles.css": ".export { color: red; }",
      "readme.md": "# Export documentation",
    });
    indexDirectory(db, tmpDir);
    const cssExports = getExports(db, path.join(tmpDir, "styles.css"));
    const mdExports = getExports(db, path.join(tmpDir, "readme.md"));
    expect(cssExports).toHaveLength(0);
    expect(mdExports).toHaveLength(0);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("Known Limitations (documented)", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
  });

  it("detects dynamic imports: import('./module') is a whole-module edge (CCA-05)", () => {
    tmpDir = createTempProject({
      "utils.ts": "export function foo() {}",
      "main.ts": "const m = await import('./utils');",
    });
    indexDirectory(db, tmpDir);
    const deps = getDeps(db, path.join(tmpDir, "main.ts"));
    expect(deps).toHaveLength(1);
    expect(deps[0].symbols).toBe("import()");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses re-exports with 'from' clause (T-008 fix)", () => {
    tmpDir = createTempProject({
      "internal.ts": "export function secret() {}",
      "barrel.ts": "export { secret } from './internal';",
    });
    indexDirectory(db, tmpDir);
    const exports = getExports(db, path.join(tmpDir, "barrel.ts"));
    expect(exports.length).toBeGreaterThan(0);
    expect(exports.find(e => e.name === "secret" && e.kind === "re-export")).toBeDefined();
    fs.rmSync(tmpDir, { recursive: true });
  });
});
