/**
 * CCA-04 (#119): get_file_context carries one-line signatures, line numbers
 * and the file's raw import lines, so "how do I call X / what does it depend
 * on" needs no follow-up read of the file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initSchema } from "../src/server/schema.js";
import { indexDirectory, recordIndexedRoot, toISOLocal } from "../src/server/indexer.js";
import { exportDetails, importLines, declarationLines, oneLine, MAX_SIGNATURE_CHARS } from "../src/server/signatures.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(REPO_ROOT, "test/fixtures/sample-project");
const SHAPES = path.join(REPO_ROOT, "test/fixtures/file-context");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

const read = (p: string) => fs.readFileSync(p, "utf-8");

// ─── Parser (unit) ───────────────────────────────────────────────────────────
describe("exportDetails — TypeScript", () => {
  const d = exportDetails(read(path.join(SHAPES, "shapes.ts")), ".ts");
  const sig = (n: string) => d.get(n)?.signature;

  it("gives every declaration its line and a one-line signature without a body", () => {
    expect(d.get("Point")).toEqual({ line: 11, signature: "interface Point extends Base<number>" });
    expect(sig("Shape")).toBe('type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number }');
    expect(sig("Color")).toBe("enum Color");
    expect(d.get("loadShapes")).toEqual({
      line: 22,
      signature: "async function loadShapes<T extends Shape>(file: string, opts: { strict?: boolean } = {}): Promise<{ shapes: T[]; color: Color }>",
    });
    expect(sig("area")).toBe("const area = (s: Shape): number =>");
    expect(sig("DEFAULTS")).toBe("const DEFAULTS: Config = {…}");
    expect(sig("ShapeStore")).toBe("class ShapeStore extends Map<string, Shape> implements Iterable<[string, Shape]>");
  });

  it("caps a long signature at MAX_SIGNATURE_CHARS with an ellipsis", () => {
    const params = Array.from({ length: 30 }, (_, i) => `p${i}: string`).join(", ");
    const long = exportDetails(`export function big(${params}): void {}`, ".ts").get("big")!.signature!;
    expect(long.length).toBeLessThanOrEqual(MAX_SIGNATURE_CHARS);
    expect(long.length).toBeGreaterThan(MAX_SIGNATURE_CHARS - 5);
    expect(long.endsWith("…")).toBe(true);
    expect(oneLine("a\n   b\tc")).toBe("a b c");
  });
});

describe("exportDetails — JavaScript and Python", () => {
  it("JS: function and let", () => {
    const d = exportDetails(read(path.join(SHAPES, "legacy.js")), ".js");
    expect(d.get("join")).toEqual({ line: 6, signature: "function join(a, b)" });
    expect(d.get("counter")).toEqual({ line: 10, signature: "let counter = 0" });
  });

  it("Python: def, async def over several lines, class, constants", () => {
    const d = exportDetails(read(path.join(SHAPES, "pkg/service.py")), ".py");
    expect(d.get("MAX_RETRIES")).toEqual({ line: 13, signature: "MAX_RETRIES = 3" });
    expect(d.get("DEFAULTS")).toEqual({ line: 14, signature: "DEFAULTS = {…}" });
    expect(d.get("fetch")).toEqual({ line: 19, signature: "def fetch(url: str, retries: int = MAX_RETRIES) -> Optional[str]" });
    expect(d.get("fetch_many")).toEqual({ line: 24, signature: "async def fetch_many(urls: List[str], limit: int = 10) -> List[str]" });
    expect(d.get("Client")).toEqual({ line: 31, signature: "class Client(models.Base)" });
  });
});

describe("importLines", () => {
  it("TS: named, multi-line, side-effect and export-from statements, with their start line", () => {
    expect(importLines(read(path.join(SHAPES, "shapes.ts")), ".ts")).toEqual([
      { line: 2, text: 'import fs from "node:fs";' },
      { line: 3, text: 'import { readConfig, type Config } from "./config.js";' },
      { line: 7, text: 'import "./side-effect.js";' },
      { line: 8, text: 'export * from "./reexported.js";' },
    ]);
  });

  it("JS: require lines", () => {
    expect(importLines(read(path.join(SHAPES, "legacy.js")), ".js")).toEqual([
      { line: 2, text: 'const path = require("path");' },
      { line: 3, text: 'const { helper } = require("./helper");' },
    ]);
  });

  it("Python: import / from-import (parenthesised), never inside a docstring", () => {
    expect(importLines(read(path.join(SHAPES, "pkg/service.py")), ".py")).toEqual([
      { line: 5, text: "import os" },
      { line: 6, text: "import json as j" },
      { line: 7, text: "from typing import (Optional, List)" },
      { line: 11, text: "from . import models" },
    ]);
  });
});

describe("declarationLines", () => {
  it("stops at the end of the declaration and marks truncation", () => {
    const src = read(path.join(SHAPES, "shapes.ts"));
    expect(declarationLines(src, 30, ".ts", 20)).toEqual({
      lines: [
        "export const area = (s: Shape): number => {",
        '  return s.kind === "circle" ? Math.PI * s.r ** 2 : s.side ** 2;',
        "};",
      ],
      truncated: false,
    });
    const cut = declarationLines(src, 22, ".ts", 3);
    expect(cut.lines).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    const py = declarationLines(read(path.join(SHAPES, "pkg/service.py")), 31, ".py", 20);
    expect(py.lines[0]).toBe("class Client(models.Base):");
    expect(py.lines[py.lines.length - 1]).toBe("        return fetch(path)");
  });
});

// ─── Schema upgrade (old DB) ─────────────────────────────────────────────────
describe("schema upgrade from a pre-v25 DB", () => {
  it("adds exports.signature/line and files.import_lines; old rows stay readable", () => {
    const sql = read(path.join(REPO_ROOT, "test/fixtures/legacy-dbs/v2.5.1.sql"));
    const db = new Database(":memory:");
    db.exec(sql);
    const cols = (t: string) => (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name);
    expect(cols("exports")).not.toContain("signature");
    db.prepare(`INSERT INTO files (path, language, extension) VALUES ('/x/a.ts', 'typescript', '.ts')`).run();
    db.prepare(`INSERT INTO exports (file_id, name, kind) VALUES (1, 'old', 'function')`).run();

    initSchema(db);
    initSchema(db); // idempotent
    expect(cols("exports").filter((c) => c === "signature" || c === "line")).toEqual(["signature", "line"]);
    expect(cols("files")).toContain("import_lines");
    expect(db.prepare(`SELECT name, kind, signature, line FROM exports`).get()).toEqual({ name: "old", kind: "function", signature: null, line: null });
  });
});

// ─── End to end over MCP stdio ───────────────────────────────────────────────
type Text = { content: { type: string; text: string }[] };
const text = (r: unknown): string => (r as Text).content.map((c) => c.text).join("\n");

let base: string;
let client: Client;
let call: (args: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca04-")));
  const proj = path.join(base, "proj");
  fs.cpSync(SAMPLE, proj, { recursive: true });
  fs.cpSync(SHAPES, path.join(proj, "extra"), { recursive: true });
  // A big file: more exports and import lines than get_file_context lists.
  const big = [
    ...Array.from({ length: 45 }, (_, i) => `import { m${i} } from "./mod${i}.js";`),
    ...Array.from({ length: 55 }, (_, i) => `export function f${i}(a: number): number { return a + m${i % 45}; }`),
  ].join("\n");
  fs.writeFileSync(path.join(proj, "extra/big.ts"), big);

  // Old row: indexed by a pre-v25 build (no signatures, no import lines) — a
  // separate root that is NOT in indexed_repos, so nothing can re-index it.
  const oldDir = path.join(base, "old");
  fs.mkdirSync(oldDir);
  const oldFile = path.join(oldDir, "legacy.ts");
  fs.writeFileSync(oldFile, `import x from "./x.js";\nexport function old(a: string): string { return a + x; }\n`);

  const dbPath = path.join(base, "context.db");
  const db = new Database(dbPath);
  initSchema(db);
  const savedRoots = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
  try { indexDirectory(db, proj); } finally {
    if (savedRoots === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    else process.env.CODE_CONTEXT_ALLOWED_ROOTS = savedRoots;
  }
  const st = fs.statSync(oldFile);
  db.prepare(`INSERT INTO files (path, language, extension, size_bytes, line_count, content, modified_at) VALUES (?, 'typescript', '.ts', ?, 2, ?, ?)`)
    .run(oldFile, st.size, read(oldFile), toISOLocal(st.mtime));
  db.prepare(`INSERT INTO exports (file_id, name, kind) VALUES ((SELECT id FROM files WHERE path = ?), 'old', 'function')`).run(oldFile);
  // Pre-v25 rows of an indexed repo: wipe the new data for types.ts.
  db.prepare(`UPDATE exports SET signature = NULL, line = NULL WHERE file_id = (SELECT id FROM files WHERE path LIKE '%/src/types.ts')`).run();
  db.prepare(`UPDATE files SET import_lines = NULL WHERE path LIKE '%/src/types.ts'`).run();
  recordIndexedRoot(db, proj, null, 0);
  db.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY, dbPath],
    cwd: proj,
    env: { ...(process.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: "code", CODE_CONTEXT_ALLOWED_ROOTS: base, OVERDRIVE_FLAIR: "0", CODE_CONTEXT_ABSOLUTE_PATHS: "" },
    stderr: "ignore",
  });
  client = new Client({ name: "cca04-test", version: "0.0.0" });
  await client.connect(transport);
  call = async (args) => text(await client.callTool({ name: "get_file_context", arguments: args }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("get_file_context over MCP stdio", () => {
  it("helpers.ts: signatures with line numbers, under 1.5 KB", async () => {
    const out = await call({ path: "src/utils/helpers.ts" });
    expect(out).toContain("## Exports (5)\n- L6 function formatDate(date: Date): string\n");
    expect(out).toContain("- L21 function clamp(value: number, min: number, max: number): number");
    expect(out).toContain("- L32 const DEFAULT_PAGE_SIZE = 20");
    expect(Buffer.byteLength(out)).toBeLessThan(1_500);
    expect(out).not.toMatch(/\n\n\n/); // empty sections leave no blank lines
  }, 30_000);

  it("api.ts: import lines with line numbers next to the resolved edges", async () => {
    const out = await call({ path: "src/services/api.ts" });
    expect(out).toContain('## Import lines (2)\nL2 import { HttpMethod } from "../types.js";\nL3 import type { ApiResponse, User } from "../types.js";');
    expect(out).toContain("- L36 function createApiClient(baseUrl: string): ApiClient");
    expect(out).toMatch(/^- src\/types\.ts \[/m);
  }, 30_000);

  it("JS and Python files", async () => {
    const js = await call({ path: "extra/legacy.js" });
    expect(js).toContain("- L6 function join(a, b)");
    expect(js).toContain('L2 const path = require("path");');
    const py = await call({ path: "extra/pkg/service.py" });
    expect(py).toContain("- L19 def fetch(url: str, retries: int = MAX_RETRIES) -> Optional[str]");
    expect(py).toContain("- L31 class Client(models.Base)");
    expect(py).toContain("L11 from . import models");
    expect(py).not.toContain("_private");
  }, 30_000);

  it("big file: lists are capped with a +N more line", async () => {
    const out = await call({ path: "extra/big.ts" });
    expect(out).toContain("## Exports (55)");
    expect(out).toContain("+15 more");
    expect(out).toContain("## Import lines (45)");
    expect(out).toContain("+15 more");
    expect(out.length).toBeLessThan(6_000);
  }, 30_000);

  it("snippet: true adds each export's source, capped per export", async () => {
    const plain = await call({ path: "src/index.ts" });
    expect(plain).not.toContain("const client = createApiClient");
    const out = await call({ path: "src/index.ts", snippet: true });
    expect(out).toContain("- L6 function createApp(apiUrl: string)\n    export function createApp(apiUrl: string) {\n      const client = createApiClient(apiUrl);");
    expect(out).toContain("\n    …\n- L30 const APP_VERSION"); // 23-line body cut at 20 lines
    expect(out).toContain('- L30 const APP_VERSION = "0.1.0"\n    export const APP_VERSION = "0.1.0";');
    const big = await call({ path: "extra/big.ts", snippet: true });
    expect(big).toContain("(snippet budget reached)");
    expect(big.length - (await call({ path: "extra/big.ts" })).length).toBeLessThan(2_048 + 200);
  }, 30_000);

  it("a pre-v25 row of an indexed repo is re-indexed quietly and gains signatures", async () => {
    const out = await call({ path: "src/types.ts" });
    expect(out).toContain("- L3 interface User");
    expect(out).toContain("- L25 enum HttpMethod");
    expect(out).not.toContain("re-indexed");
  }, 30_000);

  it("a pre-v25 row that cannot be re-indexed still renders (name + kind)", async () => {
    const out = await call({ path: path.join(base, "old/legacy.ts") });
    expect(out).toContain("## Exports (1)\n- old (function)");
    expect(out).not.toContain("Import lines");
  }, 30_000);
});
