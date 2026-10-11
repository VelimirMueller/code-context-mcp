/**
 * CCA-06 (#121): model-facing results stay compact. Over MCP stdio:
 * - the server sends short `instructions` naming the listed code tools;
 * - the `code` profile prints no flair and no `modified`/`indexed` timestamps
 *   by default; OVERDRIVE_FLAIR=1 and CODE_CONTEXT_TIMESTAMPS=1 bring them back;
 * - index_directory prints each directory's stats once.
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
import { indexDirectory } from "../src/server/indexer.js";
import { MAX_INSTRUCTIONS_CHARS } from "../src/server/tool-wrap.js";
import { stripDirStats } from "../src/server/index-summary.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(REPO_ROOT, "test/fixtures/sample-project");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");
const STAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
const text = (r: unknown): string => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

let base: string;
let proj: string;
let dbPath: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca06-")));
  proj = path.join(base, "proj");
  fs.cpSync(SAMPLE, proj, { recursive: true });
  dbPath = path.join(base, "context.db");
  const db = new Database(dbPath);
  initSchema(db);
  const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
  try {
    indexDirectory(db, proj);
  } finally {
    if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
  }
  db.close();
});
afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** A client on the shared db; `extra` env wins, `unset` names are removed. */
async function connect(extra: Record<string, string>, unset: string[] = []): Promise<Client> {
  const env = { ...(process.env as Record<string, string>), CODE_CONTEXT_ALLOWED_ROOTS: base, CODE_CONTEXT_ABSOLUTE_PATHS: "", ...extra };
  for (const k of ["OVERDRIVE_FLAIR", "CODE_CONTEXT_TIMESTAMPS", ...unset]) if (!(k in extra)) delete env[k];
  const client = new Client({ name: "cca06-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, SERVER_ENTRY, dbPath], cwd: proj, env, stderr: "ignore" }));
  return client;
}

describe("code profile defaults over MCP stdio", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect({ CODE_CONTEXT_TOOLSETS: "code,code-admin" });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
  });

  it("sends short instructions that route the graph questions", () => {
    const ins = client.getInstructions() ?? "";
    expect(ins.length).toBeGreaterThan(100);
    expect(ins.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    for (const t of ["who_imports", "find_symbol", "get_file_context", "exports_in", "project-relative"]) expect(ins).toContain(t);
  });

  it("no flair and no timestamps in find_symbol, get_file_context, search_files", async () => {
    for (const [name, args] of [
      ["find_symbol", { name: "ApiClient" }],
      ["get_file_context", { path: "src/services/api.ts" }],
      ["search_files", { query: "api" }],
    ] as const) {
      const out = text(await client.callTool({ name, arguments: args }));
      expect(out, name).not.toMatch(/░▒▓| ms$/);
      expect(out, name).not.toMatch(STAMP);
      expect(out, name).not.toMatch(/\b(modified|indexed) /i);
    }
  }, 30_000);

  it("a changed file still gets the freshness notice", async () => {
    const f = path.join(proj, "src/types.ts");
    fs.appendFileSync(f, "\nexport const CCA06 = 1;\n");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(f, later, later);
    const out = text(await client.callTool({ name: "get_file_context", arguments: { path: "src/types.ts" } }));
    expect(out).toMatch(/^↻ fresh: re-indexed 1 changed file before answering/);
    expect(out).toContain("CCA06");
  }, 30_000);

  it("index_directory prints each directory's stats once", async () => {
    const out = text(await client.callTool({ name: "index_directory", arguments: { path: proj } }));
    expect(out.split("\n")[0]).toMatch(/^# Indexed \d+ files, \d+ exports, \d+ dependencies$/);
    expect(out).toContain("### src/ — 5 files,");
    expect(out).not.toMatch(/\.\./);
    expect(out).not.toMatch(/\[\{"lang"/);
    for (const line of out.split("\n")) expect(line.match(/\d+ files?, [\d,]+ lines/g)?.length ?? 0, line).toBeLessThanOrEqual(1);
    expect(out.match(/\d+ files?, [\d,]+ lines/g)?.length).toBe((out.match(/^### /gm) ?? []).length);
  }, 30_000);
});

describe("env flags bring flair and timestamps back", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect({ CODE_CONTEXT_TOOLSETS: "code", OVERDRIVE_FLAIR: "1", CODE_CONTEXT_TIMESTAMPS: "1" });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
  });

  it("OVERDRIVE_FLAIR=1 adds the header and footer; CODE_CONTEXT_TIMESTAMPS=1 the stamps", async () => {
    const fc = text(await client.callTool({ name: "get_file_context", arguments: { path: "src/services/api.ts" } }));
    expect(fc.split("\n")[0]).toBe("● code-context ▸ get_file_context ░▒▓");
    expect(fc).toMatch(/ \d+ ms$/);
    expect(fc).toMatch(new RegExp(`\\| modified ${STAMP.source} \\| indexed ${STAMP.source}`));
    expect(text(await client.callTool({ name: "find_symbol", arguments: { name: "ApiClient" } }))).toMatch(/\| indexed \d{4}-/);
    expect(text(await client.callTool({ name: "search_files", arguments: { query: "api" } }))).toMatch(/Modified: \d{4}-.* \| indexed \d{4}-/);
  }, 30_000);
});

describe("stripDirStats", () => {
  it("drops the auto-description stats suffix only", () => {
    expect(stripDirStats("Source code. contains a, b. 5 files, 1,137 lines.")).toBe("Source code. contains a, b.");
    expect(stripDirStats("typescript modules. 1 file, 167 lines.")).toBe("typescript modules.");
    expect(stripDirStats("1 file, 2 lines.")).toBe("");
    expect(stripDirStats("Hand-written: 3 files, 10 lines, see README")).toBe("Hand-written: 3 files, 10 lines, see README");
    expect(stripDirStats(null)).toBe("");
  });
});
