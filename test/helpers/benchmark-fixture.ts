import path from "path";
import type Database from "better-sqlite3";
import { parseStoredImportLines } from "../../src/server/signatures.js";

/** The sample-project fixture root, shared by both simulated benchmarks. */
export const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "sample-project",
);

/**
 * Fixed canonical root for the paths the VANILLA arm prints (grep hits) and for
 * the historical "old" format in token-efficiency.test.ts: those outputs carry
 * absolute paths. Fixed so the token estimate never depends on where the
 * checkout lives (a .worktrees path used to make the benchmarks flaky).
 *
 * The simulated MCP outputs (simFileContext, simFindSymbol, simSearchFiles)
 * print project-relative paths instead, as the real tools do since #116.
 */
export const CANONICAL_ROOT = "/workspace/sample-project";

/**
 * Fixed canonical timestamps mirroring the real server output. get_file_context
 * and search_files both emit `modified <modified_at> | indexed <indexed_at>` and
 * find_symbol emits `indexed <indexed_at>`, with values in `YYYY-MM-DD HH:MM:SS`
 * (see toISOLocal in src/server/indexer.ts). Rendering fixed values keeps the
 * realistic token cost of those fields without leaking real mtimes.
 */
export const CANONICAL_MODIFIED_AT = "2026-01-01 00:00:00";
export const CANONICAL_INDEXED_AT = "2026-01-01 00:00:00";

/**
 * A DB path relative to the fixture root (`src/utils/helpers.ts`), as the real
 * tools print it (pathDisplay in src/server/path-resolve.ts). Throws when `p`
 * is outside the fixture root, so no machine-dependent path can leak.
 */
export function displayPath(p: string): string {
  return path.posix.relative(CANONICAL_ROOT, canonicalPath(p));
}

/**
 * Render a DB (absolute) path as an absolute path under CANONICAL_ROOT, so the
 * benchmark's token estimate is realistic (absolute-path cost) but identical on
 * every machine. Throws when `p` is outside the fixture root: a `..` segment
 * would let the result escape CANONICAL_ROOT and leak machine-dependent paths.
 */
export function canonicalPath(p: string): string {
  const rel = path.relative(FIXTURE_DIR, p).replace(/\\/g, "/");
  const escapes =
    rel === "" || // p is the fixture dir itself — not a file under it
    rel.startsWith("../") ||
    rel === ".." ||
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel);
  if (escapes) {
    throw new Error(
      `canonicalPath: path escapes the fixture root (FIXTURE_DIR): ${p}`,
    );
  }
  return path.posix.join(CANONICAL_ROOT, rel);
}

/**
 * True when `text` still carries machine- or checkout-dependent content that
 * would leak into the token estimate: the real absolute fixture path, or any
 * timestamp other than the fixed canonical ones. Canonical paths (CANONICAL_ROOT)
 * and the fixed canonical timestamps are expected and allowed.
 */
export function hasMachineDependentText(text: string): boolean {
  if (text.includes(FIXTURE_DIR)) return true;
  const timestamps = text.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g) ?? [];
  return timestamps.some(
    (t) => t !== CANONICAL_MODIFIED_AT && t !== CANONICAL_INDEXED_AT,
  );
}

// ─── Simulated MCP output: mirrors the real tools ────────────────────────────
// Same text as the handlers in src/server/index.ts (find_symbol,
// get_file_context, search_files) with project-relative paths and the fixed
// canonical timestamps. test/graph-tools.test.ts compares simFileContext with
// the real get_file_context over MCP stdio, so the two cannot drift apart.

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function capped<T>(items: T[], max: number, render: (t: T) => string): string {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push(`+${items.length - max} more`);
  return lines.join("\n");
}

/** get_file_context(path) without snippets or change history. */
export function simFileContext(db: Database.Database, filePath: string): string {
  const f = db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as any;
  if (!f) throw new Error(`simFileContext: not indexed: ${filePath}`);
  const exports = db
    .prepare("SELECT name, kind, signature, line FROM exports WHERE file_id = ? ORDER BY COALESCE(line, 1e9), id")
    .all(f.id) as { name: string; kind: string; signature: string | null; line: number | null }[];
  const deps = db
    .prepare("SELECT f.path, d.symbols FROM dependencies d JOIN files f ON d.target_id = f.id WHERE d.source_id = ?")
    .all(f.id) as { path: string; symbols: string }[];
  const dependents = db
    .prepare("SELECT f.path, d.symbols FROM dependencies d JOIN files f ON d.source_id = f.id WHERE d.target_id = ?")
    .all(f.id) as { path: string; symbols: string }[];
  const importLines = parseStoredImportLines(f.import_lines);
  const renderExport = (e: (typeof exports)[number]) => {
    const at = e.line != null ? `L${e.line} ` : "";
    return e.signature ? `- ${at}${e.signature}` : `- ${at}${e.name} (${e.kind})`;
  };
  return [
    `# ${displayPath(f.path)}`,
    `${f.language} | ${formatSize(f.size_bytes)} | ${f.line_count} lines | modified ${CANONICAL_MODIFIED_AT} | indexed ${CANONICAL_INDEXED_AT}`,
    f.summary,
    f.description && f.description !== f.summary ? f.description : "",
    exports.length > 0 ? `## Exports (${exports.length})\n${capped(exports, 40, renderExport)}` : "",
    importLines.length > 0 ? `## Import lines (${importLines.length})\n${capped(importLines, 30, (l) => `L${l.line} ${l.text}`)}` : "",
    f.external_imports ? `## External packages\n${f.external_imports}` : "",
    deps.length > 0 ? `## Imports from (${deps.length})\n${capped(deps, 30, (d) => `- ${displayPath(d.path)} [${d.symbols}]`)}` : "",
    dependents.length > 0 ? `## Imported by (${dependents.length})\n${capped(dependents, 30, (d) => `- ${displayPath(d.path)} [${d.symbols}]`)}` : "",
  ]
    .filter((x) => x)
    .join("\n");
}

/** find_symbol(name). */
export function simFindSymbol(db: Database.Database, name: string): string {
  const rows = db
    .prepare("SELECT e.name, e.kind, f.path, f.summary FROM exports e JOIN files f ON e.file_id = f.id WHERE e.name LIKE ? ORDER BY e.name")
    .all(name) as any[];
  if (!rows.length) return `No exports matching "${name}" found.`;
  return rows
    .map((r) => `${r.name} (${r.kind}) — ${displayPath(r.path)}\n  ${r.summary} | indexed ${CANONICAL_INDEXED_AT}`)
    .join("\n\n");
}

/** search_files(query). */
export function simSearchFiles(db: Database.Database, q: string): string {
  const p = q.includes("%") ? q : `%${q}%`;
  const rows = db
    .prepare(
      "SELECT path, language, line_count, summary, (SELECT COUNT(*) FROM exports WHERE file_id = files.id) as ec, (SELECT COUNT(*) FROM dependencies WHERE source_id = files.id) as dc FROM files WHERE path LIKE ? OR summary LIKE ? ORDER BY path LIMIT 25",
    )
    .all(p, p) as any[];
  if (!rows.length) return `No files matching "${q}".`;
  return rows
    .map(
      (r) =>
        `${displayPath(r.path)} (${r.language}, ${r.line_count} lines, ${r.ec} exports, ${r.dc} deps)\n  Modified: ${CANONICAL_MODIFIED_AT} | indexed ${CANONICAL_INDEXED_AT} | ${r.summary}`,
    )
    .join("\n\n");
}
