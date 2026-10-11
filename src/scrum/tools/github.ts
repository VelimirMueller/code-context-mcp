import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log as slog } from "../../sessionlog.js";
import { GhGateway } from "../github-gateway.js";
import { getProject, listProjectNames, syncGithub, type GitHubGateway, type ProjectRow } from "../github-sync.js";

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function formatProject(p: ProjectRow): string {
  const board = p.github_project_number !== null ? `${p.github_project_owner || p.repo?.split("/")[0] || "?"}/projects/${p.github_project_number}` : "—";
  return `${p.name}: repo ${p.repo ?? "—"}, board ${board}, assignee ${p.github_assignee || p.repo?.split("/")[0] || "—"}`;
}

/** Upsert a project row. Returns an error string or the stored row. */
export function upsertProject(
  db: Database.Database,
  a: { name: string; repo?: string; github_project_number?: number | null; github_project_owner?: string | null; github_assignee?: string | null },
): string | ProjectRow {
  if (!a.name.trim()) return "name must not be empty";
  if (a.repo !== undefined && !REPO_RE.test(a.repo)) return `repo must look like owner/name, got "${a.repo}"`;
  for (const k of ["github_project_owner", "github_assignee"] as const) {
    const v = a[k];
    if (v !== undefined && v !== null && !LOGIN_RE.test(v)) return `${k} must be a GitHub login, got "${v}"`;
  }
  const existing = getProject(db, a.name);
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
    "Create or update a project key: maps a short name to a GitHub repo (owner/name), an optional GitHub Project board number and the issue assignee. Milestones, sprints, epics and tickets take this name in their `project` field.",
    {
      name: z.string().describe("Project key, e.g. 'code-context-mcp'"),
      repo: z.string().optional().describe("GitHub repo owner/name"),
      github_project_number: z.number().int().nullable().optional().describe("GitHub Project (v2) number, null to unset"),
      github_project_owner: z.string().nullable().optional().describe("Board owner login (default: repo owner)"),
      github_assignee: z.string().nullable().optional().describe("Issue assignee login (default: repo owner)"),
    },
    async (args) => {
      const r = upsertProject(db, args);
      if (typeof r === "string") return { content: [{ type: "text" as const, text: `Error: ${r}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Project ${formatProject(r)}` }] };
    },
  );

  server.tool(
    "sync_github",
    "One-way sync of ONE project's milestones and tickets to its GitHub repo and Project board: creates/updates the milestone and issues (title '<ref>: <title>', Why/Done when body, priority/type/origin labels, owner assignee), sets the board Status from the ticket status and closes DONE issues. Idempotent via the stored issue number; never touches other projects. dry_run=true prints the plan (offline=true: no GitHub read at all).",
    {
      project: z.string().describe("Project key (see set_project)"),
      dry_run: z.boolean().optional().describe("Print the plan, write nothing"),
      offline: z.boolean().optional().describe("With dry_run: plan from the local db only, no GitHub read"),
      max_writes: z.number().int().positive().optional().describe("Refuse when the plan needs more writes (default 100)"),
    },
    async ({ project, dry_run, offline, max_writes }) => {
      if (!getProject(db, project)) {
        const known = listProjectNames(db);
        return { content: [{ type: "text" as const, text: `Unknown project "${project}".${known.length ? ` Known: ${known.join(", ")}.` : " Register it with set_project."}` }], isError: true };
      }
      try {
        const r = await syncGithub(db, gateway(), project, { dryRun: dry_run, offline, maxWrites: max_writes });
        slog(r.error ? "WARN" : "INFO", `sync_github: project=${project} dry_run=${!!dry_run} issues=${r.plan.issues.length} writes=${r.writes}${r.error ? " failed" : ""}`);
        return { content: [{ type: "text" as const, text: r.text }], isError: r.error !== null };
      } catch (e: any) {
        slog("WARN", `sync_github: project=${project} error=${e?.name ?? "Error"}`);
        return { content: [{ type: "text" as const, text: `Error: ${e?.message ?? String(e)}` }], isError: true };
      }
    },
  );
}
