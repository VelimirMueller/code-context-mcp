/**
 * CCA-18 (#151): tsconfig/jsconfig `paths` and `baseUrl` aliases make edges in
 * the import graph. Before, only relative imports resolved: `@/lib/x` made no
 * edge and who_imports answered 0 for an alias-heavy Vite app.
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
import { indexDirectory, refreshFiles, resolveImportPath } from "../src/server/indexer.js";
import { pathDisplay } from "../src/server/path-resolve.js";
import { whoImports, exportsIn } from "../src/server/graph.js";
import { AliasResolver, MAX_CONFIG_BYTES, globMatch, matchPaths, readJsonc, stripJsonc } from "../src/server/tsconfig-paths.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "test/fixtures/ts-alias-app");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");

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

/** Write `files` (relative path → content) under a fresh temp dir; returns its realpath. */
function tree(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca18-")));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

// ─── Lenient JSON ────────────────────────────────────────────────────────────
describe("stripJsonc / readJsonc: tsconfig text with comments and trailing commas", () => {
  it("drops comments and trailing commas, keeps comment-like text inside strings", () => {
    const src = `/* head */ {
      // line
      "paths": { "@/*": ["./src/*"], "//x": ["a/*b"], },  /* "~old/*": [] */
      "esc": "quote \\" // not a comment",
      "list": [1, 2, /* c */ ],
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({
      paths: { "@/*": ["./src/*"], "//x": ["a/*b"] },
      esc: 'quote " // not a comment',
      list: [1, 2],
    });
  });

  it("is linear on hostile input and refuses oversized files", () => {
    const hostile = "/*".repeat(200_000) + '"' + "\\\\".repeat(200_000) + ",".repeat(200_000);
    const t0 = performance.now();
    stripJsonc(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
    const dir = tree({ "big.json": `{"a": "${"x".repeat(MAX_CONFIG_BYTES)}"}`, "bad.json": "{ nope", "arr.json": "[1]" });
    try {
      expect(readJsonc(path.join(dir, "big.json"))).toBeNull();
      expect(readJsonc(path.join(dir, "bad.json"))).toBeNull();
      expect(readJsonc(path.join(dir, "arr.json"))).toBeNull();
      expect(readJsonc(path.join(dir, "missing.json"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── paths matching and include globs ────────────────────────────────────────
describe("matchPaths and globMatch follow TypeScript's rules", () => {
  it("exact key first, then the longest-prefix * pattern; targets in order; two * is invalid", () => {
    const paths = { "*": ["types/*"], "@/*": ["src/*"], "@/lib/*": ["lib/*", "fallback/*"], "@/exact": ["e.ts"], "a*b*": ["x"] };
    expect(matchPaths(paths, "@/lib/x")).toEqual(["lib/x", "fallback/x"]);
    expect(matchPaths(paths, "@/ui/x")).toEqual(["src/ui/x"]);
    expect(matchPaths(paths, "@/exact")).toEqual(["e.ts"]);
    expect(matchPaths(paths, "react")).toEqual(["types/react"]);
    expect(matchPaths({ "a*b*": ["x"] }, "aXbY")).toEqual([]);
    expect(matchPaths({ "@/*.js": ["src/*.ts"] }, "@/a.js")).toEqual(["src/a.ts"]);
  });

  it("substitutes the captured text literally and skips targets with two *", () => {
    expect(matchPaths({ "@/*": ["src/*"] }, "@/$&x")).toEqual(["src/$&x"]);
    expect(matchPaths({ "@/*": ["src/*"] }, "@/a$1b")).toEqual(["src/a$1b"]);
    expect(matchPaths({ "@/*": ["src/*/*", "lib/*", "fixed.ts"] }, "@/m")).toEqual(["lib/m", "fixed.ts"]);
  });

  it("include globs: directories, **, * and ?, and bounded cost on hostile patterns", () => {
    expect(globMatch("/p/src", "/p/src/a/b.ts")).toBe(true);
    expect(globMatch("/p/src/**/*", "/p/src/b.ts")).toBe(true);
    expect(globMatch("/p/src/**/*.test.ts", "/p/src/a/b.test.ts")).toBe(true);
    expect(globMatch("/p/src/**/*.test.ts", "/p/src/a/b.ts")).toBe(false);
    expect(globMatch("/p/vite.config.ts", "/p/src/vite.config.ts")).toBe(false);
    expect(globMatch("/p/?.ts", "/p/a.ts")).toBe(true);
    const t0 = performance.now();
    expect(globMatch("/" + "*a".repeat(40) + "b", "/" + "a".repeat(200))).toBe(false);
    expect(globMatch("/" + "**/".repeat(30) + "z", "/" + "a/".repeat(60) + "y")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

// ─── Config discovery ────────────────────────────────────────────────────────
describe("AliasResolver: config discovery, extends, references, containment", () => {
  let dir: string;
  beforeAll(() => {
    dir = tree({
      // package-style extends resolved in node_modules; carries baseUrl + paths
      "node_modules/@acme/tsconfig-base/tsconfig.json": `{ "compilerOptions": { "paths": { "#pkg/*": ["./pkg-src/*"] } } }`,
      "node_modules/@acme/tsconfig-base/pkg-src/x.ts": "export const x = 1;",
      "a/tsconfig.json": `{ "extends": "@acme/tsconfig-base", "compilerOptions": { "baseUrl": "./src" } }`,
      "a/src/util/str.ts": "export const s = 1;",
      "a/src/main.ts": "",
      "b/tsconfig.json": `{ "extends": "@acme/tsconfig-base/tsconfig" }`,
      "b/main.ts": "",
      // extends cycle: still loads, no hang
      "c/tsconfig.json": `{ "extends": "./other.json", "compilerOptions": { "paths": { "~/*": ["./*"] } } }`,
      "c/other.json": `{ "extends": "./tsconfig.json" }`,
      "c/k.ts": "",
      "c/m.ts": "",
      // alias that points outside the index root
      "d/tsconfig.json": `{ "compilerOptions": { "paths": { "out/*": ["../../*"] } } }`,
      "d/f.ts": "",
      // \${configDir} expands to the governing config's dir
      "e/base/tsconfig.json": `{ "compilerOptions": { "paths": { "@e/*": ["\${configDir}/lib/*"] } } }`,
      "e/tsconfig.json": `{ "extends": "./base/tsconfig.json" }`,
      "e/lib/y.ts": "",
      "e/f.ts": "",
    });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("baseUrl bare imports resolve when the file exists, else stay external", () => {
    const r = new AliasResolver(dir);
    const from = path.join(dir, "a/src/main.ts");
    expect(r.resolve("util/str", from)).toBe(path.join(dir, "a/src/util/str.ts"));
    expect(r.resolve("util/str.js", from)).toBe(path.join(dir, "a/src/util/str.ts"));
    expect(r.resolve("react", from)).toBeNull();
    expect(r.resolve("./util/str", from)).toBeNull(); // relative: not the resolver's job
  });

  it("package extends from node_modules: paths stay relative to the package config", () => {
    const r = new AliasResolver(dir);
    // baseUrl set in the child: paths resolve against it (TypeScript), so #pkg/x misses
    expect(r.resolve("#pkg/x", path.join(dir, "a/src/main.ts"))).toBeNull();
    expect(r.configFor(path.join(dir, "a/src/main.ts"))?.paths).toEqual({ "#pkg/*": ["./pkg-src/*"] });
    // no baseUrl: relative to the config that set paths
    expect(r.resolve("#pkg/x", path.join(dir, "b/main.ts"))).toBe(path.join(dir, "node_modules/@acme/tsconfig-base/pkg-src/x.ts"));
  });

  it("an extends cycle loads once and resolves; aliases never leave the root", () => {
    const r = new AliasResolver(dir);
    expect(r.resolve("~/k", path.join(dir, "c/m.ts"))).toBe(path.join(dir, "c/k.ts"));
    const outside = new AliasResolver(path.join(dir, "d"));
    expect(outside.resolve("out/a/src/main", path.join(dir, "d/f.ts"))).toBeNull();
    expect(resolveImportPath("out/a/src/main", path.join(dir, "d/f.ts"), path.join(dir, "d"), outside)).toBeNull();
  });

  it("${configDir} in an extended config means the extending config's dir", () => {
    expect(new AliasResolver(dir).resolve("@e/y", path.join(dir, "e/f.ts"))).toBe(path.join(dir, "e/lib/y.ts"));
  });
});

// ─── The fixture app ─────────────────────────────────────────────────────────
describe("ts-alias-app fixture: who_imports / exports_in over alias imports", () => {
  let base: string;
  let proj: string;
  let db: Database.Database;
  let show: (p: string) => string;
  const who = (t: string) => whoImports(db, t, { show }).text;
  const edges = () =>
    (
      db
        .prepare(
          `SELECT s.path a, t.path b, d.symbols s FROM dependencies d JOIN files s ON s.id = d.source_id JOIN files t ON t.id = d.target_id ORDER BY a, b`,
        )
        .all() as { a: string; b: string; s: string }[]
    ).map((r) => `${show(r.a)} -> ${show(r.b)} [${r.s}]`);

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca18-app-")));
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

  it("every alias edge, and none for the decoy, the vite config or the nested package's foreign alias", () => {
    expect(edges()).toEqual([
      "packages/legacy/app.js -> packages/legacy/utils/math.js [add]", // jsconfig paths
      "packages/ui/src/Badge.tsx -> packages/ui/src/theme/tone.ts [tone]", // baseUrl bare import
      "packages/ui/src/index.ts -> packages/ui/src/Badge.tsx [export Badge]", // nested ~ui/* alias
      "src/App.tsx -> src/components/index.ts [Card]", // @/components/index.js → index.ts
      "src/App.tsx -> src/hooks/useTotals.ts [useTotals]",
      "src/App.tsx -> src/shared/config.ts [API_URL]", // second paths target
      "src/components/Card.tsx -> src/lib/format.ts [slugify]",
      "src/components/index.ts -> src/components/Button.tsx [export Button]",
      "src/components/index.ts -> src/components/Card.tsx [export Card]",
      "src/hooks/useTotals.ts -> src/lib/format.ts [formatPrice]",
      "src/main.tsx -> src/App.tsx [App]",
      "src/main.tsx -> src/components/index.ts [Button]", // barrel index.ts via @/components
      "src/main.tsx -> src/lib/format.ts [formatPrice, slugify]", // .js specifier → .ts
    ]);
  });

  it("unresolved specifiers stay external packages; resolved aliases do not", () => {
    const ext = Object.fromEntries(
      (db.prepare(`SELECT path, external_imports FROM files WHERE external_imports IS NOT NULL`).all() as { path: string; external_imports: string }[]).map(
        (r) => [show(r.path), r.external_imports],
      ),
    );
    expect(ext).toEqual({
      "src/main.tsx": "@decoy/thing, react-dom", // the commented-out alias is no alias
      "vite.config.ts": "@/lib, vite", // tsconfig.node.json has no paths
      "packages/ui/src/Badge.tsx": "@/App, clsx", // nearest config is packages/ui's
    });
  });

  it("who_imports a file reached only through aliases", () => {
    expect(who("src/lib/format.ts")).toBe(
      [
        "# src/lib/format.ts: imported by 3 files — complete list from the import graph",
        "- src/components/Card.tsx L1 [slugify]",
        "- src/hooks/useTotals.ts L1 [formatPrice]",
        "- src/main.tsx L3 [formatPrice, slugify]",
      ].join("\n"),
    );
  });

  it("who_imports a symbol through the alias barrel", () => {
    expect(who("Button")).toBe(
      [
        "# Button (src/components/Button.tsx): imported by 1 file (+1 through re-exports) — complete list from the import graph",
        "- src/components/index.ts L1 [export Button] (re-export)",
        "## Via re-export (1): import it through a barrel above",
        "- src/main.tsx L4 [Button] via src/components/index.ts",
      ].join("\n"),
    );
    expect(who("Card")).toContain("- src/App.tsx L1 [Card] via src/components/index.ts");
    expect(who("API_URL")).toContain("- src/App.tsx L3 [API_URL]");
    expect(who("thing")).toContain("imported by 0 files");
  });

  it("exports_in unused: only what no alias import takes", () => {
    const out = exportsIn(db, "src", true, { show }).text;
    expect(out.split("\n")[0]).toBe("# Unused exports in src: 3 of 12 — no indexed file imports them (complete from the import graph)");
    expect(out.split("\n").slice(2).join("\n")).toBe(
      [
        "## src/components/Button.tsx",
        "- L1 const BUTTON_SIZES = […]",
        "## src/decoy/thing.ts",
        "- L1 const thing = 42",
        "## src/lib/format.ts",
        "- L9 function unusedFormatter(): string",
      ].join("\n"),
    );
  });

  it("refreshFiles keeps alias edges when one file is re-read", () => {
    const f = path.join(proj, "src/hooks/useTotals.ts");
    fs.appendFileSync(f, "\nexport const touched = true;\n");
    refreshFiles(db, [f], proj);
    expect(edges()).toContain("src/hooks/useTotals.ts -> src/lib/format.ts [formatPrice]");
  });
});

// ─── Over MCP stdio ──────────────────────────────────────────────────────────
describe("find_symbol and get_file_context over MCP stdio on the alias fixture", () => {
  let base: string;
  let client: Client;
  const text = (r: unknown): string => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
  const section = (out: string, title: string): string => {
    const start = out.indexOf(`## ${title}`);
    if (start === -1) return "";
    const next = out.indexOf("\n## ", start + 1);
    return out.slice(start, next === -1 ? undefined : next);
  };

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca18-mcp-")));
    const proj = path.join(base, "proj");
    fs.cpSync(FIXTURE, proj, { recursive: true });
    const dbPath = path.join(base, "context.db");
    const db = new Database(dbPath);
    initSchema(db);
    indexInto(db, proj, base);
    db.close();
    const env = { ...(process.env as Record<string, string>), CODE_CONTEXT_TOOLSETS: "code", CODE_CONTEXT_ALLOWED_ROOTS: base, CODE_CONTEXT_ABSOLUTE_PATHS: "" };
    delete env.OVERDRIVE_FLAIR;
    delete env.CODE_CONTEXT_TIMESTAMPS;
    const transport = new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, SERVER_ENTRY, dbPath], cwd: proj, env, stderr: "ignore" });
    client = new Client({ name: "cca18-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it("find_symbol: one definer per name, alias targets included", async () => {
    const out = text(await client.callTool({ name: "find_symbol", arguments: { name: "slugify" } }));
    expect(out.split("\n")[0]).toBe("slugify (function) — src/lib/format.ts");
    const tone = text(await client.callTool({ name: "find_symbol", arguments: { name: "tone" } }));
    expect(tone.split("\n")[0]).toBe("tone (function) — packages/ui/src/theme/tone.ts");
  }, 30_000);

  it("get_file_context: alias dependencies and dependents, no alias under External packages", async () => {
    const app = text(await client.callTool({ name: "get_file_context", arguments: { path: "src/App.tsx" } }));
    expect(section(app, "Imports from")).toBe(
      ["## Imports from (3)", "- src/components/index.ts [Card]", "- src/hooks/useTotals.ts [useTotals]", "- src/shared/config.ts [API_URL]"].join("\n"),
    );
    expect(section(app, "Imported by")).toBe(["## Imported by (1)", "- src/main.tsx [App]"].join("\n"));
    expect(section(app, "External packages")).toBe("");
    const main = text(await client.callTool({ name: "get_file_context", arguments: { path: "src/main.tsx" } }));
    expect(section(main, "External packages")).toBe("## External packages\n@decoy/thing, react-dom");
    expect(section(main, "Imports from")).toBe(
      ["## Imports from (3)", "- src/App.tsx [App]", "- src/lib/format.ts [formatPrice, slugify]", "- src/components/index.ts [Button]"].join("\n"),
    );
  }, 30_000);
});
