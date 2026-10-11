/**
 * CCA-05 (#120): who_imports and exports_in answer "which files import X" and
 * "which exports are unused" from the import graph, completely, so a reader
 * needs no grep to verify (bench L4) and no file-by-file read (bench L6).
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
import { indexDirectory, parseImports } from "../src/server/indexer.js";
import { pathDisplay } from "../src/server/path-resolve.js";
import { FreshnessGuard } from "../src/server/freshness.js";
import {
  whoImports,
  exportsIn,
  keepUnused,
  parseEdgeSymbols,
  MAX_LISTED_IMPORTERS,
  MAX_LISTED_EXPORTS_IN,
  type ExportRow,
} from "../src/server/graph.js";
import { importersOf, deadExportsOf } from "../scripts/bench/live/checkers.mts";
import { simFileContext, simFindSymbol, simSearchFiles } from "./helpers/benchmark-fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "test/fixtures/graph");
const SAMPLE = path.join(REPO_ROOT, "test/fixtures/sample-project");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

/** Index `dir` into a fresh db, allowing its temp location for the call. */
function indexInto(db: Database.Database, dir: string, allow: string): void {
  const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = allow;
  try {
    indexDirectory(db, dir);
  } finally {
    if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
  }
}

/** Paths an answer lists: lines starting with "- ". */
const listed = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split(" ")[0]);

// ─── Parser (unit) ───────────────────────────────────────────────────────────
describe("parseImports: every module reference the graph needs", () => {
  const syms = (src: string) => parseImports(src).map((i) => [i.source, i.symbols.join(", ")]);

  it("static imports: named, default + named, type-only, namespace, side effect", () => {
    expect(syms(`import { a, b as c } from "./x";`)).toEqual([["./x", "a, b"]]);
    expect(syms(`import React, { useState } from "react";`)).toEqual([["react", "React, useState"]]);
    expect(syms(`import type { Shape } from "./t.js";`)).toEqual([["./t.js", "Shape"]]);
    expect(syms(`import { type A, B } from "./t.js";`)).toEqual([["./t.js", "A, B"]]);
    expect(syms(`import * as ns from "./n";`)).toEqual([["./n", "* as ns"]]);
    expect(syms(`import "./polyfill";`)).toEqual([["./polyfill", ""]]);
    expect(syms(`import {\n  a,\n  b,\n} from "./multi";`)).toEqual([["./multi", "a, b"]]);
  });

  it("re-exports: named, renamed, star and star-as", () => {
    expect(syms(`export { a, b as c } from "./x";`)).toEqual([["./x", "export a, export b as c"]]);
    expect(syms(`export type { T } from "./t";`)).toEqual([["./t", "export T"]]);
    expect(syms(`export * from "./x";`)).toEqual([["./x", "export *"]]);
    expect(syms(`export * as ns from "./x";`)).toEqual([["./x", "export * as ns"]]);
  });

  it("dynamic import and require: destructured names, else the whole module", () => {
    expect(syms(`const { seed } = await import("./d.js");`)).toEqual([["./d.js", "seed"]]);
    expect(syms(`const m = await import("./d.js");`)).toEqual([["./d.js", "import()"]]);
    expect(syms(`const { helper } = require("./h");`)).toEqual([["./h", "helper"]]);
    expect(syms(`const path = require("path");`)).toEqual([["path", "require()"]]);
    expect(syms(`reimport("./no"); x.import("./no");`)).toEqual([]);
  });

  it("parseEdgeSymbols classifies the stored forms", () => {
    expect(parseEdgeSymbols("a, * as ns, export b as c, export *, export * as m, import()")).toEqual([
      { kind: "name", name: "a" },
      { kind: "whole" },
      { kind: "reexport", name: "b", as: "c" },
      { kind: "star" },
      { kind: "whole" },
      { kind: "whole" },
    ]);
    expect(parseEdgeSymbols("")).toEqual([]);
  });
});

// ─── Fixture: barrels, namespace, dynamic, side effect, Python ───────────────
describe("who_imports / exports_in on test/fixtures/graph", () => {
  let base: string;
  let proj: string;
  let db: Database.Database;
  let show: (p: string) => string;
  const who = (t: string) => whoImports(db, t, { show }).text;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca05-")));
    proj = path.join(base, "proj");
    fs.cpSync(FIXTURE, proj, { recursive: true });
    db = new Database(":memory:");
    initSchema(db);
    indexInto(db, proj, base);
    show = pathDisplay(db, { cwd: proj });
  });
  afterAll(() => {
    db?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("direct importers with symbols and import lines; the barrel is flagged and its importers listed", () => {
    expect(who("lib/core.ts")).toBe(
      [
        "# lib/core.ts: imported by 3 files (+1 through re-exports) — complete list from the import graph",
        "- app/main.ts L2 [Shape]",
        "- app/other.ts L1 [gamma, delta]",
        "- lib/index.ts L2 [export alpha, export beta as betaRenamed] (re-export)",
        "## Via re-export (1): import it through a barrel above",
        "- app/via.ts L1 [betaRenamed] via lib/index.ts",
      ].join("\n"),
    );
  });

  it("export * barrel: the file importing a passed-through name is listed via the barrel", () => {
    const out = who("lib/extra.ts");
    expect(out).toContain("- lib/index.ts L3 [export *] (re-export)");
    expect(out).toContain("- app/main.ts L1 [alpha, extraUsed] via lib/index.ts");
  });

  it("side-effect and namespace imports count as importers of the file", () => {
    expect(who("lib/dead.ts")).toContain("\n- app/side.ts L1");
    expect(who("lib/ns.ts")).toContain("- app/main.ts L3 [* as ns]");
  });

  it("symbol mode: the defining file, then only the files that take that symbol", () => {
    const alpha = who("alpha");
    expect(alpha.split("\n")[0]).toBe("# alpha (lib/core.ts): imported by 1 file (+1 through re-exports) — complete list from the import graph");
    expect(listed(alpha)).toEqual(["lib/index.ts", "app/main.ts"]);
    // renamed re-export: beta is reached as betaRenamed, by via.ts only
    expect(listed(who("beta"))).toEqual(["lib/index.ts", "app/via.ts"]);
    expect(listed(who("gamma"))).toEqual(["app/other.ts"]);
    expect(listed(who("delta"))).toEqual(["app/other.ts"]); // destructured dynamic import
    expect(listed(who("nsB"))).toEqual(["app/main.ts"]);
    expect(who("nsB")).toContain("(whole module)");
    expect(who("EPS")).toContain("imported by 0 files");
    expect(who("helper")).toContain("- py/main.py L1 [helper]");
  });

  it("path forms: relative, ./, absolute, the unresolved temp spelling, a unique suffix and a bare module name", () => {
    const want = who("lib/core.ts");
    expect(who("./lib/core.ts")).toBe(want);
    expect(who(path.join(proj, "lib/core.ts"))).toBe(want);
    // macOS: os.tmpdir() is /var/folders/… while rows are stored under /private/var/…
    const unresolved = path.join(os.tmpdir(), path.basename(base), "proj/lib/core.ts");
    expect(who(unresolved)).toBe(want);
    expect(who("core.ts")).toBe(want);
    expect(who("core")).toBe(want);
    const abs = whoImports(db, "lib/core.ts", { show: pathDisplay(db, { absolute: true }) }).text;
    expect(abs).toContain(`- ${path.join(proj, "app/main.ts")} L2 [Shape]`);
  });

  it("unknown target and ambiguous name", () => {
    expect(who("nope")).toContain('No indexed file exports "nope"');
    expect(who("lib/missing.ts")).toContain("is not in the index");
    // "index" names no export; two files have that base name
    const r = whoImports(db, "index", { show });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("- app/index.ts");
    expect(r.text).toContain("- lib/index.ts");
    // "main" is an exported Python function: symbol mode wins over the file name
    expect(who("main")).toContain("# main (py/main.py): imported by 0 files");
  });

  it("exports_in lists signatures and lines per file", () => {
    const out = exportsIn(db, "lib", false, { show }).text;
    expect(out.split("\n")[0]).toBe("# Exports in lib: 13 in 5 files");
    expect(out).toContain("## lib/core.ts\n- L2 interface Shape\n- L6 function alpha(s: Shape): string");
    expect(out).toContain("- L18 async function delta(): Promise<number>");
    expect(exportsIn(db, "./lib/", false, { show }).text).toBe(out);
    expect(exportsIn(db, "nowhere", false, { show }).text).toContain('No indexed files under "nowhere"');
  });

  it("exports_in unused: namespace, type, dynamic and re-exported uses count; side effects do not", () => {
    const out = exportsIn(db, "lib", true, { show }).text;
    expect(out.split("\n")[0]).toBe("# Unused exports in lib: 3 of 13 — no indexed file imports them (complete from the import graph)");
    expect(out).toContain("## lib/core.ts\n- L22 const EPS = 1e-9");
    expect(out).toContain("## lib/dead.ts\n- L1 function lonely(): void"); // side-effect import only
    expect(out).toContain("## lib/extra.ts\n- L5 function extraDead(): string"); // star barrel, nobody takes it
    for (const used of ["Shape", "alpha", "beta(", "gamma", "delta", "nsA", "nsB", "extraUsed", "betaRenamed"]) {
      expect(out).not.toContain(used);
    }
    expect(exportsIn(db, "py", true, { show }).text).toContain("## py/util.py\n- L5 def unused_py()");
  });
});

// ─── Caps and freshness ──────────────────────────────────────────────────────
describe("caps and read-time freshness", () => {
  let base: string;
  let proj: string;
  let db: Database.Database;
  let show: (p: string) => string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca05-caps-")));
    proj = path.join(base, "proj");
    fs.mkdirSync(path.join(proj, "users"), { recursive: true });
    fs.mkdirSync(path.join(proj, "many"), { recursive: true });
    fs.writeFileSync(path.join(proj, "hub.ts"), "export function hub(): number { return 1; }\n");
    const n = MAX_LISTED_IMPORTERS + 5;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(proj, `users/u${String(i).padStart(3, "0")}.ts`), `import { hub } from "../hub.js";\nexport const v${i} = hub();\n`);
    }
    const m = MAX_LISTED_EXPORTS_IN + 10;
    fs.writeFileSync(path.join(proj, "many/consts.ts"), Array.from({ length: m }, (_, i) => `export const c${i} = ${i};`).join("\n"));
    db = new Database(":memory:");
    initSchema(db);
    indexInto(db, proj, base);
    show = pathDisplay(db, { cwd: proj });
  });
  afterAll(() => {
    db?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("who_imports caps the list with a +N more line", () => {
    const out = whoImports(db, "hub.ts", { show }).text;
    expect(out.split("\n")[0]).toContain(`imported by ${MAX_LISTED_IMPORTERS + 5} files`);
    expect(listed(out)).toHaveLength(MAX_LISTED_IMPORTERS);
    expect(out.endsWith("+5 more")).toBe(true);
  });

  it("exports_in caps the list with a +N more line", () => {
    const out = exportsIn(db, "many", true, { show }).text;
    expect(out).toContain(`${MAX_LISTED_EXPORTS_IN + 10} of ${MAX_LISTED_EXPORTS_IN + 10}`);
    expect(listed(out)).toHaveLength(MAX_LISTED_EXPORTS_IN);
    expect(out.endsWith("+10 more")).toBe(true);
  });

  it("re-checks listed files against the disk before answering", () => {
    const fresh = new FreshnessGuard(db);
    const edited = path.join(proj, "users/u000.ts");
    fs.writeFileSync(edited, "export const v0 = 0; // no longer imports hub\n");
    const out = whoImports(db, "hub.ts", { show, fresh }).text;
    expect(out).toMatch(/^↻ fresh: re-indexed 1 changed file before answering/);
    expect(out).toContain(`imported by ${MAX_LISTED_IMPORTERS + 4} files`);
    expect(out).not.toContain("users/u000.ts");
    // exports_in unused re-checks the importers too: hub stays used, the edit is seen
    fs.writeFileSync(edited, `import { hub } from "../hub.js";\nexport const v0 = hub() + 1;\n`);
    const ex = exportsIn(db, "users", true, { show, fresh }).text;
    expect(ex).toMatch(/^↻ fresh: re-indexed 1 changed file before answering/);
  });
});

// ─── This repo's own src: the bench L4 / L6 answers ──────────────────────────
describe("this repo's src/ answers bench L4 and L6", () => {
  let base: string;
  let ws: string;
  let db: Database.Database;
  let show: (p: string) => string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca05-src-")));
    ws = path.join(base, "ws");
    fs.cpSync(path.join(REPO_ROOT, "src"), path.join(ws, "src"), {
      recursive: true,
      filter: (s) => !s.split(path.sep).includes("node_modules"),
    });
    db = new Database(":memory:");
    initSchema(db);
    indexInto(db, ws, base);
    show = pathDisplay(db, { cwd: ws });
  }, 60_000);
  afterAll(() => {
    db?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("L4: who_imports(src/server/schema.ts) is exactly the checker's importer set", () => {
    const expected = importersOf(ws, "src/server/schema.ts");
    expect(expected.length).toBeGreaterThan(0);
    const out = whoImports(db, "src/server/schema.ts", { show }).text;
    expect(listed(out).sort()).toEqual(expected);
  });

  it("L6: exports_in(src/server, unused) finds every dead export the checker expects", () => {
    // L6 counts only export function/async function/const/class and calls a
    // name "used" when its whole word appears in any other file's text. The
    // graph calls it used only when a file imports it. So the graph's unused
    // set holds every L6-dead name (recall 1) plus names that other files only
    // MENTION: a same-named local function, an option property, a comment.
    const { universe, dead } = deadExportsOf(ws, "src/server");
    const rows = db
      .prepare(
        `SELECT e.file_id, f.path, e.name, e.kind, e.signature, e.line FROM exports e JOIN files f ON f.id = e.file_id
         WHERE f.path LIKE ? AND f.path NOT LIKE ?`,
      )
      .all(`${ws}/src/server/%`, `${ws}/src/server/%/%`) as ExportRow[];
    const unused = new Set(keepUnused(db, rows.filter((r) => ["function", "const", "class"].includes(r.kind))).map((r) => r.name));
    const graphDead = [...unused].filter((n) => universe.has(n));
    expect([...dead].filter((n) => !unused.has(n))).toEqual([]); // recall 1
    const precision = graphDead.filter((n) => dead.has(n)).length / graphDead.length;
    expect(precision).toBeGreaterThanOrEqual(0.8); // the L6 pass bar
    // Every extra is a text-only mention: its word appears in another src file.
    const texts = fs.readdirSync(path.join(ws, "src"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx|mts)$/.test(e.name))
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf-8"));
    for (const extra of graphDead.filter((n) => !dead.has(n))) {
      expect(texts.filter((t) => new RegExp(`(?<![\\w$])${extra}(?![\\w$])`).test(t)).length).toBeGreaterThan(1);
    }
    // The tool's own answer agrees with the computed set.
    const out = exportsIn(db, "src/server", true, { show }).text;
    for (const n of dead) expect(out).toMatch(new RegExp(`(?<![\\w$])${n}(?![\\w$])`));
  });
});

// ─── Over MCP stdio ──────────────────────────────────────────────────────────
describe("who_imports and exports_in over MCP stdio (code profile)", () => {
  let base: string;
  let client: Client;
  const text = (r: unknown): string => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca05-mcp-")));
    const proj = path.join(base, "proj");
    fs.cpSync(SAMPLE, proj, { recursive: true });
    const dbPath = path.join(base, "context.db");
    const db = new Database(dbPath);
    initSchema(db);
    indexInto(db, proj, base);
    db.close();
    // No OVERDRIVE_FLAIR and no CODE_CONTEXT_TIMESTAMPS: the code profile's
    // defaults (no flair, no timestamps, CCA-06 #121) are what the sim mirrors.
    const env = { ...(process.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: "code", CODE_CONTEXT_ALLOWED_ROOTS: base, CODE_CONTEXT_ABSOLUTE_PATHS: "" };
    delete env.OVERDRIVE_FLAIR;
    delete env.CODE_CONTEXT_TIMESTAMPS;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, SERVER_ENTRY, dbPath],
      cwd: proj,
      env,
      stderr: "ignore",
    });
    client = new Client({ name: "cca05-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("who_imports helpers.ts: the barrel, then the entry point through it", async () => {
    const out = text(await client.callTool({ name: "who_imports", arguments: { target: "src/utils/helpers.ts" } }));
    expect(out).toContain("- src/utils/index.ts L2 [export formatDate, export capitalize, export clamp, export generateId, export DEFAULT_PAGE_SIZE] (re-export)");
    expect(out).toContain("- src/index.ts L2 [formatDate, capitalize, DEFAULT_PAGE_SIZE] via src/utils/index.ts");
  }, 30_000);

  it("the simulated benchmark output (test/helpers/benchmark-fixture.ts) equals the real tool output", async () => {
    // The benchmarks index the fixture in place; the server here reads a copy.
    // Since CCA-06 (#121) neither side prints timestamps or flair, so the
    // texts must be equal byte for byte.
    const local = new Database(":memory:");
    initSchema(local);
    indexDirectory(local, SAMPLE);
    const real = async (name: string, args: Record<string, unknown>) => text(await client.callTool({ name, arguments: args }));
    try {
      for (const f of ["src/index.ts", "src/types.ts", "src/services/api.ts", "src/utils/helpers.ts", "src/utils/index.ts"]) {
        expect(simFileContext(local, path.join(SAMPLE, f)), f).toBe(await real("get_file_context", { path: f }));
      }
      expect(simFindSymbol(local, "ApiClient")).toBe(await real("find_symbol", { name: "ApiClient" }));
      expect(simSearchFiles(local, "api")).toBe(await real("search_files", { query: "api" }));
    } finally {
      local.close();
    }
  }, 30_000);

  it("exports_in src/utils unused: what nothing takes through the barrel", async () => {
    const out = text(await client.callTool({ name: "exports_in", arguments: { dir: "src/utils", unused: true } }));
    expect(out).toMatch(/^# Unused exports in src\/utils: \d+ of \d+/);
    expect(out).toContain("function clamp(");
    expect(out).toContain("function generateId(");
    expect(out).not.toContain("function formatDate(");
  }, 30_000);
});
