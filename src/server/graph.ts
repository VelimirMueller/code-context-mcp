/**
 * Question-shaped graph tools (CCA-05, #120): `who_imports` and `exports_in`.
 *
 * Both answer from the import graph the indexer already keeps (dependencies:
 * source_id → target_id + symbols; exports with signature/line). Bench readers
 * got "## Imported by" from get_file_context and still grepped "to verify"
 * (L4), and only found the unused-exports answer when they thought of the
 * exports table themselves (L6). These tools say the answer is complete.
 *
 * Edge symbols (written by parseImports in indexer.ts):
 *   `a`              named or default import (type imports too)
 *   `* as ns`        namespace import            → whole module
 *   `import()` / `require()` without destructuring → whole module
 *   `export a [as b]` re-export                   → used only if the re-export is used
 *   `export *`        star re-export              → used only if the barrel's name is used
 *   `export * as ns`  namespace re-export         → whole module
 *   (none)           side-effect import           → no export used
 * A name the target does not export (a renamed default import, a Python
 * `import pkg.mod`) also counts as a whole-module use. Every rule errs on
 * "used": exports_in never calls an imported export unused.
 *
 * PHP edges (CCA-16) carry the short names of the classes, functions and
 * constants the file references in the target (`use`, extends, implements,
 * trait use, `new`, `::`, type hints), so they read as named imports. A PHP
 * symbol can also be asked for by its qualified name (`App\Models\User`).
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { freshnessNotice, type FreshnessGuard, type FreshRow } from "./freshness.js";
import { resolveToolPath, displayBase, canonicalPath } from "./path-resolve.js";
import { parseStoredImportLines } from "./signatures.js";
import { parseImports, parsePythonImports, resolveImportPath, resolvePythonImportTargets, isPathInside, phpLookup } from "./indexer.js";
import { AliasResolver } from "./tsconfig-paths.js";
import { parsePhp, phpEdges, PhpResolver } from "./php.js";

export const MAX_LISTED_IMPORTERS = 100;
export const MAX_LISTED_EXPORTS_IN = 150;
const MAX_SYMBOL_DEFINERS = 5;

type Show = (p: string) => string;
export interface GraphOpts {
  show: Show;
  fresh?: FreshnessGuard;
}
export interface GraphResult {
  text: string;
  isError?: boolean;
}

interface FileRow extends FreshRow {
  id: number;
  extension: string | null;
  import_lines: string | null;
}
interface Edge {
  source: FileRow;
  symbols: string;
}

type Sym =
  | { kind: "name"; name: string }
  | { kind: "reexport"; name: string; as: string }
  | { kind: "star" }
  | { kind: "whole" };

/** Parse a dependencies.symbols value into the forms listed in the header. */
export function parseEdgeSymbols(raw: string | null): Sym[] {
  if (!raw) return [];
  const out: Sym[] = [];
  for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (s === "export *") out.push({ kind: "star" });
    else if (s.startsWith("export * as ") || s.startsWith("* as ") || s === "*" || s === "import()" || s === "require()") {
      out.push({ kind: "whole" });
    } else if (s.startsWith("export ")) {
      const [name, as] = s.slice(7).split(/\s+as\s+/);
      out.push({ kind: "reexport", name, as: as ?? name });
    } else out.push({ kind: "name", name: s });
  }
  return out;
}

const FILE_COLS = `f.id, f.path, f.extension, f.import_lines, f.size_bytes, f.modified_at`;

class Graph {
  private readonly edgesStmt: Database.Statement;
  private readonly namesStmt: Database.Statement;
  private readonly starStmt: Database.Statement;
  private readonly edgeCache = new Map<number, Edge[]>();
  private readonly nameCache = new Map<number, Set<string>>();
  private readonly aliasCache = new Map<string, AliasResolver>();

  constructor(private readonly db: Database.Database) {
    this.edgesStmt = db.prepare(
      `SELECT ${FILE_COLS}, d.symbols FROM dependencies d JOIN files f ON f.id = d.source_id WHERE d.target_id = ? ORDER BY f.path`,
    );
    this.namesStmt = db.prepare(`SELECT name FROM exports WHERE file_id = ?`);
    this.starStmt = db.prepare(`SELECT target_id, symbols FROM dependencies WHERE source_id = ? AND symbols LIKE '%export *%'`);
  }

  edgesInto(fileId: number): Edge[] {
    let e = this.edgeCache.get(fileId);
    if (!e) {
      e = (this.edgesStmt.all(fileId) as (FileRow & { symbols: string })[]).map(({ symbols, ...source }) => ({ source, symbols }));
      this.edgeCache.set(fileId, e);
    }
    return e;
  }

  /** Names the file exports, including the ones an `export * from` passes through. */
  exportNames(fileId: number): Set<string> {
    let n = this.nameCache.get(fileId);
    if (!n) {
      n = new Set((this.namesStmt.all(fileId) as { name: string }[]).map((r) => r.name));
      this.nameCache.set(fileId, n); // before recursing: a star cycle ends here
      for (const e of this.starStmt.all(fileId) as { target_id: number; symbols: string }[]) {
        if (!parseEdgeSymbols(e.symbols).some((x) => x.kind === "star")) continue;
        for (const name of this.exportNames(e.target_id)) n.add(name);
      }
    }
    return n;
  }

  /** How `edge` takes `name` from its target: null = not at all. */
  takes(edge: Edge, targetId: number, name: string): "direct" | "whole" | "reexport" | null {
    let best: "direct" | "whole" | "reexport" | null = null;
    for (const s of parseEdgeSymbols(edge.symbols)) {
      if (s.kind === "name" && s.name === name) return "direct";
      if (s.kind === "whole" || (s.kind === "name" && !this.exportNames(targetId).has(s.name))) best = "whole";
      if (best === null && ((s.kind === "reexport" && s.name === name) || s.kind === "star")) best = "reexport";
    }
    return best;
  }

  /** The name a re-exporting edge publishes `name` under, or null. */
  reexportedAs(edge: Edge, name: string): string | null {
    for (const s of parseEdgeSymbols(edge.symbols)) {
      if (s.kind === "reexport" && s.name === name) return s.as;
      if (s.kind === "star") return name;
    }
    return null;
  }

  /** tsconfig/jsconfig alias resolver for an index root, shared by one answer. */
  aliasesFor(root: string): AliasResolver {
    let r = this.aliasCache.get(root);
    if (!r) {
      r = new AliasResolver(root);
      this.aliasCache.set(root, r);
    }
    return r;
  }

  /** True when any indexed file imports `name` from file `fileId`, directly or through re-exports. */
  isUsed(fileId: number, name: string, seen = new Set<string>()): boolean {
    const key = `${fileId}:${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    for (const edge of this.edgesInto(fileId)) {
      const how = this.takes(edge, fileId, name);
      if (how === "direct" || how === "whole") return true;
      if (how === "reexport") {
        const as = this.reexportedAs(edge, name);
        if (as && this.isUsed(edge.source.id, as, seen)) return true;
      }
    }
    return false;
  }
}

/** Longest indexed root containing `p`, else the filesystem root. */
function rootOf(db: Database.Database, p: string): string {
  try {
    const roots = db.prepare(`SELECT root FROM indexed_repos ORDER BY length(root) DESC`).all() as { root: string }[];
    for (const r of roots) if (isPathInside(p, r.root)) return r.root;
  } catch {
    /* foreign db */
  }
  return path.parse(p).root;
}

const phpLookups = new WeakMap<Database.Database, ReturnType<typeof phpLookup>>();

/**
 * PHP: lines of the `use` statements that reach `targetPath`; for a file that
 * reaches it without one (same namespace, extends \A\B, …) the first line
 * that references it.
 */
function phpLinesTo(db: Database.Database, importer: FileRow, targetPath: string): number[] {
  const row = db.prepare(`SELECT content FROM files WHERE id = ?`).get(importer.id) as { content: string | null } | undefined;
  if (!row?.content) return [];
  let lookup = phpLookups.get(db);
  if (!lookup) { lookup = phpLookup(db); phpLookups.set(db, lookup); }
  const resolver = new PhpResolver(rootOf(db, importer.path), lookup);
  const e = phpEdges(parsePhp(row.content), importer.path, resolver).edges.get(targetPath);
  if (!e) return [];
  return e.useLines.length ? [...new Set(e.useLines)] : [Math.min(...e.lines)];
}

/** Line numbers in `importer`'s stored import lines whose module resolves to `targetPath`. */
function importLinesTo(db: Database.Database, g: Graph, importer: FileRow, targetPath: string): number[] {
  if (importer.extension === ".php") return phpLinesTo(db, importer, targetPath);
  const lines = parseStoredImportLines(importer.import_lines);
  if (lines.length === 0) return [];
  const root = rootOf(db, importer.path);
  const py = importer.extension === ".py" || importer.extension === ".pyi";
  const out: number[] = [];
  for (const l of lines) {
    const hit = py
      ? parsePythonImports(l.text).some((imp) =>
          resolvePythonImportTargets(imp.source, imp.symbols, importer.path, root, imp.fromImport !== false).includes(targetPath),
        )
      : parseImports(l.text).some((imp) => resolveImportPath(imp.source, importer.path, root, g.aliasesFor(root)) === targetPath);
    if (hit) out.push(l.line);
  }
  return out;
}

function capped<T>(items: T[], max: number, render: (t: T) => string): string[] {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push(`+${items.length - max} more`);
  return lines;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A namespace-qualified PHP name: `App\Models\User`, `\App\Models\User`. */
const PHP_QUALIFIED = /^\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)+$/;
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface Entry {
  file: FileRow;
  symbols: string;
  lines: number[];
  note: string;
}

/**
 * Importers of `target` (a file row). `name` limits them to files that take
 * that export; null = every edge. Returns direct importers plus files that
 * import it one hop through a barrel that re-exports it.
 */
function importersOf(db: Database.Database, g: Graph, target: FileRow, name: string | null): { direct: Entry[]; via: Entry[] } {
  const direct: Entry[] = [];
  const barrels: { file: FileRow; names: Set<string> }[] = [];
  const targetNames = g.exportNames(target.id);
  for (const edge of g.edgesInto(target.id)) {
    const how = name === null ? "direct" : g.takes(edge, target.id, name);
    if (!how) continue;
    const reNames = new Set<string>();
    for (const n of name === null ? targetNames : [name]) {
      const as = g.reexportedAs(edge, n);
      if (as) reNames.add(as);
    }
    const isBarrel = parseEdgeSymbols(edge.symbols).some((s) => s.kind === "star" || s.kind === "reexport");
    if (isBarrel && reNames.size) barrels.push({ file: edge.source, names: reNames });
    direct.push({
      file: edge.source,
      symbols: edge.symbols,
      lines: importLinesTo(db, g, edge.source, target.path),
      note: isBarrel ? " (re-export)" : how === "whole" ? " (whole module)" : "",
    });
  }
  const seen = new Set(direct.map((d) => d.file.id));
  seen.add(target.id);
  const via: Entry[] = [];
  for (const b of barrels) {
    for (const edge of g.edgesInto(b.file.id)) {
      if (seen.has(edge.source.id)) continue;
      const takes = [...b.names].some((n) => g.takes(edge, b.file.id, n) !== null);
      if (!takes) continue;
      seen.add(edge.source.id);
      via.push({ file: edge.source, symbols: edge.symbols, lines: importLinesTo(db, g, edge.source, b.file.path), note: b.file.path });
    }
  }
  return { direct, via };
}

function heading(subject: string, direct: number, via: number): string {
  const extra = via ? ` (+${via} through re-exports)` : "";
  return `# ${subject}: imported by ${direct} file${direct === 1 ? "" : "s"}${extra} — complete list from the import graph`;
}

function renderEntries(show: Show, direct: Entry[], via: Entry[]): string[] {
  const at = (e: Entry) => (e.lines.length ? ` L${e.lines.join(",L")}` : "");
  const syms = (e: Entry) => (e.symbols ? ` [${e.symbols}]` : "");
  const out = capped(direct, MAX_LISTED_IMPORTERS, (e) => `- ${show(e.file.path)}${at(e)}${syms(e)}${e.note}`);
  if (via.length) {
    out.push(`## Via re-export (${via.length}): import it through a barrel above`);
    out.push(...capped(via, MAX_LISTED_IMPORTERS, (e) => `- ${show(e.file.path)}${at(e)}${syms(e)} via ${show(e.note)}`));
  }
  return out;
}

/** Re-stat the target and every listed file; true when the caller must recompute. */
function refresh(fresh: FreshnessGuard | undefined, rows: FreshRow[], acc: { reindexed: number; dropped: number }): boolean {
  if (!fresh) return false;
  const r = fresh.checkFiles(rows);
  acc.reindexed += r.reindexed;
  acc.dropped += r.dropped;
  return r.changed;
}

const getFileStmt = (db: Database.Database) => db.prepare(`SELECT ${FILE_COLS} FROM files f WHERE f.path = ?`);

/** who_imports: `target` is a file path (any spelling) or an exported symbol name. */
export function whoImports(db: Database.Database, target: string, { show, fresh }: GraphOpts): GraphResult {
  const repo = fresh?.checkRepos() ?? { warnings: [], reindexed: 0, dropped: 0 };
  const acc = { reindexed: 0, dropped: 0 };

  const qualified = PHP_QUALIFIED.test(target) ? target.replace(/^\\/, "") : null;
  if (IDENT.test(target) || qualified) {
    // A qualified PHP name: the file that declares it (exports.description), asked by its short name.
    const symbol = qualified ? qualified.slice(qualified.lastIndexOf("\\") + 1) : target;
    const definersStmt = db.prepare(
      `SELECT DISTINCT ${FILE_COLS}, MIN(CASE WHEN e.kind = 're-export' THEN 1 ELSE 0 END) AS re
       FROM exports e JOIN files f ON f.id = e.file_id WHERE e.name = ?${qualified ? ` AND e.description = ? AND f.extension = '.php'` : ""}
       GROUP BY f.id ORDER BY re, f.path`,
    );
    const compute = () => {
      const rows = (qualified ? definersStmt.all(symbol, qualified) : definersStmt.all(target)) as (FileRow & { re: number })[];
      const own = rows.filter((r) => r.re === 0);
      const definers = own.length ? own : rows;
      const g = new Graph(db);
      return { definers, results: definers.slice(0, MAX_SYMBOL_DEFINERS).map((d) => ({ d, ...importersOf(db, g, d, symbol) })) };
    };
    let r = compute();
    if (r.definers.length > 0) {
      const all = r.results.flatMap((x) => [x.d, ...x.direct.map((e) => e.file), ...x.via.map((e) => e.file)]);
      if (refresh(fresh, all, acc)) r = compute();
      const notice = freshnessNotice(repo, acc);
      if (r.definers.length === 0) return { text: `${notice}No indexed file exports "${target}" any more.` };
      const out: string[] = [];
      for (const { d, direct, via } of r.results) {
        out.push(heading(`${target} (${show(d.path)})`, direct.length, via.length));
        if (direct.length === 0) out.push("No indexed file imports it.");
        out.push(...renderEntries(show, direct, via));
      }
      if (r.definers.length > MAX_SYMBOL_DEFINERS) out.push(`+${r.definers.length - MAX_SYMBOL_DEFINERS} more files export "${target}"`);
      return { text: notice + out.join("\n") };
    }
    if (qualified) return { text: `${freshnessNotice(repo, acc)}No indexed PHP file declares "${qualified}".` };
    // No export by that name: maybe a bare file name ("schema") — try it as a path.
  }

  let resolved = resolveToolPath(db, target);
  if (IDENT.test(target) && resolved.kind === "path" && !getFileStmt(db).get(resolved.path)) {
    // A bare module name ("schema"): the indexed files with that base name.
    const named = db.prepare(`SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20`)
      .all(`%/${escapeLike(target)}.%`) as { path: string }[];
    const exact = named.filter((r) => path.basename(r.path).replace(/\.[^.]+$/, "") === target).map((r) => r.path);
    if (exact.length === 1) resolved = { kind: "path", path: exact[0] };
    else if (exact.length > 1) resolved = { kind: "ambiguous", candidates: exact };
  }
  if (resolved.kind === "ambiguous") {
    return {
      text: `"${target}" matches ${resolved.candidates.length} indexed files. Pass one of these paths:\n${resolved.candidates.map((c) => `- ${show(c)}`).join("\n")}`,
      isError: true,
    };
  }
  const get = getFileStmt(db);
  let file = get.get(resolved.path) as FileRow | undefined;
  if (!file && fresh?.indexIfEligible(resolved.path)) {
    file = get.get(resolved.path) as FileRow | undefined;
    acc.reindexed++;
  }
  if (!file) {
    const what = IDENT.test(target) ? `No indexed file exports "${target}" and no file "${show(resolved.path)}" is indexed.` : `File "${show(resolved.path)}" is not in the index.`;
    return { text: freshnessNotice(repo, acc) + what };
  }
  const compute = () => importersOf(db, new Graph(db), file!, null);
  let r = compute();
  if (refresh(fresh, [file, ...r.direct.map((e) => e.file), ...r.via.map((e) => e.file)], acc)) {
    file = get.get(resolved.path) as FileRow | undefined;
    if (!file) return { text: `${freshnessNotice(repo, acc)}File "${show(resolved.path)}" was deleted from disk and dropped from the index.` };
    r = compute();
  }
  const head = heading(show(file.path), r.direct.length, r.via.length);
  const body = r.direct.length === 0 ? ["No indexed file imports it."] : renderEntries(show, r.direct, r.via);
  return { text: freshnessNotice(repo, acc) + [head, ...body].join("\n") };
}

export interface ExportRow {
  file_id: number;
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  line: number | null;
}

/** The rows no indexed file imports (rules in the header). */
export function keepUnused(db: Database.Database, rows: ExportRow[]): ExportRow[] {
  const g = new Graph(db);
  return rows.filter((e) => !g.isUsed(e.file_id, e.name));
}

/** exports_in: exports of every indexed file under `dir`; `unused` keeps the ones nothing imports. */
export function exportsIn(db: Database.Database, dir: string, unused: boolean, { show, fresh }: GraphOpts): GraphResult {
  const repo = fresh?.checkRepos() ?? { warnings: [], reindexed: 0, dropped: 0 };
  const acc = { reindexed: 0, dropped: 0 };
  const rel = dir.replace(/\\/g, "/").replace(/^\.(\/|$)/, "").replace(/\/+$/, "");
  const abs = path.isAbsolute(dir) ? canonicalPath(dir) : canonicalPath(path.resolve(displayBase(db) ?? process.cwd(), rel));
  const filesStmt = db.prepare(`SELECT ${FILE_COLS} FROM files f WHERE f.path LIKE ? ESCAPE '\\' ORDER BY f.path`);
  const exportsStmt = db.prepare(
    `SELECT e.file_id, f.path, e.name, e.kind, e.signature, e.line FROM exports e JOIN files f ON f.id = e.file_id
     WHERE f.path LIKE ? ESCAPE '\\' ORDER BY f.path, COALESCE(e.line, 1e9), e.id`,
  );
  const like = `${escapeLike(abs.replace(/\/+$/, ""))}/%`;
  const label = path.isAbsolute(dir) ? show(abs) : rel || ".";
  let files = filesStmt.all(like) as FileRow[];
  if (files.length === 0) return { text: `${freshnessNotice(repo, acc)}No indexed files under "${path.isAbsolute(dir) ? show(abs) : rel || "."}".` };

  const importers = (): FileRow[] => {
    const g = new Graph(db);
    return files.flatMap((f) => g.edgesInto(f.id).map((e) => e.source));
  };
  if (refresh(fresh, unused ? [...files, ...importers()] : files, acc)) files = filesStmt.all(like) as FileRow[];

  const all = exportsStmt.all(like) as ExportRow[];
  const rows = unused ? keepUnused(db, all) : all;
  const nFiles = new Set(all.map((e) => e.file_id)).size;
  const head = unused
    ? `# Unused exports in ${label}: ${rows.length} of ${all.length} — no indexed file imports them (complete from the import graph)`
    : `# Exports in ${label}: ${all.length} in ${nFiles} file${nFiles === 1 ? "" : "s"}`;
  const out = [head];
  if (unused) {
    out.push("Used = imported by name, via a re-export that is itself imported, or by a whole-module import (import * as, export * as, import()/require() without names). Uses inside the file itself do not count.");
  }
  let listed = 0;
  let current = "";
  for (const e of rows) {
    if (listed >= MAX_LISTED_EXPORTS_IN) break;
    if (e.path !== current) {
      current = e.path;
      out.push(`## ${show(e.path)}`);
    }
    const at = e.line != null ? `L${e.line} ` : "";
    out.push(e.signature ? `- ${at}${e.signature}` : `- ${at}${e.name} (${e.kind})`);
    listed++;
  }
  if (rows.length > listed) out.push(`+${rows.length - listed} more`);
  if (rows.length === 0 && unused) out.push("None: every export is imported somewhere.");
  return { text: freshnessNotice(repo, acc) + out.join("\n") };
}
