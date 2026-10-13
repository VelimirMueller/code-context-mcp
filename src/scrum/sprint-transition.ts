/**
 * Sprint phase transition + phase automation in one place (#189).
 *
 * Before, the close-out SQL (auto-analysis finding, discoveries to
 * implemented / dropped) was copied into update_sprint, advance_sprint and
 * three dashboard handlers. The copies drifted (role 'auto_analysis' vs
 * 'system', epics and milestones only on the dashboard path), and the
 * dashboard ran each step in an empty `catch {}` after the status was already
 * written.
 *
 * `transitionSprint` runs the status change and every automation step in one
 * `db.transaction`. A failing step rolls the whole transition back and throws
 * a `SprintTransitionError` that names the step; nothing is half-done and
 * nothing is dropped. MCP tools and dashboard handlers both call it.
 */
import type Database from "better-sqlite3";
import { log as slog, errorClass } from "../sessionlog.js";
import type { CountRow, SprintRow, TicketRow } from "./rows.js";
import { errorMessage } from "./rows.js";

/** Phases that close the work of a sprint: auto-analysis + discovery archive. */
const CLOSE_OUT_PHASES = new Set(["done", "closed", "retro"]);
/** Phases where velocity_completed is filled from DONE tickets when it is not set. */
const VELOCITY_COMPLETED_PHASES = new Set(["done", "closed", "rest"]);

export type TransitionActor = "mcp" | "dashboard";

export interface TransitionOptions {
  actor: TransitionActor;
  /** Caller name for log lines, e.g. "update_sprint" or "dashboard advance". */
  source: string;
  /** Explicit velocity_completed; otherwise it is computed from DONE tickets where needed. */
  velocityCompleted?: number | null;
}

export interface TransitionResult {
  sprintId: number;
  from: string;
  to: string;
  velocityCommitted: number | null;
  velocityCompleted: number | null;
  /** Short machine-readable tags of what ran, e.g. `retro_generated`, `2_discoveries_implemented`. */
  automations: string[];
  /** The auto-analysis text written to retro_findings, when one was written. */
  analysis: string | null;
  discoveries: { implemented: number; dropped: number };
}

/** A transition that could not run. `status` is the HTTP status the dashboard answers. */
export class SprintTransitionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly step: string | null = null,
  ) {
    super(message);
    this.name = "SprintTransitionError";
  }
}

type TicketPoints = Pick<TicketRow, "status" | "story_points">;

const sumPoints = (tickets: TicketPoints[]): number =>
  tickets.reduce((s, t) => s + (t.story_points || 0), 0);

/**
 * Move a sprint to `to` and run the automation of that phase, all in one
 * transaction. Throws SprintTransitionError (404 when the sprint does not
 * exist, 500 with the step name when a step fails).
 */
export function transitionSprint(
  db: Database.Database,
  sprintId: number,
  to: string,
  opts: TransitionOptions,
): TransitionResult {
  const run = db.transaction((): TransitionResult => {
    const sprint = db
      .prepare("SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL")
      .get(sprintId) as SprintRow | undefined;
    if (!sprint) throw new SprintTransitionError(`Sprint #${sprintId} not found`, 404);

    const tickets = db
      .prepare("SELECT status, story_points FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL")
      .all(sprintId) as TicketPoints[];
    const result: TransitionResult = {
      sprintId,
      from: sprint.status,
      to,
      velocityCommitted: sprint.velocity_committed,
      velocityCompleted: sprint.velocity_completed,
      automations: [],
      analysis: null,
      discoveries: { implemented: 0, dropped: 0 },
    };

    const step = <T>(name: string, fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof SprintTransitionError) throw e;
        throw new SprintTransitionError(
          `Sprint #${sprintId} ${sprint.status} → ${to}: step "${name}" failed: ${errorMessage(e)}`,
          500,
          name,
        );
      }
    };

    // Commitment freezes when implementation starts and is never recalculated after.
    if (to === "implementation" && !(sprint.velocity_committed && sprint.velocity_committed > 0)) {
      result.velocityCommitted = sumPoints(tickets);
      result.automations.push("velocity_committed_frozen");
    }
    if (opts.velocityCompleted !== undefined && opts.velocityCompleted !== null) {
      result.velocityCompleted = opts.velocityCompleted;
    } else if (VELOCITY_COMPLETED_PHASES.has(to) && !sprint.velocity_completed) {
      result.velocityCompleted = sumPoints(tickets.filter((t) => t.status === "DONE"));
    }

    step("status", () => {
      db.prepare(
        `UPDATE sprints SET status = ?, velocity_committed = ?, velocity_completed = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(to, result.velocityCommitted, result.velocityCompleted, sprintId);
    });
    // The audit trail is best-effort (T-269): a failed event_log write never
    // blocks the transition, but it is reported on stderr, never dropped.
    try {
      db.prepare(
        `INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'status_changed', 'status', ?, ?, ?)`,
      ).run(sprintId, sprint.status, to, opts.actor);
    } catch (e) {
      console.error(`[audit] ${opts.source} sprint #${sprintId} status ${sprint.status}→${to}: ` + errorMessage(e));
    }

    if (CLOSE_OUT_PHASES.has(to)) {
      result.analysis = step("auto_analysis", () => writeAutoAnalysis(db, sprint, tickets, result));
      result.automations.push("retro_generated");
      result.discoveries = step("archive_discoveries", () => archiveSprintDiscoveries(db, sprintId));
      if (result.discoveries.implemented > 0) result.automations.push(`${result.discoveries.implemented}_discoveries_implemented`);
      if (result.discoveries.dropped > 0) result.automations.push(`${result.discoveries.dropped}_discoveries_dropped`);
    }

    if (to === "rest") {
      step("complete_epics", () => completeSprintEpics(db, sprintId, result.automations));
      if (sprint.milestone_id) {
        step("milestone_progress", () => updateMilestoneProgress(db, sprint.milestone_id!, result.automations));
      }
    }

    return result;
  });

  try {
    const result = run();
    slog("INFO", `${opts.source}: sprint=${sprintId} phase ${result.from}→${to} automations=${result.automations.length}`);
    return result;
  } catch (e) {
    const stepName = e instanceof SprintTransitionError && e.step ? e.step : "-";
    slog("WARN", `${opts.source}: transition rolled back sprint=${sprintId} to=${to} step=${stepName} error=${errorClass(e)}`);
    throw e;
  }
}

/**
 * One auto-analysis finding per sprint (role 'system'). A later close-out
 * phase replaces the earlier row instead of adding a second one.
 */
function writeAutoAnalysis(
  db: Database.Database,
  sprint: SprintRow,
  tickets: TicketPoints[],
  result: TransitionResult,
): string {
  const total = tickets.length;
  const done = tickets.filter((t) => t.status === "DONE").length;
  const rate = total > 0 ? Math.round((done / total) * 100) : 0;
  const committed = result.velocityCommitted ?? 0;
  const completed = result.velocityCompleted ?? 0;
  const delta = completed - committed;
  const blockers = (db.prepare(`SELECT COUNT(*) as c FROM blockers WHERE sprint_id = ?`).get(sprint.id) as CountRow).c;
  const recent = db
    .prepare(
      `SELECT name, velocity_committed, velocity_completed FROM sprints
       WHERE status IN ('closed', 'rest') AND id != ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
    )
    .all(sprint.id) as Pick<SprintRow, "name" | "velocity_committed" | "velocity_completed">[];
  const trend = recent.length > 0
    ? recent.map((s) => `${s.name}: ${s.velocity_completed ?? 0}/${s.velocity_committed ?? 0}`).join(", ")
    : "No prior sprints";
  const analysis = [
    `Auto-analysis for ${sprint.name}: ${done}/${total} tickets done (${rate}% completion rate)`,
    `Velocity: ${completed}pt completed of ${committed}pt committed (${delta >= 0 ? "+" : ""}${delta}pt)`,
    `Blockers: ${blockers}`,
    `Trend (last 5): ${trend}`,
  ].join(" | ");

  db.prepare(`DELETE FROM retro_findings WHERE sprint_id = ? AND category = 'auto_analysis'`).run(sprint.id);
  db.prepare(
    `INSERT INTO retro_findings (sprint_id, category, finding, role) VALUES (?, 'auto_analysis', ?, 'system')`,
  ).run(sprint.id, analysis);
  return analysis;
}

/** Planned discoveries of the sprint: implemented when the ticket is DONE, else dropped. */
export function archiveSprintDiscoveries(db: Database.Database, sprintId: number): { implemented: number; dropped: number } {
  const implemented = db.prepare(`
    UPDATE discoveries SET status = 'implemented', updated_at = datetime('now')
    WHERE discovery_sprint_id = ? AND status = 'planned'
      AND implementation_ticket_id IN (SELECT id FROM tickets WHERE sprint_id = ? AND status = 'DONE')
  `).run(sprintId, sprintId).changes;
  const dropped = db.prepare(`
    UPDATE discoveries SET status = 'dropped', drop_reason = 'Sprint closed without completion', updated_at = datetime('now')
    WHERE discovery_sprint_id = ? AND status = 'planned'
      AND implementation_ticket_id IN (SELECT id FROM tickets WHERE sprint_id = ? AND status != 'DONE')
  `).run(sprintId, sprintId).changes;
  return { implemented, dropped };
}

/** Epics of the sprint's tickets whose tickets are all DONE become completed. */
function completeSprintEpics(db: Database.Database, sprintId: number, automations: string[]): void {
  const epicIds = db
    .prepare(`SELECT DISTINCT epic_id FROM tickets WHERE sprint_id = ? AND epic_id IS NOT NULL AND deleted_at IS NULL`)
    .all(sprintId) as { epic_id: number }[];
  for (const { epic_id } of epicIds) {
    const undone = (db
      .prepare(`SELECT COUNT(*) as c FROM tickets WHERE epic_id = ? AND status != 'DONE' AND deleted_at IS NULL`)
      .get(epic_id) as CountRow).c;
    if (undone === 0) {
      const changed = db
        .prepare(`UPDATE epics SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status != 'completed'`)
        .run(epic_id).changes;
      if (changed > 0) automations.push(`epic_${epic_id}_completed`);
    }
  }
}

/** Milestone progress = DONE tickets / tickets of its sprints; completed at 100 % with all epics completed. */
function updateMilestoneProgress(db: Database.Database, milestoneId: number, automations: string[]): void {
  const exists = db.prepare(`SELECT id FROM milestones WHERE id = ?`).get(milestoneId);
  if (!exists) return;
  const total = (db.prepare(`
    SELECT COUNT(*) as c FROM tickets t JOIN sprints s ON t.sprint_id = s.id
    WHERE s.milestone_id = ? AND t.deleted_at IS NULL
  `).get(milestoneId) as CountRow).c;
  const done = (db.prepare(`
    SELECT COUNT(*) as c FROM tickets t JOIN sprints s ON t.sprint_id = s.id
    WHERE s.milestone_id = ? AND t.status = 'DONE' AND t.deleted_at IS NULL
  `).get(milestoneId) as CountRow).c;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const incompleteEpics = (db.prepare(`
    SELECT COUNT(*) as c FROM epics WHERE milestone_id = ? AND status != 'completed' AND deleted_at IS NULL
  `).get(milestoneId) as CountRow).c;
  const status = incompleteEpics === 0 && progress === 100 ? "completed" : "active";
  db.prepare(`UPDATE milestones SET progress = ?, status = ?, updated_at = datetime('now') WHERE id = ?`).run(progress, status, milestoneId);
  automations.push(`milestone_progress_${progress}%`);
  if (status === "completed") automations.push("milestone_completed");
}

/**
 * A ticket moved to DONE: its planned discoveries become implemented.
 * Call inside the transaction that writes the ticket status.
 */
export function promoteTicketDiscoveries(db: Database.Database, ticketId: number): number {
  return db.prepare(`
    UPDATE discoveries SET status = 'implemented', updated_at = datetime('now')
    WHERE status = 'planned' AND implementation_ticket_id = ?
  `).run(ticketId).changes;
}
