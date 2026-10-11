/**
 * Paths between agents and the index (CCA-01, #116).
 *
 * Storage: the index keys every row by REALPATH. On macOS os.tmpdir() is
 * /var/folders/… (a symlink to /private/var/…); agents resolve their cwd to the
 * realpath and their sandbox refuses /var/… as "outside the workspace", so an
 * unresolved path copied from a result could not be read back.
 *
 * Output: tools print paths relative to a display base (`src/utils/x.ts`),
 * absolute only on request (`absolute_paths: true` or
 * CODE_CONTEXT_ABSOLUTE_PATHS=1). The base is the indexed root that contains
 * the server's cwd; else the cwd itself when indexed roots sit below it (shared
 * db over a workspace folder); else the only indexed root. Files outside the
 * base — other repos in a shared db — stay absolute, so no printed relative
 * path is ever ambiguous, and every printed path resolves back here.
 *
 * Input (resolveToolPath): the printed relative form, the absolute realpath and
 * the old unresolved absolute form. Order for a relative path: base → cwd
 * (realpath, then as given) → a unique suffix match. An absolute path is
 * realpath'd; a row stored under the old spelling (db indexed before 2.12 and
 * not yet migrated) is still found.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export type PathResolution =
  | { kind: 'path'; path: string }
  | { kind: 'ambiguous'; candidates: string[] };

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Absolute realpath of `p`. A path that does not exist (yet, or any more) gets
 * the realpath of its deepest existing ancestor plus the rest, so
 * /var/x/new.ts → /private/var/x/new.ts on macOS.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    /* missing: walk up */
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(canonicalPath(parent), path.basename(abs));
}

function indexedRoots(db: Database.Database): string[] {
  try {
    return (db.prepare(`SELECT root FROM indexed_repos ORDER BY length(root) DESC`).all() as { root: string }[]).map(
      (r) => r.root,
    );
  } catch {
    return []; // foreign db without the table
  }
}

/** The directory printed paths are relative to, or null (print absolute). See the header. */
export function displayBase(db: Database.Database, cwd: string = process.cwd()): string | null {
  const c = canonicalPath(cwd);
  const roots = indexedRoots(db);
  for (const r of roots) if (inside(c, r)) return r;
  if (c !== path.parse(c).root && roots.some((r) => inside(r, c))) return c;
  return roots.length === 1 ? roots[0] : null;
}

export const absolutePathsByEnv = (): boolean => /^(1|true|yes)$/i.test(process.env.CODE_CONTEXT_ABSOLUTE_PATHS ?? '');

/**
 * A formatter for one tool response: stored path → the form the model sees.
 * Relative (forward slashes) under the display base, absolute otherwise.
 */
export function pathDisplay(
  db: Database.Database,
  opts: { absolute?: boolean; cwd?: string } = {},
): (p: string) => string {
  const absolute = opts.absolute ?? absolutePathsByEnv();
  if (absolute) return (p) => p;
  const base = displayBase(db, opts.cwd);
  if (!base) return (p) => p;
  return (p) => {
    if (!path.isAbsolute(p) || !inside(p, base) || p === base) return p;
    return path.relative(base, p).split(path.sep).join('/');
  };
}

export function resolveToolPath(
  db: Database.Database,
  input: string,
  cwd: string = process.cwd(),
): PathResolution {
  const has = (p: string): boolean => !!db.prepare(`SELECT 1 FROM files WHERE path = ?`).get(p);

  if (path.isAbsolute(input)) {
    const real = canonicalPath(input);
    if (has(real)) return { kind: 'path', path: real };
    const asGiven = path.resolve(input);
    if (asGiven !== real && has(asGiven)) return { kind: 'path', path: asGiven }; // pre-2.12 row
    // Realpath given, row still under a root's symlinked spelling (pre-2.12, not yet migrated).
    for (const r of indexedRoots(db)) {
      const rr = canonicalPath(r);
      if (rr === r || !inside(real, rr)) continue;
      const legacy = path.join(r, path.relative(rr, real));
      if (has(legacy)) return { kind: 'path', path: legacy };
    }
    return { kind: 'path', path: real };
  }

  const rel = input.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = displayBase(db, cwd);
  const realCwd = canonicalPath(cwd);
  const tries = [base ? path.resolve(base, rel) : null, path.resolve(realCwd, rel), path.resolve(cwd, rel)];
  for (const t of tries) if (t && has(t)) return { kind: 'path', path: t };

  const rows = db
    .prepare(`SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20`)
    .all(`%/${escapeLike(rel)}`) as { path: string }[];
  if (rows.length === 1) return { kind: 'path', path: rows[0].path };
  if (rows.length > 1) {
    const scopes = [base, realCwd, path.resolve(cwd)].filter((s): s is string => !!s);
    const underCwd = rows.filter((r) => scopes.some((s) => inside(r.path, s)));
    if (underCwd.length === 1) return { kind: 'path', path: underCwd[0].path };
    const pool = underCwd.length > 1 ? underCwd : rows;
    return { kind: 'ambiguous', candidates: pool.map((r) => r.path) };
  }
  // Not indexed yet: hand back the realpath under the base (or cwd) so on-demand indexing can try it.
  return { kind: 'path', path: canonicalPath(path.resolve(base ?? realCwd, rel)) };
}

/**
 * Resolve a directory path for set_directory_description: relative to the
 * display base, realpath'd, with the old unresolved spelling as fallback.
 */
export function resolveDirPath(db: Database.Database, input: string, cwd: string = process.cwd()): string {
  const has = (p: string): boolean => !!db.prepare(`SELECT 1 FROM directories WHERE path = ?`).get(p);
  const abs = path.isAbsolute(input) ? input : path.resolve(displayBase(db, cwd) ?? canonicalPath(cwd), input);
  const real = canonicalPath(abs);
  if (has(real)) return real;
  const asGiven = path.resolve(abs);
  return has(asGiven) ? asGiven : real;
}
