/**
 * Bench handlers — real benchmark runs (schema `ccc-bench/1`, index
 * `ccc-bench-index/1`) as written by scripts/bench/* and published to the
 * orphan branch `bench-results` (same `data/` layout: index.json + runs/).
 *
 * Source resolution, first hit wins (a dir counts only if it has index.json):
 *   1. env CODE_CONTEXT_BENCH_DIR      — e.g. a checkout's `data/` dir
 *   2. <dirname(dbPath)>/bench/        — copy next to the context DB
 *   3. git `origin/bench-results:data/` in the dashboard PACKAGE's own checkout
 *   4. none                            — empty state with a how-to message
 *
 * Why the package checkout and not the project the dashboard serves: the
 * `bench-results` branch only exists in the code-context repo itself, so
 * probing an arbitrary user project would never hit. The package root counts
 * only when it IS a git top-level (an npm install under node_modules inside a
 * user repo resolves to that repo's top-level and is skipped). The fallback
 * reads the local remote-tracking ref only — no fetch, no network at request
 * time; git output is cached in memory for GIT_CACHE_MS.
 *
 * Security: run ids must match RUN_ID_PATTERN (same charset publish.mts
 * enforces) AND be listed in the index; dir reads are realpath-checked to stay
 * inside the bench dir; git runs via execFile (no shell) with a short timeout.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const BENCH_DIR_ENV = "CODE_CONTEXT_BENCH_DIR";
export const BENCH_GIT_REF = "origin/bench-results";
/** Mirrors scripts/bench/lib/index-builder.mts RUN_ID_PATTERN. */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_CACHE_MS = 5 * 60 * 1000;

export const EMPTY_MESSAGE =
  `No benchmark runs found. Set ${BENCH_DIR_ENV} to a dir with index.json + runs/ ` +
  "(e.g. a code-context checkout's data/ after `npm run bench` / `npm run bench:live`), " +
  "or copy that data/ dir to <project>/bench/ next to context.db. " +
  `In a code-context checkout, \`git fetch origin bench-results\` enables the git fallback.`;

export type BenchSource =
  | { type: "dir"; dir: string; origin: "env" | "db" }
  | { type: "git"; repo: string }
  | { type: "none" };

export interface BenchSourceInfo {
  type: BenchSource["type"];
  /** Human-readable origin, e.g. "env CODE_CONTEXT_BENCH_DIR" or "git origin/bench-results". */
  label: string;
}

export interface ResolveOptions {
  dbPath: string;
  /** Root of the dashboard package (holds package.json). */
  packageDir: string;
  env?: NodeJS.ProcessEnv;
}

export class BenchError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function hasIndex(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "index.json")).isFile();
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf-8", windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

// Cache keyed by `<repo>\0<what>`; holds the promise so concurrent requests share one git call.
const gitCache = new Map<string, { at: number; value: Promise<string | null> }>();

function cachedGit(repo: string, key: string, args: string[]): Promise<string | null> {
  const k = `${repo}\0${key}`;
  const hit = gitCache.get(k);
  if (hit && Date.now() - hit.at < GIT_CACHE_MS) return hit.value;
  const value = runGit(repo, args).catch(() => null);
  gitCache.set(k, { at: Date.now(), value });
  return value;
}

/** Test hook: forget cached git output. */
export function clearBenchCache(): void {
  gitCache.clear();
}

async function gitRepoWithBenchRef(packageDir: string): Promise<string | null> {
  const root = path.resolve(packageDir);
  const top = await cachedGit(root, "toplevel", ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  let same: boolean;
  try {
    same = fs.realpathSync(top.trim()) === fs.realpathSync(root);
  } catch {
    same = false;
  }
  if (!same) return null;
  const ref = await cachedGit(root, "ref", ["rev-parse", "--verify", "--quiet", `${BENCH_GIT_REF}^{commit}`]);
  return ref ? root : null;
}

export async function resolveBenchSource(opts: ResolveOptions): Promise<BenchSource> {
  const env = opts.env ?? process.env;
  const envDir = env[BENCH_DIR_ENV];
  if (envDir && hasIndex(path.resolve(envDir))) return { type: "dir", dir: path.resolve(envDir), origin: "env" };
  const dbDir = path.join(path.dirname(path.resolve(opts.dbPath)), "bench");
  if (hasIndex(dbDir)) return { type: "dir", dir: dbDir, origin: "db" };
  const repo = await gitRepoWithBenchRef(opts.packageDir);
  if (repo) return { type: "git", repo };
  return { type: "none" };
}

export function describeSource(src: BenchSource): BenchSourceInfo {
  if (src.type === "dir") {
    return { type: "dir", label: src.origin === "env" ? `env ${BENCH_DIR_ENV}` : "<project>/bench/" };
  }
  if (src.type === "git") return { type: "git", label: `git ${BENCH_GIT_REF}` };
  return { type: "none", label: "none" };
}

function isInside(base: string, p: string): boolean {
  const rel = path.relative(base, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Read `rel` (index.json or runs/<id>.json) strictly inside `dir`. */
function readInsideDir(dir: string, rel: string): string | null {
  let base: string;
  try {
    base = fs.realpathSync(dir);
  } catch {
    return null;
  }
  const target = path.resolve(base, rel);
  if (!isInside(base, target)) throw new BenchError("path outside bench dir", 400);
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  // Symlinks must not lead out of the bench dir either.
  if (!isInside(base, real)) throw new BenchError("path outside bench dir", 400);
  return fs.readFileSync(real, "utf-8");
}

async function readRaw(src: BenchSource, rel: string): Promise<string | null> {
  if (src.type === "dir") return readInsideDir(src.dir, rel);
  if (src.type === "git") return cachedGit(src.repo, `show:${rel}`, ["show", `${BENCH_GIT_REF}:data/${rel}`]);
  return null;
}

interface IndexEntryLike {
  run_id: string;
  [k: string]: unknown;
}
interface IndexLike {
  schema: string;
  runs: IndexEntryLike[];
}

function parseIndex(raw: string | null): IndexLike | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = parsed as Partial<IndexLike> | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.runs)) return null;
  // Drop entries whose run_id could not be served anyway.
  const runs = p.runs.filter(
    (r): r is IndexEntryLike => !!r && typeof r === "object" && typeof r.run_id === "string" && RUN_ID_PATTERN.test(r.run_id),
  );
  return { schema: String(p.schema ?? ""), runs };
}

export interface BenchIndexResponse {
  source: BenchSourceInfo;
  index: IndexLike | null;
  message?: string;
}

export async function apiBenchIndex(opts: ResolveOptions): Promise<BenchIndexResponse> {
  const src = await resolveBenchSource(opts);
  const index = parseIndex(await readRaw(src, "index.json"));
  if (!index || index.runs.length === 0) {
    return { source: describeSource(src), index: null, message: src.type === "none" ? EMPTY_MESSAGE : `No readable runs in ${describeSource(src).label}. ${EMPTY_MESSAGE}` };
  }
  return { source: describeSource(src), index };
}

export interface BenchRunResponse {
  source: BenchSourceInfo;
  run: unknown;
}

export async function apiBenchRun(opts: ResolveOptions, runId: string): Promise<BenchRunResponse> {
  if (!RUN_ID_PATTERN.test(runId)) throw new BenchError("invalid run id", 400);
  const src = await resolveBenchSource(opts);
  const index = parseIndex(await readRaw(src, "index.json"));
  if (!index || !index.runs.some((r) => r.run_id === runId)) throw new BenchError("run not found", 404);
  const raw = await readRaw(src, `runs/${runId}.json`);
  if (!raw) throw new BenchError("run file missing", 404);
  try {
    return { source: describeSource(src), run: JSON.parse(raw) };
  } catch {
    throw new BenchError("run file is not valid JSON", 500);
  }
}
