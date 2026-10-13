import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveDashboardToken } from "../dashboard/auth.js";
import { formatModelRouting, KNOWN_AGENT_MODELS, modelToTier } from "./agent-model.js";
import { buildCommitContract, buildFrontendPlaybook, buildWorkflowPlaybook, checkCommitFormat, formatCommitFormatBlock } from "./frontend-playbook.js";
import {
  formatEnablement,
  getEnabledSkillSets,
  skillSetsConfigured,
} from "./skill-sets.js";
import { sprintPulse, ticketDoneCard, launchCard, sprintCompleteCard, type SprintPulseData } from "./cards.js";
import {
  getSprintById,
  getTicketsBySprint,
  getTicketById,
  getLatestSprint,
  getTicketStatusCounts,
} from "./queries.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerSkillsTools } from "./tools/skills.js";
import { registerGithubTools } from "./tools/github.js";
import { EFFECTIVE_PROJECT_SQL, TICKET_PROJECT_JOINS, TYPE_LABELS, unknownProject } from "./github-sync.js";
import { log as slog } from "../sessionlog.js";
import { archiveEntity, assertArchivable, unarchiveEntity } from "./archive.js";
import {
  errorMessage,
  type AgentRow,
  type BlockerRow,
  type BugRow,
  type CountRow,
  type DecisionRow,
  type DiscoveryRow,
  type EpicRow,
  type EventLogRow,
  type MilestoneRow,
  type PendingActionRow,
  type RetroFindingRow,
  type SkillRow,
  type SprintMetricRow,
  type SprintRow,
  type SubtaskRow,
  type TagRow,
  type TicketDependencyRow,
  type TicketRevisionRow,
  type TicketRow,
} from "./rows.js";

const DASHBOARD_PORT = process.env.DASHBOARD_PORT || "3333";

/** Resolve the actual dashboard port from DB (written by dashboard on startup) */
function resolveDashboardPort(db: Database.Database): string {
  try {
    const row = db.prepare("SELECT content FROM skills WHERE name = '_dashboard_port'").get() as { content: string } | undefined;
    if (row?.content) return row.content;
  } catch {}
  return DASHBOARD_PORT;
}

/** Bearer header so MCP→dashboard notify calls authenticate against /api/* (#15b). */
let cachedDashboardToken: string | null = null;
function dashboardAuthHeaders(): Record<string, string> {
  cachedDashboardToken ??= resolveDashboardToken();
  return { Authorization: `Bearer ${cachedDashboardToken}` };
}

interface DashboardEvent {
  type: string;
  entityType?: string;
  entityId?: number;
  change?: unknown;
  stepProgress?: {
    step: string;
    title: string;
    description: string;
    current: number;
    total: number;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    error?: string;
  };
}

/** Fire-and-forget HTTP POST to dashboard so SSE clients refresh instantly. */
export function notifyDashboard(db: Database.Database, event?: DashboardEvent): void {
  const port = resolveDashboardPort(db);
  try {
    if (event) {
      // Send typed event directly to dashboard SSE
      fetch(`http://localhost:${port}/api/notify/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders() },
        body: JSON.stringify(event),
      }).catch(() => {});
    } else {
      fetch(`http://localhost:${port}/api/notify`, { method: "POST", headers: dashboardAuthHeaders() }).catch(() => {});
    }
  } catch {}
}

/** Canonical phase transition map: current → next allowed phase (simplified 4-phase). */
const PHASE_TRANSITIONS: Record<string, string> = {
  planning: "implementation",
  implementation: "done",
  done: "rest",
  rest: "planning",
};

/** Map legacy phases to their nearest simplified phase. */
const LEGACY_PHASE_MAP: Record<string, string> = {
  preparation: "planning",
  kickoff: "planning",
  qa: "implementation",
  refactoring: "implementation",
  retro: "done",
  review: "done",
  closed: "done",
};

/**
 * Resolve a sprint's effective phase — maps legacy phases to the nearest simplified phase.
 */
function resolvePhase(status: string): string {
  return LEGACY_PHASE_MAP[status] || status;
}

/**
 * Shared gate checks used by both advance_sprint and get_sprint_playbook.
 * Returns an advisory object: warnings are informational, canProceed is always true.
 */
export function checkSprintGates(db: Database.Database, sprint: Pick<SprintRow, "id" | "velocity_committed">, nextPhase: string): { warnings: string[]; canProceed: boolean } {
  const warnings: string[] = [];
  const tickets = getTicketsBySprint(db, sprint.id);

  if (nextPhase === "implementation") {
    if (tickets.length === 0) warnings.push("No tickets assigned to this sprint. Use create_ticket to add tickets.");
    // Assignment is optional — no warning for unassigned tickets
    const noPoints = tickets.filter((t) => t.story_points == null);
    if (noPoints.length > 0) warnings.push(`${noPoints.length} ticket(s) missing story points: ${noPoints.map((t) => t.ticket_ref || `#${t.id}`).join(", ")}. Use update_ticket to estimate them.`);
    if (!sprint.velocity_committed || sprint.velocity_committed <= 0) warnings.push("velocity_committed not set. Use update_sprint to set committed velocity.");
  }
  if (nextPhase === "done" || nextPhase === "qa") {
    const undone = tickets.filter((t) => !["DONE", "BLOCKED", "NOT_DONE"].includes(t.status));
    if (undone.length > 0) warnings.push(`${undone.length} tickets still in progress: ${undone.map((t) => t.ticket_ref || `#${t.id}`).join(", ")}. Use update_ticket to mark them DONE/BLOCKED/NOT_DONE.`);
    const openBlockerCount = (db.prepare(`SELECT COUNT(*) as c FROM blockers WHERE sprint_id = ? AND status = 'open'`).get(sprint.id) as CountRow).c;
    if (openBlockerCount > 0) warnings.push(`${openBlockerCount} open blocker(s). Use resolve_blocker to close them.`);
  }
  if (nextPhase === "closed" || nextPhase === "review") {
    const doneNoQA = tickets.filter((t) => t.status === "DONE" && !t.qa_verified);
    if (doneNoQA.length > 0) {
      const ticketList = doneNoQA.map((t) => `${t.ticket_ref || '#' + t.id} ${t.title}`).join(", ");
      warnings.push(`Tickets need QA verification: ${ticketList}. Use update_ticket to verify them (qa_verified=true).`);
    }
  }
  if (nextPhase === "retro") {
    const inProgress = tickets.filter((t) => t.status === "IN_PROGRESS");
    if (inProgress.length > 0) warnings.push(`${inProgress.length} ticket(s) still IN_PROGRESS: ${inProgress.map((t) => t.ticket_ref || `#${t.id}`).join(", ")}. Complete or mark as NOT_DONE before retro.`);
  }
  if (nextPhase === "rest") {
    const retroCount = (db.prepare(`SELECT COUNT(*) as c FROM retro_findings WHERE sprint_id = ?`).get(sprint.id) as CountRow).c;
    if (retroCount === 0) warnings.push("No retro findings — consider using add_retro_finding before rest.");
  }

  return { warnings, canProceed: true };
}

/** Truncate a string for compact gate listings. */
export function truncateFinding(s: string, max = 140): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Wrap a server-rendered card in a diff fence so callers print the result verbatim. */
export function fenceCard(card: string): string {
  return "```diff\n" + card + "\n```";
}

/**
 * D2: model routing section for a ticket — single-assignment tickets keep the classic
 * directive (with per-assignment override resolution); multi-agent tickets get the
 * lead-implements / supporters-verify block (decision #4).
 */
/** A ticket_assignments row joined with the agent's default model. */
interface AssignmentRoutingRow {
  role: string;
  override: string | null;
  is_lead: number;
  agent_default: string | null;
}

export function buildModelRoutingSection(db: Database.Database, ticket: { id: number; assigned_to?: string | null }): string | null {
  let assignments: AssignmentRoutingRow[] = [];
  try {
    assignments = db.prepare(`
      SELECT ta.role, ta.model as override, ta.is_lead, a.model as agent_default
      FROM ticket_assignments ta LEFT JOIN agents a ON a.role = ta.role
      WHERE ta.ticket_id = ? ORDER BY ta.is_lead DESC, ta.role ASC
    `).all(ticket.id) as AssignmentRoutingRow[];
  } catch { /* pre-v23 DB — fall through to single-agent path */ }

  if (assignments.length > 1) {
    const lines = [`**Model routing (multi-agent):**`];
    for (const a of assignments) {
      const resolved = a.override ?? a.agent_default ?? "inherit";
      lines.push(a.is_lead
        ? `- LEAD ${a.role} — implements via subagent at \`${resolved}\``
        : `- support ${a.role} — verifies/reviews the diff via parallel subagent at \`${resolved}\``);
    }
    lines.push(`Run the lead first; spawn supporting reviewers in parallel afterward. The QA gate requires every supporting verdict to pass before qa_verified.`);
    return lines.join("\n");
  }

  const single = assignments[0];
  const role = single?.role ?? ticket.assigned_to;
  if (!role) return null;
  const agentDefault = (db.prepare(`SELECT model FROM agents WHERE role = ?`).get(role) as { model: string } | undefined)?.model ?? null;
  return formatModelRouting(role, single?.override ?? agentDefault);
}

/**
 * Guard for the single-assignee path of create_ticket / update_ticket. A model or
 * provider name in `assigned_to` ("opus", "glm") is not an error anywhere downstream —
 * buildModelRoutingSection just finds no agent and silently routes to the sonnet
 * default. Returns null when the value is a roster role (or the roster is empty:
 * agentless mode accepts anything), otherwise a user-facing message.
 */
export function unknownRosterRole(db: Database.Database, role: string | null | undefined): string | null {
  if (!role) return null;
  const roles = (db.prepare("SELECT role FROM agents").all() as { role: string }[]).map((a) => a.role);
  if (roles.length === 0 || roles.includes(role)) return null;
  return `Unknown agent role "${role}". assigned_to must be a roster role (${roles.join(", ")}) — the runtime (opus / glm / deepseek) belongs on the ticket as a tag such as impl:glm (add_tag), not in assigned_to.`;
}

/**
 * D2: replace-set a ticket's assignments. Validates roles against the agents table and
 * the exactly-one-lead invariant; mirrors the lead role into tickets.assigned_to.
 * Throws Error with a user-facing message on invalid input.
 */
export function applyTicketAssignments(
  db: Database.Database,
  ticketId: number,
  agents: Array<{ role: string; model?: string | null; lead?: boolean }>
): void {
  if (agents.length === 0) throw new Error("agents[] must not be empty — omit the param to leave assignments unchanged.");
  const validRoles = new Set((db.prepare("SELECT role FROM agents").all() as { role: string }[]).map((a) => a.role));
  const unknown = agents.filter((a) => !validRoles.has(a.role)).map((a) => a.role);
  if (unknown.length > 0) throw new Error(`Unknown agent role(s): ${unknown.join(", ")}. Valid: ${[...validRoles].join(", ")}.`);
  const seen = new Set<string>();
  for (const a of agents) {
    if (seen.has(a.role)) throw new Error(`Duplicate role in agents[]: ${a.role}`);
    seen.add(a.role);
  }
  const leads = agents.filter((a) => a.lead);
  if (agents.length === 1 && leads.length === 0) agents[0].lead = true; // single assignment is implicitly the lead
  else if (leads.length !== 1) throw new Error(`Exactly one lead required — got ${leads.length}.`);

  const lead = agents.find((a) => a.lead)!;
  db.transaction(() => {
    db.prepare(`DELETE FROM ticket_assignments WHERE ticket_id = ?`).run(ticketId);
    const ins = db.prepare(`INSERT INTO ticket_assignments (ticket_id, role, model, is_lead) VALUES (?, ?, ?, ?)`);
    for (const a of agents) ins.run(ticketId, a.role, a.model ?? null, a.lead ? 1 : 0);
    db.prepare(`UPDATE tickets SET assigned_to = ? WHERE id = ?`).run(lead.role, ticketId);
  })();
}

/**
 * D1: board edits awaiting session acknowledgment — pending_change tickets with their
 * latest field-level revision diff. Returns null when the board is quiet.
 */
export function buildChangedTicketsBlock(db: Database.Database, sprintId?: number): string | null {
  let rows: Pick<TicketRow, "id" | "ticket_ref" | "title" | "status">[] = [];
  try {
    rows = db.prepare(`
      SELECT id, ticket_ref, title, status FROM tickets
      WHERE pending_change = 1 AND deleted_at IS NULL ${sprintId ? "AND sprint_id = ?" : ""}
      ORDER BY id ASC
    `).all(...(sprintId ? [sprintId] : [])) as Pick<TicketRow, "id" | "ticket_ref" | "title" | "status">[];
  } catch { return null; /* pre-v23 DB */ }
  if (rows.length === 0) return null;

  const lines = [`## ⚠ CHANGED TICKETS (${rows.length}) — board edits awaiting acknowledgment`];
  for (const t of rows) {
    lines.push(`- ${t.ticket_ref || "#" + t.id} [${t.status}] ${t.title}`);
    const rev = db.prepare(`SELECT changed_fields, old_values, new_values FROM ticket_revisions WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`).get(t.id) as Pick<TicketRevisionRow, "changed_fields" | "old_values" | "new_values"> | undefined;
    if (rev) {
      try {
        const fields: string[] = JSON.parse(rev.changed_fields);
        const oldV: Record<string, unknown> = JSON.parse(rev.old_values);
        const newV: Record<string, unknown> = JSON.parse(rev.new_values);
        fields.forEach((f) => lines.push(`    ${f}: ${JSON.stringify(oldV[f])} → ${JSON.stringify(newV[f])}`));
      } catch { /* unparseable revision — list without diff */ }
    }
  }
  lines.push(`**Directive:** re-read each ticket, state the plan adjustment (or that none is needed), then acknowledge_ticket_changes({ ticket_ids: [...] }).`);
  return lines.join("\n");
}

/** Newest mtime of files with the given extensions under dir (shallow recursion, skips dot-dirs/node_modules). */
function newestMtime(dir: string, exts: string[], depth = 0): number {
  if (depth > 4) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p, exts, depth + 1));
    else if (exts.some((e) => entry.name.endsWith(e))) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/**
 * S1 (Sprint 1 try_next, adopted Sprint 23): warn when src is newer than the compiled
 * dist the running server was loaded from — new/changed tools are silently missing
 * until `npm run build` + MCP reconnect. Returns null when fresh or not a dev checkout.
 */
export function checkDistFreshness(rootDir: string = process.cwd()): string | null {
  try {
    const srcDir = join(rootDir, "src");
    const distDir = join(rootDir, "dist");
    if (!existsSync(srcDir) || !existsSync(distDir)) return null; // packaged install — nothing to compare
    const srcNewest = newestMtime(srcDir, [".ts", ".tsx"]);
    const distNewest = newestMtime(distDir, [".js"]);
    if (srcNewest > distNewest + 5000) {
      return "⚠ STALE DIST: src/ is newer than the compiled server — run `npm run build` and reconnect MCP, or new/changed tools stay silently missing.";
    }
    return null;
  } catch {
    return null; // freshness is advisory — never break a tool over it
  }
}

/** A4: stopwords — English function words + domain noise that says nothing about the issue. */
const ISSUE_STOPWORDS = new Set([
  "the", "a", "an", "is", "was", "were", "are", "be", "been", "being", "to", "of", "in", "for", "and", "or",
  "not", "with", "on", "at", "by", "from", "it", "its", "this", "that", "these", "those", "we", "our", "ours",
  "had", "has", "have", "no", "but", "as", "so", "than", "then", "when", "which", "while", "would", "should",
  "could", "did", "does", "do", "into", "out", "over", "under", "after", "before", "because", "instead",
  "rather", "their", "they", "them", "there", "here", "what", "where", "who", "how", "why", "all", "each",
  "every", "some", "any", "more", "most", "other", "another", "such", "only", "own", "same", "too", "very",
  "can", "will", "just", "also", "even", "still", "again", "never", "always", "without", "within", "during",
  // domain noise — present in nearly every finding, discriminates nothing
  "sprint", "sprints", "ticket", "tickets", "work", "time", "task", "tasks", "team", "needs", "needed",
  "required", "caused", "causing", "made", "making", "took", "spent", "already", "existed", "existing",
]);

export interface IssueCluster {
  term: string;
  findingCount: number;
  sprintCount: number;
  sprints: string[];
  roles: string[];
  example: string;
}

/**
 * A4: cluster went_wrong findings into recurring issues. A recurring issue is a
 * unigram/bigram appearing in findings from >= 2 distinct sprints. Clusters count
 * findings (not word occurrences); bigrams outrank unigrams at equal counts.
 */
export function clusterRecurringIssues(
  findings: Array<{ finding: string; sprint_id: number; role?: string | null; sprint_name?: string }>
): IssueCluster[] {
  type Bucket = { isBigram: boolean; entries: Array<{ sprintId: number; sprintName: string; role: string | null; text: string }> };
  const buckets = new Map<string, Bucket>();

  for (const f of findings) {
    const words = f.finding.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !ISSUE_STOPWORDS.has(w));
    const terms = new Set<string>(words);
    for (let i = 0; i < words.length - 1; i++) terms.add(`${words[i]} ${words[i + 1]}`);

    for (const term of terms) {
      let bucket = buckets.get(term);
      if (!bucket) { bucket = { isBigram: term.includes(" "), entries: [] }; buckets.set(term, bucket); }
      bucket.entries.push({ sprintId: f.sprint_id, sprintName: f.sprint_name || `#${f.sprint_id}`, role: f.role || null, text: f.finding });
    }
  }

  const clusters: IssueCluster[] = [];
  for (const [term, bucket] of buckets) {
    const sprintIds = new Set(bucket.entries.map((e) => e.sprintId));
    if (sprintIds.size < 2) continue; // recurring = seen in >= 2 distinct sprints
    clusters.push({
      term,
      findingCount: bucket.entries.length,
      sprintCount: sprintIds.size,
      sprints: [...new Set(bucket.entries.map((e) => e.sprintName))].slice(0, 6),
      roles: [...new Set(bucket.entries.map((e) => e.role).filter(Boolean))] as string[],
      example: bucket.entries[0].text,
    });
  }

  clusters.sort((a, b) =>
    b.findingCount - a.findingCount
    || (Number(b.term.includes(" ")) - Number(a.term.includes(" ")))
    || b.sprintCount - a.sprintCount
    || a.term.localeCompare(b.term));

  // Suppress unigrams fully shadowed by a stronger or equal bigram containing them
  return clusters.filter((c) => {
    if (c.term.includes(" ")) return true;
    return !clusters.some((other) => other.term.includes(" ") && other.term.includes(c.term) && other.findingCount >= c.findingCount);
  });
}

/**
 * B1: assemble SprintPulseData for the card renderers — progress, burndown,
 * ticket counts, day-in-sprint, and warning lines (blockers, QA pending).
 */
export function buildSprintPulseData(db: Database.Database, sprintId: number): SprintPulseData | null {
  const sprint = getSprintById(db, sprintId);
  if (!sprint) return null;
  const tickets = db.prepare(`SELECT status, story_points, qa_verified FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL`).all(sprintId) as Pick<TicketRow, "status" | "story_points" | "qa_verified">[];
  const counts = { done: 0, inProgress: 0, todo: 0, blocked: 0 };
  for (const t of tickets) {
    if (t.status === "DONE") counts.done++;
    else if (t.status === "IN_PROGRESS") counts.inProgress++;
    else if (t.status === "BLOCKED") counts.blocked++;
    else counts.todo++;
  }
  const totalPoints = tickets.reduce((s: number, t) => s + (t.story_points || 0), 0);
  const donePoints = tickets.filter((t) => t.status === "DONE").reduce((s: number, t) => s + (t.story_points || 0), 0);
  const burndown = (db.prepare(`SELECT completed_points FROM sprint_metrics WHERE sprint_id = ? ORDER BY date`).all(sprintId) as Pick<SprintMetricRow, "completed_points">[]).map((r) => r.completed_points || 0);

  const dayTotal = 5;
  let day = 1;
  if (sprint.start_date) {
    const d = db.prepare(`SELECT CAST(julianday('now') - julianday(?) AS INTEGER) + 1 as day`).get(sprint.start_date) as { day: number | null } | undefined;
    day = Math.min(Math.max(d?.day ?? 1, 1), dayTotal);
  }

  const warnings: string[] = [];
  const openBlockers = (db.prepare(`SELECT COUNT(*) as c FROM blockers WHERE sprint_id = ? AND status = 'open'`).get(sprintId) as CountRow).c;
  if (openBlockers > 0) warnings.push(`${openBlockers} open blocker(s)`);
  const qaPending = tickets.filter((t) => t.status === "DONE" && !t.qa_verified).length;
  if (qaPending > 0) warnings.push(`QA pending on ${qaPending} done ticket(s)`);

  return { sprintName: sprint.name, day, dayTotal, donePoints, totalPoints, burndown, counts, warnings };
}

/**
 * A3: scope deltas against the frozen commitment. Added = tickets created after the
 * sprint entered implementation (event_log timestamp, falling back to start_date /
 * created_at). Removed = tickets whose sprint_id audit trail shows them leaving.
 */
export function getScopeDeltas(db: Database.Database, sprintId: number): { addedPoints: number; addedTickets: number; removedTickets: number } {
  const sprint = db.prepare(`SELECT start_date, created_at FROM sprints WHERE id = ?`).get(sprintId) as Pick<SprintRow, "start_date" | "created_at"> | undefined;
  if (!sprint) return { addedPoints: 0, addedTickets: 0, removedTickets: 0 };
  const implEvent = db.prepare(`
    SELECT created_at FROM event_log
    WHERE entity_type = 'sprint' AND entity_id = ? AND action = 'status_changed' AND new_value = 'implementation'
    ORDER BY created_at ASC LIMIT 1
  `).get(sprintId) as Pick<EventLogRow, "created_at"> | undefined;
  const implStart = implEvent?.created_at || sprint.start_date || sprint.created_at;

  const added = db.prepare(`
    SELECT COUNT(*) as c, COALESCE(SUM(story_points), 0) as pts FROM tickets
    WHERE sprint_id = ? AND deleted_at IS NULL AND created_at > ?
  `).get(sprintId, implStart) as { c: number; pts: number };

  const removed = db.prepare(`
    SELECT COUNT(DISTINCT entity_id) as c FROM event_log
    WHERE entity_type = 'ticket' AND field_name = 'sprint_id' AND old_value = CAST(? AS TEXT)
  `).get(sprintId) as CountRow;

  return { addedPoints: added.pts, addedTickets: added.c, removedTickets: removed.c };
}

/**
 * A1: auto-apply — flip action_applied on adopted try_next findings whose linked ticket
 * reached DONE (same pattern as get_discovery_coverage's auto-promote). Returns rows changed.
 */
export function autoApplyRetroActions(db: Database.Database): number {
  const r = db.prepare(`
    UPDATE retro_findings SET action_applied = 1
    WHERE category = 'try_next' AND status = 'adopted' AND action_applied = 0
      AND linked_ticket_id IN (SELECT id FROM tickets WHERE status = 'DONE')
  `).run();
  return r.changes;
}

/**
 * A1: try_next findings that still demand a planning decision — status 'open' and not
 * deferred within the last 24h (a planning session fits in a day; the next planning
 * re-surfaces deferred items).
 */
export interface UntriagedTryNextRow {
  id: number;
  finding: string;
  role: string | null;
  action_owner: string | null;
  origin_sprint: string;
  age_sprints: number;
}

export function getUntriagedTryNext(db: Database.Database): UntriagedTryNextRow[] {
  return db.prepare(`
    SELECT rf.id, rf.finding, rf.role, rf.action_owner, s.name as origin_sprint,
      (SELECT COUNT(*) FROM sprints s2 WHERE s2.id > rf.sprint_id AND s2.deleted_at IS NULL) as age_sprints
    FROM retro_findings rf JOIN sprints s ON rf.sprint_id = s.id
    WHERE rf.category = 'try_next' AND rf.status = 'open'
      AND (rf.deferred_at IS NULL OR rf.deferred_at < datetime('now', '-24 hours'))
    ORDER BY rf.sprint_id ASC, rf.id ASC
  `).all() as UntriagedTryNextRow[];
}

/**
 * A2: open discoveries with sprint-age annotation. P0/P1 items older than 3 sprints
 * are flagged escalated and block the planning gate.
 */
export interface OpenDiscoveryRow {
  id: number;
  finding: string;
  priority: string | null;
  category: string;
  origin_sprint: string;
  age_sprints: number;
  escalated: boolean;
}

export function getOpenDiscoveries(db: Database.Database): OpenDiscoveryRow[] {
  const rows = db.prepare(`
    SELECT d.id, d.finding, d.priority, d.category, s.name as origin_sprint,
      (SELECT COUNT(*) FROM sprints s2 WHERE s2.id > d.discovery_sprint_id AND s2.deleted_at IS NULL) as age_sprints
    FROM discoveries d JOIN sprints s ON d.discovery_sprint_id = s.id
    WHERE d.status = 'discovered'
    ORDER BY d.priority ASC, age_sprints DESC, d.id ASC
  `).all() as Omit<OpenDiscoveryRow, "escalated">[];
  return rows.map((d) => ({ ...d, escalated: (d.priority === "P0" || d.priority === "P1") && d.age_sprints > 3 }));
}

/**
 * A1+A2: planning gate evaluated by start_sprint. Blocks when untriaged try_next
 * findings or escalated open discoveries exist.
 */
export function checkPlanningGate(db: Database.Database): { blocked: boolean; sections: string[]; untriaged: number; escalated: number } {
  autoApplyRetroActions(db);
  const sections: string[] = [];
  const untriaged = getUntriagedTryNext(db);
  if (untriaged.length > 0) {
    sections.push(`## Untriaged try_next findings (${untriaged.length})`);
    sections.push(`Triage each with triage_retro_finding — adopt (requires ticket_id), drop (requires dropped_reason), or defer:`);
    untriaged.slice(0, 10).forEach((f) =>
      sections.push(`- #${f.id} [${f.origin_sprint}, ${f.age_sprints} sprint(s) old${f.action_owner ? `, owner: ${f.action_owner}` : ""}] ${truncateFinding(f.finding)}`));
    if (untriaged.length > 10) sections.push(`- …and ${untriaged.length - 10} more — list_retro_findings({ category: "try_next" })`);
  }
  const escalated = getOpenDiscoveries(db).filter((d) => d.escalated);
  if (escalated.length > 0) {
    sections.push(`## Escalated open discoveries (${escalated.length}) — P0/P1 older than 3 sprints`);
    sections.push(`Pull each into the sprint (link_discovery_to_ticket) or defer/drop it (update_discovery):`);
    escalated.forEach((d) =>
      sections.push(`- ⚠ ${d.priority} #${d.id} [open ${d.age_sprints} sprints] ${truncateFinding(d.finding)}`));
  }
  return { blocked: sections.length > 0, sections, untriaged: untriaged.length, escalated: escalated.length };
}

/**
 * A1+A2: planning context block injected by load_phase_context({ phase: "tickets" }).
 * Lists ALL open try_next findings (deferred ones marked) and open discoveries, plus
 * the triage directive the planning gate will enforce.
 */
export function buildPlanningGateContext(db: Database.Database): string {
  autoApplyRetroActions(db);
  const sections: string[] = [];

  interface OpenTryNextRow {
    id: number;
    finding: string;
    action_owner: string | null;
    origin_sprint: string;
    age_sprints: number;
    recently_deferred: number;
  }
  const tryNext = db.prepare(`
    SELECT rf.id, rf.finding, rf.action_owner, s.name as origin_sprint,
      (SELECT COUNT(*) FROM sprints s2 WHERE s2.id > rf.sprint_id AND s2.deleted_at IS NULL) as age_sprints,
      CASE WHEN rf.deferred_at IS NOT NULL AND rf.deferred_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END as recently_deferred
    FROM retro_findings rf JOIN sprints s ON rf.sprint_id = s.id
    WHERE rf.category = 'try_next' AND rf.status = 'open'
    ORDER BY rf.sprint_id ASC, rf.id ASC
  `).all() as OpenTryNextRow[];
  sections.push(`## Open try_next (${tryNext.length})`);
  if (tryNext.length === 0) sections.push("None — all triaged. ✓");
  else {
    tryNext.forEach((f) =>
      sections.push(`- #${f.id} [${f.age_sprints} sprint(s) old${f.action_owner ? `, owner: ${f.action_owner}` : ""}]${f.recently_deferred ? " (deferred)" : ""} ${truncateFinding(f.finding)}`));
  }

  const discoveries = getOpenDiscoveries(db);
  sections.push(`\n## Open discoveries (${discoveries.length})`);
  if (discoveries.length === 0) sections.push("None ✓");
  else discoveries.forEach((d) =>
    sections.push(`- ${d.escalated ? "⚠ ESCALATED " : ""}${d.priority} #${d.id} [open ${d.age_sprints} sprint(s)] ${truncateFinding(d.finding)}`));

  if (tryNext.length > 0 || discoveries.length > 0) {
    sections.push(`\n**Triage directive:** before start_sprint, resolve every open try_next (triage_retro_finding: adopt ≥1 as a ticket when feasible, else drop with reason or defer) and address escalated discoveries (pull in via link_discovery_to_ticket, or defer/drop via update_discovery). The start_sprint gate enforces this; acknowledge_open_items=true overrides.`);
  }
  return sections.join("\n");
}

/**
 * T-279: shared burndown-snapshot logic, callable in-process (no MCP round-trip).
 *
 * Upserts one row in sprint_metrics for (sprint_id, date) capturing remaining vs
 * completed points — the same query the snapshot_sprint_metrics tool exposes, so
 * the tool and the auto-telemetry hooks (ticket close, phase transition) stay in
 * lockstep. Returns the computed totals; an empty sprint snapshots a valid 0/0
 * point. Pure DB work — the caller decides whether to notify the dashboard, so
 * this never reaches outward (and stays safe to wrap in a fail-open try/catch).
 */
export function snapshotSprintMetrics(
  db: Database.Database,
  sprintId: number,
  date?: string,
): { date: string; remaining: number; completed: number } {
  const d = date || new Date().toISOString().split("T")[0];
  const tickets = db.prepare(`SELECT status, story_points FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL`).all(sprintId) as Pick<TicketRow, "status" | "story_points">[];
  const remaining = tickets.filter((t) => t.status !== "DONE").reduce((s, t) => s + (t.story_points || 0), 0);
  const completed = tickets.filter((t) => t.status === "DONE").reduce((s, t) => s + (t.story_points || 0), 0);
  db.prepare(`INSERT INTO sprint_metrics (sprint_id, date, remaining_points, completed_points) VALUES (?, ?, ?, ?) ON CONFLICT(sprint_id, date) DO UPDATE SET remaining_points=excluded.remaining_points, completed_points=excluded.completed_points`).run(sprintId, d, remaining, completed);
  return { date: d, remaining, completed };
}

/** Shape of a dump_database / export_to_file JSON file (validated where it is read). */
interface DatabaseDump {
  version: string;
  exported_at: string;
  tables: Record<string, Record<string, unknown>[] | undefined>;
}

/**
 * Register read-only MCP tools for the Scrum system.
 */
export function registerScrumTools(server: McpServer, db: Database.Database): void {

  registerAnalyticsTools(server, db);
  registerSkillsTools(server, db);
  registerGithubTools(server, db);

  server.tool(
    "list_agents",
    "List all scrum team agents with their roles and capabilities",
    {},
    async () => {
      const agents = db.prepare(`SELECT role, name, description, model FROM agents ORDER BY role`).all() as Pick<AgentRow, "role" | "name" | "description" | "model">[];
      if (agents.length === 0) return { content: [{ type: "text" as const, text: "No agents found. Run reset_agents to seed factory defaults." }] };
      const text = agents.map(a => `**${a.name}** (${a.role}) — ${a.description || "No description"}\nModel: ${a.model || "default"}`).join("\n\n");
      return { content: [{ type: "text" as const, text: `# Agents (${agents.length})\n\n${text}` }] };
    }
  );

  server.tool(
    "get_agent",
    "Get full details of a scrum agent by role",
    { role: z.string().describe("Agent role (e.g. 'backend-developer')") },
    async ({ role }) => {
      const agent = db.prepare(`SELECT * FROM agents WHERE role = ?`).get(role) as AgentRow | undefined;
      if (!agent) return { content: [{ type: "text" as const, text: `Agent "${role}" not found. Use list_agents to see available roles.` }] };
      const sections = [`# ${agent.name} (${agent.role})`, agent.description || "", `Model: ${agent.model || "default"}`, `Tools: ${agent.tools || "none"}`, "", "## System Prompt", agent.system_prompt || "(none)"];
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  server.tool(
    "update_agent",
    "Update a roster agent's model, tools, system prompt, name, description or department. The model drives the Model routing directive (claude-fable* → fable, claude-opus* → opus, claude-haiku* → haiku, everything else → sonnet), so only known Claude ids are accepted; omitted fields stay unchanged.",
    {
      role: z.string().describe("Agent role to update (see list_agents)"),
      model: z.string().optional().describe(`One of: ${KNOWN_AGENT_MODELS.join(", ")}`),
      tools: z.string().nullable().optional().describe("Free-text tool inventory shown by get_agent and the dashboard (null clears)"),
      system_prompt: z.string().nullable().optional().describe("Operating instructions for the role (null clears)"),
      name: z.string().optional(),
      description: z.string().optional(),
      department: z.string().optional(),
    },
    async ({ role, model, tools, system_prompt, name, description, department }) => {
      const agent = db.prepare(`SELECT role FROM agents WHERE role = ?`).get(role);
      if (!agent) return { content: [{ type: "text" as const, text: `Agent "${role}" not found. Use list_agents to see available roles.` }], isError: true };
      if (model !== undefined && !(KNOWN_AGENT_MODELS as readonly string[]).includes(model)) {
        return { content: [{ type: "text" as const, text: `Unknown model "${model}". Allowed: ${KNOWN_AGENT_MODELS.join(", ")}. Non-Claude runtimes (e.g. OpenCode implementers) are not roster agents — tag the ticket (impl:glm) instead.` }], isError: true };
      }
      const sets: string[] = []; const vals: unknown[] = [];
      if (model !== undefined) { sets.push("model=?"); vals.push(model); }
      if (tools !== undefined) { sets.push("tools=?"); vals.push(tools); }
      if (system_prompt !== undefined) { sets.push("system_prompt=?"); vals.push(system_prompt); }
      if (name !== undefined) { sets.push("name=?"); vals.push(name); }
      if (description !== undefined) { sets.push("description=?"); vals.push(description); }
      if (department !== undefined) { sets.push("department=?"); vals.push(department); }
      if (sets.length === 0) return { content: [{ type: "text" as const, text: "Nothing to update." }] };
      sets.push("updated_at=datetime('now')");
      db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE role = ?`).run(...vals, role);
      notifyDashboard(db);
      const updated = db.prepare(`SELECT role, name, model FROM agents WHERE role = ?`).get(role) as Pick<AgentRow, "role" | "name" | "model">; // exists: checked above
      return { content: [{ type: "text" as const, text: `Agent ${updated.name} (${updated.role}) updated — model ${updated.model ?? "default"} → tier ${modelToTier(updated.model)}.` }] };
    }
  );

  server.tool(
    "list_sprints",
    "List all sprints with status and ticket counts. Use compact=true for minimal output (id, name, status only) to save tokens.",
    {
      status: z.enum(["preparation", "kickoff", "planning", "implementation", "qa", "refactoring", "retro", "review", "closed", "rest", "done"]).optional().describe("Filter by status"),
      compact: z.boolean().optional().describe("Return minimal fields (id, name, status) to save tokens"),
      last_n: z.number().optional().describe("Return only the last N sprints (default: 20)"),
      project: z.string().optional().describe("Filter by project key"),
    },
    async ({ status, compact, last_n, project }) => {
      const limit = last_n ?? 20;
      if (compact) {
        let q = `SELECT id, name, status FROM sprints`;
        const params: unknown[] = [];
        const where: string[] = [];
        if (status) { where.push("status=?"); params.push(status); }
        if (project) { where.push("project=?"); params.push(project); }
        if (where.length) q += ` WHERE ${where.join(" AND ")}`;
        q += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const sprints = db.prepare(q).all(...params) as Pick<SprintRow, "id" | "name" | "status">[];
        if (sprints.length === 0) return { content: [{ type: "text" as const, text: "No sprints found." }] };
        const text = sprints.map((s) => `#${s.id} ${s.name} [${s.status}]`).join("\n");
        return { content: [{ type: "text" as const, text: `# Sprints (${sprints.length})\n${text}` }] };
      }
      let q = `SELECT s.*, COUNT(t.id) as ticket_count, SUM(CASE WHEN t.status='DONE' THEN 1 ELSE 0 END) as done_count FROM sprints s LEFT JOIN tickets t ON t.sprint_id=s.id`;
      const params: unknown[] = [];
      const where: string[] = [];
      if (status) { where.push("s.status=?"); params.push(status); }
      if (project) { where.push("s.project=?"); params.push(project); }
      if (where.length) q += ` WHERE ${where.join(" AND ")}`;
      q += ` GROUP BY s.id ORDER BY s.created_at DESC LIMIT ?`;
      params.push(limit);
      const sprints = db.prepare(q).all(...params) as (SprintRow & { ticket_count: number; done_count: number | null })[];
      if (sprints.length === 0) return { content: [{ type: "text" as const, text: "No sprints found." }] };
      const text = sprints.map(s => `**${s.name}** [${s.status.toUpperCase()}]\nGoal: ${s.goal || "—"}\nTickets: ${s.done_count}/${s.ticket_count} done | Velocity: ${s.velocity_completed}/${s.velocity_committed}`).join("\n\n");
      return { content: [{ type: "text" as const, text: `# Sprints (${sprints.length})\n\n${text}` }] };
    }
  );

  server.tool(
    "get_sprint_summary",
    "Get a one-line summary per sprint — name, status, velocity, ticket progress. Ultra-compact for quick overviews.",
    {
      last_n: z.number().optional().describe("Number of recent sprints (default: 5)"),
    },
    async ({ last_n }) => {
      const limit = last_n ?? 5;
      const sprints = db.prepare(`
        SELECT s.name, s.status, s.velocity_committed, s.velocity_completed,
               COUNT(t.id) as tickets, SUM(CASE WHEN t.status='DONE' THEN 1 ELSE 0 END) as done
        FROM sprints s LEFT JOIN tickets t ON t.sprint_id = s.id
        WHERE s.deleted_at IS NULL
        GROUP BY s.id ORDER BY s.created_at DESC LIMIT ?
      `).all(limit) as (Pick<SprintRow, "name" | "status" | "velocity_committed" | "velocity_completed"> & { tickets: number; done: number | null })[];
      if (sprints.length === 0) return { content: [{ type: "text" as const, text: "No sprints." }] };
      const lines = sprints.map((s) => {
        // NULL columns: `null > 0` is false and `null / n` is 0 — the guards below keep that
        const pct = s.velocity_committed !== null && s.velocity_committed > 0 ? Math.round(((s.velocity_completed ?? 0) / s.velocity_committed) * 100) : 0;
        return `${s.name} [${s.status}] ${s.velocity_completed}/${s.velocity_committed}pts (${pct}%) ${s.done}/${s.tickets} tickets`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_sprint",
    "Get full sprint details with tickets, bugs, blockers, and retro findings",
    { sprint_id: z.number().describe("Sprint ID") },
    async ({ sprint_id }) => {
      const sprint = getSprintById(db, sprint_id);
      if (!sprint) return { content: [{ type: "text" as const, text: `Sprint ${sprint_id} not found.` }] };
      const tickets = db.prepare(`SELECT id, ticket_ref, title, status, priority, assigned_to, story_points, qa_verified FROM tickets WHERE sprint_id=? ORDER BY priority`).all(sprint_id) as Pick<TicketRow, "id" | "ticket_ref" | "title" | "status" | "priority" | "assigned_to" | "story_points" | "qa_verified">[];
      const bugs = db.prepare(`SELECT id, severity, description, status FROM bugs WHERE sprint_id=?`).all(sprint_id) as Pick<BugRow, "id" | "severity" | "description" | "status">[];
      const blockers = db.prepare(`SELECT id, description, status FROM blockers WHERE sprint_id=?`).all(sprint_id) as Pick<BlockerRow, "id" | "description" | "status">[];
      const findings = db.prepare(`SELECT category, role, finding, action_owner, action_applied FROM retro_findings WHERE sprint_id=?`).all(sprint_id) as Pick<RetroFindingRow, "category" | "role" | "finding" | "action_owner" | "action_applied">[];

      const sections = [`# ${sprint.name} [${sprint.status.toUpperCase()}]`, `Goal: ${sprint.goal || "—"}`, `Velocity: ${sprint.velocity_completed}/${sprint.velocity_committed}`, ""];
      sections.push(`## Tickets (${tickets.length})`);
      tickets.forEach(t => { const qa = t.qa_verified ? " ✓QA" : ""; sections.push(`- [${t.status}] ${t.priority} ${t.ticket_ref || "#"+t.id}: ${t.title} (${t.story_points || 0}sp) @${t.assigned_to || "?"}${qa}`); });
      if (bugs.length) { sections.push("", `## Bugs (${bugs.length})`); bugs.forEach(b => sections.push(`- [${b.status}] ${b.severity}: ${b.description}`)); }
      if (blockers.length) { sections.push("", `## Blockers (${blockers.length})`); blockers.forEach(b => sections.push(`- [${b.status}] ${b.description}`)); }
      if (findings.length) {
        sections.push("", `## Retro (${findings.length})`);
        ["went_well", "went_wrong", "try_next"].forEach(cat => {
          const items = findings.filter(f => f.category === cat);
          if (items.length) { sections.push(`### ${cat.replace("_", " ")}`); items.forEach(f => sections.push(`- ${f.finding} (${f.role || "team"})${f.action_applied ? " [APPLIED]" : ""}`)); }
        });
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  server.tool(
    "list_tickets",
    "List tickets with optional filters. Use compact=true for minimal output (id, title, status) to save tokens.",
    {
      sprint_id: z.number().optional().describe("Filter by sprint"),
      status: z.enum(["TODO", "IN_PROGRESS", "DONE", "BLOCKED", "PARTIAL", "NOT_DONE"]).optional(),
      assigned_to: z.string().optional(),
      project: z.string().optional().describe("Filter by project key (own, else inherited from sprint/milestone/epic)"),
      compact: z.boolean().optional().describe("Return minimal fields (id, title, status) to save tokens"),
    },
    async ({ sprint_id, status, assigned_to, project, compact }) => {
      if (compact) {
        let q = `SELECT t.id, t.title, t.status FROM tickets t ${project ? TICKET_PROJECT_JOINS : ""} WHERE 1=1`;
        const p: unknown[] = [];
        if (sprint_id !== undefined) { q += " AND t.sprint_id=?"; p.push(sprint_id); }
        if (status) { q += " AND t.status=?"; p.push(status); }
        if (assigned_to) { q += " AND t.assigned_to=?"; p.push(assigned_to); }
        if (project) { q += ` AND ${EFFECTIVE_PROJECT_SQL}=?`; p.push(project); }
        q += " ORDER BY t.status, t.id LIMIT 50";
        const tickets = db.prepare(q).all(...p) as Pick<TicketRow, "id" | "title" | "status">[];
        if (tickets.length === 0) return { content: [{ type: "text" as const, text: "No tickets found." }] };
        const text = tickets.map((t) => `#${t.id} [${t.status}] ${t.title}`).join("\n");
        return { content: [{ type: "text" as const, text: `# Tickets (${tickets.length})\n${text}` }] };
      }
      let q = `SELECT t.*, s.name as sprint_name FROM tickets t ${TICKET_PROJECT_JOINS} WHERE 1=1`;
      const p: unknown[] = [];
      if (sprint_id !== undefined) { q += " AND t.sprint_id=?"; p.push(sprint_id); }
      if (status) { q += " AND t.status=?"; p.push(status); }
      if (assigned_to) { q += " AND t.assigned_to=?"; p.push(assigned_to); }
      if (project) { q += ` AND ${EFFECTIVE_PROJECT_SQL}=?`; p.push(project); }
      q += " ORDER BY t.priority, t.status LIMIT 50";
      const tickets = db.prepare(q).all(...p) as (TicketRow & { sprint_name: string | null })[];
      if (tickets.length === 0) return { content: [{ type: "text" as const, text: "No tickets found." }] };
      const text = tickets.map(t => `[${t.status}] ${t.priority} ${t.ticket_ref || "#"+t.id}: ${t.title} (${t.story_points || 0}sp) @${t.assigned_to || "?"} — ${t.sprint_name || "backlog"}${t.github_issue ? ` gh#${t.github_issue}` : ""}`).join("\n");
      return { content: [{ type: "text" as const, text: `# Tickets (${tickets.length})\n\n${text}` }] };
    }
  );

  server.tool(
    "get_ticket",
    "Get full ticket details with subtasks and linked bugs",
    { ticket_id: z.number().describe("Ticket ID") },
    async ({ ticket_id }) => {
      const t = db.prepare(`SELECT t.*, s.name as sprint_name FROM tickets t LEFT JOIN sprints s ON t.sprint_id=s.id WHERE t.id=?`).get(ticket_id) as (TicketRow & { sprint_name: string | null }) | undefined;
      if (!t) return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} not found.` }] };
      const subtasks = db.prepare(`SELECT * FROM subtasks WHERE ticket_id=?`).all(ticket_id) as SubtaskRow[];
      const bugs = db.prepare(`SELECT * FROM bugs WHERE ticket_id=?`).all(ticket_id) as BugRow[];
      const sections = [`# ${t.ticket_ref || "#"+t.id}: ${t.title}`, `Status: ${t.status} | Priority: ${t.priority} | Points: ${t.story_points || 0}`, `Sprint: ${t.sprint_name || "backlog"} | Assigned: ${t.assigned_to || "—"} | QA: ${t.qa_verified ? "Yes" : "No"}`];
      if (t.project || t.type || t.github_issue) sections.push(`Project: ${t.project || "—"} | Type: ${t.type || "—"} | GitHub: ${t.github_issue ? `${t.github_repo ?? ""}#${t.github_issue}` : "—"}`);
      sections.push("");
      if (t.description) sections.push("## Description", t.description, "");
      if (t.acceptance_criteria) { sections.push("## Acceptance Criteria"); try { JSON.parse(t.acceptance_criteria).forEach((c: string) => sections.push(`- ${c}`)); } catch { sections.push(t.acceptance_criteria); } sections.push(""); }
      if (subtasks.length) { sections.push(`## Subtasks (${subtasks.length})`); subtasks.forEach(s => sections.push(`- [${s.status}] ${s.description} @${s.assigned_to || "?"}`)); sections.push(""); }
      if (bugs.length) { sections.push(`## Bugs (${bugs.length})`); bugs.forEach(b => sections.push(`- [${b.status}] ${b.severity}: ${b.description}`)); }
      const routing = buildModelRoutingSection(db, t);
      if (routing) sections.push("", routing);
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  server.tool(
    "list_retro_findings",
    "List retrospective findings with optional filters",
    { sprint_id: z.number().optional(), category: z.enum(["went_well", "went_wrong", "try_next"]).optional() },
    async ({ sprint_id, category }) => {
      let q = `SELECT rf.*, s.name as sprint_name FROM retro_findings rf JOIN sprints s ON rf.sprint_id=s.id WHERE 1=1`;
      const p: unknown[] = [];
      if (sprint_id !== undefined) { q += " AND rf.sprint_id=?"; p.push(sprint_id); }
      if (category) { q += " AND rf.category=?"; p.push(category); }
      q += " ORDER BY rf.sprint_id DESC, rf.category";
      const findings = db.prepare(q).all(...p) as (RetroFindingRow & { sprint_name: string })[];
      if (findings.length === 0) return { content: [{ type: "text" as const, text: "No retro findings found." }] };
      const text = findings.map(f => `[${f.category.replace("_", " ")}] ${f.finding} (${f.role || "team"}, Sprint: ${f.sprint_name})${f.action_applied ? " [APPLIED]" : ""}`).join("\n");
      return { content: [{ type: "text" as const, text: `# Retro Findings (${findings.length})\n\n${text}` }] };
    }
  );

  server.tool(
    "search_scrum",
    "Full-text search across tickets, retro findings, blockers, and bugs",
    { query: z.string().describe("Search term") },
    async ({ query }) => {
      const pattern = `%${query}%`;
      const results: string[] = [`# Search: "${query}"`, ""];
      const tickets = db.prepare(`SELECT id, ticket_ref, title, status, priority FROM tickets WHERE title LIKE ? OR description LIKE ? LIMIT 10`).all(pattern, pattern) as Pick<TicketRow, "id" | "ticket_ref" | "title" | "status" | "priority">[];
      if (tickets.length) { results.push(`## Tickets (${tickets.length})`); tickets.forEach(t => results.push(`- [${t.status}] ${t.priority} ${t.ticket_ref || "#"+t.id}: ${t.title}`)); results.push(""); }
      const findings = db.prepare(`SELECT finding, category, role FROM retro_findings WHERE finding LIKE ? LIMIT 10`).all(pattern) as Pick<RetroFindingRow, "finding" | "category" | "role">[];
      if (findings.length) { results.push(`## Retro (${findings.length})`); findings.forEach(f => results.push(`- [${f.category}] ${f.finding}`)); results.push(""); }
      const bugs = db.prepare(`SELECT id, severity, description, status FROM bugs WHERE description LIKE ? LIMIT 10`).all(pattern) as Pick<BugRow, "id" | "severity" | "description" | "status">[];
      if (bugs.length) { results.push(`## Bugs (${bugs.length})`); bugs.forEach(b => results.push(`- [${b.status}] ${b.severity}: ${b.description}`)); }
      if (tickets.length + findings.length + bugs.length === 0) return { content: [{ type: "text" as const, text: `No results for "${query}".` }] };
      return { content: [{ type: "text" as const, text: results.join("\n") }] };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_sprint",
    "Create a new sprint",
    {
      name: z.string().describe("Sprint name (e.g. 'sprint-2026-04-07')"),
      goal: z.string().optional().describe("Sprint goal"),
      start_date: z.string().optional().describe("Start date (ISO 8601)"),
      end_date: z.string().optional().describe("End date (ISO 8601)"),
      milestone_id: z.number().optional().describe("Milestone ID to associate with"),
      project: z.string().optional().describe("Project key (see set_project); omit = unassigned"),
    },
    async ({ name, goal, start_date, end_date, milestone_id, project }) => {
      try {
        const badProject = unknownProject(db, project);
        if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };
        const result = db.prepare(`INSERT INTO sprints (name, goal, start_date, end_date, milestone_id, status, project) VALUES (?, ?, ?, ?, ?, 'planning', ?)`).run(name, goal || null, start_date || null, end_date || null, milestone_id || null, project ?? null);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Sprint created: ${name} (id: ${result.lastInsertRowid})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_sprint",
    "Update sprint status or details",
    {
      sprint_id: z.number().describe("Sprint ID"),
      status: z.enum(["preparation", "kickoff", "planning", "implementation", "qa", "refactoring", "retro", "review", "closed", "rest", "done"]).optional(),
      goal: z.string().optional(),
      velocity_committed: z.number().optional(),
      velocity_completed: z.number().optional(),
      milestone_id: z.number().optional().describe("Milestone ID to associate with"),
      project: z.string().nullable().optional().describe("Project key (see set_project), null to unassign"),
    },
    async ({ sprint_id, status, goal, velocity_committed, velocity_completed, milestone_id, project }) => {
      const sprint = getSprintById(db, sprint_id);
      if (!sprint) return { content: [{ type: "text" as const, text: `Sprint #${sprint_id} not found.` }], isError: true };
      const badProject = unknownProject(db, project);
      if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };

      // ─── Phase transition gates (advisory) ─────────────────────
      let gateWarnings: string[] = [];
      if (status) {
        const effectivePhase = resolvePhase(sprint.status);
        const allowed = PHASE_TRANSITIONS[effectivePhase];
        if (allowed && allowed !== status) {
          // Allow the transition but warn
          gateWarnings.push(`Unusual transition: ${sprint.status} → ${status}. Expected next: ${allowed}`);
        }

        const gates = checkSprintGates(db, sprint, status);
        gateWarnings = gateWarnings.concat(gates.warnings);
      }

      // ─── Apply updates ──────────────────────────────────────────
      const sets: string[] = []; const vals: unknown[] = [];
      const oldStatus = sprint.status;
      if (status) { sets.push("status=?"); vals.push(status); }
      if (goal) { sets.push("goal=?"); vals.push(goal); }
      if (milestone_id !== undefined) { sets.push("milestone_id=?"); vals.push(milestone_id); }
      if (project !== undefined) { sets.push("project=?"); vals.push(project); }
      if (velocity_committed !== undefined) { sets.push("velocity_committed=?"); vals.push(velocity_committed); }
      if (velocity_completed !== undefined) { sets.push("velocity_completed=?"); vals.push(velocity_completed); }
      if (sets.length === 0) return { content: [{ type: "text" as const, text: "Nothing to update." }] };
      sets.push("updated_at=datetime('now')");
      vals.push(sprint_id);
      db.prepare(`UPDATE sprints SET ${sets.join(",")} WHERE id=?`).run(...vals);

      // ─── Event trail ────────────────────────────────────────────
      if (status && status !== oldStatus) {
        try {
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'status_changed', 'status', ?, ?, 'mcp')`).run(sprint_id, oldStatus, status);
        } catch (e) {
          console.error(`[audit] update_sprint sprint #${sprint_id} status ${oldStatus}→${status}: ` + errorMessage(e));
        }
        slog("INFO", `update_sprint: sprint=${sprint_id} phase ${oldStatus}→${status}`);
      }
      if (gateWarnings.length > 0) {
        slog("WARN", `update_sprint: gate warnings sprint=${sprint_id} to=${status} count=${gateWarnings.length}`);
      }

      // M12-015: Auto-generate retro analysis when sprint is done or closed
      let retroNote = "";
      if (status === "closed" || status === "done") {
        try {
          const sprint = getSprintById(db, sprint_id)!; // missing row throws into the catch below, as before
          const tickets = db.prepare(`SELECT id, status, story_points FROM tickets WHERE sprint_id=?`).all(sprint_id) as Pick<TicketRow, "id" | "status" | "story_points">[];
          const totalTickets = tickets.length;
          const doneTickets = tickets.filter((t) => t.status === "DONE").length;
          const completionRate = totalTickets > 0 ? Math.round((doneTickets / totalTickets) * 100) : 0;
          const committedPts = sprint.velocity_committed || 0;
          const completedPts = sprint.velocity_completed || tickets.filter((t) => t.status === "DONE").reduce((s: number, t) => s + (t.story_points || 0), 0);
          const velocityDelta = completedPts - committedPts;
          const blockerCount = (db.prepare(`SELECT COUNT(*) as c FROM blockers WHERE sprint_id=?`).get(sprint_id) as CountRow).c;

          // Velocity trend from last 5 closed sprints
          const recentSprints = db.prepare(`SELECT name, velocity_committed, velocity_completed FROM sprints WHERE status='closed' AND id != ? ORDER BY id DESC LIMIT 5`).all(sprint_id) as Pick<SprintRow, "name" | "velocity_committed" | "velocity_completed">[];
          const trendText = recentSprints.length > 0
            ? recentSprints.map((s) => `${s.name}: ${s.velocity_completed}/${s.velocity_committed}`).join(", ")
            : "No prior sprints";

          const summary = [
            `Auto-analysis for ${sprint.name}:`,
            `Velocity: ${completedPts}/${committedPts} (delta: ${velocityDelta >= 0 ? "+" : ""}${velocityDelta})`,
            `Ticket completion: ${doneTickets}/${totalTickets} (${completionRate}%)`,
            `Blockers: ${blockerCount}`,
            `Trend (last 5): ${trendText}`,
          ].join(" | ");

          db.prepare(`INSERT INTO retro_findings (sprint_id, category, finding, role) VALUES (?, 'auto_analysis', ?, 'system')`).run(sprint_id, summary);
          retroNote = "\nAuto retro analysis generated.";
        } catch {
          // Non-fatal — don't block the update
        }

        // Auto-archive discoveries linked to this sprint
        try {
          const implemented = db.prepare(`
            UPDATE discoveries SET status = 'implemented', updated_at = datetime('now')
            WHERE discovery_sprint_id = ? AND status = 'planned'
              AND implementation_ticket_id IN (SELECT id FROM tickets WHERE sprint_id = ? AND status = 'DONE')
          `).run(sprint_id, sprint_id).changes;
          const dropped = db.prepare(`
            UPDATE discoveries SET status = 'dropped', drop_reason = 'Sprint closed without completion', updated_at = datetime('now')
            WHERE discovery_sprint_id = ? AND status = 'planned'
              AND implementation_ticket_id IN (SELECT id FROM tickets WHERE sprint_id = ? AND status NOT IN ('DONE'))
          `).run(sprint_id, sprint_id).changes;
          if (implemented + dropped > 0) slog("INFO", `update_sprint: archived discoveries sprint=${sprint_id} implemented=${implemented} dropped=${dropped}`);
        } catch {}
      }

      notifyDashboard(db);
      const warningText = gateWarnings.length > 0 ? `\nWarnings:\n${gateWarnings.map(w => `- ${w}`).join("\n")}` : "";
      return { content: [{ type: "text" as const, text: `Sprint ${sprint_id} updated.${retroNote}${warningText}` }] };
    }
  );

  // ─── Ceremony Tool: advance_sprint ──────────────────────────────────────────
  server.tool(
    "advance_sprint",
    "Advance sprint to the next phase. Checks all gates, advances if they pass, returns summary + next actions. If gates fail, returns what needs to be fixed.",
    {
      sprint_id: z.number().describe("Sprint ID"),
      velocity_completed: z.number().optional().describe("Velocity completed (required when advancing to closed)"),
      format: z.enum(["text", "card"]).optional().describe("card = diff-fence transition card (launch/pulse/complete) + summary"),
      acknowledge_open_items: z.boolean().optional().describe("Override the planning gate on planning → implementation (untriaged try_next / escalated discoveries)"),
    },
    async ({ sprint_id, velocity_completed: _velocity_completed, format, acknowledge_open_items }) => {
      let velocity_completed = _velocity_completed;
      const sprint = getSprintById(db, sprint_id);
      if (!sprint) return { content: [{ type: "text" as const, text: `Sprint #${sprint_id} not found.` }], isError: true };

      // Resolve legacy phases to the nearest simplified phase for transition lookup
      const effectivePhase = resolvePhase(sprint.status);
      const nextPhase = PHASE_TRANSITIONS[effectivePhase];
      if (!nextPhase) return { content: [{ type: "text" as const, text: `Sprint "${sprint.name}" is in ${sprint.status} — no next phase.` }] };

      // A1+A2+A3: pre-created sprints pass the planning gate here (discovery #20) —
      // gate passage is the commitment moment, so velocity freezes on this transition too.
      if (nextPhase === "implementation") {
        const gate = checkPlanningGate(db);
        if (gate.blocked && !acknowledge_open_items) {
          slog("WARN", `advance_sprint: planning gate blocked sprint=${sprint_id} untriaged_try_next=${gate.untriaged} escalated_discoveries=${gate.escalated}`);
          return { content: [{ type: "text" as const, text: [
            `⛔ SPRINT ADVANCE BLOCKED — planning gate (planning → implementation)`,
            ``,
            ...gate.sections,
            ``,
            `Triage the items above, then call advance_sprint again. To advance anyway, pass acknowledge_open_items: true (defers the decisions — they re-surface at the next planning).`,
          ].join("\n") }] };
        }
      }

      const tickets = getTicketsBySprint(db, sprint_id);

      // A3: freeze commitment at implementation start if not explicitly set — never recalculated after
      if (nextPhase === "implementation" && (!sprint.velocity_committed || sprint.velocity_committed <= 0)) {
        const frozen = tickets.reduce((s: number, t) => s + (t.story_points || 0), 0);
        db.prepare(`UPDATE sprints SET velocity_committed = ? WHERE id = ?`).run(frozen, sprint_id);
        sprint.velocity_committed = frozen;
      }

      // Use shared gate checks (advisory — never blocks)
      const gates = checkSprintGates(db, sprint, nextPhase);

      // Auto-calculate velocity_completed from DONE tickets if not provided
      if ((nextPhase === "done" || nextPhase === "closed") && !velocity_completed && !sprint.velocity_completed) {
        const autoVelocity = tickets.filter((t) => t.status === "DONE").reduce((s: number, t) => s + (t.story_points || 0), 0);
        velocity_completed = autoVelocity;
      }

      // Gates are advisory — always proceed, but include warnings in response
      const warningText = gates.warnings.length > 0 ? `\nWarnings:\n${gates.warnings.map(w => `- ${w}`).join("\n")}` : "";

      // Advance sprint + archive discoveries atomically — partial failure rolls back cleanly
      let retroNote = "";
      let archivedImplemented = 0;
      let archivedDropped = 0;
      db.transaction(() => {
        const sets = ["status=?", "updated_at=datetime('now')"];
        const vals: unknown[] = [nextPhase];
        if (velocity_completed !== undefined) { sets.push("velocity_completed=?"); vals.push(velocity_completed); }
        vals.push(sprint_id);
        db.prepare(`UPDATE sprints SET ${sets.join(",")} WHERE id=?`).run(...vals);

        db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'status_changed', 'status', ?, ?, 'mcp')`).run(sprint_id, sprint.status, nextPhase);

        // Auto retro analysis when reaching done or closed
        if (nextPhase === "done" || nextPhase === "closed") {
          const totalTickets = tickets.length;
          const doneTickets = tickets.filter((t) => t.status === "DONE").length;
          const completionRate = totalTickets > 0 ? Math.round((doneTickets / totalTickets) * 100) : 0;
          const pts = velocity_completed || sprint.velocity_completed || tickets.filter((t) => t.status === "DONE").reduce((s: number, t) => s + (t.story_points || 0), 0);
          const summary = `Auto-analysis: ${doneTickets}/${totalTickets} tickets done (${completionRate}% completion rate). Velocity: ${pts}pt completed of ${sprint.velocity_committed || 0}pt committed.`;
          db.prepare(`INSERT INTO retro_findings (sprint_id, category, finding, role) VALUES (?, 'auto_analysis', ?, 'system')`).run(sprint_id, summary);
          retroNote = "\nAuto retro analysis generated.";

          // Auto-archive discoveries: mark "planned" discoveries with completed tickets as "implemented"
          archivedImplemented = db.prepare(`
            UPDATE discoveries SET status = 'implemented', updated_at = datetime('now')
            WHERE discovery_sprint_id = ? AND status = 'planned'
              AND implementation_ticket_id IN (SELECT id FROM tickets WHERE sprint_id = ? AND status = 'DONE')
          `).run(sprint_id, sprint_id).changes;

          // Auto-drop discoveries that were planned but ticket was not completed
          archivedDropped = db.prepare(`
            UPDATE discoveries SET status = 'dropped', drop_reason = 'Sprint closed without completion', updated_at = datetime('now')
            WHERE discovery_sprint_id = ? AND status = 'planned'
              AND implementation_ticket_id IN (SELECT id FROM tickets WHERE sprint_id = ? AND status NOT IN ('DONE'))
          `).run(sprint_id, sprint_id).changes;
        }
      })();

      slog("INFO", `advance_sprint: sprint=${sprint_id} phase ${sprint.status}→${nextPhase}`);
      if (gates.warnings.length > 0) {
        slog("WARN", `advance_sprint: gate warnings sprint=${sprint_id} to=${nextPhase} count=${gates.warnings.length}`);
      }
      if (archivedImplemented + archivedDropped > 0) {
        slog("INFO", `advance_sprint: archived discoveries sprint=${sprint_id} implemented=${archivedImplemented} dropped=${archivedDropped}`);
      }

      // Build next-action guidance
      const NEXT_ACTIONS: Record<string, string> = {
        implementation: "Agents work on tickets. Update ticket status via update_ticket as work progresses. Call advance_sprint once all tickets are DONE.",
        done: "Sprint work complete. Review results, add retro findings via add_retro_finding, then call advance_sprint to move to rest.",
        rest: "Sprint complete. Call start_sprint to begin the next sprint.",
        planning: "Assign tickets, set velocity, then call advance_sprint to start implementation.",
      };

      notifyDashboard(db);

      // T-279: snapshot burndown at every phase transition so the curve has
      // anchor points even when no manual snapshot_sprint_metrics call was made
      // (retro try_next #122). Fail-open like the commit gate — a telemetry write
      // must never fail an advance, so errors are swallowed to stderr (T-269 audit
      // pattern) after the transition has already committed above.
      try {
        snapshotSprintMetrics(db, sprint_id);
      } catch (e) {
        console.error(`[audit] advance_sprint sprint #${sprint_id} auto-snapshot (${sprint.status}→${nextPhase}): ` + errorMessage(e));
      }

      // B4: server-side auto-emit — phase transitions appear in the wizard timeline
      const PHASE_INDEX: Record<string, number> = { planning: 1, implementation: 2, done: 3, rest: 4 };
      notifyDashboard(db, {
        type: "step_progress",
        entityType: "sprint",
        entityId: sprint_id,
        stepProgress: {
          step: `phase-${nextPhase}`,
          title: `${sprint.name}: ${sprint.status} → ${nextPhase}`,
          description: "",
          current: PHASE_INDEX[nextPhase] || 0,
          total: 4,
          status: "completed",
        },
      });

      const summaryText = `Sprint "${sprint.name}" advanced: ${sprint.status} → ${nextPhase}${retroNote}${warningText}\n\nNext: ${NEXT_ACTIONS[nextPhase] || "Proceed to next phase."}`;

      // B1: card mode — transition-specific server-rendered card above the summary
      if (format === "card") {
        let card: string | null = null;
        if (nextPhase === "implementation") {
          card = launchCard({
            sprintName: sprint.name,
            goal: sprint.goal || "",
            ticketCount: tickets.length,
            points: tickets.reduce((s: number, t) => s + (t.story_points || 0), 0),
            phase: "implementation",
          });
        } else if (nextPhase === "rest") {
          const doneTickets = tickets.filter((t) => t.status === "DONE");
          card = sprintCompleteCard({
            sprintName: sprint.name,
            completed: velocity_completed ?? sprint.velocity_completed ?? doneTickets.reduce((s: number, t) => s + (t.story_points || 0), 0),
            committed: sprint.velocity_committed || 0,
            ticketsDone: doneTickets.length,
            ticketsTotal: tickets.length,
            qaAllVerified: doneTickets.length > 0 && doneTickets.every((t) => t.qa_verified),
          });
        } else {
          const pulse = buildSprintPulseData(db, sprint_id);
          if (pulse) card = sprintPulse(pulse);
        }
        if (card) return { content: [{ type: "text" as const, text: `${fenceCard(card)}\n${summaryText}` }] };
      }

      return { content: [{ type: "text" as const, text: summaryText }] };
    }
  );

  server.tool(
    "create_ticket",
    "Create a new ticket in a sprint",
    {
      sprint_id: z.number().describe("Sprint ID"),
      title: z.string().describe("Ticket title"),
      ticket_ref: z.string().optional().describe("Reference ID (e.g. T-021)"),
      description: z.string().optional(),
      priority: z.enum(["P0", "P1", "P2", "P3"]).optional().default("P2"),
      assigned_to: z.string().optional(),
      story_points: z.number().optional(),
      milestone: z.string().optional(),
      milestone_id: z.number().optional().describe("Milestone ID to link to"),
      epic_id: z.number().optional().describe("Epic ID to link to"),
      project: z.string().optional().describe("Project key (see set_project); omit = inherit from sprint/milestone/epic"),
      type: z.enum(TYPE_LABELS).optional().describe("Issue type for the GitHub sync"),
      origin: z.enum(["ai", "human"]).optional().describe("Who created it (GitHub label ai_issue / issue); default ai"),
      agents: z.array(z.object({
        role: z.string().describe("Agent role"),
        model: z.string().nullable().optional().describe("Per-assignment model override (null/omit = agent default)"),
        lead: z.boolean().optional().describe("Exactly one assignment must be the lead"),
      })).optional().describe("D2: multi-agent assignments (overrides assigned_to; lead mirrors into it)"),
    },
    async ({ sprint_id, title, ticket_ref, description, priority, assigned_to, story_points, milestone, milestone_id, epic_id, project, type, origin, agents }) => {
      try {
        const badProject = unknownProject(db, project);
        if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };
        if (!agents) {
          const badRole = unknownRosterRole(db, assigned_to);
          if (badRole) return { content: [{ type: "text" as const, text: badRole }], isError: true };
        }
        // Resolve milestone name from milestone_id if not provided directly
        let milestoneName = milestone || null;
        if (milestone_id && !milestoneName) {
          const ms = db.prepare(`SELECT name FROM milestones WHERE id = ?`).get(milestone_id) as Pick<MilestoneRow, "name"> | undefined;
          if (ms) milestoneName = ms.name;
        }
        const result = db.prepare(`INSERT INTO tickets (sprint_id, ticket_ref, title, description, priority, assigned_to, story_points, milestone, milestone_id, epic_id, project, type, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sprint_id, ticket_ref || null, title, description || null, priority, assigned_to || null, story_points || null, milestoneName, milestone_id || null, epic_id || null, project ?? null, type ?? null, origin ?? null);
        const newTicketId = Number(result.lastInsertRowid);
        // D2: explicit assignments win; otherwise assigned_to seeds the lead row (backfill pattern)
        if (agents) {
          try {
            applyTicketAssignments(db, newTicketId, agents);
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Ticket created (#${newTicketId}) but assignments failed: ${errorMessage(e)}` }], isError: true };
          }
        } else if (assigned_to) {
          try {
            db.prepare(`INSERT OR IGNORE INTO ticket_assignments (ticket_id, role, is_lead) VALUES (?, ?, 1)`).run(newTicketId, assigned_to);
          } catch { /* pre-v23 DB */ }
        }
        notifyDashboard(db);
        notifyDashboard(db, { type: "entity_changed", entityType: "ticket", entityId: newTicketId }); // B4
        return { content: [{ type: "text" as const, text: `Ticket created: ${ticket_ref || '#'+newTicketId} — ${title}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_ticket",
    "Update a ticket's status, assignment, milestone, epic, QA verification, or actual time. Closing a ticket (status=DONE) auto-snapshots sprint burndown; supply actual_hours to record time against the assigned agent — both are best-effort and never block the close.",
    {
      ticket_id: z.number().describe("Ticket ID"),
      status: z.enum(["TODO", "IN_PROGRESS", "DONE", "BLOCKED", "PARTIAL", "NOT_DONE"]).optional(),
      assigned_to: z.string().optional(),
      qa_verified: z.boolean().optional(),
      verified_by: z.string().optional(),
      notes: z.string().optional(),
      milestone_id: z.number().nullable().optional().describe("Milestone ID to link to (null to unlink)"),
      epic_id: z.number().nullable().optional().describe("Epic ID to link to (null to unlink)"),
      actual_hours: z.number().optional().describe("T-279: actual hours spent — recorded against the ticket's assigned agent via the same column log_time writes, so get_time_report attributes it without a separate ceremony call"),
      agents: z.array(z.object({
        role: z.string().describe("Agent role"),
        model: z.string().nullable().optional().describe("Per-assignment model override (null/omit = agent default)"),
        lead: z.boolean().optional().describe("Exactly one assignment must be the lead (implements; others verify)"),
      })).optional().describe("D2: replace-set multi-agent assignments for this ticket"),
      format: z.enum(["text", "card"]).optional().describe("card = diff-fence sprint card + compact state in one response (no follow-up get_ticket needed)"),
      project: z.string().nullable().optional().describe("Project key (see set_project), null to unassign"),
      type: z.enum(TYPE_LABELS).nullable().optional().describe("Issue type for the GitHub sync, null to clear"),
      origin: z.enum(["ai", "human"]).nullable().optional().describe("Who created it (label ai_issue / issue), null = unset"),
      github_issue: z.number().int().positive().nullable().optional().describe("Linked GitHub issue number, null to unlink"),
    },
    async ({ ticket_id, status, assigned_to, qa_verified, verified_by, notes, milestone_id, epic_id, actual_hours, agents, format, project, type, origin, github_issue }) => {
      const ticket = db.prepare(`SELECT t.*, s.status as sprint_status, s.name as sprint_name FROM tickets t LEFT JOIN sprints s ON t.sprint_id = s.id WHERE t.id = ?`).get(ticket_id) as (TicketRow & { sprint_status: string | null; sprint_name: string | null }) | undefined;
      if (!ticket) return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} not found.` }], isError: true };

      // ─── Gate enforcement ───────────────────────────────────────
      const gates: string[] = [];

      if (status === "DONE") {
        // Assignment is optional — no gate for unassigned tickets
        if (ticket.sprint_id && !["implementation", "qa", "done"].includes(ticket.sprint_status ?? "")) gates.push(`Sprint "${ticket.sprint_name}" is in ${ticket.sprint_status} phase — must be in implementation, qa, or done`);
      }
      if (status === "IN_PROGRESS") {
        if (ticket.sprint_id && !["implementation", "qa", "done"].includes(ticket.sprint_status ?? "")) gates.push(`Sprint "${ticket.sprint_name}" is in ${ticket.sprint_status} phase — must be in implementation, qa, or done`);
      }

      if (gates.length > 0) {
        slog("WARN", `update_ticket: gate blocked ticket=${ticket_id} rule=sprint-phase to=${status} sprint=${ticket.sprint_id} sprint_phase=${ticket.sprint_status}`);
        return { content: [{ type: "text" as const, text: `Gate blocked for ticket #${ticket_id}:\n${gates.map(g => `- ${g}`).join("\n")}` }], isError: true };
      }

      // ─── T-274: commit-format QA gate ───────────────────────────
      // Only fires when QA verification is being SET (qa_verified:true). Plain
      // status updates never invoke git. The ticket's referencing commits
      // (git log main..HEAD --grep <ref>) must each carry the Why:/What:/How:
      // body groups. Zero referencing commits → exempt; git/repo unavailable →
      // fail-open (skip with a note, never strand the ticket). Runs before any
      // mutation so a block leaves the row untouched.
      if (qa_verified === true && !ticket.qa_verified && ticket.ticket_ref) {
        const fmt = checkCommitFormat(ticket.ticket_ref);
        if (!fmt.ok && fmt.violations.length > 0) {
          slog("WARN", `update_ticket: gate blocked ticket=${ticket_id} rule=commit-format violations=${fmt.violations.length}`);
          return { content: [{ type: "text" as const, text: formatCommitFormatBlock(ticket.ticket_ref, fmt) }], isError: true };
        }
      }

      if (assigned_to && !agents) {
        const badRole = unknownRosterRole(db, assigned_to);
        if (badRole) return { content: [{ type: "text" as const, text: badRole }], isError: true };
      }
      const badProject = unknownProject(db, project);
      if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };

      // ─── Apply updates ──────────────────────────────────────────
      const sets: string[] = []; const vals: unknown[] = [];
      const oldStatus = ticket.status;
      if (status) { sets.push("status=?"); vals.push(status); }
      if (assigned_to) { sets.push("assigned_to=?"); vals.push(assigned_to); }
      if (qa_verified !== undefined) { sets.push("qa_verified=?"); vals.push(qa_verified ? 1 : 0); }
      if (verified_by) { sets.push("verified_by=?"); vals.push(verified_by); }
      if (notes) { sets.push("notes=?"); vals.push(notes); }
      // T-279: actual time rides the same column log_time writes; get_time_report
      // groups by assigned_to, so the ticket's current/incoming assignee gets credit.
      if (actual_hours !== undefined) { sets.push("actual_hours=?"); vals.push(actual_hours); }
      if (epic_id !== undefined) { sets.push("epic_id=?"); vals.push(epic_id); }
      if (project !== undefined) { sets.push("project=?"); vals.push(project); }
      if (type !== undefined) { sets.push("type=?"); vals.push(type); }
      if (origin !== undefined) { sets.push("origin=?"); vals.push(origin); }
      // A hand-set number has no known repo: the sync assumes the project's repo.
      // The recorded node id belongs to the old issue: drop it, so the sync never
      // treats the new number as the issue it created (CCA-14).
      if (github_issue !== undefined) { sets.push("github_issue=?", "github_repo=NULL", "github_node_id=NULL"); vals.push(github_issue); }
      if (milestone_id !== undefined) {
        sets.push("milestone_id=?"); vals.push(milestone_id);
        if (milestone_id) {
          const ms = db.prepare(`SELECT name FROM milestones WHERE id = ?`).get(milestone_id) as Pick<MilestoneRow, "name"> | undefined;
          sets.push("milestone=?"); vals.push(ms?.name || null);
        } else {
          sets.push("milestone=?"); vals.push(null);
        }
      }
      if (sets.length === 0 && !agents) return { content: [{ type: "text" as const, text: "Nothing to update." }] };

      // D2: replace-set assignments (validates roles + exactly-one-lead; mirrors lead to assigned_to)
      if (agents) {
        try {
          applyTicketAssignments(db, ticket_id, agents);
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Assignment error: ${errorMessage(e)}` }], isError: true };
        }
      }
      if (sets.length === 0) {
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} assignments updated (${agents!.length} agent(s), lead: ${agents!.find(a => a.lead)?.role ?? agents![0].role}).` }] };
      }
      sets.push("updated_at=datetime('now')");
      vals.push(ticket_id);
      // Update ticket + auto-promote discoveries atomically
      db.transaction(() => {
        db.prepare(`UPDATE tickets SET ${sets.join(",")} WHERE id=?`).run(...vals);

        // D2: legacy single-agent updates keep the assignments table in sync (new lead, supporters kept)
        if (assigned_to && !agents) {
          try {
            db.prepare(`DELETE FROM ticket_assignments WHERE ticket_id = ? AND (is_lead = 1 OR role = ?)`).run(ticket_id, assigned_to);
            db.prepare(`INSERT INTO ticket_assignments (ticket_id, role, is_lead) VALUES (?, ?, 1)`).run(ticket_id, assigned_to);
          } catch { /* pre-v23 DB */ }
        }

        if (status === 'DONE') {
          db.prepare(`
            UPDATE discoveries SET status = 'implemented', updated_at = datetime('now')
            WHERE status = 'planned' AND implementation_ticket_id = ?
          `).run(ticket_id);
        }
      })();

      // ─── Event trail ────────────────────────────────────────────
      if (status && status !== oldStatus) {
        try {
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('ticket', ?, 'status_changed', 'status', ?, ?, 'mcp')`).run(ticket_id, oldStatus, status);
        } catch (e) {
          console.error(`[audit] update_ticket ticket #${ticket_id} status ${oldStatus}→${status}: ` + errorMessage(e));
        }
        slog("INFO", `update_ticket: ticket=${ticket_id} status ${oldStatus}→${status}`);
      }
      if (qa_verified !== undefined) {
        try {
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('ticket', ?, 'updated', 'qa_verified', ?, ?, 'mcp')`).run(ticket_id, ticket.qa_verified ? 'true' : 'false', qa_verified ? 'true' : 'false');
        } catch (e) {
          console.error(`[audit] update_ticket ticket #${ticket_id} qa_verified→${qa_verified}: ` + errorMessage(e));
        }
      }

      notifyDashboard(db);

      // T-279: auto-snapshot burndown when a ticket closes — accumulates data
      // points without a manual snapshot_sprint_metrics call (retro try_next #122:
      // two retros quoted 0h est/0h actual and zero burndown snapshots). Fail-open
      // exactly like the commit gate: a telemetry write must NEVER block or fail a
      // close, so any error is swallowed to stderr (audit pattern from T-269) and
      // the close still returns success. Fires only on a real transition to DONE.
      if (status === "DONE" && status !== oldStatus && ticket.sprint_id) {
        try {
          snapshotSprintMetrics(db, ticket.sprint_id);
          notifyDashboard(db);
        } catch (e) {
          console.error(`[audit] update_ticket ticket #${ticket_id} auto-snapshot sprint #${ticket.sprint_id}: ` + errorMessage(e));
        }
      }

      // B4: server-side auto-emit — wizard mirrors terminal-driven ticket updates without extra LLM calls
      if (status && status !== oldStatus && ticket.sprint_id) {
        const prog = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL`).get(ticket.sprint_id) as { total: number; done: number | null };
        notifyDashboard(db, {
          type: "step_progress",
          entityType: "ticket",
          entityId: ticket_id,
          stepProgress: {
            step: `ticket-${ticket.ticket_ref || ticket_id}`,
            title: `${ticket.ticket_ref || "#" + ticket_id} ${ticket.title} → ${status}`,
            description: "",
            current: prog.done || 0,
            total: prog.total || 0,
            status: status === "DONE" ? "completed" : status === "BLOCKED" ? "error" : "in_progress",
          },
        });
      }

      // B1: card mode — render the pulse (or ticket-done card) + compact state inline
      if (format === "card" && ticket.sprint_id) {
        const pulse = buildSprintPulseData(db, ticket.sprint_id);
        if (pulse) {
          const updated = db.prepare(`SELECT status, qa_verified FROM tickets WHERE id = ?`).get(ticket_id) as Pick<TicketRow, "status" | "qa_verified">; // exists: checked above
          const card = updated.status === "DONE"
            ? ticketDoneCard({
                ref: ticket.ticket_ref || `#${ticket_id}`,
                title: ticket.title,
                points: ticket.story_points || 0,
                agent: (assigned_to ?? ticket.assigned_to) || "—",
                qaVerified: !!updated.qa_verified,
                pulse,
              })
            : sprintPulse(pulse);
          return { content: [{ type: "text" as const, text: `${fenceCard(card)}\nTicket #${ticket_id}: ${status ? `${oldStatus} → ${updated.status}` : "fields updated"} | sprint ${pulse.donePoints}/${pulse.totalPoints}pt, ${pulse.counts.done}/${pulse.counts.done + pulse.counts.inProgress + pulse.counts.todo + pulse.counts.blocked} tickets done` }] };
        }
      }

      const timeNote = actual_hours !== undefined ? ` — actual ${actual_hours}h logged` : "";
      return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} updated: ${status ? `${oldStatus} → ${status}` : "fields updated"}${timeNote}` }] };
    }
  );

  server.tool(
    "add_retro_finding",
    "Add a retrospective finding to a sprint",
    {
      sprint_id: z.number().describe("Sprint ID"),
      category: z.enum(["went_well", "went_wrong", "try_next"]),
      finding: z.string().describe("The finding text"),
      role: z.string().optional().describe("Role that reported this"),
      action_owner: z.string().optional().describe("Who owns the action"),
    },
    async ({ sprint_id, category, finding, role, action_owner }) => {
      db.prepare(`INSERT INTO retro_findings (sprint_id, category, finding, role, action_owner) VALUES (?,?,?,?,?)`).run(sprint_id, category, finding, role || null, action_owner || null);
      notifyDashboard(db);
      return { content: [{ type: "text" as const, text: `Retro finding added: [${category}] ${finding}` }] };
    }
  );

  server.tool(
    "triage_retro_finding",
    "Triage an open try_next retro finding at sprint planning: adopt it as a ticket, drop it with a reason, or defer it to the next planning. The start_sprint planning gate requires every open try_next to be triaged (deferrals satisfy it for 24h).",
    {
      finding_id: z.number().describe("Retro finding ID (category must be try_next)"),
      resolution: z.enum(["adopt", "drop", "defer"]).describe("adopt = becomes a ticket (ticket_id required), drop = will not do (dropped_reason required), defer = decide at next planning"),
      ticket_id: z.number().optional().describe("Ticket that implements this finding (required for adopt)"),
      dropped_reason: z.string().optional().describe("Why this will not be done (required for drop)"),
    },
    async ({ finding_id, resolution, ticket_id, dropped_reason }) => {
      try {
        const f = db.prepare(`SELECT id, category, status, finding FROM retro_findings WHERE id = ?`).get(finding_id) as Pick<RetroFindingRow, "id" | "category" | "status" | "finding"> | undefined;
        if (!f) return { content: [{ type: "text" as const, text: `Retro finding #${finding_id} not found.` }], isError: true };
        if (f.category !== "try_next") return { content: [{ type: "text" as const, text: `Finding #${finding_id} is '${f.category}' — only try_next findings are triaged.` }], isError: true };

        if (resolution === "adopt") {
          if (!ticket_id) return { content: [{ type: "text" as const, text: `adopt requires ticket_id — create the ticket first, then link it here.` }], isError: true };
          const t = db.prepare(`SELECT id, ticket_ref, title, status FROM tickets WHERE id = ?`).get(ticket_id) as Pick<TicketRow, "id" | "ticket_ref" | "title" | "status"> | undefined;
          if (!t) return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} not found.` }], isError: true };
          db.prepare(`UPDATE retro_findings SET status = 'adopted', linked_ticket_id = ?, dropped_reason = NULL, deferred_at = NULL WHERE id = ?`).run(ticket_id, finding_id);
          autoApplyRetroActions(db);
          // Audit insert intentionally unguarded — a failing trail must surface, not vanish (bug from Sprint 23 triage)
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('retro_finding', ?, 'triaged', 'status', ?, 'adopted', 'mcp')`).run(finding_id, f.status);
          notifyDashboard(db);
          return { content: [{ type: "text" as const, text: `Finding #${finding_id} adopted → ${t.ticket_ref || "#" + t.id}: ${t.title}. action_applied flips automatically when the ticket reaches DONE.` }] };
        }

        if (resolution === "drop") {
          if (!dropped_reason || !dropped_reason.trim()) return { content: [{ type: "text" as const, text: `drop requires dropped_reason — say why this will not be done.` }], isError: true };
          db.prepare(`UPDATE retro_findings SET status = 'dropped', dropped_reason = ?, deferred_at = NULL WHERE id = ?`).run(dropped_reason.trim(), finding_id);
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('retro_finding', ?, 'triaged', 'status', ?, 'dropped', 'mcp')`).run(finding_id, f.status);
          notifyDashboard(db);
          return { content: [{ type: "text" as const, text: `Finding #${finding_id} dropped: ${dropped_reason.trim()}` }] };
        }

        // defer
        db.prepare(`UPDATE retro_findings SET deferred_at = datetime('now') WHERE id = ?`).run(finding_id);
        db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('retro_finding', ?, 'triaged', 'deferred', NULL, datetime('now'), 'mcp')`).run(finding_id);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Finding #${finding_id} deferred — gate satisfied for 24h; it re-surfaces at the next planning.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "acknowledge_ticket_changes",
    "Acknowledge board-edited tickets after reacting to their changes: clears pending_change flags and completes the corresponding ticket_changed bridge actions. Call after re-reading the tickets listed in a ⚠ CHANGED TICKETS block.",
    {
      ticket_ids: z.array(z.number()).min(1).describe("Ticket IDs from the changed-tickets block"),
    },
    async ({ ticket_ids }) => {
      try {
        const placeholders = ticket_ids.map(() => "?").join(",");
        let cleared = 0;
        db.transaction(() => {
          cleared = db.prepare(`UPDATE tickets SET pending_change = 0 WHERE id IN (${placeholders}) AND pending_change = 1`).run(...ticket_ids).changes;
          db.prepare(`UPDATE pending_actions SET status = 'completed' WHERE action = 'ticket_changed' AND entity_id IN (${placeholders}) AND status IN ('pending', 'claimed')`).run(...ticket_ids);
          const log = db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('ticket', ?, 'updated', 'pending_change', '1', '0', 'mcp')`);
          for (const id of ticket_ids) log.run(id);
        })();
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Acknowledged ${cleared} changed ticket(s) — flags cleared, bridge actions completed.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_blocker",
    "Report a blocker on a sprint",
    {
      sprint_id: z.number().describe("Sprint ID"),
      description: z.string().describe("What is blocked and why"),
      ticket_id: z.number().optional().describe("Related ticket ID"),
      reported_by: z.string().optional(),
      escalated_to: z.string().optional(),
    },
    async ({ sprint_id, description, ticket_id, reported_by, escalated_to }) => {
      db.prepare(`INSERT INTO blockers (sprint_id, ticket_id, description, reported_by, escalated_to) VALUES (?,?,?,?,?)`).run(sprint_id, ticket_id || null, description, reported_by || null, escalated_to || null);
      notifyDashboard(db);
      return { content: [{ type: "text" as const, text: `Blocker reported: ${description}` }] };
    }
  );

  server.tool(
    "resolve_blocker",
    "Mark a blocker as resolved",
    { blocker_id: z.number().describe("Blocker ID") },
    async ({ blocker_id }) => {
      db.prepare(`UPDATE blockers SET status='resolved', resolved_at=datetime('now') WHERE id=?`).run(blocker_id);
      notifyDashboard(db);
      return { content: [{ type: "text" as const, text: `Blocker #${blocker_id} resolved.` }] };
    }
  );

  server.tool(
    "log_bug",
    "Log a bug against a sprint",
    {
      sprint_id: z.number().describe("Sprint ID"),
      severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
      description: z.string(),
      ticket_id: z.number().optional().describe("Related ticket ID"),
      steps_to_reproduce: z.string().optional(),
      expected: z.string().optional(),
      actual: z.string().optional(),
    },
    async ({ sprint_id, severity, description, ticket_id, steps_to_reproduce, expected, actual }) => {
      db.prepare(`INSERT INTO bugs (sprint_id, ticket_id, severity, description, steps_to_reproduce, expected, actual) VALUES (?,?,?,?,?,?,?)`).run(sprint_id, ticket_id || null, severity, description, steps_to_reproduce || null, expected || null, actual || null);

      // T-3670: Auto-regress sprint to implementation when CRITICAL bug logged during QA
      let regressionNote = "";
      if (severity === "CRITICAL") {
        const sprint = getSprintById(db, sprint_id);
        if (sprint && sprint.status === "qa") {
          db.prepare(`UPDATE sprints SET status = 'implementation', updated_at = datetime('now') WHERE id = ? AND status = 'qa'`).run(sprint_id);
          try {
            db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'status_changed', 'status', 'qa', 'implementation', 'mcp')`).run(sprint_id);
          } catch (e) {
            console.error(`[audit] log_bug sprint #${sprint_id} regression qa→implementation: ` + errorMessage(e));
          }
          regressionNote = " Sprint regressed to implementation due to CRITICAL bug.";
        }
      }

      notifyDashboard(db);
      return { content: [{ type: "text" as const, text: `Bug logged: [${severity}] ${description}${regressionNote}` }] };
    }
  );

  server.tool(
    "sync_scrum_data",
    "Re-seed scrum data from factory defaults (agents + skills). Does not overwrite existing data — only fills empty tables. Use reset_agents/reset_skills for full reset.",
    {},
    async () => {
      try {
        const { seedDefaults } = await import("./defaults.js");
        const result = seedDefaults(db);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Seed check: ${result.agents} agents seeded, ${result.skills} skills seeded (0 means tables already had data)` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Sync error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // MILESTONE & BACKLOG OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_milestone",
    "Create a new milestone for the product roadmap",
    {
      name: z.string().describe("Milestone name (must be unique)"),
      description: z.string().optional().describe("Milestone description"),
      target_date: z.string().optional().describe("Target date (ISO 8601)"),
      status: z.enum(["planned", "active", "completed"]).optional().default("planned"),
      project: z.string().optional().describe("Project key (see set_project); omit = unassigned"),
    },
    async ({ name, description, target_date, status, project }) => {
      try {
        const badProject = unknownProject(db, project);
        if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };
        const result = db.prepare(`INSERT INTO milestones (name, description, target_date, status, project) VALUES (?, ?, ?, ?, ?)`).run(name, description || null, target_date || null, status, project ?? null);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Milestone created: ${name} (id: ${result.lastInsertRowid})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_milestone",
    "Update a milestone's status, progress, or details. archived=true hides a completed milestone from lists and the dashboard (force=true archives any status); archived=false restores it.",
    {
      milestone_id: z.number().describe("Milestone ID"),
      status: z.enum(["planned", "active", "completed"]).optional(),
      description: z.string().optional(),
      progress: z.number().min(0).max(100).optional().describe("Progress percentage 0-100"),
      target_date: z.string().optional(),
      archived: z.boolean().optional().describe("true = archive (status must be completed unless force), false = unarchive"),
      force: z.boolean().optional().describe("Archive even if the milestone is not completed"),
      project: z.string().nullable().optional().describe("Project key (see set_project), null to unassign"),
      github_milestone: z.number().int().positive().nullable().optional().describe("Linked GitHub milestone number, null to unlink"),
    },
    async ({ milestone_id, status, description, progress, target_date, archived, force, project, github_milestone }) => {
      const badProject = unknownProject(db, project);
      if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };
      const sets: string[] = []; const vals: unknown[] = [];
      if (project !== undefined) { sets.push("project=?"); vals.push(project); }
      if (github_milestone !== undefined) { sets.push("github_milestone=?", "github_node_id=NULL"); vals.push(github_milestone); }
      if (status) { sets.push("status=?"); vals.push(status); }
      if (description) { sets.push("description=?"); vals.push(description); }
      if (progress !== undefined) { sets.push("progress=?"); vals.push(progress); }
      if (target_date) { sets.push("target_date=?"); vals.push(target_date); }
      if (sets.length === 0 && archived === undefined) return { content: [{ type: "text" as const, text: "Nothing to update." }] };
      try {
        let archiveNote = "";
        db.transaction(() => {
          // Validate archive eligibility against the status being set in this same call,
          // before any write, so a rejected archive never leaves a half-applied update.
          if (archived === true) assertArchivable(db, "milestone", milestone_id, { force, statusOverride: status });
          if (sets.length > 0) {
            sets.push("updated_at=datetime('now')");
            db.prepare(`UPDATE milestones SET ${sets.join(",")} WHERE id=?`).run(...vals, milestone_id);
          }
          if (archived === true) {
            const r = archiveEntity(db, "milestone", milestone_id, { force, actor: "mcp" });
            archiveNote = r.changed ? " Archived." : " Already archived.";
          } else if (archived === false) {
            const r = unarchiveEntity(db, "milestone", milestone_id, { actor: "mcp" });
            archiveNote = r.changed ? " Unarchived." : " Was not archived.";
          }
        })();
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Milestone ${milestone_id} updated.${archiveNote}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_milestones",
    "List milestones with ticket progress. Archived milestones are hidden unless include_archived=true. Use compact=true for minimal output.",
    {
      status: z.enum(["planned", "active", "completed"]).optional().describe("Filter by status"),
      include_archived: z.boolean().optional().describe("Include archived milestones (default false)"),
      compact: z.boolean().optional().describe("Return minimal fields (id, name, status) to save tokens"),
      project: z.string().optional().describe("Filter by project key"),
    },
    async ({ status, include_archived, compact, project }) => {
      type MilestoneListRow = Pick<MilestoneRow, "id" | "name" | "status" | "progress" | "target_date" | "description" | "archived_at" | "project" | "github_milestone"> & { ticket_count: number; done_count: number };
      const conditions = ["m.deleted_at IS NULL"];
      const params: unknown[] = [];
      if (status) { conditions.push("m.status = ?"); params.push(status); }
      if (project) { conditions.push("m.project = ?"); params.push(project); }
      if (!include_archived) conditions.push("m.archived_at IS NULL");
      const rows = db.prepare(`
        SELECT m.id, m.name, m.status, m.progress, m.target_date, m.description, m.archived_at, m.project, m.github_milestone,
          (SELECT COUNT(*) FROM tickets WHERE milestone_id = m.id AND deleted_at IS NULL) as ticket_count,
          (SELECT COUNT(*) FROM tickets WHERE milestone_id = m.id AND status = 'DONE' AND deleted_at IS NULL) as done_count
        FROM milestones m WHERE ${conditions.join(" AND ")} ORDER BY m.id
      `).all(...params) as MilestoneListRow[];
      if (rows.length === 0) return { content: [{ type: "text" as const, text: "No milestones found." }] };
      const tag = (m: MilestoneListRow) => (m.archived_at ? " (archived)" : "");
      const text = compact
        ? rows.map((m) => `#${m.id} ${m.name} [${m.status}]${tag(m)}`).join("\n")
        : rows.map((m) => `**${m.name}** (#${m.id}) [${m.status}]${tag(m)} progress=${m.progress}%${m.target_date ? ` target=${m.target_date}` : ""}${m.project ? ` project=${m.project}` : ""}${m.github_milestone ? ` gh-milestone=${m.github_milestone}` : ""}\n${m.description || "—"}\nTickets: ${m.done_count}/${m.ticket_count} done`).join("\n\n");
      return { content: [{ type: "text" as const, text: `# Milestones (${rows.length})\n${compact ? "" : "\n"}${text}` }] };
    }
  );

  server.tool(
    "link_ticket_to_milestone",
    "Link a ticket to a milestone by setting its milestone_id",
    {
      ticket_id: z.number().describe("Ticket ID"),
      milestone_id: z.number().describe("Milestone ID"),
    },
    async ({ ticket_id, milestone_id }) => {
      try {
        const milestone = db.prepare(`SELECT id, name FROM milestones WHERE id=?`).get(milestone_id) as Pick<MilestoneRow, "id" | "name"> | undefined;
        if (!milestone) return { content: [{ type: "text" as const, text: `Milestone ${milestone_id} not found.` }], isError: true };
        db.prepare(`UPDATE tickets SET milestone_id=?, milestone=?, updated_at=datetime('now') WHERE id=?`).run(milestone_id, milestone.name, ticket_id);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} linked to milestone "${milestone.name}" (id: ${milestone_id}).` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_vision",
    "Create or update the PRODUCT_VISION skill content",
    {
      content: z.string().describe("Product vision content (markdown)"),
    },
    async ({ content }) => {
      try {
        db.prepare(`INSERT INTO skills (name, content, owner_role) VALUES ('PRODUCT_VISION', ?, 'product-owner') ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`).run(content);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Product vision updated (${content.length} chars).` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_backlog",
    "List all backlog tickets — unassigned to any sprint or carried over from closed sprints",
    {},
    async () => {
      const tickets = db.prepare(`
        SELECT t.id, t.ticket_ref, t.title, t.priority, t.status, t.story_points, t.assigned_to, t.milestone
        FROM tickets t
        WHERE t.sprint_id IS NULL
          OR (t.status IN ('TODO','NOT_DONE') AND t.sprint_id IN (SELECT id FROM sprints WHERE status = 'closed'))
        ORDER BY t.priority, t.created_at
      `).all() as Pick<TicketRow, "id" | "ticket_ref" | "title" | "priority" | "status" | "story_points" | "assigned_to" | "milestone">[];
      if (tickets.length === 0) return { content: [{ type: "text" as const, text: "Backlog is empty." }] };
      const text = tickets.map(t => `[${t.status}] ${t.priority} ${t.ticket_ref || "#"+t.id}: ${t.title} (${t.story_points || 0}sp) @${t.assigned_to || "?"}`).join("\n");
      return { content: [{ type: "text" as const, text: `# Backlog (${tickets.length})\n\n${text}` }] };
    }
  );

  server.tool(
    "plan_sprint",
    "Create a new sprint and assign tickets to it in one operation",
    {
      name: z.string().describe("Sprint name (e.g. 'sprint-2026-04-07')"),
      goal: z.string().optional().describe("Sprint goal"),
      ticket_ids: z.array(z.number()).describe("Array of ticket IDs to assign to this sprint"),
      velocity_committed: z.number().optional().describe("Committed velocity in story points"),
    },
    async ({ name, goal, ticket_ids, velocity_committed }) => {
      try {
        const result = db.prepare(`INSERT INTO sprints (name, goal, status, velocity_committed) VALUES (?, ?, 'planning', ?)`).run(name, goal || null, velocity_committed || 0);
        const sprintId = result.lastInsertRowid;
        const updateStmt = db.prepare(`UPDATE tickets SET sprint_id=?, updated_at=datetime('now') WHERE id=?`);
        for (const tid of ticket_ids) {
          updateStmt.run(sprintId, tid);
        }
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Sprint "${name}" created (id: ${sprintId}) with ${ticket_ids.length} tickets assigned.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ─── Sprint Playbook ───────────────────────────────────────────────────────
  server.tool(
    "get_sprint_playbook",
    "Get the current sprint playbook: phase, ticket summary, gate status, blockers, and directive next actions. Follow the actions listed — do not ask for confirmation.",
    {
      sprint_id: z.number().optional().describe("Sprint ID (default: latest active sprint)"),
      format: z.enum(["text", "card"]).optional().describe("card = diff-fence pulse card above the playbook"),
    },
    async ({ sprint_id, format }) => {
      let sprint: SprintRow | undefined;
      if (sprint_id) {
        sprint = db.prepare(`SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL`).get(sprint_id) as SprintRow | undefined;
      } else {
        sprint = getLatestSprint(db);
      }
      if (!sprint) return { content: [{ type: "text" as const, text: "No active sprint found." }] };

      const tickets = getTicketsBySprint(db, sprint.id);
      const retroCount = (db.prepare(`SELECT COUNT(*) as c FROM retro_findings WHERE sprint_id = ?`).get(sprint.id) as CountRow).c;
      const blockerCount = (db.prepare(`SELECT COUNT(*) as c FROM blockers WHERE sprint_id = ? AND status = 'open'`).get(sprint.id) as CountRow).c;

      const byStatus: Record<string, number> = {};
      for (const t of tickets) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

      const doneCount = tickets.filter(t => t.status === "DONE").length;
      const qaVerified = tickets.filter(t => t.qa_verified).length;
      const totalPts = tickets.reduce((s: number, t) => s + (t.story_points || 0), 0);
      const donePts = tickets.filter(t => t.status === "DONE").reduce((s: number, t) => s + (t.story_points || 0), 0);

      // Gate check for next phase (uses shared function)
      const effectivePhase = resolvePhase(sprint.status);
      const nextPhase = PHASE_TRANSITIONS[effectivePhase] || "done";
      const gates = checkSprintGates(db, sprint, nextPhase);

      const ACTIONS: Record<string, string[]> = {
        planning: ["Assign tickets, set velocity", "Call advance_sprint to start implementation"],
        implementation: ["Work on tickets — update status via update_ticket", "Mark tickets IN_PROGRESS when starting, DONE when complete", "Call advance_sprint once all tickets are DONE"],
        done: ["Review results, add retro findings via add_retro_finding", "Call advance_sprint to move to rest"],
        rest: ["Sprint complete", "Call start_sprint to begin next sprint"],
        // Legacy phase actions for backward compat
        preparation: ["Review backlog", "Call advance_sprint to proceed"],
        kickoff: ["Define sprint goal", "Call advance_sprint to proceed"],
        qa: ["QA verifies tickets", "Call advance_sprint to proceed"],
        refactoring: ["Optional cleanup", "Call advance_sprint to proceed"],
        retro: ["Add retro findings", "Call advance_sprint to proceed"],
        review: ["Write sprint summary", "Call advance_sprint to proceed"],
        closed: ["Sprint closed", "Call advance_sprint to move to rest"],
      };

      // C1 (#11 smart verbosity): the lifecycle tutorial earns its tokens for the first
      // few sprints; an experienced project gets the numbers and the gate, nothing else.
      const sprintCount = (db.prepare(`SELECT COUNT(*) as c FROM sprints WHERE deleted_at IS NULL`).get() as CountRow).c;
      const experienced = sprintCount > 3;

      const pulseCard = format === "card" ? buildSprintPulseData(db, sprint.id) : null;
      const changedBlock = buildChangedTicketsBlock(db, sprint.id); // D1: board edits first
      const lines = [
        pulseCard ? fenceCard(sprintPulse(pulseCard)) : null,
        changedBlock,
        `# Sprint Playbook: ${sprint.name}`,
        `**Phase:** ${sprint.status} → next: ${nextPhase}`,
        `**Progress:** ${donePts}/${totalPts}pt | ${doneCount}/${tickets.length} tickets done | ${qaVerified} QA verified`,
        blockerCount > 0 ? `**Blockers:** ${blockerCount} open` : null,
        ``,
        `## Tickets`,
        ...Object.entries(byStatus).map(([s, c]) => `  ${s}: ${c}`),
        ``,
        gates.warnings.length === 0
          ? `**Gates ${sprint.status} → ${nextPhase}:** pass — advance_sprint when ready`
          : [`## Gate Status for ${sprint.status} → ${nextPhase}`, gates.warnings.map(g => `  WARNING: ${g}`).join("\n")].join("\n"),
        ...(experienced ? [] : [
          ``,
          `## What To Do Now`,
          ...(ACTIONS[sprint.status] || ["Proceed to next phase"]).map(a => `  - ${a}`),
        ]),
      ];

      return { content: [{ type: "text" as const, text: lines.filter(l => l !== null).join("\n") }] };
    }
  );

  // ─── Start Sprint (full ceremony) ──────────────────────────────────────────
  server.tool(
    "start_sprint",
    "Create a sprint with tickets in one call. Creates the sprint, creates tickets from provided list, assigns agents, links to milestone/epic, and returns the full sprint playbook for what to do next.",
    {
      name: z.string().describe("Sprint name (e.g. 'Sprint 58 — Feature X')"),
      goal: z.string().describe("Sprint goal — one sentence, measurable"),
      milestone_id: z.number().optional().describe("Milestone ID to link to"),
      epic_id: z.number().optional().describe("Epic ID to link tickets to"),
      velocity: z.number().optional().describe("Committed velocity in story points"),
      start_date: z.string().optional().describe("Start date (ISO)"),
      end_date: z.string().optional().describe("End date (ISO)"),
      tickets: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
        assigned_to: z.string().optional(),
        story_points: z.number().optional(),
      })).describe("Tickets to create and assign to this sprint"),
      acknowledge_open_items: z.boolean().optional().describe("Override the planning gate (untriaged try_next / escalated discoveries) — the items stay open and re-surface next planning"),
      format: z.enum(["text", "card"]).optional().describe("card = diff-fence launch card above the ticket list"),
    },
    async ({ name, goal, milestone_id, epic_id, velocity, start_date, end_date, tickets, acknowledge_open_items, format }) => {
      try {
        // A1+A2 planning gate: no sprint starts over untriaged retro/discovery items
        const gate = checkPlanningGate(db);
        if (gate.blocked && !acknowledge_open_items) {
          slog("WARN", `start_sprint: planning gate blocked untriaged_try_next=${gate.untriaged} escalated_discoveries=${gate.escalated}`);
          return { content: [{ type: "text" as const, text: [
            `⛔ SPRINT START BLOCKED — planning gate`,
            ``,
            ...gate.sections,
            ``,
            `Triage the items above, then call start_sprint again. To start anyway, pass acknowledge_open_items: true (defers the decisions — they re-surface at the next planning).`,
          ].join("\n") }] };
        }

        // Validate assigned_to values against real agents
        const validRoles = new Set((db.prepare("SELECT role FROM agents").all() as { role: string }[]).map(a => a.role));
        const invalidAssignments = tickets.filter(t => t.assigned_to && !validRoles.has(t.assigned_to)).map(t => `"${t.assigned_to}" (${t.title})`);
        if (invalidAssignments.length > 0) {
          return { content: [{ type: "text" as const, text: `Invalid agent roles: ${invalidAssignments.join(", ")}. Valid roles: ${[...validRoles].join(", ")}. Use \`list_agents\` to see available agents.` }], isError: true };
        }

        // Create sprint + tickets atomically — partial failure rolls back cleanly
        const createdTickets: string[] = [];
        const sprintId = db.transaction(() => {
          const sprintResult = db.prepare(`INSERT INTO sprints (name, goal, status, velocity_committed, start_date, end_date, milestone_id) VALUES (?, ?, 'planning', ?, ?, ?, ?)`).run(
            name, goal, velocity || 0, start_date || null, end_date || null, milestone_id || null
          );
          const sid = Number(sprintResult.lastInsertRowid);

          const ticketStmt = db.prepare(`INSERT INTO tickets (title, description, priority, assigned_to, story_points, sprint_id, epic_id, milestone_id, ticket_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const maxRef = (db.prepare(`SELECT MAX(id) as m FROM tickets`).get() as { m: number | null } | undefined)?.m ?? 0;

          for (let i = 0; i < tickets.length; i++) {
            const t = tickets[i];
            const ref = `T-${maxRef + i + 1}`;
            ticketStmt.run(
              t.title, t.description || null, t.priority || "P1",
              t.assigned_to || null, t.story_points || 0,
              sid, epic_id || null, milestone_id || null, ref
            );
            createdTickets.push(`${ref}: ${t.title} (${t.story_points || 0}pt → ${t.assigned_to || "unassigned"})`);
          }
          return sid;
        })();

        // Log event
        try {
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'created', 'status', NULL, 'planning', 'mcp')`).run(sprintId);
        } catch (e) {
          console.error(`[audit] create_sprint sprint #${sprintId} created: ` + errorMessage(e));
        }

        const totalPts = tickets.reduce((s, t) => s + (t.story_points || 0), 0);

        notifyDashboard(db);
        // B4: server-side auto-emit — sprint launch lands in the wizard timeline
        notifyDashboard(db, {
          type: "step_progress",
          entityType: "sprint",
          entityId: sprintId,
          stepProgress: { step: "sprint_launch", title: `Sprint created: ${name} (${totalPts}pt)`, description: goal, current: 1, total: 4, status: "completed" },
        });
        const launch = format === "card"
          ? fenceCard(launchCard({ sprintName: name, goal, ticketCount: tickets.length, points: totalPts, phase: "planning" })) + "\n"
          : null;
        return { content: [{ type: "text" as const, text: [
          launch,
          `# Sprint Created: ${name} (id: ${sprintId})`,
          `Goal: ${goal}`,
          `Velocity: ${totalPts}pt committed`,
          milestone_id ? `Milestone: #${milestone_id}` : null,
          epic_id ? `Epic: #${epic_id}` : null,
          ``,
          `## Tickets (${tickets.length})`,
          ...createdTickets,
          ``,
          `## Next Steps`,
          `1. Sprint is in \`planning\` phase`,
          `2. Review tickets, adjust assignments if needed`,
          `3. Use \`advance_sprint(${sprintId})\` to move to implementation`,
          `4. Update tickets via \`update_ticket\` as work progresses`,
          `5. Use \`advance_sprint\` to move through implementation → done → rest`,
        ].filter(Boolean).join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error creating sprint: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE DUMP / RESTORE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "dump_database",
    "Export the entire database to JSON for backup/restore",
    {
      tables: z.array(z.string()).optional().describe("Specific tables to export (default: all)"),
    },
    async ({ tables }) => {
      try {
        const allTables = [
          "agents", "sprints", "tickets", "subtasks", "retro_findings",
          "blockers", "bugs", "skills", "processes", "milestones",
          "files", "exports", "dependencies", "directories", "changes"
        ];
        const targetTables = tables && tables.length > 0 ? tables : allTables;

        const dump: Record<string, unknown[]> = {};
        for (const table of targetTables) {
          try {
            dump[table] = db.prepare(`SELECT * FROM ${table}`).all();
          } catch {
            // Table might not exist — skip
          }
        }

        const output = {
          version: "2.0.0",
          exported_at: new Date().toISOString(),
          tables: dump,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "restore_database",
    "Restore database from a JSON dump. Wraps in transaction for safety.",
    {
      dump_json: z.string().describe("The full JSON dump string from dump_database"),
    },
    async ({ dump_json }) => {
      try {
        const dump = JSON.parse(dump_json) as DatabaseDump;
        if (!dump.version || !dump.tables) {
          return { content: [{ type: "text" as const, text: "Error: Invalid dump format. Expected {version, tables}." }], isError: true };
        }

        // Foreign key ordering: parents before children
        const order = [
          "milestones", "agents", "skills", "processes",
          "sprints", "tickets", "subtasks",
          "retro_findings", "blockers", "bugs",
          "files", "exports", "dependencies", "directories", "changes"
        ];

        // Build column whitelist per table from schema
        const schemaColumns = new Map<string, Set<string>>();
        for (const table of order) {
          const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          schemaColumns.set(table, new Set(info.map(c => c.name)));
        }

        const results: string[] = [];
        const transaction = db.transaction(() => {
          for (const table of order) {
            const rows = dump.tables[table];
            if (!rows || !Array.isArray(rows) || rows.length === 0) continue;
            const validCols = schemaColumns.get(table);
            if (!validCols) continue;
            const cols = Object.keys(rows[0]).filter(c => validCols.has(c));
            if (cols.length === 0) continue;

            const placeholders = cols.map(() => "?").join(",");
            const stmt = db.prepare(
              `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`
            );

            let count = 0;
            for (const row of rows) {
              stmt.run(...cols.map(c => row[c] ?? null));
              count++;
            }
            results.push(`${table}: ${count} rows`);
          }
        });

        transaction();

        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `# Restore Complete\n\nVersion: ${dump.version}\nExported: ${dump.exported_at}\n\n${results.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "export_to_file",
    "Export database to a JSON file on disk",
    {
      output_path: z.string().optional().describe("File path (default: ./code-context-dump.json)"),
    },
    async ({ output_path }) => {
      try {
        const filePath = output_path || "./code-context-dump.json";

        const allTables = [
          "agents", "sprints", "tickets", "subtasks", "retro_findings",
          "blockers", "bugs", "skills", "processes", "milestones",
          "files", "exports", "dependencies", "directories", "changes"
        ];

        const dump: Record<string, unknown[]> = {};
        for (const table of allTables) {
          try { dump[table] = db.prepare(`SELECT * FROM ${table}`).all(); } catch {}
        }

        const output = {
          version: "2.0.0",
          exported_at: new Date().toISOString(),
          tables: dump,
        };

        const fs = await import("fs");
        const json = JSON.stringify(output, null, 2);
        fs.writeFileSync(filePath, json);

        const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
        const tableCount = Object.keys(dump).filter(k => dump[k].length > 0).length;
        const rowCount = Object.values(dump).reduce((s, rows) => s + rows.length, 0);

        return { content: [{ type: "text" as const, text: `Exported to ${filePath} (${sizeMB}MB, ${tableCount} tables, ${rowCount} rows)` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "import_from_file",
    "Restore database from a JSON dump file on disk",
    {
      input_path: z.string().describe("Path to the JSON dump file"),
    },
    async ({ input_path }) => {
      try {
        const fs = await import("fs");
        if (!fs.existsSync(input_path)) {
          return { content: [{ type: "text" as const, text: `Error: File not found: ${input_path}` }], isError: true };
        }

        const json = fs.readFileSync(input_path, "utf-8");
        const dump = JSON.parse(json) as DatabaseDump;

        if (!dump.version || !dump.tables) {
          return { content: [{ type: "text" as const, text: "Error: Invalid dump format." }], isError: true };
        }

        // Same restore logic as restore_database
        const order = [
          "milestones", "agents", "skills", "processes",
          "sprints", "tickets", "subtasks",
          "retro_findings", "blockers", "bugs",
          "files", "exports", "dependencies", "directories", "changes"
        ];

        // Build column whitelist per table from schema
        const schemaColumns2 = new Map<string, Set<string>>();
        for (const table of order) {
          const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          schemaColumns2.set(table, new Set(info.map(c => c.name)));
        }

        const results: string[] = [];
        const transaction = db.transaction(() => {
          for (const table of order) {
            const rows = dump.tables[table];
            if (!rows || !Array.isArray(rows) || rows.length === 0) continue;
            const validCols = schemaColumns2.get(table);
            if (!validCols) continue;
            const cols = Object.keys(rows[0]).filter(c => validCols.has(c));
            if (cols.length === 0) continue;
            const placeholders = cols.map(() => "?").join(",");
            const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`);
            let count = 0;
            for (const row of rows) { stmt.run(...cols.map(c => row[c] ?? null)); count++; }
            results.push(`${table}: ${count} rows`);
          }
        });
        transaction();

        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `# Restored from ${input_path}\n\nVersion: ${dump.version}\nExported: ${dump.exported_at}\n\n${results.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ─── Project Status ──────────────────────────────────────────────────────────
  server.tool(
    "get_project_status",
    "Check if the project is properly set up and return health status",
    {},
    async () => {
      const fileCount = (db.prepare("SELECT COUNT(*) as c FROM files").get() as CountRow).c;
      const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as CountRow).c;
      const sprintCount = (db.prepare("SELECT COUNT(*) as c FROM sprints").get() as CountRow).c;
      const ticketCount = (db.prepare("SELECT COUNT(*) as c FROM tickets").get() as CountRow).c;
      const skillCount = (db.prepare("SELECT COUNT(*) as c FROM skills").get() as CountRow).c;

      const status = {
        initialized: fileCount > 0,
        files_indexed: fileCount,
        agents_configured: agentCount,
        sprints_created: sprintCount,
        tickets_total: ticketCount,
        skills_loaded: skillCount,
      };

      const lines = [
        "# Project Status",
        "",
        `Files indexed: ${status.files_indexed}`,
        `Agents: ${status.agents_configured}`,
        `Sprints: ${status.sprints_created}`,
        `Tickets: ${status.tickets_total}`,
        `Skills: ${status.skills_loaded}`,
        "",
        status.initialized ? "Project is set up and ready." : "Project needs setup. Run: code-context-mcp setup .",
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ─── Resume State (Token-Efficient) ─────────────────────────────────────────
  server.tool(
    "get_resume_state",
    "Single-call resume detection. Returns minimal structured data (~150 tokens) for all command Step 0 flows. Replaces get_project_status + list_sprints + list_epics + list_discoveries.",
    {},
    async () => {
      const files = (db.prepare("SELECT COUNT(*) as c FROM files").get() as CountRow).c;
      const exports = (db.prepare("SELECT COUNT(*) as c FROM exports").get() as CountRow).c;
      const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as CountRow).c;

      // Vision
      const vision = db.prepare("SELECT content FROM skills WHERE name = 'PRODUCT_VISION' LIMIT 1").get() as { content: string } | undefined;
      const hasVision = !!(vision?.content);

      // Sprints
      const sprintsCompleted = (db.prepare("SELECT COUNT(*) as c FROM sprints WHERE status IN ('rest', 'done', 'closed') AND deleted_at IS NULL").get() as CountRow).c;
      const activeSprint = db.prepare("SELECT id, name, status FROM sprints WHERE status NOT IN ('rest', 'done', 'closed') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get() as Pick<SprintRow, "id" | "name" | "status"> | undefined;

      // Discoveries
      const activeDiscoveries = (db.prepare("SELECT COUNT(*) as c FROM discoveries WHERE status IN ('discovered', 'planned')").get() as CountRow).c;

      // Milestones
      const activeMilestone = db.prepare("SELECT id, name, status, progress FROM milestones WHERE status IN ('planned', 'active') AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id DESC LIMIT 1").get() as Pick<MilestoneRow, "id" | "name" | "status" | "progress"> | undefined;

      // Epics
      const activeEpics = (db.prepare("SELECT COUNT(*) as c FROM epics WHERE status IN ('planned', 'active') AND archived_at IS NULL").get() as CountRow).c;
      const completedEpics = (db.prepare("SELECT COUNT(*) as c FROM epics WHERE status = 'completed'").get() as CountRow).c;

      // Determine next phase
      let nextPhase = "vision";
      if (hasVision) nextPhase = "discovery";
      if (activeDiscoveries > 0 || completedEpics > 0) nextPhase = "milestone";
      if (activeMilestone) nextPhase = "epics";
      if (activeEpics > 0) nextPhase = "tickets";
      if (activeSprint) nextPhase = "implementation";

      const staleWarning = checkDistFreshness();
      const lines = [
        `# Resume State`,
        staleWarning,
        `files: ${files} | exports: ${exports} | agents: ${agents}`,
        `vision: ${hasVision ? "set" : "none"}`,
        `sprints: ${sprintsCompleted} completed${activeSprint ? ` | active: #${activeSprint.id} ${activeSprint.name} [${activeSprint.status}]` : " | active: none"}`,
        `discoveries: ${activeDiscoveries} active`,
        `milestone: ${activeMilestone ? `#${activeMilestone.id} ${activeMilestone.name} [${activeMilestone.status}] ${activeMilestone.progress}%` : "none"}`,
        `epics: ${activeEpics} active, ${completedEpics} completed`,
        `skill_sets: ${formatEnablement(getEnabledSkillSets(db), skillSetsConfigured(db))}`,
        `next_phase: ${nextPhase}`,
      ].filter((l): l is string => l !== null);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ─── Phase Context (Token-Efficient) ────────────────────────────────────────
  server.tool(
    "load_phase_context",
    "Single-call phase context loader. Bundles all data needed for a specific workflow phase into one response, replacing 2-5 separate tool calls per phase.",
    {
      phase: z.enum(["discovery", "epics", "tickets", "implementation", "retro"]).describe("Workflow phase to load context for"),
      sprint_id: z.number().optional().describe("Sprint ID (required for implementation and retro phases)"),
      ticket_id: z.number().optional().describe("Ticket ID (for implementation phase)"),
    },
    async ({ phase, sprint_id, ticket_id }) => {
      try {
        const sections: string[] = [`# Phase Context: ${phase}`];

        if (phase === "discovery") {
          // Bundles: list_discoveries (active) + list_decisions + get_discovery_coverage
          const discoveries = db.prepare(`
            SELECT d.id, d.finding, d.status, d.priority, d.category, d.created_by, d.resolution_plan, s.name as sprint_name
            FROM discoveries d JOIN sprints s ON d.discovery_sprint_id = s.id
            WHERE d.status IN ('discovered', 'planned')
            ORDER BY d.priority, d.created_at
          `).all() as (Pick<DiscoveryRow, "id" | "finding" | "status" | "priority" | "category" | "created_by" | "resolution_plan"> & { sprint_name: string })[];
          sections.push(`## Active Discoveries (${discoveries.length})`);
          if (discoveries.length === 0) sections.push("None");
          else discoveries.forEach((d) => sections.push(`- [${d.status}] ${d.priority} #${d.id}: ${d.finding}${d.resolution_plan ? " (has plan)" : ""}`));

          const decisions = db.prepare(`SELECT id, title, category, rationale FROM decisions ORDER BY created_at DESC LIMIT 10`).all() as Pick<DecisionRow, "id" | "title" | "category" | "rationale">[];
          sections.push(`\n## Recent Decisions (${decisions.length})`);
          if (decisions.length === 0) sections.push("None");
          else decisions.forEach((d) => sections.push(`- #${d.id} [${d.category}] ${d.title}`));

          // Discovery coverage counts
          const coverage = db.prepare(`SELECT status, COUNT(*) as c FROM discoveries GROUP BY status`).all() as { status: string; c: number }[];
          if (coverage.length > 0) {
            sections.push(`\n## Coverage`);
            coverage.forEach((c) => sections.push(`- ${c.status}: ${c.c}`));
          }
        }

        else if (phase === "epics") {
          // Bundles: list_epics (full) + list_agents
          const epics = db.prepare(`
            SELECT e.*, COUNT(t.id) as ticket_count, SUM(CASE WHEN t.status='DONE' THEN 1 ELSE 0 END) as done_count
            FROM epics e LEFT JOIN tickets t ON t.epic_id = e.id
            WHERE e.status IN ('planned', 'active') AND e.archived_at IS NULL
            GROUP BY e.id ORDER BY e.priority DESC, e.id
          `).all() as (EpicRow & { ticket_count: number; done_count: number | null })[];
          sections.push(`## Active Epics (${epics.length})`);
          if (epics.length === 0) sections.push("None");
          else epics.forEach((e) => sections.push(`- #${e.id} ${e.name} [${e.status}] ${e.done_count || 0}/${e.ticket_count || 0} tickets done`));

          const agents = db.prepare(`SELECT role, name FROM agents ORDER BY role`).all() as Pick<AgentRow, "role" | "name">[];
          sections.push(`\n## Agents (${agents.length})`);
          agents.forEach((a) => sections.push(`- ${a.role}: ${a.name}`));
        }

        else if (phase === "tickets") {
          // Bundles: get_velocity_trends + get_backlog + epic summary
          const velocity = db.prepare(`
            SELECT s.name as sprint_name, s.velocity_committed as committed, s.velocity_completed as completed
            FROM sprints s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 5
          `).all() as { sprint_name: string; committed: number | null; completed: number | null }[];
          const avgVelocity = velocity.length > 0 ? Math.round(velocity.reduce((s: number, v) => s + (v.completed || 0), 0) / velocity.length) : 0;
          sections.push(`## Velocity (last ${velocity.length} sprints, avg: ${avgVelocity}pts)`);
          velocity.forEach((v) => sections.push(`- ${v.sprint_name}: ${v.completed || 0}/${v.committed || 0}pts`));

          const backlog = db.prepare(`SELECT id, title, story_points, priority FROM tickets WHERE sprint_id IS NULL AND status NOT IN ('DONE', 'NOT_DONE') ORDER BY priority, id`).all() as Pick<TicketRow, "id" | "title" | "story_points" | "priority">[];
          sections.push(`\n## Backlog (${backlog.length} tickets)`);
          if (backlog.length === 0) sections.push("None");
          else backlog.forEach((t) => sections.push(`- #${t.id}: ${t.title} (${t.story_points || 0}pts) ${t.priority}`));

          const epics = db.prepare(`SELECT id, name, status FROM epics WHERE status IN ('planned', 'active') AND archived_at IS NULL ORDER BY priority DESC`).all() as Pick<EpicRow, "id" | "name" | "status">[];
          sections.push(`\n## Active Epics (${epics.length})`);
          epics.forEach((e) => sections.push(`- #${e.id} ${e.name} [${e.status}]`));

          // A1+A2: planning gate context — open try_next + open discoveries + triage directive
          sections.push("");
          sections.push(buildPlanningGateContext(db));
        }

        else if (phase === "implementation") {
          // Bundles: get_ticket + sprint progress
          const sid = sprint_id || (db.prepare(`SELECT id FROM sprints WHERE status NOT IN ('rest', 'done', 'closed') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`).get() as Pick<SprintRow, "id"> | undefined)?.id;
          if (!sid) { return { content: [{ type: "text" as const, text: "No active sprint found." }] }; }

          // D1: board edits surface before anything else
          const changed = buildChangedTicketsBlock(db, sid);
          if (changed) sections.push(changed, "");

          const tickets = db.prepare(`SELECT id, ticket_ref, title, status, story_points, assigned_to, qa_verified FROM tickets WHERE sprint_id = ? ORDER BY priority, status`).all(sid) as Pick<TicketRow, "id" | "ticket_ref" | "title" | "status" | "story_points" | "assigned_to" | "qa_verified">[];
          const done = tickets.filter((t) => t.status === "DONE").length;
          const totalPts = tickets.reduce((s: number, t) => s + (t.story_points || 0), 0);
          const donePts = tickets.filter((t) => t.status === "DONE").reduce((s: number, t) => s + (t.story_points || 0), 0);
          sections.push(`## Sprint Progress: ${donePts}/${totalPts}pts | ${done}/${tickets.length} tickets`);
          tickets.forEach((t) => {
            const qa = t.qa_verified ? " ✓QA" : "";
            sections.push(`- [${t.status}] ${t.ticket_ref || "#"+t.id}: ${t.title} (${t.story_points || 0}pts) @${t.assigned_to || "?"}${qa}`);
          });

          // If specific ticket requested, include full details
          if (ticket_id) {
            const t = getTicketById(db, ticket_id);
            if (t) {
              sections.push(`\n## Ticket Detail: ${t.ticket_ref || "#"+t.id} — ${t.title}`);
              if (t.description) sections.push(`Description: ${t.description}`);
              if (t.acceptance_criteria) {
                sections.push(`Acceptance Criteria:`);
                try { JSON.parse(t.acceptance_criteria).forEach((c: string) => sections.push(`  - ${c}`)); } catch { sections.push(`  ${t.acceptance_criteria}`); }
              }
              const routing = buildModelRoutingSection(db, t);
              if (routing) sections.push("", routing);
              // T-273: when the workflow set is on, carry the commit contract verbatim
              // into the delegated prompt (distilled from wf:write-commit-messages) so
              // the subagent obeys it without a separate get_skill round-trip.
              const contract = buildCommitContract(db);
              if (contract) sections.push(contract);
            }
          }

          const blockers = db.prepare(`SELECT id, description FROM blockers WHERE sprint_id = ? AND status = 'open'`).all(sid) as Pick<BlockerRow, "id" | "description">[];
          if (blockers.length > 0) {
            sections.push(`\n## Open Blockers (${blockers.length})`);
            blockers.forEach((b) => sections.push(`- #${b.id}: ${b.description}`));
          }

          // C1: house-style primer only with the sprint's FIRST fe ticket — later loads
          // get a pointer; granular pulls go through get_skill (deterministic, no session state)
          const feTickets = tickets.filter((t) => t.assigned_to === "fe-engineer");
          if (feTickets.length > 0) {
            const fePrior = feTickets.some((t) => ["IN_PROGRESS", "DONE"].includes(t.status) && t.id !== ticket_id);
            if (!fePrior) {
              const playbook = buildFrontendPlaybook(db);
              if (playbook) sections.push(playbook);
            } else {
              sections.push(`\n**Frontend Playbook:** already injected earlier this sprint — pull specific skills with get_skill({ name: "fe:<slug>" }).`);
            }
          }

          // Workflow skills (wf:*) are role-agnostic — same first-load/pointer split,
          // keyed on any ticket having started rather than fe assignment.
          const wfPlaybook = buildWorkflowPlaybook(db);
          if (wfPlaybook) {
            const anyPrior = tickets.some((t) => ["IN_PROGRESS", "DONE"].includes(t.status) && t.id !== ticket_id);
            if (!anyPrior) {
              sections.push(wfPlaybook);
            } else {
              sections.push(`\n**Workflow skills:** enabled — pull with get_skill({ name: "wf:<slug>" }) when writing commits/PRs.`);
            }
          }
        }

        else if (phase === "retro") {
          // Bundles: get_sprint + get_burndown + get_mood_trends + analyze_retro_patterns + get_velocity_trends
          const sid = sprint_id || (db.prepare(`SELECT id FROM sprints WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`).get() as Pick<SprintRow, "id"> | undefined)?.id;
          if (!sid) { return { content: [{ type: "text" as const, text: "No sprints found." }] }; }

          const sprint = getSprintById(db, sid)!; // missing row throws into the catch below, as before
          sections.push(`## Sprint: ${sprint.name} [${sprint.status}]`);
          sections.push(`Velocity: ${sprint.velocity_completed || 0}/${sprint.velocity_committed || 0}pts`);

          const tickets = getTicketStatusCounts(db, sid);
          sections.push(`Tickets: ${tickets.map((t) => `${t.status}: ${t.c}`).join(", ")}`);

          // Burndown
          const burndown = db.prepare(`SELECT date, completed_points, remaining_points FROM sprint_metrics WHERE sprint_id = ? ORDER BY date`).all(sid) as Pick<SprintMetricRow, "date" | "completed_points" | "remaining_points">[];
          if (burndown.length > 0) {
            sections.push(`\n## Burndown (${burndown.length} snapshots)`);
            burndown.forEach((b) => sections.push(`- ${b.date}: ${b.completed_points}pts done, ${b.remaining_points}pts remaining`));
          }

          // Mood trends — aggregate in SQL instead of shipping 35 rows to average one number (#13)
          const moodAgg = db.prepare(`
            SELECT ROUND(AVG(mood), 1) as avg_mood, COUNT(*) as readings
            FROM (SELECT mood FROM agent_mood_history ORDER BY sprint_id DESC LIMIT 35)
          `).get() as { avg_mood: number | null; readings: number };
          if (moodAgg?.readings > 0) {
            sections.push(`\n## Mood: avg ${moodAgg.avg_mood}/5 (${moodAgg.readings} readings)`);
          }

          // Retro patterns
          autoApplyRetroActions(db);
          const categories = db.prepare(`SELECT category, COUNT(*) as count FROM retro_findings GROUP BY category ORDER BY count DESC`).all() as { category: string; count: number }[];
          const lifecycle = db.prepare(`
            SELECT
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
              SUM(CASE WHEN status = 'adopted' THEN 1 ELSE 0 END) as adopted,
              SUM(CASE WHEN status = 'adopted' AND action_applied = 1 THEN 1 ELSE 0 END) as applied,
              SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) as dropped
            FROM retro_findings WHERE category = 'try_next'
          `).get() as { open: number | null; adopted: number | null; applied: number | null; dropped: number | null };
          if (categories.length > 0) {
            sections.push(`\n## Retro Patterns`);
            categories.forEach((c) => sections.push(`- ${c.category}: ${c.count}`));
            sections.push(`try_next lifecycle: ${lifecycle.open || 0} open | ${lifecycle.adopted || 0} adopted (${lifecycle.applied || 0} applied) | ${lifecycle.dropped || 0} dropped`);
          }

          // Recent velocity for comparison
          const recentVelocity = db.prepare(`SELECT name, velocity_completed, velocity_committed FROM sprints WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 3`).all() as Pick<SprintRow, "name" | "velocity_completed" | "velocity_committed">[];
          if (recentVelocity.length > 1) {
            sections.push(`\n## Recent Velocity`);
            recentVelocity.forEach((v) => sections.push(`- ${v.name}: ${v.velocity_completed || 0}/${v.velocity_committed || 0}pts`));
          }
        }

        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error loading ${phase} context: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ─── Onboarding ──────────────────────────────────────────────────────────────
  server.tool(
    "get_onboarding_status",
    "Check project setup status and return what is configured vs missing",
    {},
    async () => {
      const checks = [
        { name: "Database initialized", check: () => { try { db.prepare("SELECT 1 FROM files LIMIT 1").get(); return true; } catch { return false; } }, fix: "Run: code-context-mcp setup ." },
        { name: "Files indexed", check: () => (db.prepare("SELECT COUNT(*) as c FROM files").get() as CountRow).c > 0, fix: "Run: code-context-mcp setup . (or index_directory tool)" },
        { name: "Agents configured", check: () => (db.prepare("SELECT COUNT(*) as c FROM agents").get() as CountRow).c > 0, fix: "Run reset_agents to seed factory defaults" },
        { name: "Sprint process loaded", check: () => { const s = db.prepare("SELECT COUNT(*) as c FROM skills WHERE name IN ('SPRINT_PROCESS','SPRINT_PROCESS_JSON')").get() as CountRow; return s.c > 0; }, fix: "Run reset_sprint_process to seed factory defaults" },
        { name: "Product vision exists", check: () => { const s = db.prepare("SELECT COUNT(*) as c FROM skills WHERE name='PRODUCT_VISION'").get() as CountRow; return s.c > 0; }, fix: "Use update_vision tool to set the product vision" },
        { name: "Milestones defined", check: () => { const m = db.prepare("SELECT COUNT(*) as c FROM milestones").get() as CountRow; const s = db.prepare("SELECT COUNT(*) as c FROM skills WHERE name='MILESTONES'").get() as CountRow; return m.c > 0 || s.c > 0; }, fix: "Create milestones with create_milestone tool" },
        { name: "At least one sprint", check: () => (db.prepare("SELECT COUNT(*) as c FROM sprints").get() as CountRow).c > 0, fix: "Create a sprint with create_sprint or plan_sprint tool" },
      ];

      const results = checks.map(c => {
        const ok = c.check();
        return `${ok ? "✅" : "❌"} ${c.name}${ok ? "" : "\n   Fix: " + c.fix}`;
      });

      const done = checks.filter(c => c.check()).length;
      const total = checks.length;

      return { content: [{ type: "text" as const, text: `# Onboarding Status (${done}/${total})\n\n${results.join("\n\n")}` }] };
    }
  );

  server.tool(
    "run_onboarding",
    "Run the full project onboarding sequence — checks and fixes all missing setup steps",
    {
      project_path: z.string().optional().describe("Project root path (default: cwd)"),
    },
    async ({ project_path }) => {
      const steps: string[] = [];
      const projectDir = project_path || process.cwd();

      // Step 1: Check agents — seed from factory defaults if empty
      const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as CountRow).c;
      if (agentCount === 0) {
        const { seedDefaults } = await import("./defaults.js");
        const result = seedDefaults(db);
        steps.push(`Seeded ${result.agents} agents, ${result.skills} skills from factory defaults`);
      } else {
        steps.push(`✅ ${agentCount} agents already configured`);
      }

      // Step 2: Check sprint process
      const sprintProcess = db.prepare("SELECT COUNT(*) as c FROM skills WHERE name IN ('SPRINT_PROCESS','SPRINT_PROCESS_JSON')").get() as CountRow;
      if (sprintProcess.c === 0) {
        const { resetSprintProcess } = await import("./defaults.js");
        resetSprintProcess(db);
        steps.push("Seeded sprint process from factory defaults");
      } else {
        steps.push("✅ Sprint process loaded");
      }

      // Step 3: Check files indexed
      const fileCount = (db.prepare("SELECT COUNT(*) as c FROM files").get() as CountRow).c;
      if (fileCount === 0) {
        steps.push("⚠️ No files indexed — run: code-context-mcp setup . (or index_directory tool)");
      } else {
        steps.push(`✅ ${fileCount} files indexed`);
      }

      notifyDashboard(db);
      return { content: [{ type: "text" as const, text: `# Onboarding Complete\n\n${steps.join("\n")}` }] };
    }
  );

  // ─── Remotion Vision Animation ──────────────────────────────────────────────
  server.tool(
    "generate_vision_animation",
    "Generate project vision animation data (JSON) and provide the Remotion render command",
    {
      output_path: z.string().optional().describe("Output path for JSON data (default: ./vision-data.json)"),
    },
    async ({ output_path }) => {
      try {
        const filePath = output_path || "./vision-data.json";

        // Gather data from database
        const vision = db.prepare("SELECT content FROM skills WHERE name = 'PRODUCT_VISION' LIMIT 1").get() as { content: string } | undefined;
        const milestoneRows = db.prepare("SELECT name, status FROM milestones ORDER BY id").all() as { name: string; status: string }[];
        const sprintCount = (db.prepare("SELECT COUNT(*) as c FROM sprints WHERE status = 'closed'").get() as CountRow).c;
        const ticketCount = (db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'DONE'").get() as CountRow).c;
        const totalPoints = (db.prepare("SELECT COALESCE(SUM(velocity_completed), 0) as p FROM sprints WHERE status = 'closed'").get() as { p: number }).p;
        const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as CountRow).c;

        const data = {
          productName: "vlm-code-context-mcp",
          vision: vision?.content || "AI-powered virtual IT department via MCP",
          milestones: milestoneRows,
          stats: {
            sprints: sprintCount,
            tickets: ticketCount,
            points: totalPoints,
            agents: agentCount,
          },
        };

        const fs = await import("fs");
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        const lines = [
          `# Vision Animation Data Generated`,
          ``,
          `Output: ${filePath}`,
          ``,
          `## Data Summary`,
          `- Product: ${data.productName}`,
          `- Vision: ${data.vision.slice(0, 80)}...`,
          `- Milestones: ${milestoneRows.length}`,
          `- Sprints: ${sprintCount}`,
          `- Tickets: ${ticketCount}`,
          `- Story Points: ${totalPoints}`,
          `- Agents: ${agentCount}`,
          ``,
          `## Render Commands`,
          ``,
          `Preview in browser:`,
          `  npx remotion preview src/remotion/index.tsx`,
          ``,
          `Render MP4:`,
          `  npx remotion render src/remotion/index.tsx VisionVideo --props=${filePath} --output=vision.mp4`,
          ``,
          `Render GIF:`,
          `  npx remotion render src/remotion/index.tsx VisionVideo --props=${filePath} --codec=gif --output=vision.gif`,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Epic CRUD Tools ────────────────────────────────────────────────

  server.tool(
    "create_epic",
    "Create a new epic to group related tickets",
    {
      name: z.string().describe("Epic name"),
      description: z.string().optional().describe("Epic description"),
      milestone_id: z.number().optional().describe("Milestone ID to associate with"),
      color: z.string().default("#3b82f6").describe("Hex color for the epic (default #3b82f6)"),
      priority: z.number().min(0).max(4).default(0).describe("Priority 0-4 (default 0)"),
      project: z.string().optional().describe("Project key (see set_project); omit = unassigned"),
    },
    async ({ name, description, milestone_id, color, priority, project }) => {
      try {
        const badProject = unknownProject(db, project);
        if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };
        const result = db.prepare(
          `INSERT INTO epics (name, description, milestone_id, color, priority, project) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(name, description ?? null, milestone_id ?? null, color, priority, project ?? null);
        notifyDashboard(db);
        return {
          content: [{ type: "text" as const, text: `Epic created — id: ${result.lastInsertRowid}, name: "${name}"` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error creating epic: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_epic",
    "Update an existing epic's fields. archived=true hides a completed epic from lists and the dashboard (force=true archives any status); archived=false restores it.",
    {
      epic_id: z.number().describe("Epic ID"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      status: z.string().optional().describe("New status"),
      color: z.string().optional().describe("New hex color"),
      priority: z.number().min(0).max(4).optional().describe("New priority 0-4"),
      archived: z.boolean().optional().describe("true = archive (status must be completed unless force), false = unarchive"),
      force: z.boolean().optional().describe("Archive even if the epic is not completed"),
      project: z.string().nullable().optional().describe("Project key (see set_project), null to unassign"),
    },
    async ({ epic_id, name, description, status, color, priority, archived, force, project }) => {
      try {
        const badProject = unknownProject(db, project);
        if (badProject) return { content: [{ type: "text" as const, text: badProject }], isError: true };
        const fields: string[] = [];
        const values: unknown[] = [];
        if (project !== undefined) { fields.push("project = ?"); values.push(project); }
        if (name !== undefined) { fields.push("name = ?"); values.push(name); }
        if (description !== undefined) { fields.push("description = ?"); values.push(description); }
        if (status !== undefined) { fields.push("status = ?"); values.push(status); }
        if (color !== undefined) { fields.push("color = ?"); values.push(color); }
        if (priority !== undefined) { fields.push("priority = ?"); values.push(priority); }
        if (fields.length === 0 && archived === undefined) {
          return { content: [{ type: "text" as const, text: "No fields to update." }] };
        }
        let notFound = false;
        let archiveNote = "";
        db.transaction(() => {
          if (archived === true) assertArchivable(db, "epic", epic_id, { force, statusOverride: status });
          if (fields.length > 0) {
            const result = db.prepare(`UPDATE epics SET ${fields.join(", ")} WHERE id = ?`).run(...values, epic_id);
            if (result.changes === 0) { notFound = true; return; }
          }
          if (archived === true) {
            const r = archiveEntity(db, "epic", epic_id, { force, actor: "mcp" });
            archiveNote = r.changed ? " Archived." : " Already archived.";
          } else if (archived === false) {
            const r = unarchiveEntity(db, "epic", epic_id, { actor: "mcp" });
            archiveNote = r.changed ? " Unarchived." : " Was not archived.";
          }
        })();
        if (notFound) {
          return { content: [{ type: "text" as const, text: `Epic ${epic_id} not found.` }] };
        }
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Epic ${epic_id} updated (${fields.length} field(s)).${archiveNote}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error updating epic: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_epics",
    "List epics with optional status and milestone filters, including ticket progress counts. Archived epics are hidden unless include_archived=true. Use compact=true for minimal output (id, name, status) to save tokens.",
    {
      status: z.string().optional().describe("Filter by status"),
      milestone_id: z.number().optional().describe("Filter by milestone ID"),
      compact: z.boolean().optional().describe("Return minimal fields (id, name, status) to save tokens"),
      include_archived: z.boolean().optional().describe("Include archived epics (default false)"),
      project: z.string().optional().describe("Filter by project key"),
    },
    async ({ status, milestone_id, compact, include_archived, project }) => {
      if (compact) {
        let q = `SELECT e.id, e.name, e.status, e.archived_at FROM epics e`;
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (status) { conditions.push("e.status = ?"); params.push(status); }
        if (milestone_id !== undefined) { conditions.push("e.milestone_id = ?"); params.push(milestone_id); }
        if (project) { conditions.push("e.project = ?"); params.push(project); }
        if (!include_archived) conditions.push("e.archived_at IS NULL");
        if (conditions.length) { q += " WHERE " + conditions.join(" AND "); }
        q += " ORDER BY e.priority DESC, e.id";
        const epics = db.prepare(q).all(...params) as Pick<EpicRow, "id" | "name" | "status" | "archived_at">[];
        if (epics.length === 0) return { content: [{ type: "text" as const, text: "No epics found." }] };
        const text = epics.map((e) => `#${e.id} ${e.name} [${e.status || "open"}]${e.archived_at ? " (archived)" : ""}`).join("\n");
        return { content: [{ type: "text" as const, text: `# Epics (${epics.length})\n${text}` }] };
      }
      let q = `SELECT e.*, COUNT(t.id) as ticket_count, SUM(CASE WHEN t.status='DONE' THEN 1 ELSE 0 END) as done_count FROM epics e LEFT JOIN tickets t ON t.epic_id = e.id`;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (status) { conditions.push("e.status = ?"); params.push(status); }
      if (milestone_id !== undefined) { conditions.push("e.milestone_id = ?"); params.push(milestone_id); }
      if (project) { conditions.push("e.project = ?"); params.push(project); }
      if (!include_archived) conditions.push("e.archived_at IS NULL");
      if (conditions.length) { q += " WHERE " + conditions.join(" AND "); }
      q += " GROUP BY e.id ORDER BY e.priority DESC, e.id";
      const epics = db.prepare(q).all(...params) as (EpicRow & { ticket_count: number; done_count: number | null })[];
      if (epics.length === 0) return { content: [{ type: "text" as const, text: "No epics found." }] };
      const text = epics.map(
        (e) => `**${e.name}** (#${e.id}) [${e.status || "open"}]${e.archived_at ? " (archived)" : ""} priority=${e.priority || 0} color=${e.color || "#3b82f6"}\n${e.description || "—"}\nTickets: ${e.done_count || 0}/${e.ticket_count || 0} done`
      ).join("\n\n");
      return { content: [{ type: "text" as const, text: `# Epics (${epics.length})\n\n${text}` }] };
    }
  );

  server.tool(
    "link_ticket_to_epic",
    "Link a ticket to an epic, or unlink by passing null epic_id",
    {
      ticket_id: z.number().describe("Ticket ID"),
      epic_id: z.number().nullable().describe("Epic ID (null to unlink)"),
    },
    async ({ ticket_id, epic_id }) => {
      try {
        const result = db.prepare(`UPDATE tickets SET epic_id = ? WHERE id = ?`).run(epic_id, ticket_id);
        if (result.changes === 0) {
          return { content: [{ type: "text" as const, text: `Ticket ${ticket_id} not found.` }] };
        }
        const action = epic_id === null ? "unlinked from epic" : `linked to epic ${epic_id}`;
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Ticket ${ticket_id} ${action}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error linking ticket: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DECISIONS (M12-016)
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "log_decision",
    "Log an architectural or process decision with rationale and alternatives considered",
    {
      title: z.string().describe("Decision title"),
      rationale: z.string().optional().describe("Why this decision was made"),
      alternatives: z.string().optional().describe("Alternatives considered"),
      outcome: z.string().optional().describe("Expected or actual outcome"),
      category: z.string().optional().default("technical").describe("Category (e.g. technical, process, product)"),
    },
    async ({ title, rationale, alternatives, outcome, category }) => {
      try {
        const result = db.prepare(`INSERT INTO decisions (title, rationale, alternatives, outcome, category) VALUES (?,?,?,?,?)`).run(title, rationale || null, alternatives || null, outcome || null, category);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Decision logged: #${result.lastInsertRowid} — ${title}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_decisions",
    "List logged decisions with optional category filter",
    {
      category: z.string().optional().describe("Filter by category"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ category, limit }) => {
      let q = `SELECT * FROM decisions WHERE 1=1`;
      const p: unknown[] = [];
      if (category) { q += " AND category=?"; p.push(category); }
      q += ` ORDER BY created_at DESC LIMIT ?`;
      p.push(limit);
      const decisions = db.prepare(q).all(...p) as DecisionRow[];
      if (decisions.length === 0) return { content: [{ type: "text" as const, text: "No decisions found." }] };
      const text = decisions.map((d) => [
        `**#${d.id}: ${d.title}** [${d.category}]`,
        d.rationale ? `  Rationale: ${d.rationale}` : null,
        d.alternatives ? `  Alternatives: ${d.alternatives}` : null,
        d.outcome ? `  Outcome: ${d.outcome}` : null,
        `  Created: ${d.created_at}`,
      ].filter(Boolean).join("\n")).join("\n\n");
      return { content: [{ type: "text" as const, text: `# Decisions (${decisions.length})\n\n${text}` }] };
    }
  );

  // ── Sprint Process Config (data-driven) ────────────────────────────────────

  server.tool(
    "get_sprint_config",
    "Read the SPRINT_PROCESS skill from the database — returns the current sprint process configuration",
    {},
    async () => {
      try {
        const row = db.prepare(`SELECT content, owner_role, updated_at FROM skills WHERE name = ?`).get("SPRINT_PROCESS") as Pick<SkillRow, "content" | "owner_role" | "updated_at"> | undefined;
        if (!row) {
          return { content: [{ type: "text" as const, text: "No SPRINT_PROCESS config found in skills table. Use update_sprint_config to create one." }] };
        }
        return { content: [{ type: "text" as const, text: `# Sprint Process Config\n\nOwner: ${row.owner_role || "—"}\nUpdated: ${row.updated_at || "—"}\n\n${row.content}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_sprint_config",
    "Create or update the SPRINT_PROCESS skill — stores sprint process configuration in the database",
    {
      content: z.string().describe("Sprint process configuration content (markdown)"),
    },
    async ({ content }) => {
      try {
        db.prepare(
          `INSERT INTO skills (name, content, owner_role) VALUES ('SPRINT_PROCESS', ?, 'scrum-master') ON CONFLICT(name) DO UPDATE SET content=excluded.content, owner_role='scrum-master', updated_at=datetime('now')`
        ).run(content);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Sprint process config updated (${content.length} chars).` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M20: Sprint Metrics & Burndown
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "snapshot_sprint_metrics",
    "Capture a daily burndown snapshot for a sprint — records remaining, completed, added, and removed points",
    {
      sprint_id: z.number().describe("Sprint ID"),
      date: z.string().optional().describe("Date (ISO 8601, defaults to today)"),
    },
    async ({ sprint_id, date }) => {
      try {
        const { date: d, remaining, completed } = snapshotSprintMetrics(db, sprint_id, date);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Snapshot ${d}: ${completed}pts done, ${remaining}pts remaining` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M20: Ticket Dependencies
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "add_dependency",
    "Add a dependency between two tickets (blocks, blocked_by, or related)",
    {
      source_ticket_id: z.number().describe("Source ticket ID"),
      target_ticket_id: z.number().describe("Target ticket ID"),
      dependency_type: z.enum(["blocks", "blocked_by", "related"]).default("blocks"),
    },
    async ({ source_ticket_id, target_ticket_id, dependency_type }) => {
      try {
        if (source_ticket_id === target_ticket_id) return { content: [{ type: "text" as const, text: "Cannot create self-dependency" }], isError: true };
        // Check for circular: if target already blocks source
        if (dependency_type === "blocks") {
          const circular = db.prepare(`SELECT id FROM ticket_dependencies WHERE source_ticket_id = ? AND target_ticket_id = ? AND dependency_type = 'blocks'`).get(target_ticket_id, source_ticket_id);
          if (circular) return { content: [{ type: "text" as const, text: "Circular dependency detected — target already blocks source" }], isError: true };
        }
        db.prepare(`INSERT INTO ticket_dependencies (source_ticket_id, target_ticket_id, dependency_type) VALUES (?, ?, ?)`).run(source_ticket_id, target_ticket_id, dependency_type);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Dependency added: ticket ${source_ticket_id} ${dependency_type} ticket ${target_ticket_id}` }] };
      } catch (e) {
        if (errorMessage(e).includes("UNIQUE")) return { content: [{ type: "text" as const, text: "Dependency already exists" }], isError: true };
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "remove_dependency",
    "Remove a dependency between two tickets",
    {
      source_ticket_id: z.number().describe("Source ticket ID"),
      target_ticket_id: z.number().describe("Target ticket ID"),
    },
    async ({ source_ticket_id, target_ticket_id }) => {
      try {
        const result = db.prepare(`DELETE FROM ticket_dependencies WHERE source_ticket_id = ? AND target_ticket_id = ?`).run(source_ticket_id, target_ticket_id);
        if (result.changes > 0) notifyDashboard(db);
        return { content: [{ type: "text" as const, text: result.changes > 0 ? "Dependency removed." : "No dependency found." }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_dependency_graph",
    "Get all dependencies for a ticket or sprint",
    {
      ticket_id: z.number().optional().describe("Ticket ID (get deps for one ticket)"),
      sprint_id: z.number().optional().describe("Sprint ID (get all deps in sprint)"),
    },
    async ({ ticket_id, sprint_id }) => {
      type DependencyGraphRow = TicketDependencyRow & { source_ref: string | null; source_title: string; target_ref: string | null; target_title: string };
      try {
        let rows: DependencyGraphRow[];
        if (ticket_id) {
          rows = db.prepare(`
            SELECT d.*, s.ticket_ref as source_ref, s.title as source_title, t.ticket_ref as target_ref, t.title as target_title
            FROM ticket_dependencies d
            JOIN tickets s ON d.source_ticket_id = s.id
            JOIN tickets t ON d.target_ticket_id = t.id
            WHERE d.source_ticket_id = ? OR d.target_ticket_id = ?
          `).all(ticket_id, ticket_id) as DependencyGraphRow[];
        } else if (sprint_id) {
          rows = db.prepare(`
            SELECT d.*, s.ticket_ref as source_ref, s.title as source_title, t.ticket_ref as target_ref, t.title as target_title
            FROM ticket_dependencies d
            JOIN tickets s ON d.source_ticket_id = s.id
            JOIN tickets t ON d.target_ticket_id = t.id
            WHERE s.sprint_id = ? OR t.sprint_id = ?
          `).all(sprint_id, sprint_id) as DependencyGraphRow[];
        } else {
          return { content: [{ type: "text" as const, text: "Provide ticket_id or sprint_id" }], isError: true };
        }
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No dependencies found." }] };
        const lines = rows.map((r) => `${r.source_ref} (${r.source_title}) —[${r.dependency_type}]→ ${r.target_ref} (${r.target_title})`);
        return { content: [{ type: "text" as const, text: `# Dependencies (${rows.length})\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M20: Ticket Tags
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "add_tag",
    "Add a tag to a ticket (creates tag if it doesn't exist)",
    {
      ticket_id: z.number().describe("Ticket ID"),
      tag_name: z.string().describe("Tag name (e.g. 'tech-debt', 'security')"),
      color: z.string().optional().describe("Hex color for new tags (default #6b7280)"),
    },
    async ({ ticket_id, tag_name, color }) => {
      try {
        db.prepare(`INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)`).run(tag_name, color || "#6b7280");
        const tag = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag_name) as Pick<TagRow, "id">; // exists: inserted above
        db.prepare(`INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)`).run(ticket_id, tag.id);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Tag '${tag_name}' added to ticket ${ticket_id}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "remove_tag",
    "Remove a tag from a ticket",
    {
      ticket_id: z.number().describe("Ticket ID"),
      tag_name: z.string().describe("Tag name"),
    },
    async ({ ticket_id, tag_name }) => {
      try {
        const tag = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag_name) as Pick<TagRow, "id"> | undefined;
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_name}' not found` }], isError: true };
        db.prepare(`DELETE FROM ticket_tags WHERE ticket_id = ? AND tag_id = ?`).run(ticket_id, tag.id);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Tag '${tag_name}' removed from ticket ${ticket_id}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_tags",
    "List all available tags with usage counts",
    {},
    async () => {
      try {
        const rows = db.prepare(`SELECT t.name, t.color, COUNT(tt.ticket_id) as usage_count FROM tags t LEFT JOIN ticket_tags tt ON t.id = tt.tag_id GROUP BY t.id ORDER BY usage_count DESC`).all() as (Pick<TagRow, "name" | "color"> & { usage_count: number })[];
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No tags defined." }] };
        const lines = rows.map((r) => `- **${r.name}** (${r.color}) — ${r.usage_count} tickets`);
        return { content: [{ type: "text" as const, text: `# Tags (${rows.length})\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M20: Time Tracking
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "log_time",
    "Log estimated or actual hours on a ticket",
    {
      ticket_id: z.number().describe("Ticket ID"),
      estimated_hours: z.number().optional().describe("Estimated hours"),
      actual_hours: z.number().optional().describe("Actual hours spent"),
    },
    async ({ ticket_id, estimated_hours, actual_hours }) => {
      try {
        const sets: string[] = []; const vals: unknown[] = [];
        if (estimated_hours !== undefined) { sets.push("estimated_hours=?"); vals.push(estimated_hours); }
        if (actual_hours !== undefined) { sets.push("actual_hours=?"); vals.push(actual_hours); }
        if (sets.length === 0) return { content: [{ type: "text" as const, text: "Provide estimated_hours or actual_hours" }], isError: true };
        vals.push(ticket_id);
        db.prepare(`UPDATE tickets SET ${sets.join(",")} WHERE id=?`).run(...vals);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Time logged on ticket ${ticket_id}${estimated_hours !== undefined ? ` — est: ${estimated_hours}h` : ""}${actual_hours !== undefined ? ` — actual: ${actual_hours}h` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M20: Agent Mood History
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "record_mood",
    "Record an agent's mood for a sprint (1-5 scale)",
    {
      agent_id: z.number().describe("Agent ID"),
      sprint_id: z.number().describe("Sprint ID"),
      mood: z.number().min(1).max(5).describe("Mood 1-5 (1=burned out, 5=energized)"),
      workload_points: z.number().optional().describe("Story points assigned this sprint"),
      notes: z.string().optional().describe("Notes about mood/workload"),
    },
    async ({ agent_id, sprint_id, mood, workload_points, notes }) => {
      try {
        db.prepare(`INSERT INTO agent_mood_history (agent_id, sprint_id, mood, workload_points, notes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, sprint_id) DO UPDATE SET mood=excluded.mood, workload_points=excluded.workload_points, notes=excluded.notes`).run(agent_id, sprint_id, mood, workload_points || 0, notes || null);
        const warning = mood <= 2 ? "\n⚠️ BURNOUT RISK — mood ≤ 2. Reduce workload next sprint." : "";
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Mood recorded: agent ${agent_id}, sprint ${sprint_id}, mood ${mood}/5${warning}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Token Usage Tracking
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "log_token_usage",
    "Record token usage for a session/task. Use at the end of a task to track real consumption for benchmarking.",
    {
      sprint_id: z.number().optional().describe("Sprint ID"),
      ticket_id: z.number().optional().describe("Ticket ID"),
      input_tokens: z.number().describe("Input tokens consumed"),
      output_tokens: z.number().describe("Output tokens consumed"),
      tool_calls: z.number().optional().describe("Number of tool calls made"),
      duration_sec: z.number().optional().describe("Duration in seconds"),
      label: z.string().optional().describe("Label for this measurement (e.g. 'S-MCP', 'L-Vanilla')"),
      session_id: z.string().optional().describe("Session identifier"),
    },
    async ({ sprint_id, ticket_id, input_tokens, output_tokens, tool_calls, duration_sec, label, session_id }) => {
      try {
        const total = input_tokens + output_tokens;
        db.prepare(`INSERT INTO token_usage (session_id, sprint_id, ticket_id, input_tokens, output_tokens, total_tokens, tool_calls, duration_sec, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          session_id || null, sprint_id || null, ticket_id || null,
          input_tokens, output_tokens, total, tool_calls || 0, duration_sec || null, label || null
        );
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Token usage recorded: ${total.toLocaleString()} total (${input_tokens.toLocaleString()} in + ${output_tokens.toLocaleString()} out)${label ? ` [${label}]` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M20: Audit Trail / Event Log
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_audit_trail",
    "Get audit trail for an entity — all state changes over time",
    {
      entity_type: z.enum(["ticket", "sprint", "epic", "milestone", "agent", "blocker", "bug"]).describe("Entity type"),
      entity_id: z.number().describe("Entity ID"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ entity_type, entity_id, limit }) => {
      try {
        const rows = db.prepare(`SELECT * FROM event_log WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?`).all(entity_type, entity_id, limit || 50) as EventLogRow[];
        if (rows.length === 0) return { content: [{ type: "text" as const, text: `No audit trail for ${entity_type} #${entity_id}` }] };
        const lines = rows.map((r) => `[${r.created_at}] ${r.action}${r.field_name ? ` ${r.field_name}` : ""}: ${r.old_value || "—"} → ${r.new_value || "—"}${r.actor ? ` (by ${r.actor})` : ""}`);
        return { content: [{ type: "text" as const, text: `# Audit Trail: ${entity_type} #${entity_id} (${rows.length} events)\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "log_event",
    "Manually log an event in the audit trail",
    {
      entity_type: z.enum(["ticket", "sprint", "epic", "milestone", "agent", "blocker", "bug"]),
      entity_id: z.number(),
      action: z.enum(["created", "updated", "deleted", "status_changed"]),
      field_name: z.string().optional(),
      old_value: z.string().optional(),
      new_value: z.string().optional(),
      actor: z.string().optional(),
    },
    async ({ entity_type, entity_id, action, field_name, old_value, new_value, actor }) => {
      try {
        db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(entity_type, entity_id, action, field_name || null, old_value || null, new_value || null, actor || null);
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Event logged: ${entity_type} #${entity_id} ${action}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // M17: Recent Events for Claude Reactivity
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_recent_events",
    "List recent events from the audit trail — use this to detect dashboard-initiated changes (e.g. user moved a ticket on the kanban board)",
    {
      entity_type: z.string().optional().describe("Filter by entity type (ticket, sprint, epic, milestone)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ entity_type, limit }) => {
      try {
        const max = limit || 20;
        let sql = `SELECT * FROM event_log`;
        const params: unknown[] = [];
        if (entity_type) { sql += ` WHERE entity_type = ?`; params.push(entity_type); }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(max);
        const rows = db.prepare(sql).all(...params) as EventLogRow[];
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No recent events." }] };
        const lines = rows.map((r) => `[${r.created_at}] ${r.action} ${r.entity_type}#${r.entity_id}${r.field_name ? ` (${r.field_name}: ${r.old_value || '—'} → ${r.new_value || '—'})` : ""}${r.actor ? ` by ${r.actor}` : ""}`);
        return { content: [{ type: "text" as const, text: `# Recent Events (${rows.length})\n\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Discovery Persistence & Coverage
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_discovery",
    "Log a finding from a discovery sprint",
    {
      sprint_id: z.number().describe("Discovery sprint ID"),
      finding: z.string().describe("The discovery finding text"),
      resolution_plan: z.string().optional().describe("Plan for how to resolve this discovery — steps, approach, and acceptance criteria"),
      category: z.enum(["architecture", "ux", "performance", "testing", "integration", "general"]).optional().describe("Finding category (default: general)"),
      priority: z.enum(["P0", "P1", "P2", "P3"]).optional().describe("Priority (default: P1)"),
      created_by: z.string().optional().describe("Agent role that created this finding"),
    },
    async ({ sprint_id, finding, resolution_plan, category, priority, created_by }) => {
      try {
        const sprint = db.prepare("SELECT id, name, status FROM sprints WHERE id = ?").get(sprint_id) as Pick<SprintRow, "id" | "name" | "status"> | undefined;
        if (!sprint) return { content: [{ type: "text" as const, text: `Sprint ${sprint_id} not found.` }] };
        const cat = category || "general";
        const pri = priority || "P1";
        const result = db.prepare(
          `INSERT INTO discoveries (discovery_sprint_id, finding, category, status, priority, created_by, resolution_plan) VALUES (?, ?, ?, 'discovered', ?, ?, ?)`
        ).run(sprint_id, finding, cat, pri, created_by || null, resolution_plan || null);
        db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('discovery', ?, 'created', 'status', NULL, 'discovered', ?)`).run(result.lastInsertRowid, created_by || 'mcp');
        const planNote = resolution_plan ? " (with resolution plan)" : " (no resolution plan)";
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Discovery #${result.lastInsertRowid} created in sprint "${sprint.name}" [${cat}] ${pri}${planNote}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_discoveries",
    "List discovery findings with optional filters. Compact by default (open items, truncated one-liners) — pass verbose=true for full text and all statuses.",
    {
      sprint_id: z.number().optional().describe("Filter by discovery sprint"),
      status: z.enum(["discovered", "planned", "implemented", "dropped"]).optional().describe("Filter by status (verbose implies all statuses unless set)"),
      category: z.enum(["architecture", "ux", "performance", "testing", "integration", "general"]).optional().describe("Filter by category"),
      verbose: z.boolean().optional().describe("Full finding text, all statuses, full metadata (default false — C1 token diet)"),
    },
    async ({ sprint_id, status, category, verbose }) => {
      try {
        let sql = `SELECT d.*, s.name as sprint_name, t.title as ticket_title FROM discoveries d JOIN sprints s ON d.discovery_sprint_id = s.id LEFT JOIN tickets t ON d.implementation_ticket_id = t.id WHERE 1=1`;
        const params: unknown[] = [];
        if (sprint_id) { sql += " AND d.discovery_sprint_id = ?"; params.push(sprint_id); }
        if (status) { sql += " AND d.status = ?"; params.push(status); }
        else if (!verbose) { sql += " AND d.status IN ('discovered', 'planned')"; } // compact default: open work only
        if (category) { sql += " AND d.category = ?"; params.push(category); }
        sql += " ORDER BY s.created_at DESC, d.priority, d.created_at";
        const rows = db.prepare(sql).all(...params) as (DiscoveryRow & { sprint_name: string; ticket_title: string | null })[];
        if (rows.length === 0) return { content: [{ type: "text" as const, text: verbose ? "No discoveries found." : "No open discoveries. (verbose=true includes implemented/dropped.)" }] };
        if (!verbose) {
          const text = rows.map((d) =>
            `- [${d.status}] ${d.priority} #${d.id} ${truncateFinding(d.finding, 110)}${d.implementation_ticket_id ? ` → #${d.implementation_ticket_id}` : ""}`).join("\n");
          return { content: [{ type: "text" as const, text: `# Discoveries (${rows.length} open)\n${text}` }] };
        }
        const text = rows.map((d) => {
          const ticket = d.ticket_title ? ` → T-${d.implementation_ticket_id}: ${d.ticket_title}` : "";
          const drop = d.drop_reason ? ` (${d.drop_reason})` : "";
          return `[${d.status.toUpperCase()}] ${d.priority} #${d.id}: ${d.finding}${ticket}${drop}\n  Sprint: ${d.sprint_name} | Category: ${d.category} | By: ${d.created_by || "—"}`;
        }).join("\n\n");
        return { content: [{ type: "text" as const, text: `# Discoveries (${rows.length})\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_discovery",
    "Update a discovery's status, priority, or drop reason",
    {
      discovery_id: z.number().describe("Discovery ID"),
      status: z.enum(["discovered", "planned", "implemented", "dropped"]).optional().describe("New status"),
      priority: z.enum(["P0", "P1", "P2", "P3"]).optional().describe("New priority"),
      drop_reason: z.string().optional().describe("Why this discovery was dropped"),
      resolution_plan: z.string().optional().describe("Plan for how to resolve this discovery — steps, approach, and acceptance criteria"),
    },
    async ({ discovery_id, status, priority, drop_reason, resolution_plan }) => {
      try {
        const existing = db.prepare("SELECT * FROM discoveries WHERE id = ?").get(discovery_id) as DiscoveryRow | undefined;
        if (!existing) return { content: [{ type: "text" as const, text: `Discovery #${discovery_id} not found.` }] };
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (status) { sets.push("status = ?"); vals.push(status); }
        if (priority) { sets.push("priority = ?"); vals.push(priority); }
        if (drop_reason) { sets.push("drop_reason = ?"); vals.push(drop_reason); }
        if (resolution_plan) { sets.push("resolution_plan = ?"); vals.push(resolution_plan); }
        sets.push("updated_at = datetime('now')");
        if (sets.length === 1) return { content: [{ type: "text" as const, text: "No fields to update." }] };
        vals.push(discovery_id);
        db.prepare(`UPDATE discoveries SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        if (status && status !== existing.status) {
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('discovery', ?, 'status_changed', 'status', ?, ?, 'mcp')`).run(discovery_id, existing.status, status);
        }
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Discovery #${discovery_id} updated.${status ? ` Status: ${existing.status} → ${status}` : ""}${priority ? ` Priority: ${priority}` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "link_discovery_to_ticket",
    "Link a discovery finding to its implementation ticket — auto-sets status to planned (or implemented if ticket is DONE)",
    {
      discovery_id: z.number().describe("Discovery ID"),
      ticket_id: z.number().describe("Implementation ticket ID"),
    },
    async ({ discovery_id, ticket_id }) => {
      try {
        const discovery = db.prepare("SELECT * FROM discoveries WHERE id = ?").get(discovery_id) as DiscoveryRow | undefined;
        if (!discovery) return { content: [{ type: "text" as const, text: `Discovery #${discovery_id} not found.` }] };
        const ticket = db.prepare("SELECT id, title, status FROM tickets WHERE id = ?").get(ticket_id) as Pick<TicketRow, "id" | "title" | "status"> | undefined;
        if (!ticket) return { content: [{ type: "text" as const, text: `Ticket #${ticket_id} not found.` }] };
        const newStatus = ticket.status === "DONE" ? "implemented" : "planned";
        db.prepare("UPDATE discoveries SET implementation_ticket_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(ticket_id, newStatus, discovery_id);
        db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('discovery', ?, 'updated', 'implementation_ticket_id', NULL, ?, 'mcp')`).run(discovery_id, String(ticket_id));
        if (newStatus !== discovery.status) {
          db.prepare(`INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('discovery', ?, 'status_changed', 'status', ?, ?, 'mcp')`).run(discovery_id, discovery.status, newStatus);
        }
        notifyDashboard(db);
        return { content: [{ type: "text" as const, text: `Discovery #${discovery_id} linked to ticket #${ticket_id} "${ticket.title}" — status: ${newStatus}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Bridge Wizard: Bidirectional Terminal ↔ Dashboard ───────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "request_user_input",
    "Request user input via the dashboard wizard modal. Writes a question to the bridge action queue. If the dashboard is running, the question appears as a wizard step; if not, returns a fallback flag so the caller can ask in the terminal instead.",
    {
      step: z.string().describe("Wizard step name (e.g. 'vision', 'discovery', 'milestone', 'epics', 'tickets', 'sprint_launch', 'retro')"),
      title: z.string().describe("Question card title"),
      description: z.string().describe("Context — why this step matters"),
      fields: z.array(z.object({
        name: z.string().describe("Field key"),
        label: z.string().describe("Display label"),
        type: z.enum(["text", "textarea", "select", "number"]).describe("Input type"),
        placeholder: z.string().optional().describe("Placeholder text"),
        options: z.array(z.string()).optional().describe("Options for select fields"),
        required: z.boolean().optional().describe("Whether field is required (default true)"),
      })).describe("Form fields to display"),
      hints: z.array(z.string()).optional().describe("Hint bullets shown below the question"),
    },
    async ({ step, title, description, fields, hints }) => {
      try {
        // Check if dashboard is running (resolve actual port from DB)
        const dashPort = resolveDashboardPort(db);
        let dashboardUp = false;
        try {
          const resp = await fetch(`http://localhost:${dashPort}/api/bridge/status`, { signal: AbortSignal.timeout(500), headers: dashboardAuthHeaders() });
          dashboardUp = resp.ok;
        } catch { /* dashboard not running */ }

        if (!dashboardUp) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ fallback: true, step, title, description, fields, hints: hints || [] }),
            }],
          };
        }

        // Insert request_input action into pending_actions
        const payload = JSON.stringify({ step, title, description, fields, hints: hints || [] });
        const result = db.prepare(
          `INSERT INTO pending_actions (action, entity_type, payload, source, status) VALUES ('request_input', 'wizard', ?, 'mcp', 'pending')`
        ).run(payload);
        const actionId = result.lastInsertRowid;

        notifyDashboard(db, { type: "input_requested", entityType: "pending_action", entityId: Number(actionId) });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ fallback: false, action_id: Number(actionId), step, title }),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_user_response",
    "Poll for the user's response to a request_user_input question. Returns the response payload if ready, or 'pending' status if still waiting. Use after request_user_input when dashboard is running.",
    {
      action_id: z.number().describe("Action ID returned by request_user_input"),
      timeout_ms: z.number().optional().describe("Max time to wait in ms (default 0 = no wait, just check)"),
    },
    async ({ action_id, timeout_ms }) => {
      try {
        const timeout = timeout_ms ?? 0;
        const start = Date.now();
        const check = () => db.prepare("SELECT status, result FROM pending_actions WHERE id = ?").get(action_id) as Pick<PendingActionRow, "status" | "result"> | undefined;

        let row = check();
        if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ status: "not_found" }) }] };

        // Poll if timeout > 0
        if (timeout > 0 && row.status === "pending") {
          while (Date.now() - start < timeout) {
            await new Promise(resolve => setTimeout(resolve, 500));
            row = check()!; // a row deleted mid-poll throws into the catch below, as before
            if (row.status !== "pending") break;
          }
        }

        if (row.status === "pending") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ status: "pending" }) }] };
        }

        if (row.status === "completed" && row.result) {
          let parsed: unknown;
          try { parsed = JSON.parse(row.result); } catch { parsed = row.result; }
          return { content: [{ type: "text" as const, text: JSON.stringify({ status: "completed", response: parsed }) }] };
        }

        if (row.status === "expired") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ status: "expired" }) }] };
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({ status: row.status }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Real-Time Step Progress ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "send_step_progress",
    "Send real-time step progress updates to the wizard modal. Shows which step Claude is executing and current progress.",
    {
      step: z.string().describe("Wizard step name (e.g. 'vision', 'discovery', 'milestone')"),
      title: z.string().describe("Step title (e.g. 'Creating milestone')"),
      description: z.string().optional().describe("What is happening in this step"),
      current: z.number().describe("Current step number (1-indexed)"),
      total: z.number().describe("Total number of steps"),
      status: z.enum(["pending", "in_progress", "completed", "error"]).describe("Step status"),
      error: z.string().optional().describe("Error message if status is 'error'"),
    },
    async ({ step, title, description, current, total, status, error }) => {
      try {
        // Send step_progress event via SSE
        notifyDashboard(db, {
          type: "step_progress",
          entityType: "wizard_step",
          stepProgress: {
            step,
            title,
            description: description || "",
            current,
            total,
            status,
            error,
          },
        });

        return {
          content: [{ type: "text" as const, text: `Step progress sent: ${title} (${current}/${total})` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "send_claude_output",
    "Stream Claude's real-time text output to the dashboard wizard UI. Each call appends a line to the live output panel. Use this to show what Claude is doing during ceremonies.",
    {
      text: z.string().describe("The text content to display in the output stream"),
      line_type: z.enum(["text", "tool_call", "tool_result", "thinking", "error", "step", "system"]).optional().default("text").describe("Type of output line (default: text)"),
      step: z.string().optional().describe("Optional step name to associate this output with"),
    },
    async ({ text, line_type, step }) => {
      try {
        const port = resolveDashboardPort(db);
        try {
          await fetch(`http://localhost:${port}/api/claude-output`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...dashboardAuthHeaders() },
            body: JSON.stringify({ text: text.slice(0, 5000), lineType: line_type || "text", step: step || undefined }),
          }).catch(() => {});
        } catch {}
        return { content: [{ type: "text" as const, text: `Output streamed: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "send_claude_step",
    "Notify the dashboard wizard about a step transition during a ceremony. Shows step status in the output stream panel.",
    {
      name: z.string().describe("Step identifier (e.g. 'create_milestone', 'assign_tickets')"),
      status: z.enum(["pending", "in_progress", "completed", "error"]).describe("New step status"),
      title: z.string().optional().describe("Human-readable step title"),
      description: z.string().optional().describe("What is happening in this step"),
    },
    async ({ name, status, title, description }) => {
      try {
        const port = resolveDashboardPort(db);
        try {
          await fetch(`http://localhost:${port}/api/claude-step`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...dashboardAuthHeaders() },
            body: JSON.stringify({ name, status, title: title || undefined, description: description || undefined }),
          }).catch(() => {});
        } catch {}
        return { content: [{ type: "text" as const, text: `Step '${name}' status: ${status}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_discovery_coverage",
    "Get coverage report for a discovery sprint — auto-promotes planned discoveries whose linked ticket is DONE",
    {
      sprint_id: z.number().optional().describe("Discovery sprint ID (omit for all sprints)"),
    },
    async ({ sprint_id }) => {
      try {
        // Auto-promote: planned discoveries whose ticket is now DONE
        db.prepare(`
          UPDATE discoveries SET status = 'implemented', updated_at = datetime('now')
          WHERE status = 'planned' AND implementation_ticket_id IS NOT NULL
            AND implementation_ticket_id IN (SELECT id FROM tickets WHERE status = 'DONE')
        `).run();

        let sql = `SELECT d.status, COUNT(*) as count FROM discoveries d WHERE 1=1`;
        const params: unknown[] = [];
        if (sprint_id) { sql += " AND d.discovery_sprint_id = ?"; params.push(sprint_id); }
        sql += " GROUP BY d.status";
        const rows = db.prepare(sql).all(...params) as { status: string; count: number }[];
        const total = rows.reduce((sum: number, r) => sum + r.count, 0);
        if (total === 0) return { content: [{ type: "text" as const, text: sprint_id ? `No discoveries in sprint ${sprint_id}.` : "No discoveries found." }] };

        const counts: Record<string, number> = { discovered: 0, planned: 0, implemented: 0, dropped: 0 };
        rows.forEach((r) => { counts[r.status] = r.count; });
        const pct = (n: number) => total > 0 ? Math.round(n / total * 100) : 0;

        // Per-sprint breakdown if no filter
        let breakdown = "";
        if (!sprint_id) {
          const sprintRows = db.prepare(`
            SELECT s.id, s.name, d.status, COUNT(*) as count
            FROM discoveries d JOIN sprints s ON d.discovery_sprint_id = s.id
            GROUP BY s.id, d.status ORDER BY s.created_at DESC
          `).all() as { id: number; name: string; status: string; count: number }[];
          const sprintMap = new Map<number, { name: string; counts: Record<string, number>; total: number }>();
          sprintRows.forEach((r) => {
            if (!sprintMap.has(r.id)) sprintMap.set(r.id, { name: r.name, counts: { discovered: 0, planned: 0, implemented: 0, dropped: 0 }, total: 0 });
            const entry = sprintMap.get(r.id)!;
            entry.counts[r.status] = r.count;
            entry.total += r.count;
          });
          breakdown = "\n\n## Per Sprint\n" + [...sprintMap.entries()].map(([, v]) =>
            `**${v.name}** (${v.total}): ${v.counts.implemented} implemented, ${v.counts.planned} planned, ${v.counts.discovered} undecided, ${v.counts.dropped} dropped`
          ).join("\n");
        }

        const text = `# Discovery Coverage\n\nTotal: ${total} discoveries\n\n| Status | Count | % |\n|--------|-------|---|\n| Implemented | ${counts.implemented} | ${pct(counts.implemented)}% |\n| Planned | ${counts.planned} | ${pct(counts.planned)}% |\n| Discovered | ${counts.discovered} | ${pct(counts.discovered)}% |\n| Dropped | ${counts.dropped} | ${pct(counts.dropped)}% |${breakdown}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── Ceremony Handlers (Dashboard Integration) ────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "handle_run_kickoff",
    "Handle the /kickoff ceremony triggered from the dashboard. Initiates the full project lifecycle from vision through sprint rest using the kickoff skill.",
    {},
    async () => {
      try {
        // Return instructions to invoke the kickoff skill
        return {
          content: [{
            type: "text" as const,
            text: "RUN_KICKOFF_CEREMONY: The dashboard has requested a project kickoff. Please execute the /kickoff skill to guide the user through the full scrum lifecycle (vision → discovery → milestone → epics → tickets → sprint launch → implementation → retro → close).",
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "handle_run_retro",
    "Handle the retrospective ceremony triggered from the dashboard. Runs retro for the specified sprint.",
    {
      sprint_id: z.number().describe("Sprint ID to run retro for"),
    },
    async ({ sprint_id }) => {
      try {
        const sprint = db.prepare("SELECT id, name, status FROM sprints WHERE id = ?").get(sprint_id) as Pick<SprintRow, "id" | "name" | "status"> | undefined;
        if (!sprint) {
          return { content: [{ type: "text" as const, text: `Error: Sprint ${sprint_id} not found` }], isError: true };
        }

        // Check if retro findings already exist
        const existing = db.prepare("SELECT COUNT(*) as c FROM retro_findings WHERE sprint_id = ?").get(sprint_id) as CountRow;
        const hasFindings = existing.c > 0;

        return {
          content: [{
            type: "text" as const,
            text: `RUN_RETRO_CEREMONY: The dashboard has requested a retrospective for Sprint "${sprint.name}" (#${sprint_id}).\n\n${hasFindings ? `Note: ${existing.c} retro findings already exist for this sprint.\n\n` : ""}Please guide the user through the retrospective ceremony:\n1. What went well?\n2. What went wrong?\n3. What to try next sprint?\n\nUse add_retro_finding to save each response.`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "handle_run_review",
    "Handle the sprint review ceremony triggered from the dashboard. Shows sprint completion summary and demo.",
    {
      sprint_id: z.number().describe("Sprint ID to run review for"),
    },
    async ({ sprint_id }) => {
      try {
        const sprint = db.prepare("SELECT id, name, status, goal, velocity_committed, velocity_completed FROM sprints WHERE id = ?").get(sprint_id) as Pick<SprintRow, "id" | "name" | "status" | "goal" | "velocity_committed" | "velocity_completed"> | undefined;
        if (!sprint) {
          return { content: [{ type: "text" as const, text: `Error: Sprint ${sprint_id} not found` }], isError: true };
        }

        const tickets = db.prepare("SELECT id, title, status, ticket_ref FROM tickets WHERE sprint_id = ?").all(sprint_id) as Pick<TicketRow, "id" | "title" | "status" | "ticket_ref">[];
        const done = tickets.filter((t) => t.status === 'DONE');
        const total = tickets.length;

        return {
          content: [{
            type: "text" as const,
            text: `RUN_REVIEW_CEREMONY: The dashboard has requested a sprint review for Sprint "${sprint.name}" (#${sprint_id}).\n\n## Sprint Summary\n- **Goal**: ${sprint.goal || 'N/A'}\n- **Velocity**: ${sprint.velocity_completed || 0}/${sprint.velocity_committed || 0} points\n- **Tickets**: ${done.length}/${total} completed\n\nPlease facilitate the sprint review:\n1. Show completed tickets and their value\n2. Demo any working features\n3. Discuss any incomplete work\n4. Celebrate wins with the team`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );
}
