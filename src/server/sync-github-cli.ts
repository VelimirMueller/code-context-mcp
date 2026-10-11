#!/usr/bin/env node
// code-context-sync-github — one-way sync of ONE project to GitHub (CCA-13).
//
//   code-context-sync-github --project <name> [--db <file>] [--dry-run [--offline]]
//       [--repo owner/name] [--project-number N] [--project-owner login] [--assignee login]
//       [--milestone <id>[=<github number>]]... [--max-writes N] [--force]
//
// A live run writes only to the exact targets listed in
// CODE_CONTEXT_GITHUB_SYNC_REPOS in this process's env (comma-separated
// `owner/repo`, or `owner/repo@board-owner/N` to also write that Project
// board), and assigns only the repo owner or a login in
// CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES. --repo / --project-number / --assignee
// never authorize a write. --force re-points a project that already synced,
// and only to an allowlisted target. A refused live run leaves the db unchanged.
//
// --dry-run works on an in-memory copy of the db: the file is opened read-only,
// never migrated and never written, so it is safe against a db that an older
// code-context server still uses. The setup flags (--repo … --milestone) apply
// to that copy only in a dry run, and to the db itself in a live run.
// --offline (with --dry-run) makes no GitHub call at all.
// Exit 0 ok, 1 sync failed, 2 bad usage.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import { initScrumSchema, runMigrations, peekSchemaVersion, LATEST_SCHEMA_VERSION } from "../scrum/schema.js";
import { syncGithub, getProject, liveSyncRefusal, syncAuth, syncTargetOf, type GitHubGateway } from "../scrum/github-sync.js";
import { GhGateway } from "../scrum/github-gateway.js";
import { upsertProject } from "../scrum/tools/github.js";
import { log as slog } from "../sessionlog.js";

export const USAGE =
  "usage: code-context-sync-github --project <name> [--db <file>] [--dry-run [--offline]] [--repo owner/name] [--project-number N] [--project-owner login] [--assignee login] [--milestone <id>[=<gh number>]]... [--max-writes N] [--force]\n\nA live run needs the exact target in CODE_CONTEXT_GITHUB_SYNC_REPOS=owner/repo[@board-owner/N][,…] (a board needs the @board-owner/N form)\nand an assignee that is the repo owner or in CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES=login[,login…].";

export interface Args {
  db: string;
  project: string;
  dryRun: boolean;
  offline: boolean;
  repo?: string;
  projectNumber?: number;
  projectOwner?: string;
  assignee?: string;
  milestones: Array<{ id: number; github: number | null }>;
  maxWrites?: number;
  force?: boolean;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { db: process.env.CODE_CONTEXT_DB || "./context.db", project: "", dryRun: false, offline: false, milestones: [] };
  const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : NaN);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    if (arg === "-h" || arg === "--help") return "help";
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--offline") a.offline = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--db") {
      const v = next();
      if (!v) return "--db needs a file";
      a.db = expandHome(v);
    } else if (arg === "--project") {
      const v = next();
      if (!v) return "--project needs a name";
      a.project = v;
    } else if (arg === "--repo") {
      const v = next();
      if (!v) return "--repo needs owner/name";
      a.repo = v;
    } else if (arg === "--project-number") {
      const n = int(next());
      if (Number.isNaN(n)) return "--project-number needs a number";
      a.projectNumber = n;
    } else if (arg === "--project-owner") {
      const v = next();
      if (!v) return "--project-owner needs a login";
      a.projectOwner = v;
    } else if (arg === "--assignee") {
      const v = next();
      if (!v) return "--assignee needs a login";
      a.assignee = v;
    } else if (arg === "--max-writes") {
      const n = int(next());
      if (Number.isNaN(n) || n < 1) return "--max-writes needs a positive number";
      a.maxWrites = n;
    } else if (arg === "--milestone") {
      const m = /^(\d+)(?:=(\d+))?$/.exec(next() ?? "");
      if (!m) return "--milestone needs <id> or <id>=<github number>";
      a.milestones.push({ id: Number(m[1]), github: m[2] ? Number(m[2]) : null });
    } else return `unknown option ${arg}`;
  }
  if (!a.project) return "--project is required";
  if (a.offline && !a.dryRun) return "--offline needs --dry-run";
  a.db = path.resolve(a.db);
  return a;
}

/** Read-only snapshot of the db file into memory (WAL content included). */
export function snapshotDb(file: string): Database.Database {
  const src = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const buf = src.serialize();
    // Header bytes 18/19 = 2 mark WAL mode; an in-memory copy must be rollback mode.
    buf[18] = 1;
    buf[19] = 1;
    return new Database(buf);
  } finally {
    src.close();
  }
}

/** Apply the setup flags (project row + milestone links) to db. Returns an error or null.
 *  A dry run edits an in-memory copy, so the re-point rule does not apply there. */
export function applySetup(db: Database.Database, a: Args): string | null {
  if (a.repo !== undefined || a.projectNumber !== undefined || a.projectOwner !== undefined || a.assignee !== undefined || !getProject(db, a.project)) {
    if (!getProject(db, a.project) && a.repo === undefined) return `project "${a.project}" is not registered — pass --repo owner/name`;
    const r = upsertProject(db, {
      name: a.project,
      repo: a.repo,
      github_project_number: a.projectNumber,
      github_project_owner: a.projectOwner,
      github_assignee: a.assignee,
    }, { force: a.force, guard: !a.dryRun });
    if (typeof r === "string") return r;
  }
  for (const m of a.milestones) {
    const res = db
      .prepare(`UPDATE milestones SET project = ?${m.github !== null ? ", github_milestone = ?" : ""}, updated_at = datetime('now') WHERE id = ?`)
      .run(...(m.github !== null ? [a.project, m.github, m.id] : [a.project, m.id]));
    if (res.changes === 0) return `milestone ${m.id} not found`;
  }
  return null;
}

export async function run(a: Args, gateway: GitHubGateway = new GhGateway(), out: (s: string) => void = console.log): Promise<number> {
  if (!fs.existsSync(a.db)) {
    out(`code-context-sync-github: db not found: ${a.db}`);
    return 2;
  }
  const stamped = peekSchemaVersion(a.db);
  if (stamped > LATEST_SCHEMA_VERSION) {
    out(`code-context-sync-github: db is at schema v${stamped}, this version knows v${LATEST_SCHEMA_VERSION} — update the package`);
    return 2;
  }
  const db = a.dryRun ? snapshotDb(a.db) : new Database(a.db);
  try {
    if (!a.dryRun) {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 15000");
      if (stamped < LATEST_SCHEMA_VERSION) out(`[schema] migrating ${path.basename(a.db)} v${stamped} → v${LATEST_SCHEMA_VERSION}`);
    }
    db.pragma("foreign_keys = ON");
    // Scrum schema only: the db already exists (checked above), so the code-index
    // tables are there and stay untouched.
    initScrumSchema(db);
    runMigrations(db);
    // Setup + the live-sync permission check in one transaction: a refused
    // live run leaves the db as it was.
    db.exec("BEGIN");
    let err = applySetup(db, a);
    if (!err && !a.dryRun) {
      const p = getProject(db, a.project);
      if (p?.repo) err = liveSyncRefusal(syncTargetOf(p), syncAuth());
    }
    if (err) {
      db.exec("ROLLBACK");
      out(`code-context-sync-github: ${err}`);
      return 2;
    }
    db.exec("COMMIT");
    const r = await syncGithub(db, gateway, a.project, { dryRun: a.dryRun, offline: a.offline, maxWrites: a.maxWrites });
    out(r.text);
    if (a.dryRun) out("\n(dry run on an in-memory copy — the db file was not changed)");
    slog(r.error ? "WARN" : "INFO", `sync-github: project=${a.project} dry_run=${a.dryRun} issues=${r.plan.issues.length} writes=${r.writes}${r.error ? " failed" : ""}`);
    return r.error ? 1 : 0;
  } catch (e: any) {
    out(`code-context-sync-github: ${e?.message ?? String(e)}`);
    slog("WARN", `sync-github: failed error=${e?.name ?? "Error"}`);
    return 1;
  } finally {
    db.close();
  }
}

// Run only as a program, never on import (tests import parseArgs/run).
let invoked = "";
try {
  invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
} catch {
  /* not a real path */
}
if (invoked.endsWith(`${path.sep}sync-github-cli.js`) || invoked.endsWith(`${path.sep}sync-github-cli.ts`)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    if (parsed === "help") console.log(USAGE);
    else console.error(`code-context-sync-github: ${parsed}\n${USAGE}`);
    process.exitCode = parsed === "help" ? 0 : 2;
  } else {
    run(parsed).then((code) => (process.exitCode = code));
  }
}
