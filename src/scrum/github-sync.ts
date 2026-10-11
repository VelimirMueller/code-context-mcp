/**
 * One-way sync of one project's milestones and tickets to a GitHub repo and a
 * GitHub Project (v2) board (CCA-13, #128).
 *
 * - Scope: exactly one project. A ticket belongs to project P when its own
 *   `project` is P, or, with no own project, when every project it inherits
 *   (sprint, milestone, epic, and their milestones) is P. Tickets of other
 *   projects and ambiguous tickets are never touched.
 * - Idempotent through `tickets.github_issue` and `milestones.github_milestone`:
 *   a stored number is updated, never re-created. A second run with no local
 *   change makes no write.
 * - Ownership (CCA-14, #142): created issues / milestones carry a hidden
 *   `<!-- code-context-sync: … -->` marker; a stored number is updated only
 *   when the remote text carries the marker of the same project and ticket
 *   (or local milestone). Unmarked objects need an explicit adopt.
 * - Rate limits: one REST read of the repo milestones (only when the project
 *   has milestones) and one GraphQL read per 50 tracked issues that returns the
 *   issues, their Project items and the Status field. Writes: one REST call per
 *   changed milestone/issue, Project adds and Status changes batched as aliased
 *   GraphQL mutations (20 per request). Content-creating calls are paced.
 * - Secret hygiene: no token is read or stored (gh holds it); every text that
 *   leaves the machine is refused when it holds a secret (API keys, tokens,
 *   JWTs, private keys, credentials — raw or encoded), and scrubbed of local
 *   absolute paths, refused when a path survives (assertPublishable, which
 *   normalizes encodings on its own and does not trust the scrubber).
 * - Authorization: a live (non-dry-run) sync writes only to the exact targets
 *   listed in CODE_CONTEXT_GITHUB_SYNC_REPOS (`owner/repo`, or
 *   `owner/repo@board-owner/N` to also write that one board) and assigns only
 *   the repo owner or a login in CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES. Both are
 *   set in the process env, never by a tool.
 */
import type Database from "better-sqlite3";

export const TYPE_LABELS = ["feat", "fix", "chore", "infra", "improvement"] as const;
export type IssueType = (typeof TYPE_LABELS)[number];
export const PRIORITY_LABELS = ["P0", "P1", "P2"] as const;
export const ORIGIN_LABELS = { ai: "ai_issue", human: "issue" } as const;
export const STATUS_NAMES = ["Backlog", "Ready", "In progress", "In review", "Done"] as const;

/** Project adds / Status changes per GraphQL mutation request. */
export const MUTATION_BATCH = 20;
/** Default cap on planned writes per sync run; a bigger plan is refused. */
export const DEFAULT_MAX_WRITES = 100;

// ─── Path scrubbing + publish guard ──────────────────────────────────────────
//
// Two independent layers. The scrubber rewrites path-like tokens so normal text
// still publishes; the guard re-checks the final text on its own, after
// normalizing every encoding GitHub would still render as a path. A form the
// scrubber misses is refused by the guard — never published raw.

/** Local roots, matched on normalized text (`/` separators, decoded). */
const LOCAL_ROOT_RE =
  /(?:\/(?:Users|home|root|Volumes|tmp)\/|\/var\/folders\/|\/private\/(?:var|tmp)(?![\w.-])|[a-z]:\/(?:Users|Documents and Settings)\/)/gi;
/** Roots whose next segment is a user name (never kept as the "last segment"). */
const USER_ROOT_RE = /(?:\/(?:Users|home)\/|[a-z]:\/(?:Users|Documents and Settings)\/)$/i;
const FILE_URL_RE = /\bfile:\//i;
/**
 * Characters that end a token, shared by the scrubber (SCRUB_TOKEN_RE) and the
 * guard (findLocalRoot's URL-context check). One set, so the two can never
 * disagree on where a token starts: a root the scrubber sees as its own token
 * is never treated by the guard as part of an http(s) URL in front of it.
 */
const TOKEN_DELIMS = "\\s`'\"<>()[\\]{}|,*";
const GUARD_DELIM = new RegExp(`[${TOKEN_DELIMS}]`);
/** Tokens the scrubber rewrites: runs without delimiter characters. */
const SCRUB_TOKEN_RE = new RegExp(`[^${TOKEN_DELIMS}]+`, "g");
/** Windows "Documents and Settings" holds spaces; join it so it stays one token. */
const DOCS_AND_SETTINGS_RE = /(?<=[\\/;]|%2f|%5c)Documents and Settings(?=[\\/&%])/gi;
const TRAILING_PUNCT = /[.,:;!?]+$/;

const NAMED_ENTITIES: Record<string, string> = { sol: "/", bsol: "\\", colon: ":", amp: "&", period: ".", tilde: "~", lowbar: "_", hyphen: "-", dash: "-" };

function decodeOnce(s: string): string {
  return s
    .replace(/&#(\d{1,7});?/g, (m, d) => safeChar(Number(d), m))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/%([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{?([0-9a-f]{4})\}?/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/\\x([0-9a-f]{2})/gi, (m, h) => safeChar(parseInt(h, 16), m));
}

function safeChar(cp: number, fallback: string): string {
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

/**
 * The text as GitHub could render it, for path detection only (never sent):
 * invisible characters dropped, NFKC, percent / HTML entity / `\u` / `\x`
 * escapes decoded (repeated for double encoding), `\` → `/`, and repeated
 * slashes collapsed except right after a scheme colon.
 */
export function normalizeForGuard(text: string): string {
  return decodeAll(text).replace(/\\/g, "/").replace(/(?<!:)\/{2,}/g, "/");
}

/** Invisible / format characters a renderer drops (soft hyphen, zero-width,
 *  bidi controls, word joiners, BOM, variation selectors, Hangul fillers). */
const INVISIBLE_RE =
  /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0]|\u034F|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u180F|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F/g;

/** Invisible characters dropped, NFKC, every escape decoded (up to 4 layers). */
function decodeAll(text: string): string {
  let s = text;
  for (let i = 0; i < 4; i++) {
    const next = decodeOnce(s.replace(INVISIBLE_RE, "").normalize("NFKC"));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** True when `pre` (token text right before a root) is `http(s)://host[/…]`. */
function insideHttpUrl(pre: string): boolean {
  return /(?:^|[^a-z0-9+.-])https?:\/\/[^/]+(?:\/.*)?$/i.test(pre);
}

/** First local root (or `file:/` URL) in normalized text that is not part of
 *  an http(s) URL path: its span, or null. */
function findLocalRoot(n: string): { index: number; end: number; userDir: boolean } | null {
  const re = new RegExp(LOCAL_ROOT_RE.source, "gi");
  for (let m = re.exec(n); m; m = re.exec(n)) {
    let start = m.index;
    while (start > 0 && !GUARD_DELIM.test(n[start - 1])) start--;
    if (!insideHttpUrl(n.slice(start, m.index))) return { index: m.index, end: m.index + m[0].length, userDir: USER_ROOT_RE.test(m[0]) };
  }
  const f = FILE_URL_RE.exec(n);
  return f ? { index: f.index, end: f.index + f[0].length, userDir: false } : null;
}

/** True when text, in any encoding GitHub would render, holds a local absolute path. */
export function hasLocalPath(text: string): boolean {
  return findLocalRoot(normalizeForGuard(text)) !== null;
}

/** Replace every local absolute path (any encoding, file:// URLs included) with
 *  `…/<last segment>`; a bare user directory (`/Users/<name>`) becomes `…`.
 *  http(s) URLs stay. */
export function scrubLocalPaths(text: string): string {
  return text.replace(DOCS_AND_SETTINGS_RE, "Documents_and_Settings").replace(SCRUB_TOKEN_RE, (raw) => scrubToken(raw.replace(/Documents_and_Settings/g, "Documents and Settings")));
}

/** One token: unchanged without a local root; `k=v` pairs scrubbed per part
 *  (keeps `path=` and URL queries readable); otherwise the whole token goes. */
function scrubToken(tok: string): string {
  const n = normalizeForGuard(tok);
  const root = findLocalRoot(n);
  if (!root) return tok;
  if (tok.includes("=")) {
    const joined = tok.split("=").map(scrubToken).join("=");
    if (!hasLocalPath(joined)) return joined;
  }
  const suffix = TRAILING_PUNCT.exec(tok)?.[0] ?? "";
  const body = n.replace(TRAILING_PUNCT, "");
  const rest = body.slice(root.end).split("/").filter(Boolean);
  // The segment right after a user root is the user name — that is the leak.
  if (!rest.length || (root.userDir && rest.length === 1)) return `…${suffix}`;
  return `…/${rest[rest.length - 1]}${suffix}`;
}

// ─── Secret detection ────────────────────────────────────────────────────────
//
// Secrets are never scrubbed: a text that holds one is refused, and the error
// names the field and the secret type, never the value. The check runs on the
// raw text, on the decoded copy (entities, percent, `\u`/`\x` escapes,
// invisible characters removed) and on that copy without markdown emphasis
// and code-span marks, so no encoding or formatting hides a secret.

/** A value that looks like key material, not a word, a number or a placeholder. */
function keyLike(v: string, min: number): boolean {
  if (v.length < min) return false;
  if (/^\d+$/.test(v)) return false; // counts, ids, timestamps
  if (/^[a-z]+(?:[-_./][a-z]+)*$/.test(v)) return false; // lower-case words: "see-the-vault-entry"
  if (/^[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,5}$/i.test(v)) return false; // repo file path: src/auth/token.ts
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(v) && /_/.test(v)) return false; // ENV_VAR_NAME reference
  if (/^(?:x+|\*+|\.+|_+|-+|0+)$/i.test(v)) return false;
  if (/^(?:changeme|redacted|placeholder|example|dummy|your[-_]|<|\$\{?)/i.test(v)) return false;
  return true;
}

interface SecretDetector {
  type: string;
  re: RegExp;
  /** Extra check on the match (group 1 when present, else the whole match). */
  ok?: (value: string) => boolean;
}

const KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|api[_-]?key)[A-Za-z0-9_.-]*`;

export const SECRET_DETECTORS: readonly SecretDetector[] = [
  { type: "GitHub token", re: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { type: "Anthropic API key", re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/ },
  // `sk-` must start a word: `dsk-20261011-090622` and `task-…` pass.
  { type: "OpenAI API key", re: /(?<![A-Za-z0-9_-])sk-(?!ant-)((?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})/, ok: (v) => /\d/.test(v) && /[A-Za-z]/.test(v) },
  { type: "AWS access key id", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/ },
  { type: "AWS secret access key", re: /aws.{0,20}?(?:secret|sk).{0,20}?["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i },
  { type: "Slack token", re: /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { type: "Slack webhook URL", re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{8,}/ },
  { type: "Google API key", re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/ },
  { type: "Stripe key", re: /(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { type: "JWT", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { type: "private key block", re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/ },
  { type: "Authorization header", re: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{16,}=*)/i, ok: (v) => keyLike(v, 16) },
  { type: "credentials in URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/i, ok: (v) => !/^(?:\*+|x+|\.+|<.*>|\$\{?.*)$/i.test(v) },
  // UPPER_CASE env names anywhere in a line (not only at its start): a lower bar (8 chars).
  { type: ".env secret", re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*[ \t]*=[ \t]*["']?([^\s"'#`*|{}(),<>[\]]+)/, ok: (v) => keyLike(v, 8) },
  {
    type: "secret assignment",
    re: new RegExp(String.raw`(?<![A-Za-z0-9])${KEY_NAME}["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-+/=.~]{16,})`, "i"),
    ok: (v) => keyLike(v, 16),
  },
];

/** The secret type found in text (raw, decoded, or decoded without markdown marks), or null. */
export function findSecret(text: string): string | null {
  const decoded = decodeAll(text);
  const variants = [text, decoded, decoded.replace(/[`*]/g, "")];
  for (const d of SECRET_DETECTORS) {
    for (const v of variants) {
      const re = new RegExp(d.re.source, d.re.flags.includes("g") ? d.re.flags : `${d.re.flags}g`);
      for (let m = re.exec(v); m; m = re.exec(v)) {
        if (!d.ok || d.ok(m[1] ?? m[0])) return d.type;
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return null;
}

/** Throws (naming the field and the secret type, never the value) when text holds a secret. */
export function assertNoSecret(text: string, what: string): void {
  const type = findSecret(text);
  if (type) throw new Error(`${what} holds a secret (${type}) — refusing to publish; remove it from the local text`);
}

/** Throws when text holds a secret, or still holds a local absolute path (in
 *  any encoding GitHub renders). Independent of the scrubber. Call on every
 *  string sent to GitHub, after scrubbing. */
export function assertPublishable(text: string, what: string): void {
  assertNoSecret(text, what);
  if (hasLocalPath(text)) throw new Error(`${what} holds a local absolute path — refusing to publish`);
}

/** Secret check on the input (the scrubber must never hide a secret), scrub, then guard. */
export function publishable(text: string, what: string): string {
  assertNoSecret(text, what);
  const out = scrubLocalPaths(text);
  assertPublishable(out, what);
  return out;
}

// ─── Live-sync authorization ─────────────────────────────────────────────────
//
// Any MCP client can call set_project and sync_github, and an agent can be
// steered by prompt-injected content. So a live sync writes only to repos the
// user allowed OUTSIDE the MCP channel: the env of the server / CLI process.
// No tool can set it. Each entry pins exact targets: a repo, and optionally the
// one Project board of it. The assignee is pinned too (repo owner, or a login
// in CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES). Dry runs (online or offline) need no
// permission.

export const SYNC_ALLOWLIST_ENV = "CODE_CONTEXT_GITHUB_SYNC_REPOS";
export const SYNC_ASSIGNEES_ENV = "CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES";
const LOGIN = "[A-Za-z0-9][A-Za-z0-9-]*";
/** `owner/repo` or `owner/repo@board-owner/N`. */
const GRANT_RE = new RegExp(`^(${LOGIN}/[A-Za-z0-9._-]+)(?:@(${LOGIN})/([1-9]\\d{0,8}))?$`);
const LOGIN_ONLY_RE = new RegExp(`^${LOGIN}$`);

/** One allowlist entry: a repo (issues + milestones) and, optionally, the one
 *  Project board it may also write to. Lower case. */
export interface SyncGrant {
  repo: string;
  board: { owner: string; number: number } | null;
}

/** What a live sync may touch, read from the process env (never from a tool). */
export interface SyncAuth {
  grants: SyncGrant[];
  /** Extra assignee logins (lower case); the repo owner is always allowed. */
  assignees: string[];
}

/** The exact GitHub targets one project's sync writes to. */
export interface SyncTarget {
  repo: string;
  board: { owner: string; number: number } | null;
  assignee: string;
}

/** Parse CODE_CONTEXT_GITHUB_SYNC_REPOS-style entries (comma or whitespace
 *  separated). Malformed entries and wildcards are ignored (fail closed). */
export function parseSyncGrants(raw: string | readonly string[]): SyncGrant[] {
  const parts = typeof raw === "string" ? raw.split(/[\s,]+/) : raw.flatMap((e) => e.split(/[\s,]+/));
  const out: SyncGrant[] = [];
  for (const p of parts) {
    const m = GRANT_RE.exec(p.trim());
    if (!m) continue;
    out.push({ repo: m[1].toLowerCase(), board: m[2] ? { owner: m[2].toLowerCase(), number: Number(m[3]) } : null });
  }
  return out;
}

/** Allowlist + assignee list from the env of this process. */
export function syncAuth(env: NodeJS.ProcessEnv = process.env): SyncAuth {
  return {
    grants: parseSyncGrants(env[SYNC_ALLOWLIST_ENV] ?? ""),
    assignees: (env[SYNC_ASSIGNEES_ENV] ?? "")
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => LOGIN_ONLY_RE.test(e)),
  };
}

/** Board owner a project writes to, or null without a board. */
export function boardOwnerOf(p: Pick<ProjectRow, "repo" | "github_project_number" | "github_project_owner">): string | null {
  if (p.github_project_number === null || p.github_project_number === undefined) return null;
  return p.github_project_owner || (p.repo ? repoOwner(p.repo) : null);
}

/** The targets a project row resolves to (repo must be set). */
export function syncTargetOf(p: Pick<ProjectRow, "repo" | "github_project_number" | "github_project_owner" | "github_assignee">): SyncTarget {
  const repo = p.repo!;
  const owner = boardOwnerOf(p);
  return {
    repo,
    board: owner !== null && p.github_project_number !== null ? { owner, number: p.github_project_number } : null,
    assignee: p.github_assignee || repoOwner(repo),
  };
}

function grantText(g: SyncGrant): string {
  return g.board ? `${g.repo}@${g.board.owner}/${g.board.number}` : g.repo;
}

/**
 * Error text when a live sync to `t` is not allowed, else null.
 * - The repo must be listed.
 * - With a board, the exact `repo@board-owner/N` pair must be listed: a repo
 *   grant never extends to other boards of the same owner.
 * - The assignee must be the repo owner or listed in CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES.
 */
export function liveSyncRefusal(t: SyncTarget, auth: SyncAuth): string | null {
  const how = `Allow it outside the MCP session: set ${SYNC_ALLOWLIST_ENV} (owner/repo for issues + milestones, owner/repo@board-owner/N to also write that Project board; comma-separated) in the environment of the code-context server or the code-context-sync-github CLI, then restart the server. dry_run works without it.`;
  const repo = t.repo.toLowerCase();
  const listed = auth.grants.length ? ` (allowed: ${auth.grants.map(grantText).join(", ")})` : " (unset)";
  const forRepo = auth.grants.filter((g) => g.repo === repo);
  if (!forRepo.length) return `Live sync to ${t.repo} is not authorized: ${t.repo} is not in ${SYNC_ALLOWLIST_ENV}${listed}. ${how}`;
  if (t.board) {
    const want = { owner: t.board.owner.toLowerCase(), number: t.board.number };
    if (!forRepo.some((g) => g.board && g.board.owner === want.owner && g.board.number === want.number)) {
      return `Live sync to the Project board ${t.board.owner}/${t.board.number} is not authorized for ${t.repo}: ${SYNC_ALLOWLIST_ENV} has no entry ${repo}@${want.owner}/${want.number}${listed}. Add that exact entry, or unset the project's github_project_number to sync without a board. ${how}`;
    }
  }
  const assignee = t.assignee.toLowerCase();
  if (assignee !== repoOwner(repo) && !auth.assignees.includes(assignee)) {
    return `Live sync with assignee ${t.assignee} is not authorized: only the repo owner (${repoOwner(t.repo)}) or a login in ${SYNC_ASSIGNEES_ENV}${auth.assignees.length ? ` (${auth.assignees.join(", ")})` : " (unset)"} may be assigned. Add the login to ${SYNC_ASSIGNEES_ENV} in the server or CLI env, or unset the project's github_assignee.`;
  }
  return null;
}

/** True when the project already pushed something to GitHub (a stored issue or milestone number). */
export function projectHasSynced(db: Database.Database, project: string): boolean {
  return loadProjectTickets(db, project).tickets.some((t) => t.github_issue !== null) || loadProjectMilestones(db, project).some((m) => m.github_milestone !== null);
}

// ─── Local model ─────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  name: string;
  repo: string | null;
  github_project_owner: string | null;
  github_project_number: number | null;
  github_assignee: string | null;
  github_project_id: string | null;
  github_status_field_id: string | null;
  github_status_options: string | null;
}

export interface SyncTicket {
  id: number;
  ticket_ref: string | null;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  priority: string;
  status: string;
  review_status: string | null;
  sprint_id: number | null;
  sprint_status: string | null;
  milestone_id: number | null;
  type: IssueType | null;
  origin: "ai" | "human" | null;
  github_issue: number | null;
  github_repo: string | null;
}

export interface SyncMilestone {
  id: number;
  name: string;
  description: string | null;
  status: string;
  target_date: string | null;
  github_milestone: number | null;
}

export function getProject(db: Database.Database, name: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRow | undefined;
}

export function listProjectNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM projects ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

/** Error text for an unknown project key, or null when it exists (null/undefined = no project, fine). */
export function unknownProject(db: Database.Database, name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  if (getProject(db, name)) return null;
  const known = listProjectNames(db);
  return `Unknown project "${name}". Register it with set_project first${known.length ? ` (known: ${known.join(", ")})` : ""}.`;
}

/** SQL for a ticket's effective project: own key first, then sprint, milestone,
 *  epic, sprint's milestone, epic's milestone. Needs the joins in TICKET_PROJECT_JOINS. */
export const EFFECTIVE_PROJECT_SQL = "COALESCE(t.project, s.project, m.project, e.project, sm.project, em.project)";
export const TICKET_PROJECT_JOINS = `
  LEFT JOIN sprints s ON s.id = t.sprint_id
  LEFT JOIN milestones m ON m.id = t.milestone_id
  LEFT JOIN epics e ON e.id = t.epic_id
  LEFT JOIN milestones sm ON sm.id = s.milestone_id
  LEFT JOIN milestones em ON em.id = e.milestone_id`;

export interface Skip {
  ref: string;
  reason: string;
}

/** Tickets of `project` (strict: an own key wins; inherited keys must agree). */
export function loadProjectTickets(db: Database.Database, project: string): { tickets: SyncTicket[]; skipped: Skip[] } {
  const rows = db
    .prepare(
      `SELECT t.id, t.ticket_ref, t.title, t.description, t.acceptance_criteria, t.priority, t.status,
              t.review_status, t.sprint_id, s.status AS sprint_status, t.milestone_id, t.type, t.origin,
              t.github_issue, t.github_repo,
              t.project AS own, s.project AS p1, m.project AS p2, e.project AS p3, sm.project AS p4, em.project AS p5
       FROM tickets t ${TICKET_PROJECT_JOINS}
       WHERE t.deleted_at IS NULL
       ORDER BY t.id`,
    )
    .all() as Array<SyncTicket & { own: string | null; p1: string | null; p2: string | null; p3: string | null; p4: string | null; p5: string | null }>;
  const tickets: SyncTicket[] = [];
  const skipped: Skip[] = [];
  for (const r of rows) {
    const { own, p1, p2, p3, p4, p5, ...t } = r;
    if (own !== null) {
      if (own === project) tickets.push(t);
      continue;
    }
    const inherited = [...new Set([p1, p2, p3, p4, p5].filter((p): p is string => p !== null))];
    if (inherited.length === 1 && inherited[0] === project) tickets.push(t);
    else if (inherited.length > 1 && inherited.includes(project)) {
      skipped.push({ ref: refOf(t), reason: `ambiguous project (${inherited.join(", ")}) — set update_ticket project` });
    }
  }
  return { tickets, skipped };
}

export function loadProjectMilestones(db: Database.Database, project: string): SyncMilestone[] {
  return db
    .prepare(
      `SELECT id, name, description, status, target_date, github_milestone FROM milestones
       WHERE project = ? AND deleted_at IS NULL ORDER BY id`,
    )
    .all(project) as SyncMilestone[];
}

function refOf(t: { id: number; ticket_ref: string | null }): string {
  return t.ticket_ref || `#${t.id}`;
}

// ─── Mapping rules ───────────────────────────────────────────────────────────

/** Board column for a ticket. DONE → Done; review pending → In review;
 *  IN_PROGRESS/BLOCKED/PARTIAL → In progress; TODO in an open sprint → Ready;
 *  everything else (backlog TODO, NOT_DONE) → Backlog. */
export function statusFor(t: Pick<SyncTicket, "status" | "review_status" | "sprint_id" | "sprint_status">): (typeof STATUS_NAMES)[number] {
  if (t.status === "DONE") return "Done";
  if (t.review_status === "pending") return "In review";
  if (t.status === "IN_PROGRESS" || t.status === "BLOCKED" || t.status === "PARTIAL") return "In progress";
  if (t.status === "TODO" && t.sprint_id !== null && !["closed", "done", "rest"].includes(t.sprint_status ?? "")) return "Ready";
  return "Backlog";
}

export function issueTitle(t: Pick<SyncTicket, "ticket_ref" | "title">): string {
  assertNoSecret(t.title, "ticket title");
  return publishable(t.ticket_ref ? `${t.ticket_ref}: ${t.title}` : t.title, "issue title");
}

/** Issue body: `## Why` from the description before "Done when:", `## Done when`
 *  from the rest plus acceptance criteria. Scrubbed and guarded. */
export function buildIssueBody(t: Pick<SyncTicket, "description" | "acceptance_criteria">): string {
  assertNoSecret(t.description ?? "", "ticket description");
  assertNoSecret(t.acceptance_criteria ?? "", "acceptance criteria");
  const desc = (t.description ?? "").trim();
  const split = /(^|\n)\s*(?:#+\s*)?Done when:?\s*/i.exec(desc);
  let why = desc;
  let done = "";
  if (split) {
    why = desc.slice(0, split.index).trim();
    done = desc.slice(split.index + split[0].length).trim();
  }
  const criteria = parseCriteria(t.acceptance_criteria);
  if (criteria.length) done = [done, criteria.map((c) => `- ${c}`).join("\n")].filter(Boolean).join("\n\n");
  const body = `## Why\n\n${why || "_Not set._"}\n\n## Done when\n\n${done || "_Not set._"}\n`;
  return publishable(body, "issue body");
}

function parseCriteria(raw: string | null): string[] {
  if (!raw || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* plain text */
  }
  return [raw.trim()];
}

// ─── Ownership markers ───────────────────────────────────────────────────────
//
// A stored issue / milestone number is not proof that the sync created that
// object: `update_ticket github_issue=N`, `update_milestone github_milestone=N`
// and the `execute` tool can point a row at any issue of the repo. So the sync
// writes a hidden marker into every issue body and milestone description it
// creates, and later updates only objects whose current remote text carries
// the marker of the same project AND the same ticket (or local milestone id).
// Anything else is skipped with a plan note — never edited, closed, relabelled
// or moved on the board. Taking over an unmarked object is an explicit adopt.

const MARKER_RE = /<!--\s*code-context-sync:([^<>]*?)-->/g;

function markerPart(v: string): string {
  return encodeURIComponent(v);
}

/** Hidden marker of the issue the sync owns for `ticket` in `project`. */
export function issueMarker(project: string, ref: string): string {
  return `<!-- code-context-sync: project=${markerPart(project)} ticket=${markerPart(ref)} -->`;
}

/** Hidden marker of the milestone the sync owns for local milestone `localId` in `project`. */
export function milestoneMarker(project: string, localId: number): string {
  return `<!-- code-context-sync: project=${markerPart(project)} milestone=${localId} -->`;
}

/** Canonical `k=v k=v` forms of every marker in text. */
function markersIn(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(MARKER_RE)) out.push(m[1].trim().split(/\s+/).join(" "));
  return out;
}

export type Ownership = "owned" | "unmarked" | "foreign";

/** owned: at least one marker and every marker is `want`; unmarked: no marker;
 *  foreign: a marker of another project, ticket or milestone. */
export function ownershipOf(text: string | null | undefined, want: string): Ownership {
  const have = markersIn(text);
  if (!have.length) return "unmarked";
  const w = markersIn(want)[0];
  return have.every((h) => h === w) ? "owned" : "foreign";
}

/** text + marker on its own last line; the marker passes the publish guard too. */
export function withMarker(text: string, marker: string, what: string): string {
  assertPublishable(marker, what);
  const t = text.replace(/\s+$/, "");
  return t ? `${t}\n\n${marker}\n` : `${marker}\n`;
}

/** The issue body the sync writes for a ticket: Why / Done when + its marker. */
export function ownedIssueBody(project: string, t: Pick<SyncTicket, "id" | "ticket_ref" | "description" | "acceptance_criteria">): string {
  return withMarker(buildIssueBody(t), issueMarker(project, refOf(t)), "issue body");
}

export interface LabelRule {
  /** Labels the sync owns for this ticket; existing ones outside it are kept. */
  managed: string[];
  desired: string[];
}

/** Priority P0–P2 always managed (P3 has no label); type and origin only when
 *  the ticket sets them — except origin on create, which defaults to ai_issue. */
export function labelRule(t: Pick<SyncTicket, "priority" | "type" | "origin">, creating: boolean): LabelRule {
  const managed: string[] = [...PRIORITY_LABELS];
  const desired: string[] = [];
  if ((PRIORITY_LABELS as readonly string[]).includes(t.priority)) desired.push(t.priority);
  if (t.type && (TYPE_LABELS as readonly string[]).includes(t.type)) {
    managed.push(...TYPE_LABELS);
    desired.push(t.type);
  }
  const origin = t.origin ?? (creating ? "ai" : null);
  if (origin && origin in ORIGIN_LABELS) {
    managed.push(...Object.values(ORIGIN_LABELS));
    desired.push(ORIGIN_LABELS[origin]);
  }
  // Only the fixed label set is ever sent: GitHub creates a missing label on
  // the fly, so an unexpected value must never become a new label.
  const known = new Set<string>([...managed]);
  return { managed, desired: desired.filter((l) => known.has(l)) };
}

export function applyLabelRule(existing: string[], rule: LabelRule): string[] {
  const managed = new Set(rule.managed);
  return [...new Set([...existing.filter((l) => !managed.has(l)), ...rule.desired])];
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

function norm(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trim();
}

export function repoOwner(repo: string): string {
  return repo.split("/")[0];
}

export function assigneeOf(p: ProjectRow): string {
  return p.github_assignee || repoOwner(p.repo!);
}

// ─── Remote model (what the gateway returns) ─────────────────────────────────

export interface RemoteMilestone {
  number: number;
  title: string;
  description: string | null;
  state: "open" | "closed";
  due_on: string | null;
}

export interface RemoteIssue {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  milestone: number | null;
  /** This issue's item on the target Project, if any. */
  item: { id: string; status: string | null } | null;
}

export interface ProjectMeta {
  projectId: string;
  statusFieldId: string;
  /** Status option name → option id. */
  options: Record<string, string>;
}

export interface RemoteState {
  meta: ProjectMeta | null;
  issues: Map<number, RemoteIssue>;
  /** Stored numbers GitHub does not know (deleted or wrong repo). */
  missing: number[];
  /** null = not read (no milestone of this project needed it). */
  milestones: RemoteMilestone[] | null;
}

export interface MilestoneFields {
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: string | null;
}

export interface IssueFields {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone: number | null;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
  state?: "open" | "closed";
  state_reason?: "completed" | "reopened";
}

/** The GitHub side. `GhGateway` (github-gateway.ts) is the gh-CLI implementation;
 *  tests use an in-memory fake. */
export interface GitHubGateway {
  listMilestones(repo: string): Promise<RemoteMilestone[]>;
  createMilestone(repo: string, f: MilestoneFields): Promise<{ number: number }>;
  updateMilestone(repo: string, number: number, f: Partial<MilestoneFields>): Promise<void>;
  /** One GraphQL read per 50 issues: the issues, their item on the Project and
   *  (unless `cachedMeta` is given) the Project id + Status field. */
  readIssues(
    repo: string,
    project: { owner: string; number: number } | null,
    numbers: number[],
    cachedMeta: ProjectMeta | null,
  ): Promise<{ meta: ProjectMeta | null; issues: Map<number, RemoteIssue>; missing: number[] }>;
  createIssue(repo: string, f: IssueFields): Promise<{ number: number; nodeId: string }>;
  updateIssue(repo: string, number: number, patch: IssuePatch): Promise<void>;
  /** Aliased mutation batch; returns contentId → itemId. */
  addToProject(projectId: string, contentIds: string[]): Promise<Map<string, string>>;
  /** Aliased mutation batch. */
  setStatus(projectId: string, fieldId: string, items: Array<{ itemId: string; optionId: string }>): Promise<void>;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export interface MilestoneAction {
  /** adopt: an explicit number mapping takes over an unmarked milestone (writes the marker). */
  kind: "create" | "adopt" | "update" | "noop";
  localId: number;
  name: string;
  number: number | null;
  fields: MilestoneFields;
  changed: string[];
}

export interface IssueAction {
  kind: "create" | "update" | "noop";
  ticketId: number;
  ref: string;
  number: number | null;
  /** Full desired fields (create) — milestone resolved at apply time when the milestone is new. */
  fields: IssueFields;
  milestoneLocalId: number | null;
  patch: IssuePatch;
  changed: string[];
  status: { from: string | null; to: string };
  /** Needs a Project item (not on the board yet). */
  addToProject: boolean;
  nodeId: string | null;
  itemId: string | null;
  /** This update takes over an unmarked issue (explicit adopt) and writes the marker. */
  adopt: boolean;
}

/** Explicit take-overs of existing GitHub objects the sync did not create. */
export interface AdoptOptions {
  /** Issue numbers: each must be linked by a ticket of the project (github_issue)
   *  and its GitHub title must start with "<ticket_ref>:". */
  issues?: number[];
  /** Local milestone id → GitHub milestone number. */
  milestones?: Array<{ id: number; number: number }>;
}

export interface SyncPlan {
  project: string;
  repo: string;
  projectNumber: number | null;
  offline: boolean;
  milestones: MilestoneAction[];
  issues: IssueAction[];
  skipped: Skip[];
  warnings: string[];
}

function milestoneFields(project: string, m: SyncMilestone): MilestoneFields {
  const date = m.target_date && /^\d{4}-\d{2}-\d{2}/.test(m.target_date) ? `${m.target_date.slice(0, 10)}T00:00:00Z` : null;
  return {
    title: publishable(m.name, "milestone title"),
    description: withMarker(publishable(m.description ?? "", "milestone description"), milestoneMarker(project, m.id), "milestone description"),
    state: m.status === "completed" ? "closed" : "open",
    due_on: date,
  };
}

function diffMilestone(want: MilestoneFields, have: RemoteMilestone): string[] {
  const changed: string[] = [];
  if (want.title !== have.title) changed.push("title");
  if (norm(want.description) !== norm(have.description)) changed.push("description");
  if (want.state !== have.state) changed.push("state");
  if ((want.due_on ?? "").slice(0, 10) !== (have.due_on ?? "").slice(0, 10)) changed.push("due_on");
  return changed;
}

/**
 * Build the plan. `remote` null = offline: no GitHub read, stored numbers are
 * planned as unverified updates (a live run always re-plans from a fresh read).
 */
export function planSync(db: Database.Database, project: ProjectRow, remote: RemoteState | null, adopt: AdoptOptions = {}): SyncPlan {
  if (!project.repo) throw new Error(`Project "${project.name}" has no repo — set_project repo=owner/name first`);
  const repo = project.repo;
  const plan: SyncPlan = {
    project: project.name,
    repo,
    projectNumber: project.github_project_number,
    offline: remote === null,
    milestones: [],
    issues: [],
    skipped: [],
    warnings: [],
  };
  if (!remote) plan.warnings.push("offline: ownership markers not checked — a live run skips every issue or milestone without this sync's marker");

  // Milestones. A stored number is updated only when the remote description
  // carries this milestone's marker; an explicit mapping (adopt) takes over an
  // unmarked one. A title match alone never links.
  const msAdopt = new Map<number, number>();
  for (const a of adopt.milestones ?? []) msAdopt.set(a.id, a.number);
  const msNumber = new Map<number, number | null>(); // local id → GitHub number (null = not yet created)
  const projectMs = loadProjectMilestones(db, project.name);
  for (const id of msAdopt.keys()) {
    if (!projectMs.some((m) => m.id === id)) plan.warnings.push(`milestone adopt ${id}=${msAdopt.get(id)} ignored: local milestone ${id} is not in project ${project.name}`);
  }
  for (const m of projectMs) {
    const fields = milestoneFields(project.name, m);
    const marker = milestoneMarker(project.name, m.id);
    const adoptNum = msAdopt.get(m.id);
    const num = adoptNum ?? m.github_milestone;
    let action: MilestoneAction;
    if (num !== null && num !== undefined) {
      const have = remote?.milestones?.find((r) => r.number === num);
      if (remote && !have) {
        plan.warnings.push(`milestone "${m.name}": GitHub milestone #${num} not found in ${repo} — skipped`);
        continue;
      }
      const own = have ? ownershipOf(have.description, marker) : "owned";
      if (own === "foreign") {
        plan.warnings.push(`milestone "${m.name}": GitHub milestone #${num} carries another project's or milestone's code-context-sync marker — left untouched`);
        continue;
      }
      if (own === "unmarked" && adoptNum === undefined) {
        plan.warnings.push(
          `milestone "${m.name}": GitHub milestone #${num} has no code-context-sync marker — not created by this sync, left untouched (adopt it explicitly: --milestone ${m.id}=${num} / adopt_milestones [{milestone_id: ${m.id}, github_milestone: ${num}}])`,
        );
        continue;
      }
      const changed = have ? diffMilestone(fields, have) : ["unverified (offline)"];
      const adopting = adoptNum !== undefined && (own === "unmarked" || m.github_milestone !== adoptNum);
      action = { kind: adopting ? "adopt" : changed.length ? "update" : "noop", localId: m.id, name: m.name, number: num, fields, changed };
    } else {
      const sameTitle = remote?.milestones?.find((r) => r.title.trim().toLowerCase() === fields.title.trim().toLowerCase());
      if (sameTitle) {
        // GitHub refuses a second milestone with the same title, and a title is no proof of ownership.
        plan.warnings.push(
          `milestone "${m.name}": GitHub milestone #${sameTitle.number} has the same title — not linked by title; adopt it with --milestone ${m.id}=${sameTitle.number} / adopt_milestones, or rename one of them`,
        );
        continue;
      }
      action = { kind: "create", localId: m.id, name: m.name, number: null, fields, changed: [] };
    }
    msNumber.set(m.id, action.number);
    plan.milestones.push(action);
  }

  // Issues
  const { tickets, skipped } = loadProjectTickets(db, project.name);
  plan.skipped.push(...skipped);
  const assignee = assigneeOf(project);
  const meta = remote?.meta ?? null;
  // Adopt: only issues a ticket of this project links, each by exactly one ticket.
  const adoptIssues = new Set((adopt.issues ?? []).filter((n) => Number.isInteger(n) && n > 0));
  const linkedBy = new Map<number, number>();
  for (const t of tickets) if (t.github_issue !== null && (!t.github_repo || t.github_repo.toLowerCase() === repo.toLowerCase())) linkedBy.set(t.github_issue, (linkedBy.get(t.github_issue) ?? 0) + 1);
  for (const n of adoptIssues) {
    if (!linkedBy.has(n)) plan.warnings.push(`adopt #${n} ignored: no ticket of project ${project.name} links issue #${n} (set update_ticket github_issue=${n} first)`);
  }
  for (const t of tickets) {
    const ref = refOf(t);
    if (t.github_issue !== null && t.github_repo && t.github_repo.toLowerCase() !== repo.toLowerCase()) {
      plan.skipped.push({ ref, reason: `issue #${t.github_issue} belongs to ${t.github_repo}, not ${repo}` });
      continue;
    }
    let title: string;
    let body: string;
    try {
      title = issueTitle(t);
      body = ownedIssueBody(project.name, t);
    } catch (e: any) {
      plan.skipped.push({ ref, reason: e.message });
      continue;
    }
    const creating = t.github_issue === null;
    if (creating && !t.type) {
      plan.skipped.push({ ref, reason: "no type — set update_ticket type (feat|fix|chore|infra|improvement)" });
      continue;
    }
    const rule = labelRule(t, creating);
    const msLocal = t.milestone_id !== null && msNumber.has(t.milestone_id) ? t.milestone_id : null;
    const msNum = msLocal !== null ? msNumber.get(msLocal) ?? null : null;
    const statusTo = statusFor(t);
    const wantClosed = t.status === "DONE";

    if (creating) {
      plan.issues.push({
        kind: "create",
        ticketId: t.id,
        ref,
        number: null,
        fields: { title, body, labels: rule.desired, assignees: [assignee], milestone: msNum },
        milestoneLocalId: msLocal,
        patch: wantClosed ? { state: "closed", state_reason: "completed" } : {},
        changed: wantClosed ? ["close"] : [],
        status: { from: null, to: statusTo },
        addToProject: project.github_project_number !== null,
        nodeId: null,
        itemId: null,
        adopt: false,
      });
      continue;
    }

    const num = t.github_issue!;
    if (remote && remote.missing.includes(num)) {
      plan.skipped.push({ ref, reason: `issue #${num} not found in ${repo} — clear github_issue to re-create` });
      continue;
    }
    const have = remote?.issues.get(num);
    // Ownership: update only an issue whose body carries this ticket's marker,
    // unless this run adopts it explicitly.
    let adopting = false;
    if (have) {
      const own = ownershipOf(have.body, issueMarker(project.name, ref));
      if (own === "foreign") {
        plan.skipped.push({ ref, reason: `issue #${num} carries another ticket's or project's code-context-sync marker — left untouched` });
        continue;
      }
      if (own === "unmarked") {
        if (!adoptIssues.has(num)) {
          plan.skipped.push({
            ref,
            reason: `issue #${num} has no code-context-sync marker — not created by this sync, left untouched (adopt: [${num}] takes it over when its GitHub title starts with "${t.ticket_ref ?? "<ticket_ref>"}:")`,
          });
          continue;
        }
        const refusal = adoptRefusal(t, have, linkedBy.get(num) ?? 0);
        if (refusal) {
          plan.skipped.push({ ref, reason: `adopt #${num} refused: ${refusal}` });
          continue;
        }
        adopting = true;
      }
    } else if (!remote && adoptIssues.has(num)) {
      adopting = true; // offline plan: the title rule is checked on the live read
    }
    const patch: IssuePatch = {};
    const changed: string[] = adopting ? ["adopt"] : [];
    if (have) {
      if (title !== have.title) { patch.title = title; changed.push("title"); }
      if (norm(body) !== norm(have.body)) { patch.body = body; changed.push("body"); }
      const labels = applyLabelRule(have.labels, rule);
      if (!sameSet(labels, have.labels)) { patch.labels = labels; changed.push("labels"); }
      if (!have.assignees.some((a) => a.toLowerCase() === assignee.toLowerCase())) {
        patch.assignees = [...have.assignees, assignee];
        changed.push("assignees");
      }
      if (msLocal !== null && (msNum === null || msNum !== have.milestone)) { patch.milestone = msNum; changed.push("milestone"); }
      if (wantClosed && have.state === "open") { patch.state = "closed"; patch.state_reason = "completed"; changed.push("close"); }
      if (!wantClosed && have.state === "closed") { patch.state = "open"; patch.state_reason = "reopened"; changed.push("reopen"); }
    } else {
      // Offline: send the full managed set; existing unmanaged labels are unknown, so labels are left out.
      Object.assign(patch, { title, body, assignees: [assignee], ...(msLocal !== null ? { milestone: msNum } : {}) });
      patch.state = wantClosed ? "closed" : "open";
      changed.push("unverified (offline)");
    }
    const item = have?.item ?? null;
    plan.issues.push({
      kind: changed.length ? "update" : "noop",
      ticketId: t.id,
      ref,
      number: num,
      fields: { title, body, labels: rule.desired, assignees: [assignee], milestone: msNum },
      milestoneLocalId: msLocal,
      patch,
      changed,
      status: { from: remote ? item?.status ?? null : null, to: statusTo },
      addToProject: project.github_project_number !== null && remote !== null && item === null,
      nodeId: have?.nodeId ?? null,
      itemId: item?.id ?? null,
      adopt: adopting,
    });
  }

  if (project.github_project_number !== null && meta) {
    for (const name of new Set(plan.issues.map((i) => i.status.to))) {
      if (!optionId(meta, name)) plan.warnings.push(`Project has no Status option "${name}" — status left unchanged for those issues`);
    }
  }
  if (project.github_project_number === null) plan.warnings.push("no github_project_number — issues are not added to a Project board");
  return plan;
}

/**
 * Why an unmarked issue may not be adopted for ticket t, or null. The GitHub
 * title must already start with "<ticket_ref>:" — so an agent cannot adopt an
 * arbitrary issue — and exactly one ticket of the project must link it.
 */
export function adoptRefusal(t: Pick<SyncTicket, "ticket_ref">, have: Pick<RemoteIssue, "title">, linkCount = 1): string | null {
  if (!t.ticket_ref) return "the ticket has no ticket_ref, and the GitHub title must start with it";
  if (linkCount > 1) return `${linkCount} tickets of the project link this issue`;
  if (!have.title.trimStart().startsWith(`${t.ticket_ref}:`)) return `its GitHub title does not start with "${t.ticket_ref}:"`;
  return null;
}

function optionId(meta: ProjectMeta, name: string): string | undefined {
  const hit = Object.keys(meta.options).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? meta.options[hit] : undefined;
}

/** True when this issue's board column must change. */
function statusChanges(a: IssueAction): boolean {
  return a.status.from === null || a.status.from.toLowerCase() !== a.status.to.toLowerCase();
}

/** Planned write count (REST calls + mutation aliases). */
export function plannedWrites(plan: SyncPlan): number {
  let n = 0;
  for (const m of plan.milestones) if (m.kind === "create" || m.kind === "update" || (m.kind === "adopt" && m.changed.length)) n++;
  for (const i of plan.issues) {
    if (i.kind === "create") n += 1 + (i.patch.state === "closed" ? 1 : 0);
    if (i.kind === "update") n++;
    if (plan.projectNumber !== null) {
      if (i.kind === "create" || i.addToProject) n++;
      if (statusChanges(i)) n++;
    }
  }
  return n;
}

// ─── Format ──────────────────────────────────────────────────────────────────

export function formatPlan(plan: SyncPlan, header: string): string {
  const lines = [header];
  const board = plan.projectNumber !== null ? `, Project #${plan.projectNumber}` : "";
  lines.push(`Target: ${plan.repo}${board}${plan.offline ? " — offline (no GitHub read; updates unverified)" : ""}`);
  if (plan.milestones.length) {
    lines.push("", `Milestones (${plan.milestones.length}):`);
    for (const m of plan.milestones) {
      const tag = { create: "+ create", adopt: "~ adopt ", update: "~ update", noop: "= ok    " }[m.kind];
      const num = m.number !== null ? ` #${m.number}` : "";
      const ch = m.changed.length ? ` — ${m.changed.join(", ")}` : "";
      lines.push(`  ${tag}${num} "${m.name}"${ch}`);
    }
  }
  lines.push("", `Issues (${plan.issues.length}):`);
  if (!plan.issues.length) lines.push("  (none)");
  for (const i of plan.issues) {
    const tag = i.adopt ? "~ adopt " : { create: "+ create", update: "~ update", noop: "= ok    " }[i.kind];
    const num = i.number !== null ? ` #${i.number}` : "";
    const parts: string[] = [];
    if (i.kind === "create") parts.push(`labels [${i.fields.labels.join(", ")}] @${i.fields.assignees[0]}`);
    if (i.changed.length) parts.push(i.changed.join(", "));
    if (plan.projectNumber !== null) {
      if (i.kind === "create" || i.addToProject) parts.push("add to board");
      if (statusChanges(i)) parts.push(`status ${i.status.from ?? "—"} → ${i.status.to}`);
    }
    lines.push(`  ${tag}${num} ${i.ref}${parts.length ? ` — ${parts.join("; ")}` : ""}`);
  }
  if (plan.skipped.length) {
    lines.push("", `Skipped (${plan.skipped.length}):`);
    for (const s of plan.skipped) lines.push(`  - ${s.ref}: ${s.reason}`);
  }
  if (plan.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of plan.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("", `Planned writes: ${plannedWrites(plan)}`);
  return lines.join("\n");
}

// ─── Read + apply ────────────────────────────────────────────────────────────

function cachedMeta(p: ProjectRow): ProjectMeta | null {
  if (!p.github_project_id || !p.github_status_field_id || !p.github_status_options) return null;
  try {
    return { projectId: p.github_project_id, statusFieldId: p.github_status_field_id, options: JSON.parse(p.github_status_options) };
  } catch {
    return null;
  }
}

/** All GitHub reads one sync needs: ≤1 REST (milestones) + 1 GraphQL per 50 issues. */
export async function readRemote(db: Database.Database, gw: GitHubGateway, project: ProjectRow, opts: { trustCache?: boolean } = {}): Promise<RemoteState> {
  const repo = project.repo!;
  const milestones = loadProjectMilestones(db, project.name).length ? await gw.listMilestones(repo) : null;
  const numbers = loadProjectTickets(db, project.name)
    .tickets.filter((t) => t.github_issue !== null && (!t.github_repo || t.github_repo.toLowerCase() === repo.toLowerCase()))
    .map((t) => t.github_issue!);
  const board =
    project.github_project_number !== null
      ? { owner: project.github_project_owner || repoOwner(repo), number: project.github_project_number }
      : null;
  // A live run never trusts the cached Project id: any db writer (the `execute`
  // tool included) could point it at another board. It resolves the id from
  // the authorized owner/number in the same GraphQL read.
  const cached = opts.trustCache === false ? null : cachedMeta(project);
  const r = numbers.length || (board && !cached) ? await gw.readIssues(repo, board, numbers, cached) : { meta: cached, issues: new Map(), missing: [] };
  return { ...r, meta: r.meta ?? cached, milestones };
}

export interface SyncOptions {
  dryRun?: boolean;
  /** Dry run without any GitHub read. */
  offline?: boolean;
  maxWrites?: number;
  /** Live-sync authorization. Default: syncAuth(process.env).
   *  Code callers only (tests); no MCP tool or CLI flag sets it. */
  auth?: SyncAuth;
  /** Pause between content-creating calls (GitHub secondary limits). Default 1000 ms. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Explicit take-over of unmarked issues / milestones. A live run honours it
   *  only after the allowlist check passed; a dry run only plans it. */
  adopt?: AdoptOptions;
}

export interface SyncResult {
  plan: SyncPlan;
  text: string;
  writes: number;
  error: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function syncGithub(db: Database.Database, gw: GitHubGateway, projectName: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const project = getProject(db, projectName);
  if (!project) throw new Error(unknownProject(db, projectName)!);
  if (!project.repo) throw new Error(`Project "${projectName}" has no repo — set_project repo=owner/name first`);

  if (!opts.dryRun) {
    const refusal = liveSyncRefusal(syncTargetOf(project), opts.auth ?? syncAuth());
    if (refusal) throw new Error(refusal);
  }

  if (opts.dryRun && opts.offline) {
    const plan = planSync(db, project, null, opts.adopt);
    return { plan, text: formatPlan(plan, `sync_github ${projectName} — dry run (offline)`), writes: 0, error: null };
  }
  const remote = await readRemote(db, gw, project, { trustCache: !!opts.dryRun });
  const plan = planSync(db, project, remote, opts.adopt);
  if (opts.dryRun) return { plan, text: formatPlan(plan, `sync_github ${projectName} — dry run`), writes: 0, error: null };

  const max = opts.maxWrites ?? DEFAULT_MAX_WRITES;
  const planned = plannedWrites(plan);
  if (planned > max) {
    const text = formatPlan(plan, `sync_github ${projectName} — refused: ${planned} planned writes exceed max_writes=${max}`);
    return { plan, text, writes: 0, error: `planned writes ${planned} > max_writes ${max}` };
  }

  // Cache the Project ids for later runs (one fewer GraphQL field read).
  if (remote.meta && JSON.stringify(remote.meta) !== JSON.stringify(cachedMeta(project))) {
    db.prepare(
      "UPDATE projects SET github_project_id = ?, github_status_field_id = ?, github_status_options = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(remote.meta.projectId, remote.meta.statusFieldId, JSON.stringify(remote.meta.options), project.id);
  }

  const sleep = opts.sleep ?? defaultSleep;
  const pause = opts.pauseMs ?? 1000;
  let writes = 0;
  const done: string[] = [];
  try {
    // 1. Milestones
    const setMs = db.prepare("UPDATE milestones SET github_milestone = ?, updated_at = datetime('now') WHERE id = ?");
    for (const m of plan.milestones) {
      if (m.kind === "create") {
        const r = await gw.createMilestone(plan.repo, m.fields);
        writes++;
        m.number = r.number;
        setMs.run(r.number, m.localId);
        done.push(`created milestone #${r.number}`);
        if (pause) await sleep(pause);
      } else if (m.kind === "adopt") {
        if (m.changed.length) {
          await gw.updateMilestone(plan.repo, m.number!, m.fields);
          writes++;
        }
        setMs.run(m.number, m.localId);
        done.push(`adopted milestone #${m.number}`);
      } else if (m.kind === "update") {
        await gw.updateMilestone(plan.repo, m.number!, m.fields);
        writes++;
        done.push(`updated milestone #${m.number}`);
      }
    }
    const msNum = new Map(plan.milestones.map((m) => [m.localId, m.number]));

    // 2. Issues (number stored right after each create → a rerun never duplicates)
    const setIssue = db.prepare("UPDATE tickets SET github_issue = ?, github_repo = ?, updated_at = datetime('now') WHERE id = ?");
    for (const i of plan.issues) {
      if (i.kind === "create") {
        const fields = { ...i.fields, milestone: i.milestoneLocalId !== null ? msNum.get(i.milestoneLocalId) ?? null : null };
        const r = await gw.createIssue(plan.repo, fields);
        writes++;
        i.number = r.number;
        i.nodeId = r.nodeId;
        setIssue.run(r.number, plan.repo, i.ticketId);
        done.push(`created #${r.number} (${i.ref})`);
        if (i.patch.state === "closed") {
          await gw.updateIssue(plan.repo, r.number, i.patch);
          writes++;
        }
        if (pause) await sleep(pause);
      } else if (i.kind === "update") {
        const patch = { ...i.patch };
        if (i.milestoneLocalId !== null && "milestone" in patch) patch.milestone = msNum.get(i.milestoneLocalId) ?? null;
        await gw.updateIssue(plan.repo, i.number!, patch);
        writes++;
        done.push(`${i.adopt ? "adopted" : "updated"} #${i.number} (${i.ref})`);
      }
    }

    // 3. Board: add missing items, then set Status — batched mutations.
    const meta = remote.meta;
    if (plan.projectNumber !== null && meta) {
      const toAdd = plan.issues.filter((i) => (i.kind === "create" || i.addToProject) && i.nodeId);
      for (let k = 0; k < toAdd.length; k += MUTATION_BATCH) {
        const chunk = toAdd.slice(k, k + MUTATION_BATCH);
        const ids = await gw.addToProject(meta.projectId, chunk.map((i) => i.nodeId!));
        writes += chunk.length;
        for (const i of chunk) i.itemId = ids.get(i.nodeId!) ?? null;
      }
      const toSet = plan.issues
        .filter((i) => i.itemId && statusChanges(i) && optionId(meta, i.status.to))
        .map((i) => ({ itemId: i.itemId!, optionId: optionId(meta, i.status.to)! }));
      for (let k = 0; k < toSet.length; k += MUTATION_BATCH) {
        const chunk = toSet.slice(k, k + MUTATION_BATCH);
        try {
          await gw.setStatus(meta.projectId, meta.statusFieldId, chunk);
        } catch (e) {
          // Stale cached option ids: drop the cache so the next run re-reads them.
          db.prepare("UPDATE projects SET github_project_id = NULL, github_status_field_id = NULL, github_status_options = NULL WHERE id = ?").run(project.id);
          throw e;
        }
        writes += chunk.length;
      }
      if (toAdd.length) done.push(`added ${toAdd.length} item(s) to the board`);
      if (toSet.length) done.push(`set Status on ${toSet.length} item(s)`);
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const text = `${formatPlan(plan, `sync_github ${projectName} — FAILED after ${writes} write(s): ${msg}`)}\n\nDone before the failure: ${done.join("; ") || "nothing"}. Stored issue numbers make a rerun safe.`;
    return { plan, text, writes, error: msg };
  }
  const summary = done.length ? done.join("; ") : "no change";
  return { plan, text: `${formatPlan(plan, `sync_github ${projectName} — applied`)}\n\nResult: ${summary} (${writes} write(s)).`, writes, error: null };
}
