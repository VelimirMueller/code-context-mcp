import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log as slog } from "../../sessionlog.js";
import { GhGateway } from "../github-gateway.js";
import {
  boardOwnerOf,
  getProject,
  listProjectNames,
  liveSyncRefusal,
  projectHasSynced,
  syncAuth,
  syncGithub,
  syncTargetOf,
  SYNC_ALLOWLIST_ENV,
  type GitHubGateway,
  type ProjectRow,
  type SyncAuth,
} from "../github-sync.js";

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function formatProject(p: ProjectRow): string {
  const board = p.github_project_number !== null ? `${p.github_project_owner || p.repo?.split("/")[0] || "?"}/projects/${p.github_project_number}` : "—";
  return `${p.name}: repo ${p.repo ?? "—"}, board ${board}, assignee ${p.github_assignee || p.repo?.split("/")[0] || "—"}`;
}

export interface UpsertOptions {
  /** Re-point a project that already synced. Honoured only when the new
   *  target (exact repo, exact board, assignee) passes the live-sync check. */
  force?: boolean;
  /** Authorization override for code callers (tests). Default: syncAuth(process.env). */
  auth?: SyncAuth;
  /** false skips the re-point rule (the CLI dry run, which edits an in-memory copy). */
  guard?: boolean;
}

/**
 * Upsert a project row. Returns an error string or the stored row.
 *
 * Re-point rule: once a project has synced (a ticket holds github_issue or a
 * milestone holds github_milestone), changing its repo, board number or board
 * owner is refused — the stored numbers belong to the old target, and a
 * re-point would send the project's ticket text somewhere else. `force` lifts
 * this only when the NEW target passes the live-sync check: its exact
 * `owner/repo` (and `owner/repo@board-owner/N` with a board) is in the env
 * allowlist, which no tool can set. The assignee may change freely here; every
 * live sync still refuses an assignee that is not allowed.
 */
export function upsertProject(
  db: Database.Database,
  a: { name: string; repo?: string; github_project_number?: number | null; github_project_owner?: string | null; github_assignee?: string | null },
  opts: UpsertOptions = {},
): string | ProjectRow {
  if (!a.name.trim()) return "name must not be empty";
  if (a.repo !== undefined && !REPO_RE.test(a.repo)) return `repo must look like owner/name, got "${a.repo}"`;
  for (const k of ["github_project_owner", "github_assignee"] as const) {
    const v = a[k];
    if (v !== undefined && v !== null && !LOGIN_RE.test(v)) return `${k} must be a GitHub login, got "${v}"`;
  }
  const existing = getProject(db, a.name);
  if (existing && opts.guard !== false) {
    const next = {
      repo: a.repo ?? existing.repo,
      github_project_number: a.github_project_number !== undefined ? a.github_project_number : existing.github_project_number,
      github_project_owner: a.github_project_owner !== undefined ? a.github_project_owner : existing.github_project_owner,
    };
    const lc = (v: string | null) => (v ?? "").toLowerCase();
    const moves =
      lc(next.repo) !== lc(existing.repo) ||
      next.github_project_number !== existing.github_project_number ||
      lc(boardOwnerOf(next)) !== lc(boardOwnerOf(existing));
    if (moves && projectHasSynced(db, a.name)) {
      if (!opts.force) {
        return `project "${a.name}" already synced to ${existing.repo ?? "GitHub"} (stored issue/milestone numbers); changing its repo or board is refused. Pass force=true to re-point it — honoured only when the new target is in ${SYNC_ALLOWLIST_ENV} (owner/repo, or owner/repo@board-owner/N with a board).`;
      }
      // Repo + board only: the assignee is not part of the re-point and is
      // checked by every live sync.
      const refusal = next.repo ? liveSyncRefusal(syncTargetOf({ ...next, github_assignee: null }), opts.auth ?? syncAuth()) : null;
      if (refusal) return `force refused: ${refusal}`;
    }
  }
  if (!existing) {
    db.prepare(
      "INSERT INTO projects (name, repo, github_project_number, github_project_owner, github_assignee) VALUES (?, ?, ?, ?, ?)",
    ).run(a.name, a.repo ?? null, a.github_project_number ?? null, a.github_project_owner ?? null, a.github_assignee ?? null);
  } else {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of ["repo", "github_project_number", "github_project_owner", "github_assignee"] as const) {
      if (a[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(a[k]);
      }
    }
    // A new repo or board invalidates the cached Project ids.
    if (a.repo !== undefined || a.github_project_number !== undefined || a.github_project_owner !== undefined) {
      sets.push("github_project_id = NULL", "github_status_field_id = NULL", "github_status_options = NULL");
    }
    if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...vals, existing.id);
  }
  return getProject(db, a.name)!;
}

/**
 * Project registry + one-way GitHub sync (CCA-13). `gateway` is injectable for
 * tests; production uses the gh CLI.
 */
export function registerGithubTools(server: McpServer, db: Database.Database, gateway: () => GitHubGateway = () => new GhGateway()): void {
  server.tool(
    "set_project",
    "Create or update a project key: maps a short name to a GitHub repo (owner/name), an optional GitHub Project board number and the issue assignee. Milestones, sprints, epics and tickets take this name in their `project` field. A project that already synced keeps its repo/board unless force=true and the new target is allowlisted. A live sync needs the exact repo (and repo@board-owner/N for a board) in the server env CODE_CONTEXT_GITHUB_SYNC_REPOS, and an assignee that is the repo owner or listed in CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES.",
    {
      name: z.string().describe("Project key, e.g. 'code-context-mcp'"),
      repo: z.string().optional().describe("GitHub repo owner/name"),
      github_project_number: z.number().int().nullable().optional().describe("GitHub Project (v2) number, null to unset"),
      github_project_owner: z.string().nullable().optional().describe("Board owner login (default: repo owner)"),
      github_assignee: z.string().nullable().optional().describe("Issue assignee login (default: repo owner)"),
      force: z.boolean().optional().describe("Re-point a project that already synced; honoured only when the new repo/board is allowlisted in the server env"),
    },
    async ({ force, ...args }) => {
      const r = upsertProject(db, args, { force });
      if (typeof r === "string") return { content: [{ type: "text" as const, text: `Error: ${r}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Project ${formatProject(r)}` }] };
    },
  );

  server.tool(
    "sync_github",
    "One-way sync of ONE project's milestones and tickets to its GitHub repo and Project board: creates/updates the milestone and issues (title '<ref>: <title>', Why/Done when body, priority/type/origin labels, owner assignee), sets the board Status from the ticket status and closes DONE issues. Idempotent via the stored issue number; never touches other projects. Updates only issues/milestones whose GitHub text carries this sync's hidden marker (project + ticket); others are skipped. adopt=[N…] takes over unmarked issues linked by a ticket whose GitHub title starts with '<ticket_ref>:'; adopt_milestones maps a local milestone to a GitHub number. dry_run=true prints the plan (offline=true: no GitHub read at all). A live run needs the exact target in the server env CODE_CONTEXT_GITHUB_SYNC_REPOS (owner/repo; owner/repo@board-owner/N for a board) and an assignee that is the repo owner or in CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES (no tool sets either). Texts holding a secret or a local path are refused.",
    {
      project: z.string().describe("Project key (see set_project)"),
      dry_run: z.boolean().optional().describe("Print the plan, write nothing"),
      offline: z.boolean().optional().describe("With dry_run: plan from the local db only, no GitHub read"),
      max_writes: z.number().int().positive().optional().describe("Refuse when the plan needs more writes (default 100)"),
      adopt: z
        .array(z.number().int().positive())
        .max(500)
        .optional()
        .describe("Issue numbers to take over although they carry no sync marker. Each must be linked by one ticket of the project (github_issue) and its GitHub title must start with '<ticket_ref>:'. Live runs need the allowlist; dry runs only plan it."),
      adopt_milestones: z
        .array(z.object({ milestone_id: z.number().int().positive(), github_milestone: z.number().int().positive() }))
        .max(100)
        .optional()
        .describe("Explicit mapping local milestone id → GitHub milestone number, to take over an unmarked milestone. A title match never links."),
    },
    async ({ project, dry_run, offline, max_writes, adopt, adopt_milestones }) => {
      if (!getProject(db, project)) {
        const known = listProjectNames(db);
        return { content: [{ type: "text" as const, text: `Unknown project "${project}".${known.length ? ` Known: ${known.join(", ")}.` : " Register it with set_project."}` }], isError: true };
      }
      try {
        const r = await syncGithub(db, gateway(), project, {
          dryRun: dry_run,
          offline,
          maxWrites: max_writes,
          adopt: { issues: adopt, milestones: adopt_milestones?.map((m) => ({ id: m.milestone_id, number: m.github_milestone })) },
        });
        slog(r.error ? "WARN" : "INFO", `sync_github: project=${project} dry_run=${!!dry_run} issues=${r.plan.issues.length} writes=${r.writes}${r.error ? " failed" : ""}`);
        return { content: [{ type: "text" as const, text: r.text }], isError: r.error !== null };
      } catch (e: any) {
        slog("WARN", `sync_github: project=${project} error=${e?.name ?? "Error"}`);
        return { content: [{ type: "text" as const, text: `Error: ${e?.message ?? String(e)}` }], isError: true };
      }
    },
  );
}
