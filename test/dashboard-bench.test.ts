/**
 * Dashboard bench reader — source resolution (env dir → db-adjacent bench/ →
 * git origin/bench-results in the package checkout → empty state) and the
 * /api/bench/index + /api/bench/run/:id routes over real HTTP.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBenchSource,
  apiBenchIndex,
  apiBenchRun,
  clearBenchCache,
  BENCH_DIR_ENV,
  BENCH_PRIVATE_DIRS_ENV,
  EMPTY_MESSAGE,
  resolvePrivateDirs,
} from "../src/dashboard/handlers/bench.js";
import { freePort } from "./helpers/free-port.js";
import { makeRepo, write, commitAll, git } from "./helpers/git-repo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DASHBOARD_ENTRY = path.join(REPO_ROOT, "src/dashboard/dashboard.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

const RUN_ID = "glm-20261011-003210";

function makeIndex(runIds: string[]) {
  return {
    schema: "ccc-bench-index/1",
    runs: runIds.map((run_id) => ({
      run_id,
      kind: "agent-glm",
      date: "2026-10-11",
      ts: "2026-10-11T00:32:10Z",
      model: "zai-coding-plan/glm-5.3",
      trigger: "manual",
      headline: { success_vanilla_pct: 93.3, success_cc_pct: 93.3, tokens_saved_pct: 6.7, tool_calls_saved_pct: -18.3 },
    })),
  };
}

/** A bench dir (index.json + runs/<id>.json) under `dir`. */
function writeBenchDir(dir: string, runIds: string[], tag = "x"): string {
  mkdirSync(path.join(dir, "runs"), { recursive: true });
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(makeIndex(runIds)));
  for (const id of runIds) {
    writeFileSync(path.join(dir, "runs", `${id}.json`), JSON.stringify({ schema: "ccc-bench/1", run_id: id, tag }));
  }
  return dir;
}

let tmp: string;
/** A non-git dir standing in for the package root, so the git fallback never hits. */
let noGitPkg: string;

beforeEach(() => {
  clearBenchCache();
});

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "cc-bench-")));
  noGitPkg = path.join(tmp, "pkg");
  mkdirSync(noGitPkg);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("bench source resolution", () => {
  it("prefers env CODE_CONTEXT_BENCH_DIR over the db-adjacent dir", async () => {
    const envDir = writeBenchDir(path.join(tmp, "env1"), [RUN_ID], "env");
    const proj = path.join(tmp, "proj1");
    writeBenchDir(path.join(proj, "bench"), [RUN_ID], "db");
    const opts = { dbPath: path.join(proj, "context.db"), packageDir: noGitPkg, env: { [BENCH_DIR_ENV]: envDir } };
    expect(await resolveBenchSource(opts)).toEqual({ type: "dir", dir: envDir, origin: "env" });
    const res = await apiBenchRun(opts, RUN_ID);
    expect(res.source.label).toBe(`env ${BENCH_DIR_ENV}`);
    expect((res.run as { tag: string }).tag).toBe("env");
  });

  it("uses <dirname(dbPath)>/bench/ when env is unset or has no index.json", async () => {
    const proj = path.join(tmp, "proj2");
    writeBenchDir(path.join(proj, "bench"), [RUN_ID], "db");
    const emptyEnv = path.join(tmp, "env-empty");
    mkdirSync(emptyEnv);
    const opts = { dbPath: path.join(proj, "context.db"), packageDir: noGitPkg, env: { [BENCH_DIR_ENV]: emptyEnv } };
    expect(await resolveBenchSource(opts)).toMatchObject({ type: "dir", origin: "db" });
    const idx = await apiBenchIndex(opts);
    expect(idx.index?.runs.map((r) => r.run_id)).toEqual([RUN_ID]);
    expect(idx.source.type).toBe("dir");
  });

  it("returns an explicit empty state when nothing is available", async () => {
    const opts = { dbPath: path.join(tmp, "proj-none", "context.db"), packageDir: noGitPkg, env: {} };
    const idx = await apiBenchIndex(opts);
    expect(idx).toEqual({ source: { type: "none", label: "none" }, index: null, message: EMPTY_MESSAGE });
    await expect(apiBenchRun(opts, RUN_ID)).rejects.toMatchObject({ status: 404 });
  });

  it("falls back to git origin/bench-results:data/ in the package checkout (no network)", async () => {
    const repo = makeRepo("cc-bench-git-");
    try {
      write(repo, "README.md", "x");
      commitAll(repo, "main");
      git(repo, "checkout", "-q", "--orphan", "bench-results");
      git(repo, "rm", "-rfq", ".");
      writeBenchDir(path.join(repo, "data"), [RUN_ID], "git");
      const sha = commitAll(repo, "bench");
      git(repo, "update-ref", "refs/remotes/origin/bench-results", sha);
      git(repo, "checkout", "-q", "main");
      const opts = { dbPath: path.join(tmp, "proj-git", "context.db"), packageDir: repo, env: {} };
      expect(await resolveBenchSource(opts)).toEqual({ type: "git", repo });
      const res = await apiBenchRun(opts, RUN_ID);
      expect(res.source.label).toBe("git origin/bench-results");
      expect((res.run as { tag: string }).tag).toBe("git");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips the git fallback when the package dir is only a subdir of a repo", async () => {
    const repo = makeRepo("cc-bench-sub-");
    try {
      write(repo, "node_modules/pkg/package.json", "{}");
      commitAll(repo);
      const opts = { dbPath: path.join(tmp, "x", "context.db"), packageDir: path.join(repo, "node_modules/pkg"), env: {} };
      expect(await resolveBenchSource(opts)).toEqual({ type: "none" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("bench run id guard", () => {
  it("rejects ids outside the charset and ids the index does not list", async () => {
    const envDir = writeBenchDir(path.join(tmp, "env-guard"), [RUN_ID]);
    // A run file that exists on disk but is not in the index must not be served.
    writeFileSync(path.join(envDir, "runs", "unlisted.json"), "{}");
    const opts = { dbPath: path.join(tmp, "g", "context.db"), packageDir: noGitPkg, env: { [BENCH_DIR_ENV]: envDir } };
    for (const bad of ["../index", "..%2Fx", "Upper", "-lead", "a/b", "a.json", "", "x".repeat(82)]) {
      await expect(apiBenchRun(opts, bad), bad).rejects.toMatchObject({ status: 400 });
    }
    await expect(apiBenchRun(opts, "unlisted")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a run file that symlinks out of the bench dir", async () => {
    const envDir = writeBenchDir(path.join(tmp, "env-link"), ["linked"]);
    const outside = path.join(tmp, "secret.json");
    writeFileSync(outside, JSON.stringify({ secret: true }));
    rmSync(path.join(envDir, "runs", "linked.json"));
    symlinkSync(outside, path.join(envDir, "runs", "linked.json"));
    const opts = { dbPath: path.join(tmp, "l", "context.db"), packageDir: noGitPkg, env: { [BENCH_DIR_ENV]: envDir } };
    await expect(apiBenchRun(opts, "linked")).rejects.toMatchObject({ status: 400 });
  });
});

describe("private suite dirs (CODE_CONTEXT_BENCH_PRIVATE_DIRS)", () => {
  /** A private suite dir: suite.json (alias) + data/ bench dir. */
  function writeSuite(dir: string, runIds: string[], suite: Record<string, unknown> = { id: "synthetic-suite", alias: "Suite A" }): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "suite.json"), JSON.stringify({ schema: "ccc-bench-suite/1", private: true, ...suite }));
    writeBenchDir(path.join(dir, "data"), runIds, "private");
    return dir;
  }

  it("resolves suite dirs and data dirs, keys by list position, skips dirs without index.json", () => {
    const a = writeSuite(path.join(tmp, "priv-a"), ["opus-20261012-092421"]);
    const b = writeSuite(path.join(tmp, "priv-b"), ["glm-20261012-101500"], { id: "suite-b" });
    const empty = path.join(tmp, "priv-empty");
    mkdirSync(empty, { recursive: true });
    const env = { [BENCH_PRIVATE_DIRS_ENV]: [a, empty, path.join(b, "data"), ""].join(path.delimiter) };
    expect(resolvePrivateDirs(env)).toEqual([
      { key: "p0", dir: path.join(a, "data"), alias: "Suite A" },
      { key: "p2", dir: path.join(b, "data"), alias: "suite-b" },
    ]);
    expect(resolvePrivateDirs({})).toEqual([]);
  });

  it("merges private runs into the index, flagged with alias and key, newest first", async () => {
    const pub = writeBenchDir(path.join(tmp, "pub-merge"), [RUN_ID]);
    const priv = writeSuite(path.join(tmp, "priv-merge"), ["opus-20261012-092421"]);
    // The private index entry is newer than the public one.
    writeFileSync(
      path.join(priv, "data", "index.json"),
      JSON.stringify({ schema: "ccc-bench-index/1", runs: [{ run_id: "opus-20261012-092421", kind: "agent-opus", date: "2026-10-12", ts: "2026-10-12T09:24:21Z", model: "m", trigger: "manual", headline: null }] }),
    );
    const opts = { dbPath: path.join(tmp, "m", "context.db"), packageDir: noGitPkg, env: { [BENCH_DIR_ENV]: pub, [BENCH_PRIVATE_DIRS_ENV]: priv } };
    const res = await apiBenchIndex(opts);
    expect(res.index!.runs.map((r) => [r.run_id, r.private ?? false, r.suite ?? null, r.source_key ?? null])).toEqual([
      ["opus-20261012-092421", true, "Suite A", "p0"],
      [RUN_ID, false, null, null],
    ]);
    expect(res.private).toEqual([{ key: "p0", alias: "Suite A", runs: 1 }]);
  });

  it("serves private runs only through ?suite=<key>, with the same id + index + realpath rules", async () => {
    const priv = writeSuite(path.join(tmp, "priv-run"), ["opus-20261012-092421"]);
    writeFileSync(path.join(priv, "data", "runs", "unlisted.json"), "{}");
    const outside = path.join(tmp, "priv-outside.json");
    writeFileSync(outside, JSON.stringify({ secret: true }));
    writeFileSync(path.join(priv, "data", "index.json"), JSON.stringify(makeIndex(["opus-20261012-092421", "linked"])));
    symlinkSync(outside, path.join(priv, "data", "runs", "linked.json"));
    const opts = { dbPath: path.join(tmp, "r", "context.db"), packageDir: noGitPkg, env: { [BENCH_PRIVATE_DIRS_ENV]: priv } };
    await expect(apiBenchRun(opts, "opus-20261012-092421", "p0")).resolves.toMatchObject({ run: { run_id: "opus-20261012-092421", tag: "private" } });
    // Without the key the public source serves (here: none).
    await expect(apiBenchRun(opts, "opus-20261012-092421")).rejects.toMatchObject({ status: 404 });
    await expect(apiBenchRun(opts, "unlisted", "p0")).rejects.toMatchObject({ status: 404 });
    await expect(apiBenchRun(opts, "linked", "p0")).rejects.toMatchObject({ status: 400 });
    await expect(apiBenchRun(opts, "../index", "p0")).rejects.toMatchObject({ status: 400 });
    for (const badKey of ["p", "x0", "p0/..", "../p0", "p1234"]) {
      await expect(apiBenchRun(opts, "opus-20261012-092421", badKey), badKey).rejects.toMatchObject({ status: 400 });
    }
    await expect(apiBenchRun(opts, "opus-20261012-092421", "p7")).rejects.toMatchObject({ status: 404 });
  });

  it("shows private runs when there is no public source", async () => {
    const priv = writeSuite(path.join(tmp, "priv-only"), ["opus-20261012-092421"]);
    const opts = { dbPath: path.join(tmp, "o", "context.db"), packageDir: noGitPkg, env: { [BENCH_PRIVATE_DIRS_ENV]: priv } };
    const res = await apiBenchIndex(opts);
    expect(res.index!.runs).toHaveLength(1);
    expect(res.index!.runs[0]).toMatchObject({ private: true, suite: "Suite A", source_key: "p0" });
  });
});

describe("bench routes over real HTTP", () => {
  const TOKEN = "test-bench-token-0123456789abcdef0123";
  const PORT = freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  let proc: ChildProcess;
  let root: string;
  let serverLog = "";

  const getJson = async (p: string) => {
    const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "cc-bench-http-")));
    const benchDir = writeBenchDir(path.join(root, "data"), [RUN_ID], "http");
    const privDir = writeBenchDir(path.join(root, "priv-suite", "data"), [RUN_ID], "http-private");
    writeFileSync(path.join(root, "priv-suite", "suite.json"), JSON.stringify({ schema: "ccc-bench-suite/1", id: "s", alias: "Suite H", private: true }));
    proc = spawn(process.execPath, [TSX_CLI, DASHBOARD_ENTRY, path.join(root, "context.db"), String(PORT)], {
      cwd: root,
      env: {
        ...process.env,
        CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN,
        DASHBOARD_PORT: String(PORT),
        [BENCH_DIR_ENV]: benchDir,
        [BENCH_PRIVATE_DIRS_ENV]: path.dirname(privDir),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    proc.stdout?.on("data", (d) => { serverLog += String(d); });
    proc.stderr?.on("data", (d) => { serverLog += String(d); });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`dashboard exited early:\n${serverLog}`);
      try {
        const r = await getJson("/api/bench/index");
        if (r.status === 200 && r.body.index) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`dashboard did not become ready:\n${serverLog}`);
  }, 40000);

  afterAll(() => {
    if (proc?.pid) {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    proc?.kill("SIGKILL");
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("serves the index from the env dir", async () => {
    const r = await getJson("/api/bench/index");
    expect(r.status).toBe(200);
    expect(r.body.source).toEqual({ type: "dir", label: `env ${BENCH_DIR_ENV}` });
    expect(r.body.index.runs[0].run_id).toBe(RUN_ID);
  });

  it("serves a listed run file", async () => {
    const r = await getJson(`/api/bench/run/${RUN_ID}`);
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ run_id: RUN_ID, tag: "http" });
  });

  it("rejects invalid and traversal ids with 400, unknown ids with 404", async () => {
    expect((await getJson("/api/bench/run/Bad_Id")).status).toBe(400);
    expect((await getJson("/api/bench/run/..%2F..%2Fcontext.db")).status).toBe(400);
    expect((await getJson("/api/bench/run/%2e%2e%2findex")).status).toBe(400);
    expect((await getJson("/api/bench/run/%E0%A4%A")).status).toBe(400);
    expect((await getJson("/api/bench/run/nope-123")).status).toBe(404);
  });

  it("serves a private run with ?suite=<key>; the same id without it is the public run", async () => {
    const idx = await getJson("/api/bench/index");
    const priv = idx.body.index.runs.find((r: any) => r.private);
    expect(priv).toMatchObject({ run_id: RUN_ID, suite: "Suite H", source_key: "p0" });
    const r = await getJson(`/api/bench/run/${RUN_ID}?suite=p0`);
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ tag: "http-private" });
    expect((await getJson(`/api/bench/run/${RUN_ID}`)).body.run).toMatchObject({ tag: "http" });
    expect((await getJson(`/api/bench/run/${RUN_ID}?suite=..%2Fp0`)).status).toBe(400);
    expect((await getJson(`/api/bench/run/${RUN_ID}?suite=p9`)).status).toBe(404);
  });

  it("requires auth like every other /api route", async () => {
    const res = await fetch(`${BASE}/api/bench/index`);
    expect(res.status).toBe(401);
  });
});
