/**
 * CCA-13 (#128): project key + one-way GitHub sync. No test reaches GitHub:
 * the engine runs against an in-memory FakeGitHub, and GhGateway against a
 * fake `gh` runner that records argv/stdin and returns canned JSON.
 */
import { describe, it, expect, beforeEach } from "vitest";
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
  syncAllowlist,
  SYNC_ALLOWLIST_ENV,
  buildIssueBody,
  labelRule,
  applyLabelRule,
  planSync,
  scrubLocalPaths,
  statusFor,
  syncGithub,
  getProject,
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
import { parseArgs, run as runCli } from "../src/server/sync-github-cli.js";
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
const noSleep = { pauseMs: 0, allowedRepos: [REPO] };

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
    expect(issue.body).toBe("## Why\n\nWhy text\n\n## Done when\n\ny\n");
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
    // reads: one milestone list + one issue read using the cached Project ids
    expect(gh.log).toEqual(["readMilestones octo/app", "readIssues 200 cached"]);
  });

  it("updates a linked issue: title/body/labels/assignee, keeps unmanaged labels, moves Status", async () => {
    gh.milestones.push({ number: 1, title: "M1", description: "Goal", state: "open", due_on: null });
    gh.seedIssue(116, { title: "old title", labels: ["P0", "feat", "issue", "keep-me"], assignees: ["someone"], milestone: 1, item: { id: "PVTI_x", status: "Backlog" } });
    const t = ticket(db, { sprint_id: ids.sprint, ticket_ref: "APP-2", title: "New", priority: "P2", status: "IN_PROGRESS", milestone_id: ids.ms, notes: "GitHub: octo/app#116" });
    backfillGithubIssues(db);
    expect(row(db, t).github_issue).toBe(116);
    const r = await syncGithub(db, gh, "app", noSleep);
    expect(r.plan.milestones[0].kind).toBe("link");
    const i = gh.issues.get(116)!;
    expect(i.title).toBe("APP-2: New");
    expect(i.labels.sort()).toEqual(["P2", "feat", "issue", "keep-me"].sort());
    expect(i.assignees).toEqual(["someone", "octo"]);
    expect(i.item?.status).toBe("In progress");
    expect(gh.writes()).toEqual(["updateIssue 116 assignees,body,labels,title", "setStatus 1"]);
  });

  it("closes the issue when the ticket is DONE and sets Status Done; reopens when it is not", async () => {
    gh.milestones.push({ number: 1, title: "M1", description: "Goal", state: "open", due_on: null });
    gh.seedIssue(120, { title: "APP-3: T", body: buildIssueBody({ description: null, acceptance_criteria: null }), labels: ["P1"], assignees: ["octo"], item: { id: "PVTI_1", status: "In progress" } });
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
    gh.seedIssue(130, { title: "APP-4: T", body: buildIssueBody({ description: null, acceptance_criteria: null }), labels: ["P2"], assignees: ["octo"] });
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
    const body = buildIssueBody({ description: null, acceptance_criteria: null });
    for (let n = 116; n <= 128; n++) ticket(db, { sprint_id: s, ticket_ref: `C-${n}`, title: "t", priority: "P1", milestone_id: 1, github_issue: n });
    const { run, calls } = fakeRunner((args, input) => {
      if (args.includes("GET")) return { stdout: [{ number: 1, title: "M1", description: "", state: "open", due_on: null }] };
      const nums = [...input.query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return {
        stdout: {
          data: {
            repository: Object.fromEntries(nums.map((n) => [`i${n}`, issueNode(n, { title: `C-${n}: t`, body })])),
            board: { projectV2: { id: "PVT_1", field: { id: "F", options: [{ id: "o1", name: "Ready" }] } } },
          },
        },
      };
    });
    const r = await syncGithub(db, new GhGateway(run), "app", noSleep);
    expect(r.error).toBeNull();
    expect(r.writes).toBe(0);
    expect(calls).toHaveLength(2);
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

/** Run fn with CODE_CONTEXT_GITHUB_SYNC_REPOS set (or unset), then restore it. */
async function withAllowlist<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[SYNC_ALLOWLIST_ENV];
  if (value === undefined) delete process.env[SYNC_ALLOWLIST_ENV];
  else process.env[SYNC_ALLOWLIST_ENV] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[SYNC_ALLOWLIST_ENV];
    else process.env[SYNC_ALLOWLIST_ENV] = prev;
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
  it("parses the allowlist: comma or space separated, case-insensitive, junk and wildcards ignored", () => {
    expect(syncAllowlist({ [SYNC_ALLOWLIST_ENV]: " octo/app, Octo/Other  bad * x/* ,," })).toEqual(["octo/app", "octo/other"]);
    expect(syncAllowlist({})).toEqual([]);
  });
  it("refuses an unlisted repo or a board owner without a listed repo, and says how to allow it", () => {
    expect(liveSyncRefusal("octo/app", "octo", ["octo/app"])).toBeNull();
    expect(liveSyncRefusal("Octo/App", null, ["octo/app"])).toBeNull();
    expect(liveSyncRefusal("evil/pub", null, ["octo/app"])).toMatch(/evil\/pub is not in CODE_CONTEXT_GITHUB_SYNC_REPOS.*add it to CODE_CONTEXT_GITHUB_SYNC_REPOS/);
    expect(liveSyncRefusal("octo/app", "evil", ["octo/app"])).toMatch(/board of evil is not authorized/);
    expect(liveSyncRefusal("octo/app", null, [])).toMatch(/\(unset\)/);
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
    await withAllowlist("octo/other,OCTO/app", async () => {
      const r = await syncGithub(db, gh, "app", { pauseMs: 0 });
      expect(r.error).toBeNull();
      expect(gh.writes()).toContain("createIssue 200");
    });
  });
  it("a board owned by an unlisted owner is refused even when the repo is listed", async () => {
    db.prepare("UPDATE projects SET github_project_owner = 'evil' WHERE name = 'app'").run();
    await withAllowlist("octo/app", async () => {
      await expect(syncGithub(db, gh, "app", { pauseMs: 0 })).rejects.toThrow(/board of evil/);
      expect(gh.log).toEqual([]);
    });
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
      expect((await call("sync_github", { project: "app" })).isError).toBe(false);
    });
    expect(gh.writes()).toContain("createIssue 200");

    await withAllowlist(`${REPO},octo/public`, async () => {
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
      const forcedOk = await call("set_project", { name: "app", repo: "octo/public", force: true });
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
});
