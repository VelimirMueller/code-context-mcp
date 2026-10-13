/**
 * GitHubGateway over the `gh` CLI (CCA-13). gh holds the token; this module
 * never reads, logs or stores it. Every call is `gh api …` through spawn (no
 * shell); request bodies go over stdin (`--input -`), so no ticket text ever
 * lands on a command line.
 *
 * Read budget per sync: `listMilestones` (1 REST; one more per extra 100
 * milestones) and `readIssues` (1 GraphQL per 50 issues, at least one; the
 * viewer login in each, the Project id + Status field in the first request
 * unless cached). Board writes are aliased mutation batches.
 *
 * Reads fail closed: a partial milestone list is an error, and an issue node
 * whose number, node id or repository does not match the request is returned
 * neither as an issue nor as missing — the engine then leaves it untouched.
 */
import { spawn } from "node:child_process";
import type {
  GitHubGateway,
  IssueFields,
  IssueRead,
  IssuePatch,
  MilestoneFields,
  ProjectMeta,
  RemoteIssue,
  RemoteMilestone,
} from "./github-sync.js";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh <args>` with optional stdin. Injected in tests (fake gh layer). */
export type GhRunner = (args: string[], input?: string) => Promise<GhResult>;

/** The real runner: spawn("gh", args), no shell, 60 s timeout. */
export const ghRunner: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error("gh CLI not found — install it and run `gh auth login`") : e),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

/** Issues per GraphQL read. */
export const READ_BATCH = 50;
/** Milestones per REST page, and the most pages one sync reads (a repo with more is refused, never half-read). */
export const MILESTONE_PAGE = 100;
export const MAX_MILESTONE_PAGES = 10;

const ISSUE_FRAGMENT = `fragment SyncIssue on Issue {
  id number title body state
  author { login }
  repository { nameWithOwner }
  labels(first: 50) { totalCount nodes { name } }
  assignees(first: 20) { nodes { login } }
  milestone { number }
  projectItems(first: 20) { nodes { id project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
}`;

/** A REST milestone, as listMilestones reads it (fields are checked where GitHub may omit them). */
interface RestMilestone {
  number: number;
  node_id?: string | null;
  title: string;
  description?: string | null;
  state: "open" | "closed";
  due_on?: string | null;
  creator?: { login?: string | null } | null;
}

/** The REST response of a created milestone or issue. */
interface RestCreated {
  number: number;
  node_id: string;
}

/** One entry of a GraphQL `errors` array. */
interface GqlError {
  path?: unknown;
  type?: string;
  message?: string;
}

/** A project item node from ISSUE_FRAGMENT. */
interface GqlProjectItem {
  id: string;
  project?: { id?: string | null } | null;
  fieldValueByName?: { name?: string | null } | null;
}

/** An issue node from ISSUE_FRAGMENT. Identity fields are optional: readIssues verifies them. */
interface GqlIssueNode {
  id?: string | null;
  number?: number | null;
  title: string;
  body?: string | null;
  state?: string | null;
  author?: { login?: string | null } | null;
  repository?: { nameWithOwner?: string | null } | null;
  labels?: { totalCount?: number | null; nodes?: Array<{ name: string }> | null } | null;
  assignees?: { nodes?: Array<{ login: string }> | null } | null;
  milestone?: { number: number } | null;
  projectItems?: { nodes?: Array<GqlProjectItem | null> | null } | null;
}

/** `data` of the SyncRead query. */
interface SyncReadData {
  viewer?: { login?: string | null } | null;
  repository?: Record<string, GqlIssueNode | null> | null;
  board?: {
    projectV2?: {
      id: string;
      field?: { id?: string | null; options?: Array<{ id: string; name: string }> | null } | null;
    } | null;
  } | null;
}

/** `data` of the SyncAdd mutation: one `a<k>` alias per content id. */
type SyncAddData = Record<string, { item?: { id?: string | null } | null } | null | undefined>;

function short(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

export class GhGateway implements GitHubGateway {
  /** Calls made, for logs and rate-limit tests. */
  readonly calls = { rest: 0, graphql: 0 };

  constructor(private readonly run: GhRunner = ghRunner) {}

  private async rest<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
    if (body !== undefined) args.push("--input", "-");
    this.calls.rest++;
    const r = await this.run(args, body !== undefined ? JSON.stringify(body) : undefined);
    if (r.code !== 0) throw new Error(`gh api ${method} ${path} failed: ${short(r.stderr || r.stdout)}`);
    return (r.stdout.trim() ? JSON.parse(r.stdout) : null) as T;
  }

  private async graphql<D>(query: string, variables: Record<string, unknown>): Promise<{ data: D; errors: GqlError[] }> {
    this.calls.graphql++;
    const r = await this.run(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
    let parsed: { data?: D | null; errors?: GqlError[] | null } | null = null;
    try {
      parsed = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    } catch {
      /* not JSON */
    }
    if (!parsed || (!parsed.data && r.code !== 0)) throw new Error(`gh api graphql failed: ${short(r.stderr || r.stdout)}`);
    // `{}` stands for "no data": every D reads its fields optionally.
    return { data: parsed.data ?? ({} as D), errors: parsed.errors ?? [] };
  }

  async listMilestones(repo: string): Promise<RemoteMilestone[]> {
    const out: RemoteMilestone[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.rest<RestMilestone[] | null>("GET", `repos/${repo}/milestones?state=all&per_page=${MILESTONE_PAGE}&page=${page}`);
      if (!Array.isArray(rows)) throw new Error(`gh api GET repos/${repo}/milestones returned no list`);
      for (const m of rows) {
        out.push({
          number: m.number,
          nodeId: typeof m.node_id === "string" ? m.node_id : "",
          title: m.title,
          description: m.description ?? null,
          state: m.state,
          due_on: m.due_on ?? null,
          creator: typeof m.creator?.login === "string" ? m.creator.login : null,
        });
      }
      if (rows.length < MILESTONE_PAGE) return out;
      if (page >= MAX_MILESTONE_PAGES) throw new Error(`${repo} has more than ${MAX_MILESTONE_PAGES * MILESTONE_PAGE} milestones — refusing a partial milestone read`);
    }
  }

  async createMilestone(repo: string, f: MilestoneFields): Promise<{ number: number; nodeId: string }> {
    const r = await this.rest<RestCreated>("POST", `repos/${repo}/milestones`, f);
    return { number: r.number, nodeId: r.node_id };
  }

  async updateMilestone(repo: string, number: number, f: Partial<MilestoneFields>): Promise<void> {
    await this.rest("PATCH", `repos/${repo}/milestones/${number}`, f);
  }

  async createIssue(repo: string, f: IssueFields): Promise<{ number: number; nodeId: string }> {
    const body: Record<string, unknown> = { title: f.title, body: f.body, labels: f.labels, assignees: f.assignees };
    if (f.milestone !== null) body.milestone = f.milestone;
    const r = await this.rest<RestCreated>("POST", `repos/${repo}/issues`, body);
    return { number: r.number, nodeId: r.node_id };
  }

  async updateIssue(repo: string, number: number, patch: IssuePatch): Promise<void> {
    await this.rest("PATCH", `repos/${repo}/issues/${number}`, patch);
  }

  async readIssues(
    repo: string,
    project: { owner: string; number: number } | null,
    numbers: number[],
    cachedMeta: ProjectMeta | null,
  ): Promise<IssueRead> {
    const [owner, name] = repo.split("/");
    const issues = new Map<number, RemoteIssue>();
    const missing: number[] = [];
    let meta = cachedMeta;
    let viewer: string | null = null;
    const needMeta = project !== null && cachedMeta === null;
    const chunks: number[][] = [];
    for (let k = 0; k < numbers.length; k += READ_BATCH) chunks.push(numbers.slice(k, k + READ_BATCH));
    // Always one read: the viewer login is part of every ownership decision.
    if (!chunks.length) chunks.push([]);

    for (let c = 0; c < chunks.length; c++) {
      const nums = chunks[c];
      const withMeta = needMeta && c === 0;
      const vars: Record<string, unknown> = {};
      const decl: string[] = [];
      const parts: string[] = ["viewer { login }"];
      if (nums.length) {
        decl.push("$owner: String!", "$name: String!");
        Object.assign(vars, { owner, name });
        parts.push(`repository(owner: $owner, name: $name) {\n${nums.map((n) => `    i${n}: issue(number: ${Number(n)}) { ...SyncIssue }`).join("\n")}\n  }`);
      }
      if (withMeta) {
        decl.push("$powner: String!", "$pnum: Int!");
        Object.assign(vars, { powner: project!.owner, pnum: project!.number });
        parts.push(`board: repositoryOwner(login: $powner) { ... on ProjectV2Owner { projectV2(number: $pnum) { id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`);
      }
      const query = `query SyncRead${decl.length ? `(${decl.join(", ")})` : ""} {\n  ${parts.join("\n  ")}\n}${nums.length ? `\n${ISSUE_FRAGMENT}` : ""}`;
      const { data, errors } = await this.graphql<SyncReadData>(query, vars);
      if (typeof data.viewer?.login === "string" && data.viewer.login) {
        if (viewer !== null && viewer.toLowerCase() !== data.viewer.login.toLowerCase()) throw new Error("GitHub GraphQL returned two different viewer logins in one sync");
        viewer = data.viewer.login;
      }

      const notFound = new Set<string>();
      for (const e of errors) {
        const at = Array.isArray(e.path) ? e.path.join(".") : "";
        if (e.type === "NOT_FOUND" && /^repository\.i\d+$/.test(at)) notFound.add(at.split(".")[1]);
        else throw new Error(`GitHub GraphQL error${at ? ` at ${at}` : ""}: ${short(String(e.message ?? e.type ?? "unknown"))}`);
      }

      if (withMeta) {
        const pv = data.board?.projectV2;
        if (!pv) throw new Error(`GitHub Project ${project!.owner}#${project!.number} not found or not readable by the gh token`);
        if (!pv.field?.id) throw new Error(`GitHub Project ${project!.owner}#${project!.number} has no single-select "Status" field`);
        meta = {
          projectId: pv.id,
          statusFieldId: pv.field.id,
          options: Object.fromEntries((pv.field.options ?? []).map((o) => [o.name, o.id])),
        };
      }
      for (const n of nums) {
        const node = data.repository?.[`i${n}`];
        if (notFound.has(`i${n}`) || node === null) {
          missing.push(n);
          continue;
        }
        // Not returned, or not the issue asked for (a pull request, another
        // repo after a transfer, no node id): unverified — neither issue nor missing.
        if (!node || typeof node.id !== "string" || !node.id || node.number !== n) continue;
        if (String(node.repository?.nameWithOwner ?? "").toLowerCase() !== repo.toLowerCase()) continue;
        const labelNodes = node.labels?.nodes ?? [];
        const item = meta ? (node.projectItems?.nodes ?? []).find((it) => it?.project?.id === meta!.projectId) : undefined;
        issues.set(n, {
          number: node.number,
          nodeId: node.id,
          title: node.title,
          body: node.body ?? "",
          state: String(node.state).toLowerCase() === "closed" ? "closed" : "open",
          labels: labelNodes.map((l) => l.name),
          labelsTruncated: typeof node.labels?.totalCount === "number" ? node.labels.totalCount > labelNodes.length : false,
          assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
          milestone: node.milestone?.number ?? null,
          item: item ? { id: item.id, status: item.fieldValueByName?.name ?? null } : null,
          author: typeof node.author?.login === "string" ? node.author.login : null,
        });
      }
    }
    return { meta, issues, missing, viewer };
  }

  async addToProject(projectId: string, contentIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!contentIds.length) return out;
    const vars: Record<string, unknown> = { p: projectId };
    const decl = ["$p: ID!"];
    const parts = contentIds.map((id, k) => {
      vars[`c${k}`] = id;
      decl.push(`$c${k}: ID!`);
      return `a${k}: addProjectV2ItemById(input: { projectId: $p, contentId: $c${k} }) { item { id } }`;
    });
    const { data, errors } = await this.graphql<SyncAddData>(`mutation SyncAdd(${decl.join(", ")}) {\n  ${parts.join("\n  ")}\n}`, vars);
    if (errors.length) throw new Error(`addProjectV2ItemById failed: ${short(String(errors[0].message ?? errors[0].type))}`);
    contentIds.forEach((id, k) => {
      const itemId = data[`a${k}`]?.item?.id;
      if (itemId) out.set(id, itemId);
    });
    return out;
  }

  async setStatus(projectId: string, fieldId: string, items: Array<{ itemId: string; optionId: string }>): Promise<void> {
    if (!items.length) return;
    const vars: Record<string, unknown> = { p: projectId, f: fieldId };
    const decl = ["$p: ID!", "$f: ID!"];
    const parts = items.map((it, k) => {
      vars[`i${k}`] = it.itemId;
      vars[`o${k}`] = it.optionId;
      decl.push(`$i${k}: ID!`, `$o${k}: String!`);
      return `s${k}: updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i${k}, fieldId: $f, value: { singleSelectOptionId: $o${k} } }) { projectV2Item { id } }`;
    });
    const { errors } = await this.graphql<unknown>(`mutation SyncStatus(${decl.join(", ")}) {\n  ${parts.join("\n  ")}\n}`, vars);
    if (errors.length) throw new Error(`updateProjectV2ItemFieldValue failed: ${short(String(errors[0].message ?? errors[0].type))}`);
  }
}
