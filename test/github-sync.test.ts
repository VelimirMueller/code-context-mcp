/**
 * CCA-13 (#128): project key + one-way GitHub sync. No test reaches GitHub:
 * the engine runs against an in-memory FakeGitHub, and GhGateway against a
 * fake `gh` runner that records argv/stdin and returns canned JSON.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// No test may reach GitHub: the real gh runner spawns `gh`, so any spawn of it
// fails the run. Every test uses FakeGitHub or a fake GhRunner instead.
const ghSpawns = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const guard = (cmd: unknown) => {
    if (typeof cmd === "string" && /(^|\/)gh$/.test(cmd)) {
      ghSpawns.n++;
      throw new Error("test tried to run the real gh CLI");
    }
  };
  return {
    ...real,
    spawn: ((cmd: string, ...rest: any[]) => (guard(cmd), (real.spawn as any)(cmd, ...rest))) as typeof real.spawn,
    execFile: ((cmd: string, ...rest: any[]) => (guard(cmd), (real.execFile as any)(cmd, ...rest))) as typeof real.execFile,
  };
});
afterAll(() => {
  expect(ghSpawns.n).toBe(0);
});
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initScrumSchema, runMigrations, backfillGithubIssues, LATEST_SCHEMA_VERSION } from "../src/scrum/schema.js";
import {
  assertPublishable,
  hasLocalPath,
  liveSyncRefusal,
  publishable,
  parseSyncGrants,
  syncAuth,
  syncTargetOf,
  findSecret,
  assertNoSecret,
  SYNC_ALLOWLIST_ENV,
  SYNC_ASSIGNEES_ENV,
  buildIssueBody,
  labelRule,
  applyLabelRule,
  planSync,
  scrubLocalPaths,
  statusFor,
  syncGithub,
  getProject,
  issueMarker,
  milestoneMarker,
  ownedIssueBody,
  ownershipOf,
  adoptRefusal,
  type GitHubGateway,
  type IssueFields,
  type IssuePatch,
  type MilestoneFields,
  type ProjectMeta,
  type RemoteIssue,
  type RemoteMilestone,
} from "../src/scrum/github-sync.js";
import { GhGateway, type GhRunner } from "../src/scrum/github-gateway.js";
import { registerGithubTools, upsertProject } from "../src/scrum/tools/github.js";
import { registerScrumTools } from "../src/scrum/tools.js";
import { parseArgs, parseIssueList, run as runCli } from "../src/server/sync-github-cli.js";
import { initSchema } from "../src/server/schema.js";

process.env.CODE_CONTEXT_DASHBOARD_TOKEN ??= "test-token-unused-by-fake-server";

const REPO = "octo/app";
const OPTIONS = { Backlog: "opt-b", Ready: "opt-r", "In progress": "opt-p", "In review": "opt-v", Done: "opt-d" };

// ─── Fake GitHub ─────────────────────────────────────────────────────────────

class FakeGitHub implements GitHubGateway {
  milestones: RemoteMilestone[] = [];
  issues = new Map<number, RemoteIssue & { repo: string }>();
  nextIssue = 200;
  log: string[] = [];
  readNumbers: number[][] = [];
  meta: ProjectMeta = { projectId: "PVT_1", statusFieldId: "F_status", options: { ...OPTIONS } };
  private items = 0;

  writes(): string[] {
    return this.log.filter((l) => !l.startsWith("read"));
  }
  async listMilestones(repo: string) {
    this.log.push(`readMilestones ${repo}`);
    return this.milestones.map((m) => ({ ...m }));
  }
  async createMilestone(_repo: string, f: MilestoneFields) {
    const number = this.milestones.length + 1;
    this.milestones.push({ number, title: f.title, description: f.description, state: f.state, due_on: f.due_on });
    this.log.push(`createMilestone ${number}`);
    return { number };
  }
  async updateMilestone(_repo: string, number: number, f: Partial<MilestoneFields>) {
    Object.assign(this.milestones.find((m) => m.number === number)!, f);
    this.log.push(`updateMilestone ${number}`);
  }
  async readIssues(repo: string, _p: unknown, numbers: number[], cached: ProjectMeta | null) {
    this.log.push(`readIssues ${numbers.join(",")}${cached ? " cached" : ""}`);
    this.readNumbers.push(numbers);
    const issues = new Map<number, RemoteIssue>();
    const missing: number[] = [];
    for (const n of numbers) {
      const i = this.issues.get(n);
      if (i && i.repo === repo) issues.set(n, structuredClone(i));
      else missing.push(n);
    }
    return { meta: this.meta, issues, missing };
  }
  async createIssue(repo: string, f: IssueFields) {
    const number = this.nextIssue++;
    const nodeId = `I_${number}`;
    this.issues.set(number, { repo, number, nodeId, title: f.title, body: f.body, state: "open", labels: [...f.labels], assignees: [...f.assignees], milestone: f.milestone, item: null });
    this.log.push(`createIssue ${number}`);
    return { number, nodeId };
  }
  async updateIssue(_repo: string, number: number, p: IssuePatch) {
    const i = this.issues.get(number)!;
    const { state_reason: _r, ...rest } = p;
    Object.assign(i, rest);
    this.log.push(`updateIssue ${number} ${Object.keys(p).sort().join(",")}`);
  }
  async addToProject(_pid: string, contentIds: string[]) {
    const out = new Map<string, string>();
    for (const c of contentIds) {
      const issue = [...this.issues.values()].find((i) => i.nodeId === c)!;
      issue.item = { id: `PVTI_${++this.items}`, status: null };
      out.set(c, issue.item.id);
    }
    this.log.push(`addToProject ${contentIds.length}`);
    return out;
  }
  async setStatus(_pid: string, _fid: string, items: Array<{ itemId: string; optionId: string }>) {
    const byOpt = Object.fromEntries(Object.entries(OPTIONS).map(([k, v]) => [v, k]));
    for (const it of items) {
      const issue = [...this.issues.values()].find((i) => i.item?.id === it.itemId)!;
      issue.item!.status = byOpt[it.optionId];
    }
    this.log.push(`setStatus ${items.length}`);
  }
  seedIssue(number: number, over: Partial<RemoteIssue> = {}, repo = REPO) {
    this.issues.set(number, { repo, number, nodeId: `I_${number}`, title: "old", body: "", state: "open", labels: [], assignees: [], milestone: null, item: null, ...over });
  }
}

// ─── Local fixtures ──────────────────────────────────────────────────────────

function memDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initScrumSchema(db);
  runMigrations(db, { freshDb: true });
  db.prepare("INSERT INTO skills (name, content) VALUES ('_dashboard_port', '9')").run();
  return db;
}

function seed(db: Database.Database) {
  upsertProject(db, { name: "app", repo: REPO, github_project_number: 7 });
  upsertProject(db, { name: "other", repo: "octo/other", github_project_number: 8 });
  const ms = Number(db.prepare("INSERT INTO milestones (name, description, status, project) VALUES ('M1', 'Goal', 'active', 'app')").run().lastInsertRowid);
  const sprint = Number(db.prepare("INSERT INTO sprints (name, status, milestone_id) VALUES ('S1', 'implementation', ?)").run(ms).lastInsertRowid);
  return { ms, sprint };
}

function ticket(db: Database.Database, f: Record<string, unknown>): number {
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO tickets (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(f) as any[]).lastInsertRowid);
}

const row = (db: Database.Database, id: number) => db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as any;
/** Authorization as the env would give it (no process.env involved). */
const authFor = (repos: string, assignees = "") => syncAuth({ [SYNC_ALLOWLIST_ENV]: repos, [SYNC_ASSIGNEES_ENV]: assignees });
const noSleep = { pauseMs: 0, auth: authFor(`${REPO}@octo/7`) };

// ─── Rules ───────────────────────────────────────────────────────────────────

describe("status mapping", () => {
  it.each([
    [{ status: "DONE", review_status: null, sprint_id: 1, sprint_status: "implementation" }, "Done"],
    [{ status: "DONE", review_status: "pending", sprint_id: 1, sprint_status: "implementation" }, "Done"],
    [{ status: "IN_PROGRESS", review_status: "pending", sprint_id: 1, sprint_status: "qa" }, "In review"],
    [{ status: "IN_PROGRESS", review_status: null, sprint_id: 1, sprint_status: "implementation" }, "In progress"],
    [{ status: "BLOCKED", review_status: null, sprint_id: 1, sprint_status: "implementation" }, "In progress"],
    [{ status: "TODO", review_status: null, sprint_id: 1, sprint_status: "planning" }, "Ready"],
    [{ status: "TODO", review_status: null, sprint_id: 1, sprint_status: "closed" }, "Backlog"],
    [{ status: "TODO", review_status: null, sprint_id: null, sprint_status: null }, "Backlog"],
    [{ status: "NOT_DONE", review_status: null, sprint_id: 1, sprint_status: "done" }, "Backlog"],
  ])("%j → %s", (t, want) => {
    expect(statusFor(t as any)).toBe(want);
  });
});

describe("labels", () => {
  it("create: priority + type + ai_issue by default", () => {
    expect(labelRule({ priority: "P1", type: "feat", origin: null }, true).desired).toEqual(["P1", "feat", "ai_issue"]);
  });
  it("human origin → issue; P3 has no priority label", () => {
    expect(labelRule({ priority: "P3", type: "fix", origin: "human" }, true).desired).toEqual(["fix", "issue"]);
  });
  it("update keeps unmanaged labels and unset type/origin labels", () => {
    const rule = labelRule({ priority: "P2", type: null, origin: null }, false);
    expect(applyLabelRule(["P0", "feat", "issue", "keep-me"], rule).sort()).toEqual(["P2", "feat", "issue", "keep-me"].sort());
  });
  it("a set type replaces the other type label", () => {
    const rule = labelRule({ priority: "P0", type: "chore", origin: "ai" }, false);
    expect(applyLabelRule(["P0", "feat", "issue"], rule).sort()).toEqual(["P0", "ai_issue", "chore"].sort());
  });
});

describe("path scrubbing + publish guard", () => {
  it("strips local absolute paths, keeps the last segment", () => {
    const s = scrubLocalPaths("see /Users/jane/Desktop/repo/src/a.ts and /var/folders/x1/T/tmp-9/out.log, C:\\Users\\jane\\x\\b.ts");
    expect(s).toBe("see …/a.ts and …/out.log, …/b.ts");
  });
  it("leaves URLs, repo-relative and home-relative paths alone", () => {
    const s = "https://example.com/home/page src/server/git.ts ~/Desktop/x";
    expect(scrubLocalPaths(s)).toBe(s);
  });
  it("scrubs /private/var, /tmp, /home", () => {
    expect(scrubLocalPaths("`/private/var/folders/a/b` /tmp/x.db /home/u/p")).toBe("`…/b` …/x.db …/p");
  });
  it("refuses a surviving path or a token", () => {
    expect(() => assertPublishable("at /Users/jane/x", "body")).toThrow(/local absolute path/);
    expect(() => assertPublishable("token ghp_abcdefghijklmnopqrstuvwxyz0123", "body")).toThrow(/token/);
    expect(() => assertPublishable("fine text src/a.ts", "body")).not.toThrow();
  });
  it("issue body has Why / Done when and no local path", () => {
    const body = buildIssueBody({
      description: "Broken at /Users/jane/dev/repo/src/x.ts.\nDone when: it works in /var/folders/q/T/run.",
      acceptance_criteria: JSON.stringify(["tests pass"]),
    });
    expect(body).toBe("## Why\n\nBroken at …/x.ts.\n\n## Done when\n\nit works in …/run.\n\n- tests pass\n");
    expect(body).not.toMatch(/\/Users\/|\/var\/folders/);
  });
});

// ─── Engine ──────────────────────────────────────────────────────────────────

describe("syncGithub", () => {
  let db: Database.Database;
  let gh: FakeGitHub;
  let ids: { ms: number; sprint: number };
  beforeEach(() => {
    db = memDb();
    gh = new FakeGitHub();
    ids = seed(db);
  });

  it("creates the milestone and a new issue with labels, assignee, board item and Status", async () => {
    const t = ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "Add x", description: "Why text\nDone when: y", priority: "P1", type: "feat", milestone_id: ids.ms });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.error).toBeNull();
    expect(gh.writes()).toEqual(["createMilestone 1", "createIssue 200", "addToProject 1", "setStatus 1"]);
    const issue = gh.issues.get(200)!;
    expect(issue.title).toBe("APP-1: Add x");
    expect(issue.body).toBe("## Why\n\nWhy text\n\n## Done when\n\ny\n\n<!-- code-context-sync: project=app ticket=APP-1 -->\n");
    expect(gh.milestones[0].description).toBe("Goal\n\n<!-- code-context-sync: project=app milestone=1 -->\n");
    expect(issue.labels).toEqual(["P1", "feat", "ai_issue"]);
    expect(issue.assignees).toEqual(["octo"]);
    expect(issue.milestone).toBe(1);
    expect(issue.item?.status).toBe("Ready");
    expect(row(db, t)).toMatchObject({ github_issue: 200, github_repo: REPO });
    expect((db.prepare("SELECT github_milestone FROM milestones WHERE id = ?").get(ids.ms) as any).github_milestone).toBe(1);
    // Project ids cached for the next run
    expect(getProject(db, "app")!.github_status_field_id).toBe("F_status");
  });

  it("is idempotent: a second run makes no write and no duplicate", async () => {
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "Add x", priority: "P1", type: "feat", milestone_id: ids.ms });
    await syncGithub(db, gh, "app", noSleep);
    gh.log = [];
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(gh.writes()).toEqual([]);
    expect(r.plan.issues.map((i) => i.kind)).toEqual(["noop"]);
    expect(r.plan.milestones.map((m) => m.kind)).toEqual(["noop"]);
    expect(gh.issues.size).toBe(1);
    // reads: one milestone list + one issue read; a live run re-resolves the
    // Project ids from the authorized owner/number in that same read (no cache).
    expect(gh.log).toEqual(["readMilestones octo/app", "readIssues 200"]);
  });

  it("adopts a hand-made issue and milestone: title/body/labels/assignee, keeps unmanaged labels, moves Status", async () => {
    gh.milestones.push({ number: 1, title: "M1", description: "Goal", state: "open", due_on: null });
    gh.seedIssue(116, { title: "APP-2: old title", labels: ["P0", "feat", "issue", "keep-me"], assignees: ["someone"], milestone: 1, item: { id: "PVTI_x", status: "Backlog" } });
    const t = ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-2", title: "New", priority: "P2", status: "IN_PROGRESS", milestone_id: ids.ms, notes: "GitHub: octo/app#116" });
    backfillGithubIssues(db);
    expect(row(db, t).github_issue).toBe(116);
    const r = await syncGithub(db, gh, "app", { ...noSleep, adopt: { issues: [116], milestones: [{ id: ids.ms, number: 1 }] } });
    expect(r.plan.milestones[0].kind).toBe("adopt");
    expect(r.plan.issues[0]).toMatchObject({ kind: "update", adopt: true });
    const i = gh.issues.get(116)!;
    expect(i.title).toBe("APP-2: New");
    expect(i.body).toContain(issueMarker("app", "APP-2"));
    expect(i.labels.sort()).toEqual(["P2", "feat", "issue", "keep-me"].sort());
    expect(i.assignees).toEqual(["someone", "octo"]);
    expect(i.item?.status).toBe("In progress");
    expect(gh.milestones[0].description).toContain(milestoneMarker("app", ids.ms));
    expect((db.prepare("SELECT github_milestone FROM milestones WHERE id = ?").get(ids.ms) as any).github_milestone).toBe(1);
    expect(gh.writes()).toEqual(["updateMilestone 1", "updateIssue 116 assignees,body,labels,title", "setStatus 1"]);
    // Owned now: a rerun without adopt is a no-op.
    gh.log = [];
    const again = await syncGithub(db, gh, "app", noSleep);
    expect(again.plan.skipped).toEqual([]);
    expect(gh.writes()).toEqual([]);
  });

  it("closes the issue when the ticket is DONE and sets Status Done; reopens when it is not", async () => {
    gh.milestones.push({ number: 1, title: "M1", description: "Goal", state: "open", due_on: null });
    gh.seedIssue(120, { title: "APP-3: T", body: ownedIssueBody("app", { id: 0, ticket_ref: "APP-3", description: null, acceptance_criteria: null }), labels: ["P1"], assignees: ["octo"], item: { id: "PVTI_1", status: "In progress" } });
    const t = ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-3", title: "T", priority: "P1", status: "DONE", github_issue: 120 });
    await syncGithub(db, gh, "app", noSleep);
    expect(gh.issues.get(120)!.state).toBe("closed");
    expect(gh.writes()).toEqual(["updateIssue 120 state,state_reason", "setStatus 1"]);
    expect(gh.issues.get(120)!.item?.status).toBe("Done");

    db.prepare("UPDATE tickets SET status = 'IN_PROGRESS' WHERE id = ?").run(t);
    gh.log = [];
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.plan.issues[0].changed).toContain("reopen");
    expect(gh.issues.get(120)!.state).toBe("open");
  });

  it("adds a linked issue that is not on the board yet", async () => {
    gh.milestones.push({ number: 1, title: "M1", description: "Goal", state: "open", due_on: null });
    gh.seedIssue(130, { title: "APP-4: T", body: ownedIssueBody("app", { id: 0, ticket_ref: "APP-4", description: null, acceptance_criteria: null }), labels: ["P2"], assignees: ["octo"] });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-4", title: "T", priority: "P2", github_issue: 130 });
    await syncGithub(db, gh, "app", noSleep);
    expect(gh.writes()).toEqual(["addToProject 1", "setStatus 1"]);
    expect(gh.issues.get(130)!.item?.status).toBe("Ready");
  });

  it("never touches tickets of another project, ambiguous tickets or issues of another repo", async () => {
    const otherMs = Number(db.prepare("INSERT INTO milestones (name, project) VALUES ('M2', 'other')").run().lastInsertRowid);
    const own = ticket(db, { sprint_id: ids.sprint, ticket_ref: "OWN", title: "own other", type: "fix", project: "other" });
    ticket(db, { sprint_id: null, ticket_ref: "INH", title: "inherits other", type: "fix", milestone_id: otherMs, github_issue: 999 });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "AMB", title: "ambiguous", type: "fix", milestone_id: otherMs });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "XREPO", title: "x", type: "fix", github_issue: 5, github_repo: "octo/other" });
    ticket(db, { sprint_id: null, ticket_ref: "NONE", title: "unassigned", type: "fix" });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "MINE", title: "mine", type: "feat" });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.plan.issues.map((i) => i.ref)).toEqual(["MINE"]);
    expect(r.plan.skipped.map((s) => s.ref).sort()).toEqual(["AMB", "XREPO"]);
    expect(gh.readNumbers.flat()).not.toContain(999);
    expect(gh.readNumbers.flat()).not.toContain(5);
    expect(row(db, own).github_issue).toBeNull();
    expect([...gh.issues.values()].map((i) => i.title)).toEqual(["MINE: mine"]);
  });

  it("skips a new ticket without a type; P3 and human origin map to labels", async () => {
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "NOTYPE", title: "x" });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "HUM", title: "y", priority: "P3", type: "infra", origin: "human" });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.plan.skipped).toEqual([{ ref: "NOTYPE", reason: expect.stringMatching(/no type/) }]);
    expect(gh.issues.get(200)!.labels).toEqual(["infra", "issue"]);
  });

  it("sends no local absolute path to GitHub", async () => {
    db.prepare("UPDATE milestones SET description = 'see /Users/jane/plan.md' WHERE id = ?").run(ids.ms);
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "P", title: "fix /Users/jane/dev/a.ts", description: "log at /var/folders/ab/T/x.log", type: "fix", milestone_id: ids.ms });
    await syncGithub(db, gh, "app", noSleep);
    const sent = JSON.stringify([...gh.issues.values(), ...gh.milestones]);
    expect(sent).not.toMatch(/\/Users\/|\/var\/folders\//);
    expect(gh.issues.get(200)!.title).toBe("P: fix …/a.ts");
  });

  it("dry run reads but writes nothing (GitHub and db)", async () => {
    const t = ticket(db, { sprint_id: ids.sprint, ticket_ref: "D", title: "d", type: "feat", milestone_id: ids.ms });
    const r = await syncGithub(db, gh, "app", { dryRun: true });
    expect(gh.writes()).toEqual([]);
    expect(r.text).toMatch(/dry run/);
    expect(r.text).toMatch(/\+ create D — labels \[P2, feat, ai_issue\] @octo; add to board; status — → Ready/);
    expect(row(db, t).github_issue).toBeNull();
    expect(getProject(db, "app")!.github_project_id).toBeNull();
  });

  it("offline dry run makes no GitHub call at all", async () => {
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "D", title: "d", type: "feat", github_issue: 50 });
    const r = await syncGithub(db, gh, "app", { dryRun: true, offline: true });
    expect(gh.log).toEqual([]);
    expect(r.text).toMatch(/offline/);
    expect(r.plan.issues[0].changed).toEqual(["unverified (offline)"]);
  });

  it("refuses a plan above max_writes before any write", async () => {
    for (let k = 0; k < 3; k++) ticket(db, { sprint_id: ids.sprint, ticket_ref: `M${k}`, title: "m", type: "feat" });
    const r = await syncGithub(db, gh, "app", { ...noSleep, maxWrites: 4 });
    expect(r.error).toMatch(/max_writes/);
    expect(gh.writes()).toEqual([]);
  });

  it("stores each created number at once, so a failure mid-run never duplicates", async () => {
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "A", title: "a", type: "feat" });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "B", title: "b", type: "feat" });
    const orig = gh.createIssue.bind(gh);
    let n = 0;
    gh.createIssue = async (repo, f) => {
      if (++n === 2) throw new Error("boom");
      return orig(repo, f);
    };
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.error).toBe("boom");
    gh.createIssue = orig;
    await syncGithub(db, gh, "app", noSleep);
    expect([...gh.issues.values()].map((i) => i.title).sort()).toEqual(["A: a", "B: b"]);
  });

  it("an unknown project or a project without repo is an error", async () => {
    await expect(syncGithub(db, gh, "nope")).rejects.toThrow(/Unknown project/);
    upsertProject(db, { name: "norepo" });
    await expect(syncGithub(db, gh, "norepo")).rejects.toThrow(/no repo/);
  });
});

// ─── Ownership markers + adopt (CCA-14, #142) ────────────────────────────────

describe("ownership markers", () => {
  it("marker format and ownership", () => {
    expect(issueMarker("code-context", "CCA-01")).toBe("<!-- code-context-sync: project=code-context ticket=CCA-01 -->");
    expect(issueMarker("a b", "#12")).toBe("<!-- code-context-sync: project=a%20b ticket=%2312 -->");
    expect(milestoneMarker("app", 3)).toBe("<!-- code-context-sync: project=app milestone=3 -->");
    const want = issueMarker("app", "APP-1");
    expect(ownershipOf(`x\n\n${want}\n`, want)).toBe("owned");
    expect(ownershipOf("<!--code-context-sync:   project=app  ticket=APP-1-->", want)).toBe("owned");
    expect(ownershipOf("no marker", want)).toBe("unmarked");
    expect(ownershipOf(null, want)).toBe("unmarked");
    expect(ownershipOf(issueMarker("app", "APP-2"), want)).toBe("foreign");
    expect(ownershipOf(issueMarker("other", "APP-1"), want)).toBe("foreign");
    expect(ownershipOf(issueMarker("app", "APP-10"), want)).toBe("foreign");
    // A matching marker next to a foreign one is not ownership.
    expect(ownershipOf(`${want}\n${issueMarker("app", "APP-2")}`, want)).toBe("foreign");
  });
  it("a project name or ref holding a local path or a secret never reaches the marker", () => {
    expect(() => ownedIssueBody("/Users/jane/p", { id: 1, ticket_ref: "A-1", description: null, acceptance_criteria: null })).toThrow(/local absolute path/);
  });
  it("adopt title rule", () => {
    expect(adoptRefusal({ ticket_ref: "CCA-01" }, { title: "CCA-01: Do x" })).toBeNull();
    expect(adoptRefusal({ ticket_ref: "CCA-1" }, { title: "CCA-10: Do x" })).toMatch(/does not start with "CCA-1:"/);
    expect(adoptRefusal({ ticket_ref: "CCA-01" }, { title: "Release notes" })).toMatch(/does not start/);
    expect(adoptRefusal({ ticket_ref: null }, { title: "x" })).toMatch(/no ticket_ref/);
    expect(adoptRefusal({ ticket_ref: "A" }, { title: "A: x" }, 2)).toMatch(/2 tickets/);
  });
});

describe("syncGithub ownership", () => {
  let db: Database.Database;
  let gh: FakeGitHub;
  let ids: { ms: number; sprint: number };
  beforeEach(() => {
    db = memDb();
    gh = new FakeGitHub();
    ids = seed(db);
  });
  const owned = (ref: string) => ownedIssueBody("app", { id: 0, ticket_ref: ref, description: null, acceptance_criteria: null });

  it("a ticket retargeted at an unmarked issue (update_ticket github_issue=N) is skipped: no edit, close, relabel or board move", async () => {
    gh.seedIssue(5, { title: "Security policy", body: "Hand-written, important.", labels: ["docs"], item: null });
    const before = structuredClone(gh.issues.get(5));
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "x", priority: "P1", type: "feat", status: "DONE", github_issue: 5 });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.error).toBeNull();
    expect(r.plan.issues).toEqual([]);
    expect(r.plan.skipped).toEqual([{ ref: "APP-1", reason: expect.stringMatching(/issue #5 has no code-context-sync marker — not created by this sync, left untouched \(adopt: \[5\]/) }]);
    expect(r.text).toMatch(/Skipped \(1\):\n {2}- APP-1: issue #5 has no code-context-sync marker/);
    expect(gh.writes().filter((w) => !w.startsWith("createMilestone"))).toEqual([]);
    expect(gh.issues.get(5)).toEqual(before);
  });

  it("an issue with another ticket's or project's marker is skipped, even with adopt", async () => {
    gh.seedIssue(6, { title: "APP-1: x", body: owned("APP-2") });
    gh.seedIssue(7, { title: "APP-3: y", body: ownedIssueBody("other", { id: 0, ticket_ref: "APP-3", description: null, acceptance_criteria: null }) });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "x", priority: "P1", github_issue: 6 });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-3", title: "y", priority: "P1", github_issue: 7 });
    const before = structuredClone([...gh.issues.values()]);
    const r = await syncGithub(db, gh, "app", { ...noSleep, adopt: { issues: [6, 7] } });
    expect(r.plan.skipped.map((s) => [s.ref, s.reason])).toEqual([
      ["APP-1", "issue #6 carries another ticket's or project's code-context-sync marker — left untouched"],
      ["APP-3", "issue #7 carries another ticket's or project's code-context-sync marker — left untouched"],
    ]);
    expect([...gh.issues.values()]).toEqual(before);
  });

  it("a marked issue is updated", async () => {
    gh.seedIssue(8, { title: "APP-1: old", body: owned("APP-1"), labels: ["P1"], assignees: ["octo"], item: { id: "PVTI_8", status: "Ready" } });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "new", priority: "P1", github_issue: 8 });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.plan.skipped).toEqual([]);
    expect(gh.issues.get(8)!.title).toBe("APP-1: new");
    expect(gh.writes()).toContain("updateIssue 8 title");
  });

  it("adopt with a matching title on an allowlisted repo writes the marker", async () => {
    gh.seedIssue(116, { title: "APP-1: hand-made", body: "by hand", labels: ["P1"], assignees: ["octo"] });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "hand-made", priority: "P1", github_issue: 116 });
    const r = await withAllowlist(`${REPO}@octo/7`, () => syncGithub(db, gh, "app", { pauseMs: 0, adopt: { issues: [116] } }));
    expect(r.error).toBeNull();
    expect(r.text).toMatch(/~ adopt {2}#116 APP-1 — adopt, body/);
    expect(r.text).toMatch(/adopted #116 \(APP-1\)/);
    expect(gh.issues.get(116)!.body).toBe(owned("APP-1"));
  });

  it("adopt is refused when the GitHub title does not start with the ticket ref", async () => {
    gh.seedIssue(9, { title: "Release checklist", body: "by hand" });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "x", priority: "P1", github_issue: 9 });
    const r = await syncGithub(db, gh, "app", { ...noSleep, adopt: { issues: [9] } });
    expect(r.plan.skipped).toEqual([{ ref: "APP-1", reason: 'adopt #9 refused: its GitHub title does not start with "APP-1:"' }]);
    expect(gh.issues.get(9)!.body).toBe("by hand");
    expect(gh.writes().filter((w) => w.includes(" 9"))).toEqual([]);
  });

  it("adopt of an issue no ticket links is ignored with a warning", async () => {
    gh.seedIssue(10, { title: "APP-1: x", body: "by hand" });
    const r = await syncGithub(db, gh, "app", { ...noSleep, adopt: { issues: [10] } });
    expect(r.plan.warnings).toContain("adopt #10 ignored: no ticket of project app links issue #10 (set update_ticket github_issue=10 first)");
    expect(gh.readNumbers.flat()).not.toContain(10);
  });

  it("adopt on a dry run is planned only; without the allowlist a live adopt is refused before any call", async () => {
    gh.seedIssue(116, { title: "APP-1: x", body: "by hand" });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "x", priority: "P1", github_issue: 116 });
    await withAllowlist(undefined, async () => {
      const dry = await syncGithub(db, gh, "app", { dryRun: true, adopt: { issues: [116] } });
      expect(dry.text).toMatch(/~ adopt {2}#116 APP-1/);
      expect(dry.plan.issues[0]).toMatchObject({ adopt: true, kind: "update" });
      const offline = await syncGithub(db, gh, "app", { dryRun: true, offline: true, adopt: { issues: [116] } });
      expect(offline.text).toMatch(/~ adopt {2}#116 APP-1 — adopt, unverified \(offline\)/);
      expect(gh.writes()).toEqual([]);
      gh.log = [];
      await expect(syncGithub(db, gh, "app", { pauseMs: 0, adopt: { issues: [116] } })).rejects.toThrow(/not authorized/);
      expect(gh.log).toEqual([]);
    });
    expect(gh.issues.get(116)!.body).toBe("by hand");
  });

  it("milestones: a title match never links; a stored number without the marker is left alone; a mapping adopts", async () => {
    gh.milestones.push({ number: 1, title: "M1", description: "hand-made", state: "open", due_on: null });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "x", priority: "P1", type: "feat", milestone_id: ids.ms });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.plan.milestones).toEqual([]);
    expect(r.plan.warnings.join("\n")).toMatch(/GitHub milestone #1 has the same title — not linked by title/);
    expect(gh.writes()).toEqual(["createIssue 200", "addToProject 1", "setStatus 1"]);
    expect(gh.issues.get(200)!.milestone).toBeNull();
    expect(gh.milestones[0].description).toBe("hand-made");
    expect((db.prepare("SELECT github_milestone FROM milestones WHERE id = ?").get(ids.ms) as any).github_milestone).toBeNull();

    // update_milestone github_milestone=1 (or execute) points the row at it: still untouched.
    db.prepare("UPDATE milestones SET github_milestone = 1 WHERE id = ?").run(ids.ms);
    gh.log = [];
    const r2 = await syncGithub(db, gh, "app", noSleep);
    expect(r2.plan.warnings.join("\n")).toMatch(/milestone #1 has no code-context-sync marker — not created by this sync, left untouched/);
    expect(gh.writes()).toEqual([]);

    // A foreign marker is refused even with a mapping.
    gh.milestones[0].description = milestoneMarker("other", ids.ms);
    const r3 = await syncGithub(db, gh, "app", { ...noSleep, adopt: { milestones: [{ id: ids.ms, number: 1 }] } });
    expect(r3.plan.warnings.join("\n")).toMatch(/carries another project's or milestone's code-context-sync marker/);
    expect(gh.writes()).toEqual([]);

    // The explicit mapping adopts it.
    gh.milestones[0].description = "hand-made";
    const r4 = await syncGithub(db, gh, "app", { ...noSleep, adopt: { milestones: [{ id: ids.ms, number: 1 }] } });
    expect(r4.plan.milestones[0].kind).toBe("adopt");
    expect(gh.milestones[0]).toMatchObject({ title: "M1", description: `Goal\n\n${milestoneMarker("app", ids.ms)}\n` });
    expect(gh.issues.get(200)!.milestone).toBe(1);
  });

  it("MCP sync_github passes adopt and adopt_milestones", async () => {
    gh.seedIssue(116, { title: "APP-1: x", body: "by hand" });
    gh.milestones.push({ number: 1, title: "M1", description: "", state: "open", due_on: null });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "x", priority: "P1", github_issue: 116 });
    const server = new FakeServer();
    registerGithubTools(server as never, db, () => gh);
    const r = await server.tools.get("sync_github")!({ project: "app", dry_run: true, adopt: [116], adopt_milestones: [{ milestone_id: ids.ms, github_milestone: 1 }] });
    expect(text(r)).toMatch(/~ adopt {2}#1 "M1"/);
    expect(text(r)).toMatch(/~ adopt {2}#116 APP-1/);
    expect(gh.writes()).toEqual([]);
  });
});

// ─── gh layer (fake runner) ──────────────────────────────────────────────────

function fakeRunner(respond: (args: string[], input: any) => { code?: number; stdout?: unknown; stderr?: string }) {
  const calls: Array<{ args: string[]; input: any }> = [];
  const run: GhRunner = async (args, input) => {
    const parsed = input ? JSON.parse(input) : undefined;
    calls.push({ args, input: parsed });
    const r = respond(args, parsed);
    return { code: r.code ?? 0, stdout: typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout ?? null), stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

function issueNode(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `I_${n}`, number: n, title: `T${n}`, body: "", state: "OPEN",
    labels: { nodes: [{ name: "P1" }] }, assignees: { nodes: [{ login: "octo" }] }, milestone: { number: 1 },
    projectItems: { nodes: [{ id: `PVTI_${n}`, project: { id: "PVT_1" }, fieldValueByName: { name: "Ready" } }, { id: "other", project: { id: "PVT_9" }, fieldValueByName: null }] },
    ...extra,
  };
}

describe("GhGateway over a fake gh runner", () => {
  it("reads issues + Project meta in ONE GraphQL call, args never carry content", async () => {
    const { run, calls } = fakeRunner((_a, input) => {
      const nums = [...input.query.matchAll(/i(\d+): issue\(number: (\d+)\)/g)].map((m) => Number(m[2]));
      const repository = Object.fromEntries(nums.map((n) => [`i${n}`, n === 118 ? null : issueNode(n)]));
      return {
        code: 1,
        stdout: {
          data: { repository, board: { projectV2: { id: "PVT_1", field: { id: "F", options: [{ id: "o1", name: "Ready" }] } } } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "i118"], message: "Could not resolve" }],
        },
      };
    });
    const gw = new GhGateway(run);
    const r = await gw.readIssues("octo/app", { owner: "octo", number: 10 }, [116, 117, 118], null);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["api", "graphql", "--input", "-"]);
    expect(calls[0].input.variables).toEqual({ owner: "octo", name: "app", powner: "octo", pnum: 10 });
    expect(r.meta).toEqual({ projectId: "PVT_1", statusFieldId: "F", options: { Ready: "o1" } });
    expect(r.missing).toEqual([118]);
    expect(r.issues.get(116)).toMatchObject({ nodeId: "I_116", state: "open", labels: ["P1"], milestone: 1, item: { id: "PVTI_116", status: "Ready" } });
  });

  it("chunks 120 issues into 3 reads; cached meta drops the board field", async () => {
    const { run, calls } = fakeRunner((_a, input) => {
      const nums = [...input.query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return { stdout: { data: { repository: Object.fromEntries(nums.map((n) => [`i${n}`, issueNode(n)])) } } };
    });
    const gw = new GhGateway(run);
    const cached = { projectId: "PVT_1", statusFieldId: "F", options: {} };
    const nums = Array.from({ length: 120 }, (_, k) => k + 1);
    const r = await gw.readIssues("octo/app", { owner: "octo", number: 10 }, nums, cached);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => !c.input.query.includes("projectV2("))).toBe(true);
    expect(r.issues.size).toBe(120);
  });

  it("REST writes go through -X/--input - with the body on stdin", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: { number: 201, node_id: "I_201" } }));
    const gw = new GhGateway(run);
    const r = await gw.createIssue("octo/app", { title: "t", body: "b", labels: ["P1"], assignees: ["octo"], milestone: null });
    expect(r).toEqual({ number: 201, nodeId: "I_201" });
    expect(calls[0].args).toEqual(["api", "-X", "POST", "-H", "Accept: application/vnd.github+json", "repos/octo/app/issues", "--input", "-"]);
    expect(calls[0].input).toEqual({ title: "t", body: "b", labels: ["P1"], assignees: ["octo"] });
  });

  it("batches board adds and Status sets as aliased mutations", async () => {
    const { run, calls } = fakeRunner((_a, input) =>
      input.query.startsWith("mutation SyncAdd")
        ? { stdout: { data: { a0: { item: { id: "X0" } }, a1: { item: { id: "X1" } } } } }
        : { stdout: { data: {} } },
    );
    const gw = new GhGateway(run);
    const ids = await gw.addToProject("PVT_1", ["I_1", "I_2"]);
    expect([...ids]).toEqual([["I_1", "X0"], ["I_2", "X1"]]);
    await gw.setStatus("PVT_1", "F", [{ itemId: "X0", optionId: "o" }, { itemId: "X1", optionId: "o" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].input.query.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(2);
  });

  it("a gh failure is an error with gh's message", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" }));
    await expect(new GhGateway(run).listMilestones("octo/app")).rejects.toThrow(/rate limit exceeded/);
  });

  it("a whole no-change sync of 13 linked issues costs 2 gh calls (1 REST + 1 GraphQL)", async () => {
    const db = memDb();
    upsertProject(db, { name: "app", repo: REPO, github_project_number: 10 });
    db.prepare("INSERT INTO milestones (name, description, status, project, github_milestone) VALUES ('M1', '', 'active', 'app', 1)").run();
    const s = Number(db.prepare("INSERT INTO sprints (name, status, project) VALUES ('S', 'implementation', 'app')").run().lastInsertRowid);
    for (let n = 116; n <= 128; n++) ticket(db, { sprint_id: s, ticket_ref: `C-${n}`, title: "t", priority: "P1", milestone_id: 1, github_issue: n });
    const { run, calls } = fakeRunner((args, input) => {
      if (args.includes("GET")) return { stdout: [{ number: 1, title: "M1", description: `${milestoneMarker("app", 1)}\n`, state: "open", due_on: null }] };
      const nums = [...input.query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return {
        stdout: {
          data: {
            repository: Object.fromEntries(
              nums.map((n) => [`i${n}`, issueNode(n, { title: `C-${n}: t`, body: ownedIssueBody("app", { id: 0, ticket_ref: `C-${n}`, description: null, acceptance_criteria: null }) })]),
            ),
            board: { projectV2: { id: "PVT_1", field: { id: "F", options: [{ id: "o1", name: "Ready" }] } } },
          },
        },
      };
    });
    const r = await syncGithub(db, new GhGateway(run), "app", { pauseMs: 0, auth: authFor(`${REPO}@octo/10`) });
    expect(r.error).toBeNull();
    expect(r.plan.skipped).toEqual([]);
    expect(r.plan.issues.map((i) => i.kind)).toEqual(Array(13).fill("noop"));
    expect(r.plan.milestones.map((m) => m.kind)).toEqual(["noop"]);
    expect(r.writes).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("adopting 13 hand-made issues needs no extra read: 2 reads + 13 writes", async () => {
    const db = memDb();
    upsertProject(db, { name: "app", repo: REPO });
    const s = Number(db.prepare("INSERT INTO sprints (name, status, project) VALUES ('S', 'implementation', 'app')").run().lastInsertRowid);
    for (let n = 116; n <= 128; n++) ticket(db, { sprint_id: s, ticket_ref: `C-${n}`, title: "t", priority: "P1", github_issue: n });
    const { run, calls } = fakeRunner((args, input) => {
      if (args.includes("PATCH")) return { stdout: {} };
      const nums = [...input.query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return { stdout: { data: { repository: Object.fromEntries(nums.map((n) => [`i${n}`, issueNode(n, { title: `C-${n}: hand-made`, body: "made by hand" })])) } } };
    });
    const adopt = { issues: Array.from({ length: 13 }, (_, k) => 116 + k) };
    const r = await syncGithub(db, new GhGateway(run), "app", { pauseMs: 0, auth: authFor(REPO), adopt });
    expect(r.error).toBeNull();
    expect(r.writes).toBe(13);
    expect(calls.filter((c) => c.args.includes("graphql"))).toHaveLength(1);
    expect(calls).toHaveLength(14);
    expect(calls.filter((c) => c.args.includes("PATCH")).every((c) => String(c.input.body).includes("<!-- code-context-sync: project=app ticket=C-"))).toBe(true);
  });
});

// ─── Schema / backfill ───────────────────────────────────────────────────────

describe("schema v26 + notes backfill", () => {
  it("adds project columns (NULL by default) and the projects table", () => {
    const db = memDb();
    expect(LATEST_SCHEMA_VERSION).toBe(26);
    for (const t of ["milestones", "sprints", "epics", "tickets"]) {
      expect((db.pragma(`table_info(${t})`) as any[]).map((c) => c.name)).toContain("project");
    }
    const cols = (db.pragma("table_info(tickets)") as any[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["type", "origin", "github_issue", "github_repo"]));
    expect(() => ticket(db, { title: "x", type: "bogus" })).toThrow(/CHECK/);
  });

  it("backfills github_issue from notes once, on the upgrade to v26, never the project", () => {
    const db = memDb();
    const a = ticket(db, { title: "a", notes: "GitHub: VelimirMueller/code-context-mcp#116 — merged in PR #131" });
    const b = ticket(db, { title: "b", notes: "no link" });
    db.prepare("DELETE FROM schema_versions WHERE version = 26").run();
    runMigrations(db);
    expect(row(db, a)).toMatchObject({ github_issue: 116, github_repo: "VelimirMueller/code-context-mcp", project: null });
    expect(row(db, b).github_issue).toBeNull();
    db.prepare("UPDATE tickets SET github_issue = NULL WHERE id = ?").run(a);
    runMigrations(db); // already v26: no re-fill
    expect(row(db, a).github_issue).toBeNull();
  });
});

// ─── MCP tools ───────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _d: string, _s: unknown, h: Handler) {
    this.tools.set(name, h);
  }
}
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

describe("MCP tools", () => {
  it("create/update/list tools take and filter by project; unknown projects are refused", async () => {
    const db = memDb();
    const server = new FakeServer();
    registerScrumTools(server as never, db);
    const call = (n: string, a: Record<string, unknown>) => server.tools.get(n)!(a);
    expect(text(await call("set_project", { name: "app", repo: REPO, github_project_number: 7 }))).toMatch(/app: repo octo\/app, board octo\/projects\/7, assignee octo/);
    expect((await call("set_project", { name: "bad", repo: "not a repo" })).isError).toBe(true);
    expect((await call("create_milestone", { name: "M", status: "planned", project: "nope" })).isError).toBe(true);
    await call("create_milestone", { name: "M", status: "planned", project: "app" });
    await call("create_sprint", { name: "S", project: "app" });
    await call("create_epic", { name: "E", color: "#fff", priority: 0, project: "app" });
    await call("create_sprint", { name: "S2" });
    const sprintId = (db.prepare("SELECT id FROM sprints WHERE name='S'").get() as any).id;
    const s2 = (db.prepare("SELECT id FROM sprints WHERE name='S2'").get() as any).id;
    await call("create_ticket", { sprint_id: sprintId, title: "inherits", priority: "P1", type: "feat" });
    await call("create_ticket", { sprint_id: s2, title: "unassigned", priority: "P1" });
    expect(text(await call("list_tickets", { project: "app" }))).toMatch(/inherits/);
    expect(text(await call("list_tickets", { project: "app" }))).not.toMatch(/unassigned/);
    expect(text(await call("list_sprints", { project: "app", compact: true }))).toMatch(/S \[planning\]/);
    expect(text(await call("list_sprints", { project: "app", compact: true }))).not.toMatch(/S2/);
    expect(text(await call("list_milestones", { project: "app" }))).toMatch(/project=app/);
    expect(text(await call("list_epics", { project: "app", compact: true }))).toMatch(/E/);
    const tid = (db.prepare("SELECT id FROM tickets WHERE title='unassigned'").get() as any).id;
    await call("update_ticket", { ticket_id: tid, project: "app", type: "fix", origin: "human", github_issue: 42 });
    expect(row(db, tid)).toMatchObject({ project: "app", type: "fix", origin: "human", github_issue: 42, github_repo: null });
    await call("update_milestone", { milestone_id: 1, github_milestone: 3 });
    expect((db.prepare("SELECT github_milestone FROM milestones WHERE id=1").get() as any).github_milestone).toBe(3);
    expect((await call("update_sprint", { sprint_id: s2, project: "zzz" })).isError).toBe(true);
  });

  it("sync_github runs through the injected gateway", async () => {
    const db = memDb();
    seed(db);
    const gh = new FakeGitHub();
    const server = new FakeServer();
    registerGithubTools(server as never, db, () => gh);
    const r = await server.tools.get("sync_github")!({ project: "app", dry_run: true });
    expect(text(r)).toMatch(/sync_github app — dry run/);
    expect(gh.writes()).toEqual([]);
    const bad = await server.tools.get("sync_github")!({ project: "zzz" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Known: app, other/);
  });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

describe("code-context-sync-github CLI", () => {
  it("parses args", () => {
    expect(parseArgs(["--project", "p", "--dry-run", "--offline", "--milestone", "14=1", "--milestone", "3", "--db", "/x.db"])).toMatchObject({
      project: "p", dryRun: true, offline: true, milestones: [{ id: 14, github: 1 }, { id: 3, github: null }], db: "/x.db",
    });
    expect(parseArgs(["--project", "p", "--adopt", "116-118", "--adopt", "#120,118"])).toMatchObject({ adopt: [116, 117, 118, 120] });
    expect(parseArgs(["--project", "p", "--adopt", "5-3"])).toMatch(/ascending/);
    expect(parseArgs(["--project", "p", "--adopt", "x"])).toMatch(/--adopt needs/);
    expect(parseArgs(["--dry-run"])).toBe("--project is required");
    expect(parseArgs(["--project", "p", "--offline"])).toBe("--offline needs --dry-run");
  });

  it("dry run works on an in-memory copy: the db file bytes do not change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cca13-"));
    const file = path.join(dir, "context.db");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    initSchema(db);
    initScrumSchema(db);
    runMigrations(db, { freshDb: true });
    db.prepare("DELETE FROM schema_versions WHERE version = 26").run(); // pretend an older server owns it
    const ms = Number(db.prepare("INSERT INTO milestones (name, status) VALUES ('M', 'active')").run().lastInsertRowid);
    db.prepare("INSERT INTO tickets (title, ticket_ref, milestone_id, notes) VALUES ('t', 'C-1', ?, 'GitHub: octo/app#9')").run(ms);
    db.close();
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const before = hash();
    const out: string[] = [];
    const gh = new FakeGitHub();
    const code = await runCli(
      { db: file, project: "app", dryRun: true, offline: true, repo: REPO, projectNumber: 7, milestones: [{ id: ms, github: 1 }] },
      gh,
      (s) => out.push(s),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/~ update #9 C-1/);
    expect(gh.log).toEqual([]);
    expect(hash()).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("planSync guards", () => {
  it("refuses a project without repo", () => {
    const db = memDb();
    upsertProject(db, { name: "x" });
    expect(() => planSync(db, getProject(db, "x")!, null)).toThrow(/no repo/);
  });
});

// ─── Security review fixes ───────────────────────────────────────────────────

/** Run fn with CODE_CONTEXT_GITHUB_SYNC_REPOS (and _ASSIGNEES) set or unset, then restore both. */
async function withAllowlist<T>(value: string | undefined, fn: () => Promise<T> | T, assignees?: string): Promise<T> {
  const prev = [process.env[SYNC_ALLOWLIST_ENV], process.env[SYNC_ASSIGNEES_ENV]];
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set(SYNC_ALLOWLIST_ENV, value);
  set(SYNC_ASSIGNEES_ENV, assignees);
  try {
    return await fn();
  } finally {
    set(SYNC_ALLOWLIST_ENV, prev[0]);
    set(SYNC_ASSIGNEES_ENV, prev[1]);
  }
}

describe("publish guard: encoded and prefixed local paths (parser differential)", () => {
  // Every form GitHub still renders as a local path. Each must be scrubbed or
  // refused — never published raw — and the guard alone (no scrubber) must
  // refuse the raw text.
  const bypasses: Array<[string, string]> = [
    ["file:// URL", "see file:///Users/jane/dev/a.ts"],
    ["file:// autolink", "<file:///Users/jane/dev/a.ts>"],
    ["file:// markdown link target", "[spec](file:///Users/jane/dev/a.ts)"],
    ["file:// non-user path", "file:///etc/jane/hosts"],
    ["prefixed root", "x/Users/jane/dev/a.ts"],
    ["markdown-escaped slashes", "\\/Users\\/jane\\/dev\\/a.ts"],
    ["JSON-escaped slashes", '{"path":"\\/Users\\/jane\\/a.ts"}'],
    ["JSON \\u002F escapes", "\\u002FUsers\\u002Fjane\\u002Fa.ts"],
    ["percent-encoded", "%2FUsers%2Fjane%2Fdev%2Fa.ts"],
    ["double percent-encoded", "%252FUsers%252Fjane%252Fa.ts"],
    ["HTML decimal entity", "&#47;Users&#47;jane&#47;a.ts"],
    ["HTML hex entity", "&#x2F;Users&#x2f;jane&#x2F;a.ts"],
    ["HTML named entity", "&sol;Users&sol;jane&sol;a.ts"],
    ["double-encoded entity", "&amp;#47;Users&amp;#47;jane&amp;#47;a.ts"],
    ["Windows forward slashes", "C:/Users/jane/dev/a.ts"],
    ["Windows backslashes", "C:\\Users\\jane\\dev\\a.ts"],
    ["Windows JSON-escaped", "C:\\\\Users\\\\jane\\\\a.ts"],
    ["Documents and Settings", "C:\\Documents and Settings\\jane\\a.ts"],
    ["Documents and Settings, forward", "C:/Documents and Settings/jane/a.ts"],
    ["lower-case root", "/users/jane/a.ts"],
    ["zero-width space inside root", "/Us\u200bers/jane/a.ts"],
    ["BOM splits the token", "/Us\ufeffers/jane/a.ts"],
    ["empty-host http URL", "https:///Users/jane/a.ts"],
    ["double slash", "//Users//jane//a.ts"],
    ["bold markdown", "**/Users/jane/a.ts**"],
    ["docker volume", "-v /home/jane/src:/app"],
    ["bare user dir", "home is /Users/jane"],
    ["/private/tmp", "/private/tmp/jane-build/a.log"],
    ["/private/var", "/private/var/jane/x"],
    ["/Volumes", "/Volumes/Disk/jane/a.ts"],
    ["fullwidth solidus", "\uff0fUsers\uff0fjane\uff0fa.ts"],
  ];
  it.each(bypasses)("%s: the guard alone refuses the raw text", (_name, raw) => {
    expect(hasLocalPath(raw)).toBe(true);
    expect(() => assertPublishable(raw, "body")).toThrow(/local absolute path/);
  });
  it.each(bypasses)("%s: scrubbed or refused, never published raw", (_name, raw) => {
    let out: string | null = null;
    try {
      out = publishable(raw, "body");
    } catch (e: any) {
      expect(e.message).toMatch(/local absolute path/);
    }
    if (out !== null) {
      expect(hasLocalPath(out)).toBe(false);
      expect(out).not.toMatch(/jane/);
    }
  });
  it("normal text gets scrubbed, not refused", () => {
    expect(publishable("open file:///Users/jane/dev/a.ts now", "b")).toBe("open …/a.ts now");
    expect(publishable("[spec](file:///Users/jane/dev/spec.md)", "b")).toBe("[spec](…/spec.md)");
    expect(publishable("at %2FUsers%2Fjane%2Fa.ts.", "b")).toBe("at …/a.ts.");
    expect(publishable("in &#47;Users&#47;jane&#47;a.ts", "b")).toBe("in …/a.ts");
    expect(publishable("C:/Users/jane/x/b.ts and C:\\Documents and Settings\\jane\\c.ts", "b")).toBe("…/b.ts and …/c.ts");
    expect(publishable('{"p":"\\/Users\\/jane\\/a.ts"}', "b")).toBe('{"p":"…/a.ts"}');
    expect(publishable("home is /Users/jane, ok", "b")).toBe("home is …, ok");
    expect(publishable("x/Users/jane/a.ts", "b")).toBe("…/a.ts");
    expect(publishable("--db=/Users/jane/ctx.db", "b")).toBe("--db=…/ctx.db");
  });

  const allowed = [
    "https://github.com/home/x",
    "https://github.com/root/repo/blob/main/tmp/x.ts",
    "https://example.com/Users/list?q=1",
    "[docs](https://example.com/home/page)",
    "<https://example.com/tmp/file>",
    "http://localhost:3000/Volumes/list",
    "https://example.com/a%2Fhome%2Fx",
    "https://example.com/a?next=%2Fhome%2Fx",
    "src/server/git.ts and ./tmp-file and home/office",
    "~/Desktop/repo/a.ts",
    "a profile:/x line and a /usr/local/bin path",
  ];
  it.each(allowed)("allowed and unchanged: %s", (text) => {
    expect(hasLocalPath(text)).toBe(false);
    expect(publishable(text, "body")).toBe(text);
  });
  it("the token check also sees encoded tokens", () => {
    expect(() => assertPublishable("ghp%5Fabcdefghijklmnopqrstuvwxyz0123", "body")).toThrow(/token/);
  });
});

describe("live-sync authorization (CODE_CONTEXT_GITHUB_SYNC_REPOS)", () => {
  it("parses the allowlist: owner/repo or owner/repo@board-owner/N; junk, wildcards and bad boards ignored", () => {
    expect(parseSyncGrants(" octo/app, Octo/Other@Octo/7  bad * x/* o/r@* o/r@x/0 o/r@x/-1 o/r@x/1/2 o/r@/3 ,,")).toEqual([
      { repo: "octo/app", board: null },
      { repo: "octo/other", board: { owner: "octo", number: 7 } },
    ]);
    expect(syncAuth({})).toEqual({ grants: [], assignees: [] });
    expect(syncAuth({ [SYNC_ASSIGNEES_ENV]: "Alice, bob  -bad x/y" }).assignees).toEqual(["alice", "bob"]);
  });

  // The authorization matrix: [case, target, CODE_CONTEXT_GITHUB_SYNC_REPOS, _ASSIGNEES, expected refusal (null = allowed)]
  const T = (repo: string, board: [string, number] | null = null, assignee?: string) => ({
    repo,
    board: board ? { owner: board[0], number: board[1] } : null,
    assignee: assignee ?? repo.split("/")[0],
  });
  const matrix: Array<[string, ReturnType<typeof T>, string, string, RegExp | null]> = [
    ["repo listed, no board", T("octo/app"), "octo/app", "", null],
    ["case-insensitive", T("Octo/App"), "octo/app", "", null],
    ["repo not listed", T("evil/pub"), "octo/app", "", /evil\/pub is not in CODE_CONTEXT_GITHUB_SYNC_REPOS/],
    ["allowlist unset", T("octo/app"), "", "", /\(unset\)/],
    ["exact repo@board pair", T("octo/app", ["octo", 7]), "octo/app@octo/7", "", null],
    ["pair, board owner other than repo owner", T("octo/app", ["acme", 3]), "octo/app@acme/3", "", null],
    ["repo-only grant never covers a board", T("octo/app", ["octo", 7]), "octo/app", "", /board octo\/7 is not authorized.*no entry octo\/app@octo\/7/],
    ["another board of the same owner", T("octo/app", ["octo", 9]), "octo/app@octo/7", "", /board octo\/9 is not authorized/],
    ["same board number, other owner", T("octo/app", ["evil", 7]), "octo/app@octo/7", "", /board evil\/7 is not authorized/],
    ["board granted to another repo only", T("octo/app", ["octo", 7]), "octo/app,octo/other@octo/7", "", /board octo\/7 is not authorized/],
    ["board pair of another repo does not authorize this repo", T("octo/app"), "octo/other@octo/7", "", /octo\/app is not in/],
    ["two boards for one repo: each pinned", T("octo/app", ["octo", 8]), "octo/app@octo/7 octo/app@octo/8", "", null],
    ["assignee = repo owner", T("octo/app", null, "OCTO"), "octo/app", "", null],
    ["assignee not allowed", T("octo/app", null, "stranger"), "octo/app", "", /assignee stranger is not authorized.*CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES \(unset\)/],
    ["assignee listed", T("octo/app", null, "Alice"), "octo/app", "alice", null],
    ["assignee list does not leak to others", T("octo/app", null, "mallory"), "octo/app", "alice", /assignee mallory is not authorized/],
    ["board owner is not an allowed assignee", T("octo/app", ["acme", 3], "acme"), "octo/app@acme/3", "", /assignee acme is not authorized/],
  ];
  it.each(matrix)("authorization: %s", (_n, target, repos, assignees, want) => {
    const r = liveSyncRefusal(target, authFor(repos, assignees));
    if (want === null) expect(r).toBeNull();
    else {
      expect(r).toMatch(want);
      expect(r).toMatch(/CODE_CONTEXT_GITHUB_SYNC_(REPOS|ASSIGNEES)/);
    }
  });
  it("syncTargetOf resolves board owner and assignee defaults", () => {
    expect(syncTargetOf({ repo: "octo/app", github_project_number: 7, github_project_owner: null, github_assignee: null })).toEqual(T("octo/app", ["octo", 7]));
    expect(syncTargetOf({ repo: "octo/app", github_project_number: null, github_project_owner: "acme", github_assignee: "bob" })).toEqual(T("octo/app", null, "bob"));
  });

  let db: Database.Database;
  let gh: FakeGitHub;
  let ids: { ms: number; sprint: number };
  beforeEach(() => {
    db = memDb();
    gh = new FakeGitHub();
    ids = seed(db);
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "Add x", priority: "P1", type: "feat", milestone_id: ids.ms });
  });

  it("a live sync without the env is refused before any GitHub call; dry runs stay allowed", async () => {
    await withAllowlist(undefined, async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/not authorized.*CODE_CONTEXT_GITHUB_SYNC_REPOS/);
      expect(gh.log).toEqual([]);
      expect((await syncGithub(db, gh, "app", { dryRun: true })).error).toBeNull();
      expect((await syncGithub(db, gh, "app", { dryRun: true, offline: true })).error).toBeNull();
      expect(gh.writes()).toEqual([]);
    });
  });
  it("the env allowlist authorizes a live sync; another repo on the list does not", async () => {
    await withAllowlist("octo/other", async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/octo\/app is not in/);
    });
    await withAllowlist("octo/other,OCTO/app@Octo/7", async () => {
      const r = await syncGithub(db, gh, "app", { pauseMs: 0 });
      expect(r.error).toBeNull();
      expect(gh.writes()).toContain("createIssue 200");
    });
  });
  it("a board other than the pinned one is refused before any GitHub call, even when the repo is listed", async () => {
    // Repo-only grant: no board at all.
    await withAllowlist("octo/app", async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/board octo\/7 is not authorized/);
    });
    // set_project on a not-yet-synced project can move the board; the pinned pair still refuses it.
    upsertProject(db, { name: "app", github_project_number: 99 });
    await withAllowlist("octo/app@octo/7", async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/board octo\/99 is not authorized/);
    });
    upsertProject(db, { name: "app", github_project_number: 7, github_project_owner: "evil" });
    await withAllowlist("octo/app@octo/7", async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/board evil\/7 is not authorized/);
    });
    expect(gh.log).toEqual([]);
    // Without a board the repo grant is enough, and nothing touches a board.
    upsertProject(db, { name: "app", github_project_number: null, github_project_owner: null });
    await withAllowlist("octo/app", async () => {
      const r = await syncGithub(db, gh, "app", { pauseMs: 0 });
      expect(r.error).toBeNull();
      expect(gh.writes()).toEqual(["createMilestone 1", "createIssue 200"]);
    });
  });

  it("an assignee other than the repo owner needs CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES", async () => {
    upsertProject(db, { name: "app", github_assignee: "stranger" });
    await withAllowlist("octo/app@octo/7", async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/assignee stranger is not authorized/);
      expect(gh.log).toEqual([]);
      // Dry runs stay allowlist-free.
      expect((await syncGithub(db, gh, "app", { dryRun: true, offline: true })).error).toBeNull();
    });
    await withAllowlist("octo/app@octo/7", async () => {
      expect((await syncGithub(db, gh, "app", { pauseMs: 0 })).error).toBeNull();
      expect(gh.issues.get(200)!.assignees).toEqual(["stranger"]);
    }, "stranger");
  });

  it("a live run ignores a cached Project id and resolves the board from the authorized owner/number", async () => {
    // Any db writer (the `execute` tool) could plant another board's id in the cache.
    db.prepare("UPDATE projects SET github_project_id = 'PVT_OTHER', github_status_field_id = 'F_x', github_status_options = ? WHERE name = 'app'").run(JSON.stringify(OPTIONS));
    const projectIds: string[] = [];
    const add = gh.addToProject.bind(gh);
    gh.addToProject = async (pid, ids) => (projectIds.push(pid), add(pid, ids));
    await withAllowlist("octo/app@octo/7", async () => {
      expect((await syncGithub(db, gh, "app", { pauseMs: 0 })).error).toBeNull();
    });
    expect(gh.log.find((l) => l.startsWith("readIssues"))).not.toMatch(/cached/);
    expect(projectIds).toEqual(["PVT_1"]);
  });

  it("MCP: sync_github cannot authorize itself; set_project cannot re-point a synced project", async () => {
    const server = new FakeServer();
    registerGithubTools(server as never, db, () => gh);
    const call = (n: string, a: Record<string, unknown>) => server.tools.get(n)!(a);
    await withAllowlist(undefined, async () => {
      // Extra args (an injected allowlist) are ignored.
      const r = await call("sync_github", { project: "app", allowedRepos: [REPO], allowed_repos: REPO });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not authorized.*CODE_CONTEXT_GITHUB_SYNC_REPOS/);
      expect(gh.log).toEqual([]);
      expect((await call("sync_github", { project: "app", dry_run: true })).isError).toBe(false);
      // Not synced yet: re-pointing is a plain setup change.
      expect((await call("set_project", { name: "app", repo: "octo/app2" })).isError).toBeUndefined();
      expect((await call("set_project", { name: "app", repo: REPO })).isError).toBeUndefined();
    });
    await withAllowlist(REPO, async () => {
      // A repo grant alone does not cover the project's board.
      expect(text(await call("sync_github", { project: "app" }))).toMatch(/board octo\/7 is not authorized/);
    });
    await withAllowlist(`${REPO}@octo/7`, async () => {
      expect((await call("sync_github", { project: "app" })).isError).toBe(false);
    });
    expect(gh.writes()).toContain("createIssue 200");

    await withAllowlist(`${REPO}@octo/7,octo/public`, async () => {
      const moved = await call("set_project", { name: "app", repo: "evil/public" });
      expect(moved.isError).toBe(true);
      expect(text(moved)).toMatch(/already synced to octo\/app.*force=true/);
      expect(text(await call("set_project", { name: "app", github_project_number: 99 }))).toMatch(/refused/);
      expect(text(await call("set_project", { name: "app", github_project_owner: "evil" }))).toMatch(/refused/);
      // force is honoured only for an allowlisted target.
      const forcedBad = await call("set_project", { name: "app", repo: "evil/public", force: true });
      expect(forcedBad.isError).toBe(true);
      expect(text(forcedBad)).toMatch(/force refused: .*evil\/public is not in/);
      expect(getProject(db, "app")!.repo).toBe(REPO);
      // Same values and the assignee stay free.
      expect((await call("set_project", { name: "app", repo: "OCTO/app", github_project_number: 7 })).isError).toBeUndefined();
      expect((await call("set_project", { name: "app", github_assignee: "someone" })).isError).toBeUndefined();
      // octo/public is granted without a board, so moving there with board 7 is refused.
      const forcedBoard = await call("set_project", { name: "app", repo: "octo/public", force: true });
      expect(text(forcedBoard)).toMatch(/force refused: .*board octo\/7 is not authorized/);
      const forcedOk = await call("set_project", { name: "app", repo: "octo/public", github_project_number: null, force: true });
      expect(forcedOk.isError).toBeUndefined();
      expect(getProject(db, "app")!.repo).toBe("octo/public");
    });
  });
});

describe("code-context-sync-github CLI authorization", () => {
  function fileDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cca13-auth-"));
    const file = path.join(dir, "context.db");
    const db = new Database(file);
    initSchema(db);
    initScrumSchema(db);
    runMigrations(db, { freshDb: true });
    const ms = Number(db.prepare("INSERT INTO milestones (name, status) VALUES ('M', 'active')").run().lastInsertRowid);
    db.prepare("INSERT INTO tickets (title, ticket_ref, milestone_id, priority, type) VALUES ('t', 'C-1', ?, 'P1', 'feat')").run(ms);
    db.close();
    return { dir, file, ms };
  }
  const base = (file: string, ms: number) => ({ db: file, project: "app", dryRun: false, offline: false, repo: REPO, milestones: [{ id: ms, github: null }], maxWrites: 10 });

  it("--repo alone does not authorize a live run: exit 2, no GitHub call, db unchanged", async () => {
    const { dir, file, ms } = fileDb();
    const out: string[] = [];
    const gh = new FakeGitHub();
    const code = await withAllowlist(undefined, () => runCli(base(file, ms), gh, (s) => out.push(s)));
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/not authorized.*CODE_CONTEXT_GITHUB_SYNC_REPOS/);
    expect(gh.log).toEqual([]);
    const db = new Database(file, { readonly: true });
    // The setup flags were rolled back with the refusal.
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT project FROM milestones WHERE id = ?").get(ms)).toEqual({ project: null });
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the env allowlist authorizes the live run; a dry run needs no allowlist", async () => {
    const { dir, file, ms } = fileDb();
    const gh = new FakeGitHub();
    const out: string[] = [];
    expect(await withAllowlist(undefined, () => runCli({ ...base(file, ms), dryRun: true }, gh, (s) => out.push(s)))).toBe(0);
    expect(gh.writes()).toEqual([]);
    expect(await withAllowlist(REPO, () => runCli(base(file, ms), gh, (s) => out.push(s)))).toBe(0);
    expect(gh.writes()).toContain("createIssue 200");
    // Re-pointing the now-synced project: refused, and --force only to an allowlisted repo.
    const other = { ...base(file, ms), repo: "evil/public", milestones: [] };
    expect(await withAllowlist(REPO, () => runCli(other, gh, (s) => out.push(s)))).toBe(2);
    expect(await withAllowlist(REPO, () => runCli({ ...other, force: true }, gh, (s) => out.push(s)))).toBe(2);
    expect(out.join("\n")).toMatch(/force refused/);
    const db = new Database(file, { readonly: true });
    expect((db.prepare("SELECT repo FROM projects WHERE name = 'app'").get() as any).repo).toBe(REPO);
    db.close();
    expect(parseArgs(["--project", "p", "--force"])).toMatchObject({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--adopt and --milestone <id>=<N> adopt hand-made issues and milestones on an allowlisted live run", async () => {
    const { dir, file, ms } = fileDb();
    const setup = new Database(file);
    setup.prepare("UPDATE tickets SET github_issue = 116").run();
    setup.close();
    const gh = new FakeGitHub();
    gh.milestones.push({ number: 1, title: "M", description: "by hand", state: "open", due_on: null });
    gh.seedIssue(116, { title: "C-1: t", body: "by hand", labels: ["P1"], assignees: ["octo"] });
    const out: string[] = [];
    const args = { ...base(file, ms), milestones: [{ id: ms, github: 1 }], adopt: parseIssueList("116-116") as number[] };
    // Without the allowlist: refused, nothing written.
    expect(await withAllowlist(undefined, () => runCli(args, gh, (s) => out.push(s)))).toBe(2);
    expect(gh.writes()).toEqual([]);
    expect(await withAllowlist(REPO, () => runCli(args, gh, (s) => out.push(s)))).toBe(0);
    expect(out.join("\n")).toMatch(/adopted milestone #1; adopted #116 \(C-1\)/);
    expect(gh.issues.get(116)!.body).toContain(issueMarker("app", "C-1"));
    expect(gh.milestones[0].description).toContain(milestoneMarker("app", ms));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Secret guard (second security review) ───────────────────────────────────

describe("no test reaches GitHub", () => {
  it("the real gh runner is blocked in this file", async () => {
    const { ghRunner } = await import("../src/scrum/github-gateway.js");
    await expect(Promise.resolve().then(() => ghRunner(["api", "user"]))).rejects.toThrow(/real gh CLI/);
    ghSpawns.n = 0; // this probe is the one intended spawn attempt
  });
});

describe("publish guard: secrets", () => {
  // Built at runtime so no literal key-shaped string sits in the repo.
  const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const mixed = (n: number) => rep("aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY", n);
  const upper = (n: number) => rep("A1B2C3D4E5F6G7H8J9K0", n);
  const secrets: Array<[string, string, string]> = [
    ["GitHub classic token", `token ${"gh" + "p_"}${mixed(36)}`, "GitHub token"],
    ["GitHub fine-grained token", `${"github" + "_pat_"}${mixed(22)}_${mixed(59)}`, "GitHub token"],
    ["GitHub app token", `${"gh" + "s_"}${mixed(36)}`, "GitHub token"],
    ["Anthropic key", `use ${"sk-" + "ant-"}api03-${mixed(40)}-${mixed(20)}`, "Anthropic API key"],
    ["OpenAI key", `${"sk" + "-"}${mixed(48)}`, "OpenAI API key"],
    ["OpenAI project key", `${"sk-" + "proj-"}${mixed(60)}`, "OpenAI API key"],
    ["AWS access key id", `id ${"AK" + "IA"}${upper(16)} here`, "AWS access key id"],
    ["AWS temp key id", `${"AS" + "IA"}${upper(16)}`, "AWS access key id"],
    ["AWS secret access key", `aws_secret_access_key = ${rep("wJalrXUtnFEMI/K7MDENG+bPxRfiCY", 40)}`, "AWS secret access key"],
    ["Slack bot token", `${"xo" + "xb-"}123456789012-123456789012-${mixed(24)}`, "Slack token"],
    ["Slack user token", `${"xo" + "xp-"}123456789012-${mixed(20)}`, "Slack token"],
    ["Slack webhook", `https://hooks.slack.com/services/T${upper(8)}/B${upper(8)}/${mixed(24)}`, "Slack webhook URL"],
    ["Google API key", `${"AI" + "za"}${mixed(35)}`, "Google API key"],
    ["Stripe live secret", `${"sk_" + "live_"}${mixed(24)}`, "Stripe key"],
    ["Stripe restricted", `${"rk_" + "live_"}${mixed(24)}`, "Stripe key"],
    ["JWT", `${"ey" + "J"}hbGciOiJIUzI1NiJ9.${"ey" + "J"}zdWIiOiIxMjM0NTY3ODkwIn0.${mixed(43)}`, "JWT"],
    ["PEM RSA private key", `-----BEGIN RSA PRIVATE KEY-----\n${mixed(64)}\n-----END RSA PRIVATE KEY-----`, "private key block"],
    ["PEM OpenSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----", "private key block"],
    ["PEM PKCS8 private key", "-----BEGIN PRIVATE KEY-----", "private key block"],
    ["Authorization Bearer", `Authorization: Bearer ${mixed(32)}`, "Authorization header"],
    ["Authorization Basic", `Authorization: Basic ${mixed(24)}==`, "Authorization header"],
    ["credentials in URL", `postgres://admin:${mixed(12)}@db.example.com/app`, "credentials in URL"],
    [".env line", `DB_PASSWORD=${mixed(12)}`, ".env secret"],
    [".env export line", `export SERVICE_API_TOKEN="${mixed(20)}"`, ".env secret"],
    ["api_key=", `api_key=${mixed(24)}`, "secret assignment"],
    ["client_secret:", `client_secret: ${mixed(24)}`, "secret assignment"],
    ["JSON apiKey", `{"apiKey": "${mixed(24)}"}`, "secret assignment"],
    ["password:", `password: ${mixed(18)}`, "secret assignment"],
    ["passwd=", `passwd=${mixed(18)}`, "secret assignment"],
  ];

  // Encodings GitHub (or a reader) would still turn back into the secret.
  const every = (s: string, f: (c: string) => string) => [...s].map(f).join("");
  const encoders: Array<[string, (s: string) => string]> = [
    ["raw", (s) => s],
    ["zero-width split", (s) => every(s, (c) => `${c}\u200b`)],
    ["soft hyphen + BOM split", (s) => every(s, (c) => `${c}\u00ad\ufeff`)],
    ["percent", (s) => every(s, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)],
    ["double percent", (s) => every(s, (c) => `%25${c.charCodeAt(0).toString(16).padStart(2, "0")}`)],
    ["HTML decimal entity", (s) => every(s, (c) => `&#${c.charCodeAt(0)};`)],
    ["HTML hex entity", (s) => every(s, (c) => `&#x${c.charCodeAt(0).toString(16)};`)],
    ["\\u escape", (s) => every(s, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)],
    ["fullwidth (NFKC)", (s) => every(s, (c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c))],
  ];
  const cases = secrets.flatMap(([name, text, type]) => encoders.map(([enc, f]) => [`${name} (${enc})`, f(text), type, text] as const));

  it.each(cases)("%s: refused, the message names the field and type, never the value", (_n, text, type, plain) => {
    expect(findSecret(text)).toBe(type);
    let msg = "";
    try {
      publishable(`context before ${text} context after`, "ticket description");
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toBe(`ticket description holds a secret (${type}) — refusing to publish; remove it from the local text`);
    // Never echo the secret (not even a long fragment of it).
    const value = plain.replace(/^.*?[:=]\s*"?/, "");
    expect(msg).not.toContain(value.slice(0, 12));
  });

  it.each(secrets)("%s: found in markdown code spans, fences, emphasis and next to , * | { } neighbours", (_n, text, type) => {
    for (const wrap of [
      (s: string) => `\`${s}\``,
      (s: string) => `\`\`\`env\n${s}\n\`\`\``,
      (s: string) => `**${s}**`,
      (s: string) => `a,${s},b`,
      (s: string) => `*${s}*`,
      (s: string) => `|${s}|`,
      (s: string) => `{${s}}`,
      (s: string) => `[link](${s})`,
    ]) {
      expect(findSecret(wrap(text))).toBe(type);
    }
  });

  it("a secret split by markdown code-span or emphasis marks is still found", () => {
    const key = `${"sk_" + "live_"}${"aB3dE5fG7hJ9kL2mN4pQ6rS8"}`;
    expect(findSecret(`${key.slice(0, 10)}\`${key.slice(10, 16)}\`${key.slice(16)}`)).toBe("Stripe key");
    expect(findSecret(`${key.slice(0, 10)}**${key.slice(10)}**`)).toBe("Stripe key");
    expect(findSecret(`**api_key**: \`${"aB3dE5fG7hJ9kL2mN4pQ"}\``)).toBe("secret assignment");
  });

  it("a secret inside a local path is refused, never scrubbed away silently", () => {
    const key = `${"sk-" + "ant-"}api03-${"aB3dE5fG7hJ9kL2mN4pQ6rS8tU0"}`;
    expect(() => publishable(`see /Users/jane/${key}/a.ts`, "ticket description")).toThrow(/secret \(Anthropic API key\)/);
    expect(() => publishable(`see file:///Users/jane/a.ts?k=${key}`, "milestone description")).toThrow(/milestone description holds a secret/);
  });

  const allowed = [
    "rotate the token and the API key, then the secret",
    "token: see the vault entry",
    "token: see-the-vault-entry-for-this",
    "issue #128, PR #140, ticket CCA-13",
    "commit 32a07bc and 32a07bc4f1e2d3c4b5a6978877665544332211ff",
    "sha=32a07bc4f1e2d3c4b5a6978877665544332211ff",
    "id 550e8400-e29b-41d4-a716-446655440000",
    "run dsk-20261011-090622 finished",
    "dsk-20261011-090622-abcdefghijklmnop",
    "task-1234567890abcdefghijklmnop",
    "scikit-learn, sk-learn and risk-management-overview-2026",
    "max_tokens: 1000000000000000000",
    "primary_key: ticket_id_reference_column",
    "token_file: src/server/auth/token.ts",
    "API_KEY=${OPENAI_API_KEY}",
    "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
    "API_KEY=<your-key-here>",
    "SECRET_KEY=changeme",
    "DB_PASSWORD=xxxxxxxxxxxx",
    "ZAI_API_KEY=ZAI_API_KEY_FROM_RIG",
    "the Bearer authentication-is-required-for-this",
    "password: hunter2",
    "https://user@github.com/octo/app and git@github.com:octo/app.git",
    "postgres://admin:****@db.example.com/app",
    "eyJ alone, ghp_short, AIza short, xoxb-short",
    "-----BEGIN PUBLIC KEY----- and -----BEGIN CERTIFICATE-----",
    "set CODE_CONTEXT_GITHUB_SYNC_REPOS=VelimirMueller/code-context-mcp@VelimirMueller/3",
    "the keyboard-shortcuts-reference-guide and monkey: patch",
  ];
  it.each(allowed)("allowed and unchanged: %s", (text) => {
    expect(findSecret(text)).toBeNull();
    expect(publishable(text, "ticket description")).toBe(text);
  });

  it("names the field: title, description, acceptance criteria, milestone text", () => {
    const key = `${"AK" + "IA"}${"A1B2C3D4E5F6G7H8"}`;
    expect(() => assertNoSecret(`x ${key}`, "ticket title")).toThrow(/^ticket title holds a secret \(AWS access key id\)/);
    expect(() => buildIssueBody({ description: `fix ${key}`, acceptance_criteria: null })).toThrow(/^ticket description holds a secret/);
    expect(() => buildIssueBody({ description: "ok", acceptance_criteria: JSON.stringify(["ok", `uses ${key}`]) })).toThrow(/^acceptance criteria holds a secret/);
  });

  it("sync: a ticket holding a secret is skipped with the reason; a milestone with one fails the plan; GitHub never sees the value", async () => {
    const db = memDb();
    const gh = new FakeGitHub();
    const ids = seed(db);
    const key = `${"sk_" + "live_"}${"aB3dE5fG7hJ9kL2mN4pQ6rS8"}`;
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-1", title: "ok", priority: "P1", type: "feat" });
    ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-2", title: "leaks", description: `charge with &#${key.charCodeAt(0)};${key.slice(1)}`, priority: "P1", type: "fix" });
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.error).toBeNull();
    expect(r.plan.skipped).toEqual([{ ref: "APP-2", reason: "ticket description holds a secret (Stripe key) — refusing to publish; remove it from the local text" }]);
    expect(r.text).not.toContain(key.slice(4));
    const sent = JSON.stringify([...gh.issues.values()]);
    expect(sent).not.toContain(key.slice(4));
    expect([...gh.issues.values()].map((i) => i.title)).toEqual(["APP-1: ok"]);

    db.prepare("UPDATE milestones SET description = ? WHERE id = ?").run(`token: ${key}`, ids.ms);
    await expect(syncGithub(db, new FakeGitHub(), "app", noSleep)).rejects.toThrow(/milestone description holds a secret \(Stripe key\)/);
  });
});

describe("scrubber and guard agree on token boundaries (parser differential)", () => {
  // Every delimiter the scrubber splits on is a delimiter for the guard too, so
  // the guard never reads a local root as the path of an http(s) URL before it.
  const neighbours = [",", "*", "|", "{", "}", "`", "(", ")", "[", "]", "<", ">", "'", '"', " "];
  const layouts: Array<[string, (c: string) => string]> = [
    ["after a URL", (c) => `https://example.com/a${c}/Users/jane/a.ts`],
    ["after a URL, closed", (c) => `https://example.com/a${c}/Users/jane/a.ts${c}`],
    ["wrapped", (c) => `${c}/Users/jane/a.ts${c}`],
    ["after a URL, zero-width before the root", (c) => `https://example.com/a${c}\u200b/Users/jane/a.ts`],
    ["after a URL, encoded root", (c) => `https://example.com/a${c}%2FUsers%2Fjane%2Fa.ts`],
  ];
  const cases = layouts.flatMap(([name, f]) => neighbours.map((c) => [`${name} with ${JSON.stringify(c)}`, f(c)] as const));
  it.each(cases)("%s: the guard refuses raw, publishable never leaks", (_n, raw) => {
    expect(hasLocalPath(raw)).toBe(true);
    expect(() => assertPublishable(raw, "body")).toThrow(/local absolute path/);
    let out: string | null = null;
    try {
      out = publishable(raw, "body");
    } catch (e: any) {
      expect(e.message).toMatch(/local absolute path/);
    }
    if (out !== null) {
      expect(hasLocalPath(out)).toBe(false);
      expect(out).not.toMatch(/jane/);
    }
  });
  it.each([
    ["markdown code span", "run `/Users/jane/dev/a.ts` now", "run `…/a.ts` now"],
    ["fenced block", "```\n/Users/jane/dev/a.ts\n```", "```\n…/a.ts\n```"],
    ["zero-width split root", "at /Us\u200bers/jane/dev/a.ts", "at …/a.ts"],
    ["zero-width split user", "at /Users/ja\u200bne/a.ts", "at …/a.ts"],
    ["JSON object", '{"cwd":"/Users/jane/dev","n":1}', '{"cwd":"…/dev","n":1}'],
    ["table cell", "| path | /home/jane/x.log |", "| path | …/x.log |"],
  ])("%s: scrubbed", (_n, raw, want) => {
    expect(publishable(raw, "body")).toBe(want);
  });
});

