/**
 * T-278 — Dashboard route-parity guard.
 *
 * Discovery #17 slice 1 migrates the scrum API route domain out of
 * dashboard.ts into handlers/sprint.ts via the registry. This test freezes the
 * *served* route table — the (method, path) pairs the running server actually
 * recognises — so the migration (and every later slice) can prove it left the
 * surface byte-identical.
 *
 * Mechanism: spawn the real dashboard (same harness as test/ticket-patch.test.ts),
 * then probe every route in the golden table below. The router's final branch
 * answers an unrecognised path with HTTP 404 and the exact body
 * `{"ok":false,"error":"unknown endpoint"}`. A route is "served" iff its probe
 * does NOT produce that sentinel — known routes either succeed or fail with a
 * *different* error (400 "description required", 404 "sprint not found", …),
 * never the unknown-endpoint sentinel. Removing or altering a route registration
 * makes its probe fall through to the sentinel, turning this test red.
 *
 * The table is intentionally the FULL surface (code-intel + scrum + planning +
 * team + bridge), not just the migrated slice, so it doubles as a regression
 * guard for the whole router. It is read-only w.r.t. the scrum source tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./helpers/free-port.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DASHBOARD_ENTRY = path.join(REPO_ROOT, "src/dashboard/dashboard.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

const TOKEN = "test-route-parity-token-0123456789abcdef";
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess;
let tmpRoot: string;
let dbPath: string;
let serverLog = "";

const UNKNOWN_ENDPOINT_SENTINEL = "unknown endpoint";

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function ourDbHasSchema(): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sprints'").get();
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`dashboard process exited early (code ${proc.exitCode}):\n${serverLog}`);
    }
    try {
      const res = await fetch(`${BASE}/api/sprints`, { headers: authHeaders() });
      if (res.ok && ourDbHasSchema()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dashboard server did not become ready in ${timeoutMs}ms:\n${serverLog}`);
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "cc-route-parity-"));
  dbPath = path.join(tmpRoot, "context.db");
  proc = spawn(process.execPath, [TSX_CLI, DASHBOARD_ENTRY, dbPath, String(PORT)], {
    cwd: tmpRoot,
    env: { ...process.env, CODE_CONTEXT_DASHBOARD_TOKEN: TOKEN, DASHBOARD_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout?.on("data", (d) => { serverLog += String(d); });
  proc.stderr?.on("data", (d) => { serverLog += String(d); });
  proc.on("error", (e) => { serverLog += `[spawn error] ${e.message}\n`; });
  await waitForServer();
}, 40000);

afterAll(() => {
  if (proc?.pid) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* group already gone */ }
  }
  proc?.kill("SIGKILL");
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * The golden route table: every (method, path) the router serves under /api/*
 * plus /health. Concrete ids (1) stand in for the :id route params. `body` is
 * sent on mutating probes so we exercise the route's branch (its inner 400s are
 * fine — they are NOT the unknown-endpoint sentinel). This list is the frozen
 * contract; the migration must not add or drop an entry.
 */
interface Route { method: string; path: string; body?: unknown }

const SCRUM_ROUTES: Route[] = [
  // sprint lifecycle + planning
  { method: "POST", path: "/api/sprints/plan", body: { name: "x", ticket_ids: [] } },
  { method: "POST", path: "/api/sprints/archive-completed" },
  { method: "POST", path: "/api/sprint/1/advance" },
  { method: "POST", path: "/api/sprint/1/archive" },
  { method: "POST", path: "/api/sprint/1/unarchive" },
  { method: "POST", path: "/api/sprint/1/stuck", body: {} },
  { method: "GET", path: "/api/sprints" },
  { method: "GET", path: "/api/sprint/1" },
  { method: "PUT", path: "/api/sprint/1", body: {} },
  { method: "DELETE", path: "/api/sprint/1" },
  // sprint sub-resources
  { method: "GET", path: "/api/sprint/1/burndown" },
  { method: "GET", path: "/api/sprint/1/tickets" },
  { method: "GET", path: "/api/sprint/1/blockers" },
  { method: "POST", path: "/api/sprint/1/blockers", body: { description: "d" } },
  { method: "GET", path: "/api/sprint/1/bugs" },
  { method: "POST", path: "/api/sprint/1/bugs", body: { description: "d", severity: "LOW" } },
  { method: "GET", path: "/api/sprint/1/retro" },
  { method: "POST", path: "/api/sprint/1/retro", body: { category: "c", finding: "f" } },
  // blocker / bug / retro mutations
  { method: "PATCH", path: "/api/blocker/1", body: {} },
  { method: "PATCH", path: "/api/bug/1", body: {} },
  { method: "PATCH", path: "/api/retro/1", body: {} },
  { method: "GET", path: "/api/retro/all" },
  // ticket CRUD (scrum domain)
  { method: "POST", path: "/api/tickets", body: { title: "t" } },
  { method: "PUT", path: "/api/ticket/1", body: {} },
  { method: "PATCH", path: "/api/ticket/1", body: { title: "renamed" } },
  { method: "PATCH", path: "/api/ticket/1/milestone", body: {} },
];

const OTHER_ROUTES: Route[] = [
  // code-intel (T-277)
  { method: "GET", path: "/api/files" },
  { method: "GET", path: "/api/directories" },
  { method: "GET", path: "/api/stats" },
  { method: "GET", path: "/api/graph" },
  { method: "GET", path: "/api/changes" },
  { method: "GET", path: "/api/file/1" },
  { method: "GET", path: "/api/file/1/changes" },
  // skills / agents
  { method: "GET", path: "/api/skills" },
  { method: "GET", path: "/api/skill/SOME_SKILL" },
  { method: "GET", path: "/api/agents" },
  { method: "POST", path: "/api/agents", body: { role: "r", name: "n" } },
  { method: "PUT", path: "/api/agent/r", body: {} },
  { method: "DELETE", path: "/api/agent/r" },
  // milestones / vision / epics
  { method: "GET", path: "/api/milestones" },
  { method: "POST", path: "/api/milestones", body: { name: "m" } },
  { method: "PUT", path: "/api/milestone/1", body: {} },
  { method: "DELETE", path: "/api/milestone/1" },
  { method: "PUT", path: "/api/vision", body: { content: "v" } },
  { method: "GET", path: "/api/epics" },
  { method: "POST", path: "/api/epics", body: { name: "e" } },
  { method: "PUT", path: "/api/epic/1", body: {} },
  { method: "DELETE", path: "/api/epic/1" },
  { method: "POST", path: "/api/milestone/1/archive" },
  { method: "POST", path: "/api/milestone/1/unarchive" },
  { method: "POST", path: "/api/epic/1/archive" },
  { method: "POST", path: "/api/epic/1/unarchive" },
  { method: "PATCH", path: "/api/sprint/1/milestone", body: {} },
  { method: "PATCH", path: "/api/ticket/1/epic", body: {} },
  // discoveries
  { method: "GET", path: "/api/discoveries" },
  { method: "GET", path: "/api/discoveries/coverage" },
  { method: "GET", path: "/api/discoveries/sprints" },
  { method: "POST", path: "/api/discovery/1/link", body: {} },
  { method: "PATCH", path: "/api/discovery/1", body: {} },
  // grouped / backlog / activity / misc reads
  { method: "GET", path: "/api/sprints/grouped" },
  { method: "GET", path: "/api/backlog" },
  { method: "GET", path: "/api/activity" },
  { method: "GET", path: "/api/comparison" },
  { method: "GET", path: "/api/benchmark" },
  { method: "GET", path: "/api/benchmark-stochastic" },
  { method: "GET", path: "/api/bench/index" },
  { method: "GET", path: "/api/bench/run/sim-1" },
  { method: "GET", path: "/api/token-usage" },
  { method: "GET", path: "/api/trash" },
  { method: "GET", path: "/api/dump" },
  { method: "POST", path: "/api/restore", body: {} },
  { method: "GET", path: "/api/project/status" },
  // bridge
  { method: "GET", path: "/api/bridge/actions" },
  { method: "POST", path: "/api/bridge/actions", body: { action: "custom" } },
  { method: "PATCH", path: "/api/bridge/actions/1/respond", body: { result: "r" } },
  { method: "GET", path: "/api/bridge/status" },
  // sprint process + gates
  { method: "GET", path: "/api/sprint-process/markdown" },
  { method: "GET", path: "/api/sprint/1/gates" },
  { method: "GET", path: "/api/sprint-process" },
  { method: "PUT", path: "/api/sprint-process", body: { phases: [{ name: "P", criteria: [], actions: [] }] } },
  { method: "GET", path: "/api/sprint/1/gate/rest" },
  // health (no auth)
  { method: "GET", path: "/health" },
];

const ALL_ROUTES = [...SCRUM_ROUTES, ...OTHER_ROUTES];

async function probe(route: Route): Promise<{ status: number; text: string }> {
  const init: RequestInit = { method: route.method, headers: authHeaders() };
  if (route.body !== undefined) init.body = JSON.stringify(route.body);
  const res = await fetch(`${BASE}${route.path}`, init);
  return { status: res.status, text: await res.text() };
}

/** A route is "served" iff its response is not the unknown-endpoint sentinel. */
function isServed(r: { status: number; text: string }): boolean {
  return !(r.status === 404 && r.text.includes(UNKNOWN_ENDPOINT_SENTINEL));
}

describe("dashboard route-parity: every golden route is served", () => {
  it("recognises all migrated scrum routes (none fall through to unknown-endpoint)", async () => {
    const unserved: string[] = [];
    for (const route of SCRUM_ROUTES) {
      const r = await probe(route);
      if (!isServed(r)) unserved.push(`${route.method} ${route.path} → ${r.status} ${r.text}`);
    }
    expect(unserved).toEqual([]);
  });

  it("recognises the full router surface (code-intel + planning + team + bridge)", async () => {
    const unserved: string[] = [];
    for (const route of ALL_ROUTES) {
      const r = await probe(route);
      if (!isServed(r)) unserved.push(`${route.method} ${route.path} → ${r.status} ${r.text}`);
    }
    expect(unserved).toEqual([]);
  });

  it("counts the frozen route table (drift = intentional table edit)", () => {
    // Bumping this requires consciously editing the golden table above — it is the
    // tripwire for an accidental route addition/removal during a later slice.
    expect(SCRUM_ROUTES.length).toBe(26);
    expect(ALL_ROUTES.length).toBe(82);
  });

  it("control: a genuinely unknown path DOES hit the unknown-endpoint sentinel", async () => {
    // Proves the discriminator is real — if this path were silently 'served',
    // the parity assertions above would be vacuous.
    const r = await probe({ method: "GET", path: "/api/this-route-does-not-exist" });
    expect(r.status).toBe(404);
    expect(r.text).toContain(UNKNOWN_ENDPOINT_SENTINEL);
    expect(isServed(r)).toBe(false);
  });
});
