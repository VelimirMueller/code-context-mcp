/**
 * Resolve a file path an agent passes to a tool into the absolute path the
 * index stores. Agents usually send repo-relative paths (`src/server/schema.ts`);
 * the index keys files by absolute path, so a relative path used to miss and
 * the agent fell back to grep (benchmark 2026-10-11).
 *
 * Order: absolute as given → relative to the server's cwd (the project root
 * when Claude Code starts the server) → a unique suffix match in the index.
 * One database can hold several repos, so several suffix matches prefer the
 * one under cwd and otherwise come back as candidates instead of a guess.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';

export type PathResolution =
  | { kind: 'path'; path: string }
  | { kind: 'ambiguous'; candidates: string[] };

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function resolveToolPath(
  db: Database.Database,
  input: string,
  cwd: string = process.cwd(),
): PathResolution {
  if (path.isAbsolute(input)) return { kind: 'path', path: input };
  const rel = input.replace(/\\/g, '/').replace(/^\.\//, '');
  const fromCwd = path.resolve(cwd, rel);
  const exact = db.prepare(`SELECT path FROM files WHERE path = ?`).get(fromCwd) as
    | { path: string }
    | undefined;
  if (exact) return { kind: 'path', path: exact.path };

  const rows = db
    .prepare(`SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20`)
    .all(`%/${escapeLike(rel)}`) as { path: string }[];
  if (rows.length === 1) return { kind: 'path', path: rows[0].path };
  if (rows.length > 1) {
    const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
    const underCwd = rows.filter((r) => r.path.startsWith(root));
    if (underCwd.length === 1) return { kind: 'path', path: underCwd[0].path };
    const pool = underCwd.length > 1 ? underCwd : rows;
    return { kind: 'ambiguous', candidates: pool.map((r) => r.path) };
  }
  // Not indexed yet: hand back the cwd-relative path so on-demand indexing can try it.
  return { kind: 'path', path: fromCwd };
}
