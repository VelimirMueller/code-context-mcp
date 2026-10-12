/**
 * CCA-16 (#148) security review: the PHP indexer runs on every file of an
 * indexed repo, including attacker-controlled files in cloned repos, inside
 * the MCP server and the dashboard watcher. One crafted .php file must never
 * hang or crash the process.
 *
 * Each pathological input is about 1 MB. Before the fix, `$` runs, headers
 * without a body (`class A class A …`), `const const …`, `use` after code and
 * a long namespace took seconds to minutes (quadratic), and nested `"{$`
 * interpolation threw "Maximum call stack size exceeded".
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../src/server/schema.js";
import { indexDirectory } from "../src/server/indexer.js";
import {
  parsePhp, stripPhp, PhpResolver, type PhpParse, type PhpRef,
  MAX_PHP_PARSE_BYTES, MAX_PHP_EXPORTS, MAX_PHP_REFS, MAX_PHP_NAME_CHARS, MAX_PSR4_ENTRIES,
} from "../src/server/php.js";
import { declarationLines, MAX_SIGNATURE_CHARS, MAX_STORED_IMPORT_LINES } from "../src/server/signatures.js";

const MB = 1_000_000;
/** `unit` repeated to exactly `n` characters. */
const rep = (unit: string, n = MB): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const list = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("");

/** Best of three runs, so a busy CI machine does not fail the bound; a hang still hangs the first run. */
function timed<T>(fn: () => T): { ms: number; result: T } {
  let best = Infinity;
  let result!: T;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    result = fn();
    best = Math.min(best, performance.now() - t);
    if (best < 50) break;
  }
  return { ms: best, result };
}

function expectSane(p: PhpParse): void {
  expect(p.exports.length).toBeLessThanOrEqual(MAX_PHP_EXPORTS);
  expect(p.refs.length).toBeLessThanOrEqual(MAX_PHP_REFS);
  expect(p.useLines.length).toBeLessThanOrEqual(MAX_STORED_IMPORT_LINES);
  for (const e of p.exports) {
    expect(e.signature.length).toBeLessThanOrEqual(MAX_SIGNATURE_CHARS);
    expect(e.fqn.length).toBeLessThanOrEqual(2 * MAX_PHP_NAME_CHARS + 1);
  }
  for (const r of p.refs) expect(r.fqn.length).toBeLessThanOrEqual(MAX_PHP_NAME_CHARS);
  for (const u of p.useLines) expect(u.text.length).toBeLessThanOrEqual(MAX_SIGNATURE_CHARS);
}

warmUp();
function warmUp(): void {
  for (let k = 0; k < 3; k++) parsePhp(`<?php namespace A; use B\\C; class D extends C { function e(F $f): G { return new H("{$x}"); } }`.repeat(200));
}

const CASES: Record<string, string> = {
  "a run of $ (was quadratic: `\\$+name` backtracked)": "<?php " + rep("$"),
  "a run of backslashes": "<?php " + rep("\\"),
  "one 1 MB name": "<?php " + rep("a"),
  "spaces": "<?php " + rep(" "),
  "open braces (deep nesting)": "<?php " + rep("{"),
  "close braces": "<?php " + rep("}"),
  "open parens": "<?php " + rep("("),
  "a qualified name of 500k segments": "<?php new " + rep("A\\"),
  "unterminated heredoc": "<?php $x = <<<EOT\n" + rep("x\n"),
  "heredoc label that never closes, many label prefixes": "<?php $x = <<<AB\n" + rep("A"),
  "heredoc with a 5000-char label": "<?php $x = <<<" + "A".repeat(5000) + "B\n" + rep("A", MB - 6000),
  "many heredoc starts": "<?php " + rep("<<<A\n"),
  "a run of <": "<?php " + rep("<"),
  "unterminated double-quoted string": '<?php $x = "' + rep("a"),
  "unterminated single-quoted string of escaped quotes": "<?php $x = '" + rep("\\'"),
  "nested interpolation (was a stack overflow)": "<?php " + rep('"{$'),
  "nested interpolation with quotes in array keys": '<?php "' + rep('{$a["{$'),
  "unterminated block comment": "<?php /*" + rep("x"),
  "?> inside a string": "<?php $a = '?>" + rep("x"),
  "no open tag (inline HTML)": rep("x"),
  "many open and close tags": rep("<?php ?>"),
  "line comments": "<?php " + rep("#x\n"),
  "class headers without a body (was quadratic)": "<?php " + rep("class A "),
  "class extends headers without a body": "<?php " + rep("class A extends B "),
  "enum headers without a body": "<?php " + rep("enum A: "),
  "functions without a body": "<?php " + rep("function f() "),
  "functions with an open paren": "<?php " + rep("function f( "),
  "constants without a semicolon": "<?php " + rep("const A = 1 "),
  "const const const (was quadratic)": "<?php " + rep("const "),
  "anonymous classes with open args": "<?php " + rep("new class("),
  "trait use without a semicolon": "<?php class A { " + rep("use T "),
  "use without a semicolon": "<?php " + rep("use A "),
  "catch lists without a close": "<?php " + rep("catch (A|"),
  "40k names, then a use of each (was quadratic)": "<?php " + list(40_000, (i) => `X${i}::a();`) + list(40_000, (i) => `use X${i};`),
  "60k use statements": "<?php " + list(60_000, (i) => `use A\\B${i};\n`),
  "one grouped use of 100k names": "<?php use A\\{" + Array.from({ length: 100_000 }, (_, i) => `B${i}`).join(",") + "};",
  "100k distinct class names": "<?php " + list(100_000, (i) => `Foo${i} `),
  "a 500k-char namespace, then 20k names (was a timeout)": "<?php namespace " + rep("A", 500_000) + "; " + list(20_000, (i) => `Foo${i} `),
  "3000-char class names": "<?php " + rep("class " + "A".repeat(3000) + " {} "),
  "declarations with 3000 spaces in each header": "<?php " + rep("class A" + " ".repeat(3000)),
  "declarations with a 3000-char comment in each header": "<?php " + rep("function f() /*" + "x".repeat(3000) + "*/ "),
  "anonymous classes behind attributes and modifiers": "<?php " + rep("new #[a] readonly class "),
  "unmatched ] before each class": "<?php " + rep("] class "),
  "deeply nested attribute brackets before many classes": "<?php #" + rep("[", 400_000) + rep("]", 400_000) + rep(" class", 100_000),
  "binary junk and null bytes": "<?php " + list(MB, (i) => String.fromCharCode((i * 7919) % 256)),
  "minified: 20k classes on one line": "<?php namespace A;" + list(20_000, (i) => `class C${i} extends B implements I{function f(X $x):Y{return new Z;}}`),
};

describe("parsePhp on crafted 1 MB inputs: linear time, bounded results", () => {
  for (const [name, src] of Object.entries(CASES)) {
    it(`${name}: < 200 ms`, () => {
      const { ms, result } = timed(() => parsePhp(src));
      expect(ms).toBeLessThan(200);
      expectSane(result);
    });
  }

  it("stripPhp keeps the length on nested interpolation and does not throw", () => {
    const src = CASES["nested interpolation (was a stack overflow)"];
    const out = stripPhp(src);
    expect(out.length).toBe(src.length);
    expect(out.slice(6).trim()).toBe(""); // all one unterminated string
  });

  it("caps declarations and says so; a normal file sets no note", () => {
    const p = parsePhp(CASES["class headers without a body (was quadratic)"]);
    expect(p.exports).toHaveLength(MAX_PHP_EXPORTS);
    expect(p.exports[0]).toMatchObject({ name: "A", kind: "class", line: 1 });
    expect(p.exports[0].signature.endsWith("…")).toBe(true);
    expect(p.limited).toBe(`PHP structure capped: first ${MAX_PHP_EXPORTS} declarations`);
    expect(parsePhp("<?php namespace App; class A extends B {}").limited).toBeUndefined();
  });

  it("caps references and skips over-long names", () => {
    const refs = parsePhp(CASES["100k distinct class names"]);
    expect(refs.refs).toHaveLength(MAX_PHP_REFS);
    expect(refs.limited).toContain(`first ${MAX_PHP_REFS} references`);
    const ns = parsePhp(CASES["a 500k-char namespace, then 20k names (was a timeout)"]);
    expect(ns.namespace).toBe("");
    expect(ns.limited).toContain(`names over ${MAX_PHP_NAME_CHARS} characters skipped`);
  });

  it("a later use of a name first seen in code still marks it imported (map, not a rescan)", () => {
    const p = parsePhp(CASES["40k names, then a use of each (was quadratic)"]);
    expect(p.refs.every((r) => r.fromUse && !r.tentative)).toBe(true);
  });
});

describe("headers longer than the short scan read exactly as before", () => {
  const params = Array.from({ length: 60 }, (_, i) => `Foo${i} $p${i}`).join(", ");
  const src = [
    "<?php",
    "namespace App;",
    `function many(${params}): Bar {}`,
    `const LIST = [${Array.from({ length: 200 }, (_, i) => i).join(", ")}];`,
    "$x = new class(new class extends Inner {}) extends Outer implements First, Second {};",
    "class Last extends Base {}",
  ].join("\n");
  const p = parsePhp(src);

  it("signatures end at the body / semicolon and are cut at 160 characters", () => {
    expect(p.exports.map((e) => [e.kind, e.name, e.line])).toEqual([
      ["function", "many", 3],
      ["const", "LIST", 4],
      ["class", "Last", 6], // the anonymous classes on line 5 are not exports
    ]);
    expect(p.exports[0].signature).toMatch(/^function many\(Foo0 \$p0, .*…$/);
    expect(p.exports[0].signature).toHaveLength(MAX_SIGNATURE_CHARS);
    expect(p.exports[1].signature).toMatch(/^const LIST = \[0, 1, 2, .*…$/);
    expect(p.exports[2].signature).toBe("class Last extends Base");
  });

  it("extends / implements of nested anonymous classes are read once, in order", () => {
    expect(p.refs.filter((r) => !r.fqn.includes("Foo")).map((r) => r.fqn)).toEqual([
      "App\\Bar", "App\\Inner", "App\\Outer", "App\\First", "App\\Second", "App\\Base",
    ]);
  });
});

describe("size cap", () => {
  it(`a file over ${MAX_PHP_PARSE_BYTES / (1024 * 1024)} MB gets no structure, at once`, () => {
    const big = "<?php namespace App; class Big {}\n" + rep("// filler\n", MAX_PHP_PARSE_BYTES);
    const t = performance.now();
    const p = parsePhp(big);
    expect(performance.now() - t).toBeLessThan(50);
    expect(p).toEqual({ limited: "PHP structure not indexed: file larger than 2 MB", namespace: "", exports: [], useLines: [], refs: [] });
  });

  it("counts UTF-8 bytes, not characters", () => {
    const wide = "<?php class Wide {}\n// " + rep("€", Math.ceil(MAX_PHP_PARSE_BYTES / 3) + 10);
    expect(wide.length).toBeLessThan(MAX_PHP_PARSE_BYTES);
    expect(parsePhp(wide).exports).toEqual([]);
    const under = "<?php class Under {}\n// " + rep("x", MAX_PHP_PARSE_BYTES - 100);
    expect(parsePhp(under).exports.map((e) => e.name)).toEqual(["Under"]);
  });

  it("the indexer stores a too-large PHP file as a plain file with a note", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca16-adv-")));
    const saved = { roots: process.env.CODE_CONTEXT_ALLOWED_ROOTS, kb: process.env.CODE_CONTEXT_MAX_FILE_KB };
    const db = new Database(":memory:");
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "Big.php"), "<?php\nnamespace App;\nclass Big {}\n" + rep("// filler\n", MAX_PHP_PARSE_BYTES + 1000));
      fs.writeFileSync(path.join(repo, "Crafted.php"), "<?php " + rep("class A ", 400_000));
      fs.writeFileSync(path.join(repo, "Small.php"), "<?php\nnamespace App;\nclass Small extends Big {}\n");
      process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
      process.env.CODE_CONTEXT_MAX_FILE_KB = "4096";
      initSchema(db);
      const t = performance.now();
      indexDirectory(db, repo);
      expect(performance.now() - t).toBeLessThan(5_000);
      const row = (name: string) => db.prepare(`SELECT id, summary FROM files WHERE path = ?`).get(path.join(repo, name)) as { id: number; summary: string };
      const big = row("Big.php");
      expect(big.summary).toContain("(PHP structure not indexed: file larger than 2 MB)");
      expect(db.prepare(`SELECT COUNT(*) AS n FROM exports WHERE file_id = ?`).get(big.id)).toEqual({ n: 0 });
      expect(row("Crafted.php").summary).toContain(`(PHP structure capped: first ${MAX_PHP_EXPORTS} declarations)`);
      expect(row("Small.php").summary).not.toContain("PHP structure");
    } finally {
      db.close();
      for (const [k, v] of [["CODE_CONTEXT_ALLOWED_ROOTS", saved.roots], ["CODE_CONTEXT_MAX_FILE_KB", saved.kb]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PSR-4 resolution on a crafted composer.json", () => {
  const withRepo = (composer: unknown, fn: (root: string) => void) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca16-psr4-")));
    try {
      fs.writeFileSync(path.join(root, "composer.json"), typeof composer === "string" ? composer : JSON.stringify(composer));
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const ref = (fqn: string): PhpRef => ({ fqn, kind: "class", line: 1, fromUse: true, tentative: false });

  it("hundreds of nested prefixes with many dirs: bounded lookups per reference", () => {
    // `A\`, `A\A\`, … every prefix matches `A\A\…\X`, each with 50 base dirs (uncapped: 20,000 lookups per reference)
    const psr4: Record<string, string[]> = {};
    for (let k = 1; k <= 400; k++) psr4["A\\".repeat(k)] = Array.from({ length: 50 }, (_, d) => `d${d}`);
    withRepo({ autoload: { "psr-4": psr4 } }, (root) => {
      let lookups = 0;
      const resolver = new PhpResolver(root, { isIndexed: () => { lookups++; return false; }, declared: () => [] });
      const chain = resolver.psr4For(root);
      expect(chain[0].entries.length).toBe(MAX_PSR4_ENTRIES);
      const t = performance.now();
      for (let i = 0; i < 1_000; i++) resolver.resolve(ref("A\\".repeat(300) + `X${i}`), path.join(root, "f.php"));
      expect(performance.now() - t).toBeLessThan(2_000);
      expect(lookups).toBeLessThanOrEqual(1_000 * 64);
    });
  });

  it("a composer.json over 1 MB is ignored", () => {
    const filler = "x".repeat(1024 * 1024);
    withRepo(`{"autoload":{"psr-4":{"App\\\\":"src/"}},"x":"${filler}"}`, (root) => {
      const resolver = new PhpResolver(root, { isIndexed: () => true, declared: () => [] });
      expect(resolver.psr4For(root)).toEqual([]);
    });
  });

  it("a run of backslashes in a prefix normalizes like a short one", () => {
    withRepo({ autoload: { "psr-4": { ["\\".repeat(500) + "App" + "\\".repeat(500)]: "src/", "\\": "lib/" } } }, (root) => {
      const resolver = new PhpResolver(root, { isIndexed: () => false, declared: () => [] });
      expect(resolver.psr4For(root)[0].entries.map((e) => e.prefix)).toEqual(["App\\", ""]);
    });
  });
});

describe("get_file_context snippets on crafted lines (declarationLines)", () => {
  it("an unterminated string of backslashes no longer backtracks exponentially", () => {
    const content = "<?php\nfunction f() {\n'" + "\\".repeat(100_000) + "\n}\n";
    const t = performance.now();
    const { lines } = declarationLines(content, 2, ".php", 40);
    expect(performance.now() - t).toBeLessThan(200);
    expect(lines).toHaveLength(3);
  });

  it("strings still hide their braces", () => {
    expect(declarationLines("const a = f('{', \"}\\\"{\");\nconst b = 1;\n", 1, ".ts", 10).lines).toEqual(["const a = f('{', \"}\\\"{\");"]);
  });
});

describe("anonymous classes are not exports, but their references are", () => {
  const cases: Array<[string, string, string[]]> = [
    ["new class extends X", "return new class extends Migration { use HasThing; };", ["Illuminate\\Database\\Migrations\\Migration", "App\\HasThing"]],
    ["new class(args) implements Y", "$a = new class($x, new Dep()) implements Contract, \\Other\\Iface {};", ["App\\Contract", "Other\\Iface", "App\\Dep"]],
    ["new readonly class (PHP 8.3)", "$b = new readonly class extends RoBase {};", ["App\\RoBase"]],
    ["attributes before the class", "$c = new #[Attr(['k' => 1])] #[Other] readonly class extends AttrBase implements AttrIface {};", ["App\\Attr", "App\\Other", "App\\AttrBase", "App\\AttrIface"]],
  ];
  for (const [name, line, refs] of cases) {
    it(name, () => {
      const p = parsePhp(`<?php\nnamespace App;\nuse Illuminate\\Database\\Migrations\\Migration;\n${line}\nclass Named extends Base {}\n`);
      expect(p.exports.map((e) => e.name)).toEqual(["Named"]);
      const got = p.refs.map((r) => r.fqn);
      for (const r of refs) expect(got).toContain(r);
      expect(got).not.toContain("App\\readonly");
    });
  }
});

describe("an anonymous class's parent is an edge in the index", () => {
  it("a migration-style `return new class extends Base` depends on Base and exports nothing", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cca16-anon-")));
    const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    const db = new Database(":memory:");
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(path.join(repo, "app"), { recursive: true });
      fs.mkdirSync(path.join(repo, "database"));
      fs.writeFileSync(path.join(repo, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));
      fs.writeFileSync(path.join(repo, "app/Base.php"), "<?php\nnamespace App;\nabstract class Base {}\n");
      fs.writeFileSync(path.join(repo, "database/2026_create.php"), "<?php\nuse App\\Base;\nreturn new class extends Base {\n  public function up(): void {}\n};\n");
      process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
      initSchema(db);
      indexDirectory(db, repo);
      const id = (db.prepare(`SELECT id FROM files WHERE path = ?`).get(path.join(repo, "database/2026_create.php")) as { id: number }).id;
      expect(db.prepare(`SELECT COUNT(*) AS n FROM exports WHERE file_id = ?`).get(id)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT t.path, d.symbols FROM dependencies d JOIN files t ON t.id = d.target_id WHERE d.source_id = ?`).all(id))
        .toEqual([{ path: path.join(repo, "app/Base.php"), symbols: "Base" }]);
    } finally {
      db.close();
      if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
      else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
