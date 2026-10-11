/**
 * Bulk re-index of every git repo under a root, for the CLI
 * (`code-context-reindex`) and a scheduled job. The read-time guard in
 * freshness.ts keeps answers honest between runs; this keeps the index
 * complete (new repos, new untracked files) and small (policy purge, prune).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { indexDirectory, removeFiles, isPathInside, realPathOf } from "./indexer.js";
import { isDeniedPath, isDeniedDirPath } from "./index-policy.js";
import { isGitCheckout } from "./git.js";

export const IGNORE_MARKER = ".code-context-ignore";

export interface DbStats {
  files: number;
  depFiles: number;
  /** Repos under the root that have at least one indexed file. */
  reposCovered: number;
  bytes: number;
}

export interface RepoResult {
  root: string;
  files: number;
  pruned: number;
  ms: number;
  error?: string;
}

export interface ReindexOptions {
  /** Directory whose child git checkouts are discovered (with all=true). */
  root: string;
  /** Explicit repo paths; when empty, every repo under root. */
  repos?: string[];
  pruneMissing?: boolean;
  vacuum?: boolean;
  dbPath?: string;
  progress?: (line: string) => void;
}

export interface ReindexSummary {
  before: DbStats;
  after: DbStats;
  purgedDenied: number;
  purgedMarked: { root: string; files: number }[];
  prunedMissing: { repos: number; files: number; dirs: number };
  repos: RepoResult[];
  ok: boolean;
}

/** Direct children of `root` that are git checkouts, split by the ignore marker. Dot-dirs (.worktrees) are skipped. */
export function discoverRepos(root: string): { repos: string[]; marked: string[] } {
  const repos: string[] = [];
  const marked: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { repos, marked };
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    if (!isGitCheckout(dir)) continue;
    (fs.existsSync(path.join(dir, IGNORE_MARKER)) ? marked : repos).push(dir);
  }
  return { repos: repos.sort(), marked: marked.sort() };
}

const DEP_SQL = `path LIKE '%/node_modules/%' OR path LIKE '%/vendor/%'`;

export function dbStats(db: Database.Database, root: string, dbPath?: string): DbStats {
  const files = (db.prepare(`SELECT COUNT(*) c FROM files`).get() as { c: number }).c;
  const depFiles = (db.prepare(`SELECT COUNT(*) c FROM files WHERE ${DEP_SQL}`).get() as { c: number }).c;
  const prefix = realPathOf(root) + path.sep; // rows are stored under the realpath
  const covered = db
    .prepare(
      `SELECT COUNT(DISTINCT substr(path, ?, instr(substr(path, ?), '/') - 1)) c FROM files WHERE substr(path, 1, ?) = ?`,
    )
    .get(prefix.length + 1, prefix.length + 1, prefix.length, prefix) as { c: number };
  let bytes = 0;
  if (dbPath) {
    for (const suffix of ["", "-wal"]) {
      try {
        bytes += fs.statSync(dbPath + suffix).size;
      } catch {
        /* absent */
      }
    }
  }
  return { files, depFiles, reposCovered: covered.c, bytes };
}

/** Nearest ancestor of `file` holding a `.git` entry, cached per directory. */
function makeRootFinder(knownRoots: string[]): (file: string) => string | null {
  const sorted = [...knownRoots].sort((a, b) => b.length - a.length);
  const cache = new Map<string, string | null>();
  return (file) => {
    for (const r of sorted) if (isPathInside(file, r)) return r;
    let dir = path.dirname(file);
    const visited: string[] = [];
    let found: string | null = null;
    while (true) {
      const hit = cache.get(dir);
      if (hit !== undefined) {
        found = hit;
        break;
      }
      visited.push(dir);
      if (isGitCheckout(dir)) {
        found = dir;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    for (const v of visited) cache.set(v, found);
    return found;
  };
}

/**
 * Delete every row the current policy would never have written: dependency
 * dirs, build output, lockfiles, binaries, oversized files, Laravel storage/.
 * Judged relative to the file's checkout, so a repo living under a dot-dir is
 * not wiped by the dot rule. Their change-log rows go too. Returns files purged.
 */
export function purgeDenied(db: Database.Database): number {
  const known = (db.prepare(`SELECT root FROM indexed_repos`).all() as { root: string }[]).map((r) => r.root);
  const rootOf = makeRootFinder(known);
  const rows = db.prepare(`SELECT path, size_bytes FROM files`).all() as { path: string; size_bytes: number | null }[];
  const doomed: string[] = [];
  for (const r of rows) {
    const root = rootOf(r.path) ?? path.dirname(r.path);
    if (isDeniedPath(r.path, root, r.size_bytes ?? undefined)) doomed.push(r.path);
  }
  const delChanges = db.prepare(`DELETE FROM changes WHERE file_path = ?`);
  const dirs = db.prepare(`SELECT id, path FROM directories`).all() as { id: number; path: string }[];
  const delDir = db.prepare(`DELETE FROM directories WHERE id = ?`);
  let n = 0;
  db.transaction(() => {
    n = removeFiles(db, doomed);
    for (const p of doomed) delChanges.run(p);
    for (const d of dirs) {
      const root = rootOf(path.join(d.path, "x"));
      if (root && isDeniedDirPath(d.path, root)) delDir.run(d.id);
    }
  })();
  return n;
}

/** Remove everything indexed under `root` (files, dirs, its indexed_repos row), under either spelling. */
export function purgeUnder(db: Database.Database, root: string): number {
  const real = realPathOf(root);
  const lexical = path.resolve(root);
  return purgeUnderExact(db, real) + (real === lexical ? 0 : purgeUnderExact(db, lexical));
}

function purgeUnderExact(db: Database.Database, root: string): number {
  const prefix = path.resolve(root) + path.sep;
  const paths = (db.prepare(`SELECT path FROM files WHERE substr(path, 1, ?) = ?`).all(prefix.length, prefix) as {
    path: string;
  }[]).map((r) => r.path);
  let n = 0;
  db.transaction(() => {
    n = removeFiles(db, paths);
    db.prepare(`DELETE FROM changes WHERE substr(file_path, 1, ?) = ?`).run(prefix.length, prefix);
    db.prepare(`DELETE FROM directories WHERE path = ? OR substr(path, 1, ?) = ?`).run(path.resolve(root), prefix.length, prefix);
    db.prepare(`DELETE FROM indexed_repos WHERE root = ?`).run(path.resolve(root));
  })();
  return n;
}

/** Drop repos whose root is gone, then any file/dir row whose path is gone. */
export function pruneMissing(db: Database.Database): { repos: number; files: number; dirs: number } {
  let repos = 0;
  let files = 0;
  for (const { root } of db.prepare(`SELECT root FROM indexed_repos`).all() as { root: string }[]) {
    if (fs.existsSync(root)) continue;
    files += purgeUnder(db, root);
    repos++;
  }
  const gone = (db.prepare(`SELECT path FROM files`).all() as { path: string }[])
    .map((r) => r.path)
    .filter((p) => !fs.existsSync(p));
  files += removeFiles(db, gone);
  const delDir = db.prepare(`DELETE FROM directories WHERE id = ?`);
  let dirs = 0;
  const dirRows = db.prepare(`SELECT id, path FROM directories`).all() as { id: number; path: string }[];
  db.transaction(() => {
    for (const d of dirRows) {
      if (fs.existsSync(d.path)) continue;
      delDir.run(d.id);
      dirs++;
    }
  })();
  return { repos, files, dirs };
}

export function runReindex(db: Database.Database, opts: ReindexOptions): ReindexSummary {
  const say = opts.progress ?? (() => {});
  const root = path.resolve(opts.root);
  const before = dbStats(db, root, opts.dbPath);

  const discovered = discoverRepos(root);
  const targets = opts.repos && opts.repos.length > 0 ? opts.repos.map((r) => path.resolve(r)) : discovered.repos;

  const purgedMarked: { root: string; files: number }[] = [];
  // Discovery mode only: a run limited to explicit repos touches nothing else.
  const explicit = !!(opts.repos && opts.repos.length > 0);
  for (const m of explicit ? [] : discovered.marked) {
    const n = purgeUnder(db, m);
    purgedMarked.push({ root: m, files: n });
    say(`skip  ${path.basename(m)} (${IGNORE_MARKER}) — purged ${n} rows`);
  }

  const purgedDenied = purgeDenied(db);
  say(`purge ${purgedDenied} rows matching the ignore policy`);

  const prunedMissing = opts.pruneMissing ? pruneMissing(db) : { repos: 0, files: 0, dirs: 0 };
  if (opts.pruneMissing) {
    say(`prune ${prunedMissing.repos} missing repos, ${prunedMissing.files} missing files, ${prunedMissing.dirs} missing dirs`);
  }

  const repos: RepoResult[] = [];
  for (const repo of targets) {
    const start = Date.now();
    if (fs.existsSync(path.join(repo, IGNORE_MARKER))) {
      say(`skip  ${path.basename(repo)} (${IGNORE_MARKER})`);
      continue;
    }
    try {
      const s = indexDirectory(db, repo);
      const r = { root: repo, files: s.files, pruned: s.prunedFiles, ms: Date.now() - start };
      repos.push(r);
      say(`index ${path.basename(repo)}: ${s.files} files, pruned ${s.prunedFiles} (${r.ms} ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      repos.push({ root: repo, files: 0, pruned: 0, ms: Date.now() - start, error: msg });
      say(`FAIL  ${path.basename(repo)}: ${msg}`);
    }
  }

  if (opts.vacuum) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
  }

  const after = dbStats(db, root, opts.dbPath);
  return { before, after, purgedDenied, purgedMarked, prunedMissing, repos, ok: repos.every((r) => !r.error) };
}
