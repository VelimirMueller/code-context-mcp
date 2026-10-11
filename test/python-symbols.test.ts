import { describe, test, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { parsePythonExports, parsePythonImports, resolvePythonImport, resolvePythonImportTargets, indexDirectory } from "../src/server/indexer";
import { createTestDb } from "./helpers/db.js";

// ─── parsePythonExports ─────────────────────────────────────────────────────

describe("parsePythonExports — functions, classes, constants", () => {
  test("exports def, async def, class and UPPER_CASE constants with docstrings", () => {
    const content = [
      `def visible():`,
      `    """Shown."""`,
      ``,
      `async def fetch():`,
      `    """Fetch data."""`,
      ``,
      `class Thing:`,
      `    """A thing."""`,
      ``,
      `lower = 1`,
      `UPPER_CASE_CONST = 7`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "visible", kind: "function", description: "Shown." },
      { name: "fetch", kind: "function", description: "Fetch data." },
      { name: "Thing", kind: "class", description: "A thing." },
      { name: "UPPER_CASE_CONST", kind: "const", description: null },
    ]);
  });

  test("nested defs and methods are not exported", () => {
    const content = [
      `def outer():`,
      `    """Outer."""`,
      ``,
      `    def inner():`,
      `        pass`,
      ``,
      `class Thing:`,
      `    """A thing."""`,
      ``,
      `    def method(self):`,
      `        """Method doc."""`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "outer", kind: "function", description: "Outer." },
      { name: "Thing", kind: "class", description: "A thing." },
    ]);
  });

  test("skips names starting with underscore", () => {
    const content = [
      `def _private():`,
      `    """Hidden."""`,
      ``,
      `def public():`,
      `    pass`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "public", kind: "function", description: null },
    ]);
  });

  test("reads the docstring after a multi-line signature and class bases", () => {
    const content = [
      `def multi_line(`,
      `    a,`,
      `    b,`,
      `):`,
      `    """Multi-line signature doc."""`,
      ``,
      `class WithBases(Base, metaclass=Meta):`,
      `    """Bases doc."""`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "multi_line", kind: "function", description: "Multi-line signature doc." },
      { name: "WithBases", kind: "class", description: "Bases doc." },
    ]);
  });

  test("takes the first non-empty line of a multi-line docstring", () => {
    const content = [
      `def f():`,
      `    """`,
      `    First line of doc.`,
      ``,
      `    More detail.`,
      `    """`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "f", kind: "function", description: "First line of doc." },
    ]);
  });

  test("a def inside a module-level triple-quoted string is not exported", () => {
    const content = [
      `"""`,
      `def fake_function():`,
      `    """Not real."""`,
      `"""`,
      ``,
      `def real_function():`,
      `    """Real."""`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "real_function", kind: "function", description: "Real." },
    ]);
  });
});

// ─── parsePythonExports — __all__ ───────────────────────────────────────────

describe("parsePythonExports — __all__ filtering", () => {
  test("keeps only listed names, keeps _private when listed, adds re-exports", () => {
    const content = [
      `def public_one():`,
      `    """One."""`,
      ``,
      `async def public_two():`,
      `    """Two."""`,
      ``,
      `def _private():`,
      `    """Hidden."""`,
      ``,
      `def unlisted():`,
      `    pass`,
      ``,
      `LOWER_CASE = 1`,
      `UPPER_CONST = 42`,
      ``,
      `__all__ = ["public_one", "UPPER_CONST", "_private", "not_defined"]`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "public_one", kind: "function", description: "One." },
      { name: "UPPER_CONST", kind: "const", description: null },
      { name: "_private", kind: "function", description: "Hidden." },
      { name: "not_defined", kind: "re-export", description: null },
    ]);
  });

  test("supports tuple and multi-line __all__", () => {
    const content = [
      `def a(): pass`,
      `X = 1`,
      `__all__ = (`,
      `    "X",`,
      `    "a",`,
      `)`,
    ].join("\n");
    expect(parsePythonExports(content)).toEqual([
      { name: "X", kind: "const", description: null },
      { name: "a", kind: "function", description: null },
    ]);
  });
});

// ─── parsePythonImports ─────────────────────────────────────────────────────

describe("parsePythonImports", () => {
  test("parses every import form, including inside functions", () => {
    const content = [
      `import os`,
      `import a.b.c`,
      `import a.b as x, d`,
      `from .mod import x, y as z`,
      `from ..pkg.mod import (`,
      `    first,`,
      `    second as sec,`,
      `)`,
      `from . import mod`,
      `from pkg.mod import thing`,
      `import numpy as np`,
      ``,
      `def run():`,
      `    import json`,
      `    from .sub import g`,
    ].join("\n");
    // fromImport is covered by its own test below; compare symbols + source here
    expect(parsePythonImports(content).map(({ symbols, source }) => ({ symbols, source }))).toEqual([
      { symbols: ["os"], source: "os" },
      { symbols: ["a.b.c"], source: "a.b.c" },
      { symbols: ["x"], source: "a.b" },
      { symbols: ["d"], source: "d" },
      { symbols: ["x", "z"], source: ".mod" },
      { symbols: ["first", "sec"], source: "..pkg.mod" },
      { symbols: ["mod"], source: "." },
      { symbols: ["thing"], source: "pkg.mod" },
      { symbols: ["np"], source: "numpy" },
      { symbols: ["json"], source: "json" },
      { symbols: ["g"], source: ".sub" },
    ]);
  });

  test("ignores imports inside triple-quoted strings and comments", () => {
    const content = [
      `"""`,
      `import fake`,
      `from .fake import x`,
      `"""`,
      `# import also_fake`,
    ].join("\n");
    expect(parsePythonImports(content)).toEqual([]);
  });
});

// ─── resolvePythonImport ────────────────────────────────────────────────────

describe("resolvePythonImport", () => {
  let tmp: string;
  let root: string;

  const write = (base: string, rel: string, content = ""): string => {
    const full = path.join(base, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "cc-py-res-"))); // index stores realpaths (CCA-01)
    root = path.join(tmp, "root");
    write(root, "app.py");
    write(root, "pkg/__init__.py");
    write(root, "pkg/mod.py");
    write(root, "pkg/client.py");
    write(root, "pkg/sub/inner.py");
    write(root, "src/lib.py");
    write(root, "a/deep.py");
    write(tmp, "escape.py", "X = 1\n"); // real file, but outside root
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("relative import resolves next to the file", () => {
    expect(resolvePythonImport(".mod", ["x"], path.join(root, "pkg/client.py"), root)).toBe(path.join(root, "pkg/mod.py"));
  });

  test("'from . import mod' uses the first symbol", () => {
    expect(resolvePythonImport(".", ["mod"], path.join(root, "pkg/client.py"), root)).toBe(path.join(root, "pkg/mod.py"));
  });

  test("parent-relative import goes up one directory per extra dot", () => {
    expect(resolvePythonImport("..mod", ["x"], path.join(root, "pkg/sub/inner.py"), root)).toBe(path.join(root, "pkg/mod.py"));
  });

  test("package resolves to __init__.py when no module file exists", () => {
    expect(resolvePythonImport(".pkg", ["x"], path.join(root, "app.py"), root)).toBe(path.join(root, "pkg/__init__.py"));
    expect(resolvePythonImport(".", ["pkg"], path.join(root, "app.py"), root)).toBe(path.join(root, "pkg/__init__.py"));
  });

  test("absolute import resolves from rootDir", () => {
    expect(resolvePythonImport("pkg.mod", ["x"], path.join(root, "app.py"), root)).toBe(path.join(root, "pkg/mod.py"));
    expect(resolvePythonImport("pkg", ["x"], path.join(root, "app.py"), root)).toBe(path.join(root, "pkg/__init__.py"));
  });

  test("absolute import also resolves from rootDir/src", () => {
    expect(resolvePythonImport("lib", ["f"], path.join(root, "app.py"), root)).toBe(path.join(root, "src/lib.py"));
  });

  test("stdlib and third-party imports resolve to null", () => {
    expect(resolvePythonImport("os", ["path"], path.join(root, "app.py"), root)).toBeNull();
    expect(resolvePythonImport("os.path", ["join"], path.join(root, "app.py"), root)).toBeNull();
    expect(resolvePythonImport("numpy", ["array"], path.join(root, "app.py"), root)).toBeNull();
  });

  test("missing modules resolve to null", () => {
    expect(resolvePythonImport(".nope", ["x"], path.join(root, "pkg/client.py"), root)).toBeNull();
  });

  test("a path escaping rootDir resolves to null even when the file exists", () => {
    expect(resolvePythonImport("...escape", ["X"], path.join(root, "a/deep.py"), root)).toBeNull();
  });
});

// ─── End-to-end index ───────────────────────────────────────────────────────

describe("Python end-to-end index", () => {
  let root: string;
  let db: Database.Database;

  const write = (rel: string, content: string): string => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };

  const exportsOf = (p: string) =>
    (db.prepare("SELECT e.name, e.kind, e.description FROM exports e JOIN files f ON e.file_id = f.id WHERE f.path = ? ORDER BY e.id").all(p) as { name: string; kind: string; description: string | null }[]);

  const edgeBetween = (src: string, tgt: string) =>
    (db.prepare(
      "SELECT d.symbols FROM dependencies d JOIN files s ON d.source_id = s.id JOIN files t ON d.target_id = t.id WHERE s.path = ? AND t.path = ?",
    ).get(src, tgt) as { symbols: string } | undefined);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "cc-py-e2e-"))); // index stores realpaths (CCA-01)
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
    db = createTestDb();
  });

  afterEach(() => {
    delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("indexes Python exports and dependency edges into the DB", () => {
    const appPath = write("app.py", [
      `"""Tiny app."""`,
      `import os`,
      `from pkg.mod import do_thing`,
      ``,
      `def main():`,
      `    """Run the app."""`,
      `    return do_thing()`,
      ``,
    ].join("\n"));
    const modPath = write("pkg/mod.py", [
      `"""Mod."""`,
      ``,
      `def do_thing():`,
      `    """Does the thing."""`,
      ``,
      `class Thing:`,
      `    """A thing."""`,
      ``,
      `def _private():`,
      `    pass`,
      ``,
      `LIMIT = 10`,
      ``,
    ].join("\n"));
    write("pkg/__init__.py", `"""Package root."""\nPKG_VERSION = "1.0"\n`);

    const stats = indexDirectory(db, root);

    expect(stats.files).toBe(3);
    expect(stats.deps).toBe(1);

    expect(exportsOf(modPath)).toEqual([
      { name: "do_thing", kind: "function", description: "Does the thing." },
      { name: "Thing", kind: "class", description: "A thing." },
      { name: "LIMIT", kind: "const", description: null },
    ]);
    expect(exportsOf(appPath)).toEqual([
      { name: "main", kind: "function", description: "Run the app." },
    ]);

    expect(edgeBetween(appPath, modPath)).toEqual({ symbols: "do_thing" });
    expect(edgeBetween(appPath, path.join(root, "pkg/__init__.py"))).toBeUndefined();

    const appRow = db.prepare("SELECT language, external_imports FROM files WHERE path = ?").get(appPath) as { language: string; external_imports: string | null };
    expect(appRow.language).toBe("python");
    expect(appRow.external_imports).toBe("os"); // stdlib only; pkg.mod resolved in-repo
  });
});

// ─── one edge per imported submodule (review finding 2026-10-09) ────────────

describe("resolvePythonImportTargets — submodules get their own edge", () => {
  let tmp: string;
  let root: string;
  const write = (rel: string) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "X = 1\n");
    return full;
  };
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "cc-py-tgt-"))); // index stores realpaths (CCA-01)
    root = path.join(tmp, "root");
    for (const f of ["app.py", "pkg/__init__.py", "pkg/a.py", "pkg/b.py", "pkg/c/__init__.py", "x/__init__.py", "x/y.py"]) write(f);
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = root; // the indexer refuses roots outside its sandbox
  });
  afterEach(() => {
    delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("from . import a, b → both sibling modules", () => {
    const got = resolvePythonImportTargets(".", ["a", "b"], path.join(root, "pkg/__init__.py"), root);
    expect(got.sort()).toEqual([path.join(root, "pkg/a.py"), path.join(root, "pkg/b.py")].sort());
  });

  test("from pkg import a, c → module file and sub-package __init__", () => {
    const got = resolvePythonImportTargets("pkg", ["a", "c"], path.join(root, "app.py"), root);
    expect(got.sort()).toEqual([path.join(root, "pkg/a.py"), path.join(root, "pkg/c/__init__.py")].sort());
  });

  test("from pkg import a, some_function → submodule plus the package itself", () => {
    const got = resolvePythonImportTargets("pkg", ["a", "some_function"], path.join(root, "app.py"), root);
    expect(got.sort()).toEqual([path.join(root, "pkg/__init__.py"), path.join(root, "pkg/a.py")].sort());
  });

  test("from pkg import * → the package only", () => {
    expect(resolvePythonImportTargets("pkg", ["*"], path.join(root, "app.py"), root)).toEqual([path.join(root, "pkg/__init__.py")]);
  });

  test("import x.y as z (not a from-import) → x/y.py, never x/y/z.py", () => {
    expect(resolvePythonImportTargets("x.y", ["z"], path.join(root, "app.py"), root, false)).toEqual([path.join(root, "x/y.py")]);
  });

  test("parser marks from-imports and plain imports", () => {
    const imps = parsePythonImports("import x.y as z\nfrom . import a, b\n");
    expect(imps.map(i => i.fromImport)).toEqual([false, true]);
  });

  test("index: from . import a, b in pkg/__init__.py gives two dependency edges", () => {
    writeFileSync(path.join(root, "pkg/__init__.py"), "from . import a, b\n");
    const db = createTestDb();
    indexDirectory(db, root);
    const rows = db.prepare(
      `SELECT t.path AS target FROM dependencies d JOIN files s ON d.source_id = s.id JOIN files t ON d.target_id = t.id WHERE s.path = ?`,
    ).all(path.join(root, "pkg/__init__.py")) as { target: string }[];
    expect(rows.map(r => r.target).sort()).toEqual([path.join(root, "pkg/a.py"), path.join(root, "pkg/b.py")].sort());
  });
});
