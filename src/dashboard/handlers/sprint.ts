/**
 * Scrum API handlers — sprints, tickets, retro, burndown, blockers, bugs.
 *
 * Migrated out of ../dashboard.ts (T-278) along the plan documented in
 * ./index.ts. Each function takes the shared Database connection (`db`, the
 * same read-write connection that owns the scrum schema) and returns plain
 * data; the router in dashboard.ts calls these instead of inline query logic.
 * Query bodies are byte-identical to the originals — zero route-surface change.
 *
 * Side-effects stay in the router per the migration contract: mutating routes
 * call `notifyClients()` after the handler, and `apiSprintUpdate` no longer
 * rebuilds marketing stats itself (the router does that when status='closed').
 */
import type Database from 'better-sqlite3';
import type { CountRow, SprintRow, TicketRow } from '../../scrum/rows.js';
import {
  validateEnum,
  validateSprintTransition,
  badRequest,
  ALLOWED_AGENT_MODELS,
} from './validation.js';
import { log as slog } from '../../sessionlog.js';
import { transitionSprint, promoteTicketDiscoveries } from '../../scrum/sprint-transition.js';
import {
  parseBody,
  RetroFindingCreateBody,
  RetroFindingUpdateBody,
  SprintStuckBody,
  BlockerCreateBody,
  StatusOnlyBody,
  BugCreateBody,
  MilestoneLinkBody,
  PlanSprintBody,
  SprintUpdateBody,
  TicketCreateBody,
  TicketUpdateBody,
  TicketPatchBody,
} from './schemas.js';

// ─── Scrum reads ────────────────────────────────────────────────────────────

export function apiSprints(db: Database.Database) {
  try {
    return db
      .prepare(
        `
      SELECT s.*,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND deleted_at IS NULL) as ticket_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND status = 'DONE' AND deleted_at IS NULL) as done_count,
        (SELECT COUNT(*) FROM tickets WHERE sprint_id = s.id AND qa_verified = 1 AND deleted_at IS NULL) as qa_count,
        (SELECT COUNT(*) FROM retro_findings WHERE sprint_id = s.id) as retro_count,
        (SELECT COUNT(*) FROM blockers WHERE sprint_id = s.id AND status = 'open') as open_blockers
      FROM sprints s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC
    `,
      )
      .all();
  } catch (e) {
    console.error('[api] apiSprints error:', e);
    return [];
  }
}

export function apiSprintDetail(db: Database.Database, id: number) {
  try {
    const sprint = db.prepare(`SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL`).get(id);
    if (!sprint) return null;
    return sprint;
  } catch (e) {
    console.error('[api] apiSprintDetail error:', e);
    return null;
  }
}

export function apiBurndown(db: Database.Database, sprintId: number) {
  try {
    const sprint = db
      .prepare(
        `SELECT name, velocity_committed, start_date, end_date FROM sprints WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(sprintId) as any;
    if (!sprint) return null;
    const metrics = db
      .prepare(
        `SELECT date, remaining_points, completed_points, added_points, removed_points FROM sprint_metrics WHERE sprint_id = ? ORDER BY date`,
      )
      .all(sprintId) as any[];
    // Also compute live snapshot from current tickets if no metrics recorded yet
    const tickets = db
      .prepare(
        `SELECT status, story_points FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL`,
      )
      .all(sprintId) as any[];
    const totalPts = tickets.reduce((s: number, t: any) => s + (t.story_points || 0), 0);
    const donePts = tickets
      .filter((t: any) => t.status === 'DONE')
      .reduce((s: number, t: any) => s + (t.story_points || 0), 0);
    return {
      sprint_name: sprint.name,
      committed: sprint.velocity_committed || totalPts,
      start_date: sprint.start_date,
      end_date: sprint.end_date,
      current: { remaining: totalPts - donePts, completed: donePts, total: totalPts },
      metrics,
    };
  } catch {
    return { metrics: [] };
  }
}

export function apiSprintTickets(db: Database.Database, sprintId: number) {
  try {
    return db
      .prepare(
        `
      SELECT t.id, t.ticket_ref, t.title, t.description, t.priority, t.status, t.assigned_to,
        t.story_points, t.milestone, t.milestone_id, t.epic_id, t.qa_verified, t.verified_by, t.acceptance_criteria, t.notes, t.review_status,
        m.name as milestone_name,
        e.name as epic_name
      FROM tickets t
      LEFT JOIN milestones m ON t.milestone_id = m.id
      LEFT JOIN epics e ON t.epic_id = e.id
      WHERE t.sprint_id = ? AND t.deleted_at IS NULL ORDER BY t.priority, t.status
    `,
      )
      .all(sprintId);
  } catch (e) {
    console.error('[api] apiSprintTickets error:', e);
    return [];
  }
}

export function apiSprintRetro(db: Database.Database, sprintId: number) {
  try {
    return db
      .prepare(
        `
      SELECT id, role, category, finding, action_owner, action_applied, linked_ticket_id
      FROM retro_findings WHERE sprint_id = ? ORDER BY category
    `,
      )
      .all(sprintId);
  } catch {
    return [];
  }
}

export function createRetroFinding(db: Database.Database, sprintId: number, raw: unknown) {
  const body = parseBody(RetroFindingCreateBody, raw);
  db.prepare(
    `INSERT INTO retro_findings (sprint_id, role, category, finding, action_owner) VALUES (?, ?, ?, ?, ?)`,
  ).run(sprintId, body.role ?? null, body.category, body.finding, body.action_owner ?? null);
}

export function updateRetroFinding(db: Database.Database, findingId: number, raw: unknown) {
  const body = parseBody(RetroFindingUpdateBody, raw);
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (body.action_applied !== undefined) {
    updates.push('action_applied = ?');
    params.push(body.action_applied ? 1 : 0);
  }
  if (body.action_owner) {
    updates.push('action_owner = ?');
    params.push(body.action_owner);
  }
  if (body.linked_ticket_id !== undefined) {
    updates.push('linked_ticket_id = ?');
    params.push(body.linked_ticket_id);
  }
  if (updates.length > 0) {
    params.push(findingId);
    db.prepare(`UPDATE retro_findings SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
}

export function apiSprintBlockers(db: Database.Database, sprintId: number) {
  try {
    return db
      .prepare(
        `
      SELECT b.id, b.sprint_id, b.ticket_id, b.description, b.reported_by,
        b.escalated_to, b.status, b.resolved_at, b.created_at,
        t.title as ticket_title
      FROM blockers b
      LEFT JOIN tickets t ON b.ticket_id = t.id
      WHERE b.sprint_id = ? ORDER BY b.status DESC, b.created_at DESC
    `,
      )
      .all(sprintId);
  } catch {
    return [];
  }
}

export function apiSprintBugs(db: Database.Database, sprintId: number) {
  try {
    return db
      .prepare(
        `
      SELECT bg.id, bg.sprint_id, bg.ticket_id, bg.severity, bg.description,
        bg.steps_to_reproduce, bg.expected, bg.actual, bg.status, bg.created_at,
        t.title as ticket_title
      FROM bugs bg
      LEFT JOIN tickets t ON bg.ticket_id = t.id
      WHERE bg.sprint_id = ? ORDER BY
        CASE bg.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        bg.status DESC, bg.created_at DESC
    `,
      )
      .all(sprintId);
  } catch {
    return [];
  }
}

export function apiAllRetroFindings(db: Database.Database) {
  try {
    return db
      .prepare(
        `
      SELECT rf.id, rf.role, rf.category, rf.finding, rf.action_owner, rf.action_applied,
        rf.sprint_id, s.name as sprint_name
      FROM retro_findings rf
      JOIN sprints s ON rf.sprint_id = s.id AND s.deleted_at IS NULL
      ORDER BY s.created_at DESC, rf.category
    `,
      )
      .all();
  } catch {
    return [];
  }
}

// ─── Sprint stuck / Blocker / Bug CRUD ─────────────────────────────────────

export function apiReportSprintStuck(db: Database.Database, sprintId: number, raw: unknown) {
  const body = parseBody(SprintStuckBody, raw);
  const sprint = db
    .prepare(`SELECT name, status FROM sprints WHERE id = ? AND deleted_at IS NULL`)
    .get(sprintId) as Pick<SprintRow, 'name' | 'status'> | undefined;
  if (!sprint) throw Object.assign(new Error('sprint not found'), { status: 404 });
  db.prepare(
    `INSERT INTO blockers (sprint_id, description, reported_by, status) VALUES (?, ?, ?, 'open')`,
  ).run(
    sprintId,
    `Sprint stuck in ${body.phase || sprint.status} phase for 10+ minutes. Requires intervention.`,
    'dashboard-ui',
  );
  return { ok: true, message: `Blocker created: sprint ${sprint.name} stuck in ${sprint.status}` };
}

export function apiCreateBlocker(db: Database.Database, sprintId: number, raw: unknown) {
  const body = parseBody(BlockerCreateBody, raw);
  db.prepare(
    `INSERT INTO blockers (sprint_id, ticket_id, description, reported_by, escalated_to, status) VALUES (?, ?, ?, ?, ?, 'open')`,
  ).run(
    sprintId,
    body.ticket_id ?? null,
    body.description,
    body.reported_by ?? null,
    body.escalated_to ?? null,
  );
  return { ok: true };
}

export function apiUpdateBlocker(db: Database.Database, blockerId: number, raw: unknown) {
  const body = parseBody(StatusOnlyBody, raw);
  if (body.status === 'resolved') {
    db.prepare(
      `UPDATE blockers SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`,
    ).run(blockerId);
  } else if (body.status) {
    db.prepare(`UPDATE blockers SET status = ? WHERE id = ?`).run(body.status, blockerId);
  }
  return { ok: true };
}

export function apiCreateBug(db: Database.Database, sprintId: number, raw: unknown) {
  const body = parseBody(BugCreateBody, raw);
  db.prepare(
    `INSERT INTO bugs (sprint_id, ticket_id, severity, description, steps_to_reproduce, expected, actual, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(
    sprintId,
    body.ticket_id ?? null,
    body.severity,
    body.description,
    body.steps_to_reproduce ?? null,
    body.expected ?? null,
    body.actual ?? null,
  );
  return { ok: true };
}

export function apiUpdateBug(db: Database.Database, bugId: number, raw: unknown) {
  const body = parseBody(StatusOnlyBody, raw);
  if (body.status) {
    db.prepare(`UPDATE bugs SET status = ? WHERE id = ?`).run(body.status, bugId);
  }
  return { ok: true };
}

// ─── Sprint lifecycle (delete / archive / plan / advance / update) ──────────

export function apiDeleteSprint(db: Database.Database, sprintId: number) {
  const existing = db
    .prepare('SELECT id FROM sprints WHERE id = ? AND deleted_at IS NULL')
    .get(sprintId);
  if (!existing) throw Object.assign(new Error('sprint not found'), { status: 404 });
  db.prepare("UPDATE tickets SET deleted_at = datetime('now') WHERE sprint_id = ?").run(sprintId);
  db.prepare("UPDATE sprints SET deleted_at = datetime('now') WHERE id = ?").run(sprintId);
  return { ok: true };
}

// Sprints are archivable only once finished. Eligibility is enforced here (server-side,
// single source of truth) so a stale frontend can never archive an in-flight sprint.
const ARCHIVABLE_STATUSES = ['closed', 'rest', 'done'] as const;

export function apiArchiveSprint(db: Database.Database, sprintId: number) {
  const sprint = db
    .prepare('SELECT id, status, archived_at FROM sprints WHERE id = ? AND deleted_at IS NULL')
    .get(sprintId) as any;
  if (!sprint) throw Object.assign(new Error('sprint not found'), { status: 404 });
  if (!ARCHIVABLE_STATUSES.includes(sprint.status)) {
    throw Object.assign(
      new Error(
        `only finished sprints can be archived (status must be one of: ${ARCHIVABLE_STATUSES.join(', ')}); got '${sprint.status}'`,
      ),
      { status: 400 },
    );
  }
  db.prepare(
    "UPDATE sprints SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(sprintId);
  const updated = db.prepare('SELECT archived_at FROM sprints WHERE id = ?').get(sprintId) as any;
  try {
    db.prepare(
      "INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'updated', 'archived_at', ?, ?, 'dashboard')",
    ).run(sprintId, sprint.archived_at ?? null, updated.archived_at);
  } catch (e) {
    console.error('[api] apiArchiveSprint audit error:', e);
  }
  return { ok: true, archived_at: updated.archived_at };
}

export function apiUnarchiveSprint(db: Database.Database, sprintId: number) {
  const sprint = db
    .prepare('SELECT id, archived_at FROM sprints WHERE id = ? AND deleted_at IS NULL')
    .get(sprintId) as any;
  if (!sprint) throw Object.assign(new Error('sprint not found'), { status: 404 });
  db.prepare(
    "UPDATE sprints SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(sprintId);
  try {
    db.prepare(
      "INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'updated', 'archived_at', ?, NULL, 'dashboard')",
    ).run(sprintId, sprint.archived_at ?? null);
  } catch (e) {
    console.error('[api] apiUnarchiveSprint audit error:', e);
  }
  return { ok: true, archived_at: null };
}

export function apiArchiveCompletedSprints(db: Database.Database) {
  // One transaction: select the eligible ids, archive them all, audit one event each.
  const bulk = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id FROM sprints WHERE status IN ('closed', 'rest', 'done') AND archived_at IS NULL AND deleted_at IS NULL`,
      )
      .all() as Array<{ id: number }>;
    const update = db.prepare(
      "UPDATE sprints SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    );
    const audit = db.prepare(
      "INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('sprint', ?, 'updated', 'archived_at', NULL, ?, 'dashboard')",
    );
    const select = db.prepare('SELECT archived_at FROM sprints WHERE id = ?');
    for (const { id } of rows) {
      update.run(id);
      const { archived_at } = select.get(id) as any;
      try {
        audit.run(id, archived_at);
      } catch (e) {
        console.error('[api] apiArchiveCompletedSprints audit error:', e);
      }
    }
    return rows.length;
  });
  return { archived: bulk() };
}

export function apiUpdateTicketMilestone(db: Database.Database, ticketId: number, raw: unknown) {
  const milestoneId = parseBody(MilestoneLinkBody, raw).milestone_id;
  if (milestoneId === null || milestoneId === undefined) {
    db.prepare('UPDATE tickets SET milestone = NULL, milestone_id = NULL WHERE id = ?').run(
      ticketId,
    );
  } else {
    const milestone = db.prepare('SELECT name FROM milestones WHERE id = ?').get(milestoneId) as
      | { name: string }
      | undefined;
    if (!milestone) throw Object.assign(new Error('milestone not found'), { status: 404 });
    db.prepare('UPDATE tickets SET milestone = ?, milestone_id = ? WHERE id = ?').run(
      milestone.name,
      milestoneId,
      ticketId,
    );
  }
  return { ok: true };
}

export function apiPlanSprint(db: Database.Database, raw: unknown) {
  const body = parseBody(PlanSprintBody, raw);
  const name = body.name;
  const goal = body.goal;
  // The schema refine guarantees one of the two arrays.
  const ticketIds = body.ticketIds ?? body.ticket_ids ?? [];
  const velocity = body.targetVelocity ?? body.velocity_committed ?? 0;
  const startDate = body.startDate ?? body.start_date ?? null;
  const endDate = body.endDate ?? body.end_date ?? null;
  const result = db
    .prepare(
      `INSERT INTO sprints (name, goal, status, velocity_committed, start_date, end_date) VALUES (?, ?, 'planning', ?, ?, ?)`,
    )
    .run(name, goal || null, velocity, startDate, endDate);
  const sprintId = result.lastInsertRowid;
  const updateStmt = db.prepare(
    `UPDATE tickets SET sprint_id=?, updated_at=datetime('now') WHERE id=?`,
  );
  for (const tid of ticketIds) {
    updateStmt.run(sprintId, tid);
  }
  return { id: sprintId, name, tickets_assigned: ticketIds.length };
}

// ─── Sprint Advance API (direct, no bridge) ────────────────────────────────
export function apiAdvanceSprint(db: Database.Database, sprintId: number) {
  const sprint = db
    .prepare('SELECT status FROM sprints WHERE id = ? AND deleted_at IS NULL')
    .get(sprintId) as Pick<SprintRow, 'status'> | undefined;
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });

  const TRANSITIONS: Record<string, string> = {
    planning: 'implementation',
    implementation: 'done',
    done: 'rest',
    rest: 'planning',
    preparation: 'implementation',
    kickoff: 'implementation',
    qa: 'done',
    refactoring: 'done',
    retro: 'rest',
    review: 'rest',
    closed: 'rest',
  };
  const nextPhase = TRANSITIONS[sprint.status];
  if (!nextPhase)
    throw Object.assign(new Error(`No transition from ${sprint.status}`), { status: 400 });

  // Status + automation in one transaction (#189); a failed step rolls back and throws.
  const t = transitionSprint(db, sprintId, nextPhase, {
    actor: 'dashboard',
    source: 'dashboard: advance',
  });
  return { ok: true, from: t.from, to: t.to, sprint_id: sprintId, automations: t.automations };
}

// ─── Sprint Update API ──────────────────────────────────────────────────────
const SPRINT_PHASE_ORDER = [
  'planning',
  'implementation',
  'done',
  'rest',
  'preparation',
  'kickoff',
  'qa',
  'refactoring',
  'retro',
  'review',
  'closed',
] as const;

export function verifyPhaseGate(
  db: Database.Database,
  sprintId: number,
  targetPhase: string,
): { canTransition: boolean; blockers: string[]; warnings: string[] } {
  const warnings: string[] = [];

  const sprint = db
    .prepare('SELECT * FROM sprints WHERE id = ? AND deleted_at IS NULL')
    .get(sprintId) as any;
  if (!sprint) return { canTransition: false, blockers: ['Sprint not found'], warnings: [] };

  if (targetPhase === 'implementation') {
    const ticketCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM tickets WHERE sprint_id = ? AND deleted_at IS NULL')
        .get(sprintId) as any
    ).c;
    if (ticketCount === 0) warnings.push('No tickets assigned to this sprint');
    if (!sprint.velocity_committed) warnings.push('No velocity committed');
  }

  if (targetPhase === 'done' || targetPhase === 'qa') {
    const undone = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM tickets WHERE sprint_id = ? AND status != 'DONE' AND deleted_at IS NULL",
        )
        .get(sprintId) as any
    ).c;
    if (undone > 0) warnings.push(`${undone} tickets not DONE`);
    const openBlockers = (
      db
        .prepare("SELECT COUNT(*) as c FROM blockers WHERE sprint_id = ? AND status = 'open'")
        .get(sprintId) as any
    ).c;
    if (openBlockers > 0) warnings.push(`${openBlockers} open blockers`);
  }

  if (targetPhase === 'rest') {
    const retroCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM retro_findings WHERE sprint_id = ?')
        .get(sprintId) as any
    ).c;
    if (retroCount === 0) warnings.push('No retro findings recorded');
    if (!sprint.velocity_completed) warnings.push('Velocity completed not set');
  }

  // Advisory gates: always allow transition, just warn
  return { canTransition: true, blockers: [], warnings };
}

/**
 * Update a sprint's mutable fields and (advisory) phase transition.
 *
 * Returns `{ result, marketingDirty }`. `marketingDirty` is true when the sprint
 * was closed (status='closed'); the router rebuilds marketing stats in that case
 * — that side-effect stays out of the handler per the migration contract.
 */
export function apiSprintUpdate(
  db: Database.Database,
  id: number,
  raw: unknown,
): { result: { id: number; updated: true; review_warnings?: string[] }; marketingDirty: boolean } {
  const body = parseBody(SprintUpdateBody, raw);
  // Read current sprint state before updating
  const current = db.prepare(`SELECT * FROM sprints WHERE id = ?`).get(id) as SprintRow | undefined;
  if (!current) throw new Error('sprint not found');

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  let reviewWarnings: string[] | undefined;

  // Phase gate verification before transition (advisory — never blocks)
  const gateWarnings: string[] = [];
  if (body.status && body.status !== current.status) {
    const gate = verifyPhaseGate(db, id, body.status);
    gateWarnings.push(...gate.warnings);
  }

  // Phase transition validation when status is changing
  if (body.status && body.status !== current.status) {
    const newStatus = body.status;
    const currentStatus = current.status;

    // Validate transition order
    validateEnum(newStatus, [...SPRINT_PHASE_ORDER], 'sprint status');
    validateEnum(currentStatus, [...SPRINT_PHASE_ORDER], 'sprint status');
    validateSprintTransition(currentStatus, newStatus);

    // When transitioning to 'done' or 'qa': advisory warnings only
    if (newStatus === 'done' || newStatus === 'qa') {
      const undone = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM tickets WHERE sprint_id = ? AND status != 'DONE' AND deleted_at IS NULL`,
          )
          .get(id) as CountRow
      ).c;
      if (undone > 0) {
        gateWarnings.push(`${undone} ticket(s) are not DONE`);
      }

      // M13-038: Review sign-off warning for senior role tickets
      const unapproved = db
        .prepare(
          `SELECT ticket_ref, title, assigned_to, review_status FROM tickets
         WHERE sprint_id = ? AND deleted_at IS NULL
           AND status = 'DONE'
           AND assigned_to IN ('architect','lead-developer','scrum-master')
           AND (review_status IS NULL OR review_status != 'approved')`,
        )
        .all(id) as Pick<TicketRow, 'ticket_ref' | 'title' | 'assigned_to' | 'review_status'>[];
      if (unapproved.length > 0) {
        reviewWarnings = unapproved.map(
          (t) => `${t.ticket_ref} (${t.assigned_to}): review_status=${t.review_status ?? 'none'}`,
        );
      }
    }
  }
  const changesStatus = !!body.status && body.status !== current.status;

  if (body.goal !== undefined) {
    sets.push('goal=?');
    vals.push(body.goal);
  }
  if (body.velocity_committed !== undefined) {
    sets.push('velocity_committed=?');
    vals.push(body.velocity_committed);
  }
  if (body.velocity_completed !== undefined && !changesStatus) {
    sets.push('velocity_completed=?');
    vals.push(body.velocity_completed);
  }
  if (sets.length === 0 && !changesStatus) throw new Error('nothing to update');

  // Field updates + phase transition + its automation (auto-analysis, discovery
  // archive, epics, milestone) in one transaction (#189). The marketing-stats
  // rebuild on 'closed' stays a router side-effect — see `marketingDirty`.
  db.transaction(() => {
    if (sets.length > 0) {
      db.prepare(
        `UPDATE sprints SET ${[...sets, "updated_at=datetime('now')"].join(',')} WHERE id=?`,
      ).run(...vals, id);
    }
    if (changesStatus) {
      transitionSprint(db, id, body.status!, {
        actor: 'dashboard',
        source: 'dashboard: sprint update',
        velocityCompleted: body.velocity_completed,
      });
    }
  })();
  if (changesStatus && gateWarnings.length > 0) {
    slog(
      'WARN',
      `dashboard: gate warnings sprint=${id} to=${body.status} count=${gateWarnings.length}`,
    );
  }

  const result: { id: number; updated: true; review_warnings?: string[] } = { id, updated: true };
  if (reviewWarnings) {
    result.review_warnings = reviewWarnings;
  }
  return { result, marketingDirty: body.status === 'closed' };
}

// ─── Ticket CRUD API ────────────────────────────────────────────────────────
/** Same as the `tickets.priority` column default and the MCP create_ticket default. */
export const DEFAULT_TICKET_PRIORITY = 'P2';

/**
 * Next free `T-<n>` ref (#210). `n` starts after the highest id of all rows,
 * soft-deleted ones included (ids are AUTOINCREMENT, so they are never reused),
 * and skips any ref that a row already has, for example one the MCP
 * `create_ticket` tool set by hand. Call it in the transaction that inserts.
 */
export function nextTicketRef(db: Database.Database): string {
  const maxId = db.prepare(`SELECT MAX(id) AS m FROM tickets`).get() as { m: number | null };
  const taken = db.prepare(`SELECT 1 FROM tickets WHERE ticket_ref = ? LIMIT 1`);
  let n = (maxId.m ?? 0) + 1;
  while (taken.get(`T-${n}`)) n++;
  return `T-${n}`;
}

export function apiCreateTicket(db: Database.Database, raw: unknown) {
  const {
    title,
    description,
    priority,
    sprint_id,
    epic_id,
    milestone_id,
    assigned_to,
    story_points,
  } = parseBody(TicketCreateBody, raw);
  // No priority (absent or null) gets the column default, the same value the MCP
  // create_ticket tool uses. Any other value must be a valid priority.
  const ticketPriority = priority ?? DEFAULT_TICKET_PRIORITY;
  validateEnum(ticketPriority, ['P0', 'P1', 'P2', 'P3'], 'priority');

  // Resolve milestone name if milestone_id provided
  let milestone: string | null = null;
  if (milestone_id) {
    const ms = db.prepare(`SELECT name FROM milestones WHERE id = ?`).get(milestone_id) as
      | { name: string }
      | undefined;
    if (ms) milestone = ms.name;
  }

  // Ref and insert in one IMMEDIATE transaction: the write lock is taken before the
  // reads, so no other connection (e.g. the MCP server on the same file) can take the
  // ref between them.
  const insert = db.transaction(() => {
    const ticket_ref = nextTicketRef(db);
    return db
      .prepare(
        `
    INSERT INTO tickets (ticket_ref, title, description, priority, sprint_id, epic_id, milestone_id, milestone, assigned_to, story_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      )
      .run(
        ticket_ref,
        title,
        description || null,
        ticketPriority,
        sprint_id || null,
        epic_id || null,
        milestone_id || null,
        milestone,
        assigned_to || null,
        story_points ?? 0,
      );
  });
  const result = insert.immediate();

  // The saved row, so the caller sees the stored defaults (priority, status).
  return db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(result.lastInsertRowid) as TicketRow;
}

export function apiUpdateTicket(db: Database.Database, id: number, raw: unknown) {
  const body = parseBody(TicketUpdateBody, raw);
  const existing = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as
    | TicketRow
    | undefined;
  if (!existing) throw new Error('ticket not found');

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (body.title !== undefined) {
    sets.push('title=?');
    vals.push(body.title);
  }
  if (body.description !== undefined) {
    sets.push('description=?');
    vals.push(body.description);
  }
  if (body.priority !== undefined) {
    validateEnum(body.priority, ['P0', 'P1', 'P2', 'P3'], 'priority');
    sets.push('priority=?');
    vals.push(body.priority);
  }
  if (body.status !== undefined) {
    validateEnum(
      body.status,
      ['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'PARTIAL', 'NOT_DONE'],
      'ticket status',
    );
    sets.push('status=?');
    vals.push(body.status);
  }
  if (body.assigned_to !== undefined) {
    sets.push('assigned_to=?');
    vals.push(body.assigned_to);
  }
  if (body.story_points !== undefined) {
    sets.push('story_points=?');
    vals.push(body.story_points);
  }
  if (body.qa_verified !== undefined) {
    sets.push('qa_verified=?');
    vals.push(body.qa_verified ? 1 : 0);
  }
  if (body.review_status !== undefined) {
    if (body.review_status !== null)
      validateEnum(body.review_status, ['pending', 'approved', 'rejected'], 'review_status');
    sets.push('review_status=?');
    vals.push(body.review_status);
  }
  if (body.epic_id !== undefined) {
    sets.push('epic_id=?');
    vals.push(body.epic_id);
  }
  if (body.milestone_id !== undefined) {
    sets.push('milestone_id=?');
    vals.push(body.milestone_id);
    // Also update milestone name
    if (body.milestone_id) {
      const ms = db.prepare(`SELECT name FROM milestones WHERE id = ?`).get(body.milestone_id) as
        | { name: string }
        | undefined;
      sets.push('milestone=?');
      vals.push(ms?.name || null);
    } else {
      sets.push('milestone=?');
      vals.push(null);
    }
  }
  if (sets.length === 0) throw new Error('nothing to update');
  sets.push("updated_at=datetime('now')");
  vals.push(id);
  db.transaction(() => {
    db.prepare(`UPDATE tickets SET ${sets.join(',')} WHERE id=?`).run(...vals);
    // A ticket moved to DONE promotes its planned discoveries (#189: shared helper, no empty catch).
    if (body.status === 'DONE') promoteTicketDiscoveries(db, id);
  })();
  if (body.status !== undefined && body.status !== existing.status) {
    slog('INFO', `dashboard: ticket=${id} status ${existing.status}→${body.status}`);
  }

  return { id, updated: true };
}

// ─── D1b (T-248): dashboard full-field ticket PATCH ─────────────────────────
// UI-editable surface only. DONE/PARTIAL/NOT_DONE and qa_verified stay
// process-controlled (QA gate integrity — spec "Risks" #6): this endpoint can
// never produce them. Sprint-scope edits (sprint_id) are also out of surface.
const UI_TICKET_PATCH_FIELDS = [
  'title',
  'description',
  'notes',
  'story_points',
  'priority',
  'status',
  'assignments',
];
const UI_TICKET_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED'];
const PROCESS_CONTROLLED_TICKET_STATUSES = ['DONE', 'PARTIAL', 'NOT_DONE'];

interface TicketAssignmentRow {
  role: string;
  model: string | null;
  is_lead: number;
}

/** Validate + normalize the request's assignments array (D2 replace-set input). */
function normalizeTicketAssignments(db: Database.Database, raw: any): TicketAssignmentRow[] {
  if (!Array.isArray(raw))
    throw badRequest('assignments must be an array of { role, model?, lead? }');
  const seen = new Set<string>();
  const out: TicketAssignmentRow[] = [];
  let leadCount = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('each assignment must be an object { role, model?, lead? }');
    }
    const { role, model, lead } = entry as { role?: unknown; model?: unknown; lead?: unknown };
    if (typeof role !== 'string' || !role.trim())
      throw badRequest('assignment role must be a non-empty string');
    if (seen.has(role)) throw badRequest(`duplicate assignment role '${role}'`);
    seen.add(role);
    if (!db.prepare('SELECT role FROM agents WHERE role = ?').get(role)) {
      throw badRequest(`unknown role '${role}': no such agent`);
    }
    if (model !== undefined && model !== null) {
      if (typeof model !== 'string') throw badRequest('assignment model must be a string or null');
      validateEnum(model, ALLOWED_AGENT_MODELS, 'model');
    }
    if (lead !== undefined && typeof lead !== 'boolean')
      throw badRequest('assignment lead must be a boolean');
    if (lead === true) leadCount++;
    out.push({
      role,
      model: (model as string | null | undefined) ?? null,
      is_lead: lead === true ? 1 : 0,
    });
  }
  if (leadCount !== 1) {
    throw badRequest(`exactly one assignment must have lead=true (got ${leadCount})`);
  }
  // Lead first, then alphabetical — same deterministic order the response uses.
  return out.sort((a, b) => b.is_lead - a.is_lead || a.role.localeCompare(b.role));
}

function getTicketAssignments(db: Database.Database, ticketId: number): TicketAssignmentRow[] {
  return db
    .prepare(
      'SELECT role, model, is_lead FROM ticket_assignments WHERE ticket_id = ? ORDER BY is_lead DESC, role',
    )
    .all(ticketId) as TicketAssignmentRow[];
}

/** Full ticket row (incl. change_seq / pending_change) + its assignments. */
function getTicketWithAssignments(db: Database.Database, ticketId: number): any {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  return { ...ticket, assignments: getTicketAssignments(db, ticketId) };
}

function assignmentSetsEqual(a: TicketAssignmentRow[], b: TicketAssignmentRow[]): boolean {
  const key = (rows: TicketAssignmentRow[]) =>
    JSON.stringify([...rows].sort((x, y) => x.role.localeCompare(y.role)));
  return key(a) === key(b);
}

export function apiPatchTicket(
  db: Database.Database,
  id: number,
  raw: unknown,
): { result: { ok: true; ticket: any }; changedFields: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- field rules below check each value's type (D1b)
  const body: Record<string, any> = parseBody(TicketPatchBody, raw);
  for (const key of Object.keys(body)) {
    if (!UI_TICKET_PATCH_FIELDS.includes(key)) {
      const hint =
        key === 'qa_verified'
          ? ' — qa_verified is process-controlled (QA gate) and can never be set from the UI'
          : '';
      throw badRequest(
        `unknown field '${key}'${hint}. UI-editable fields: ${UI_TICKET_PATCH_FIELDS.join(', ')}`,
      );
    }
  }
  if (Object.keys(body).length === 0) {
    throw badRequest(
      `nothing to update — provide at least one of: ${UI_TICKET_PATCH_FIELDS.join(', ')}`,
    );
  }

  const existing = db
    .prepare('SELECT * FROM tickets WHERE id = ? AND deleted_at IS NULL')
    .get(id) as any;
  if (!existing) throw Object.assign(new Error('ticket not found'), { status: 404 });

  // Validate every provided field, recording only actual value changes.
  const changedFields: string[] = [];
  const oldValues: Record<string, any> = {};
  const newValues: Record<string, any> = {};
  const sets: string[] = [];
  const vals: any[] = [];
  const recordScalar = (field: string, oldVal: any, newVal: any) => {
    changedFields.push(field);
    oldValues[field] = oldVal;
    newValues[field] = newVal;
    sets.push(`${field}=?`);
    vals.push(newVal);
  };

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim())
      throw badRequest('title must be a non-empty string');
    if (body.title !== existing.title) recordScalar('title', existing.title, body.title);
  }
  // Clearable text fields (description, notes): a string or null; null clears (#206).
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string')
      throw badRequest('description must be a string or null');
    if (body.description !== existing.description)
      recordScalar('description', existing.description, body.description);
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string')
      throw badRequest('notes must be a string or null');
    if (body.notes !== existing.notes) recordScalar('notes', existing.notes, body.notes);
  }
  if (body.story_points !== undefined) {
    if (
      typeof body.story_points !== 'number' ||
      !Number.isInteger(body.story_points) ||
      body.story_points < 0
    ) {
      throw badRequest('story_points must be a non-negative integer');
    }
    if (body.story_points !== existing.story_points)
      recordScalar('story_points', existing.story_points, body.story_points);
  }
  if (body.priority !== undefined) {
    validateEnum(body.priority, ['P0', 'P1', 'P2', 'P3'], 'priority');
    if (body.priority !== existing.priority)
      recordScalar('priority', existing.priority, body.priority);
  }
  if (body.status !== undefined) {
    if (!UI_TICKET_STATUSES.includes(body.status)) {
      const hint = PROCESS_CONTROLLED_TICKET_STATUSES.includes(body.status)
        ? ` — '${body.status}' is process-controlled (QA gate) and can never be set from the UI`
        : '';
      throw badRequest(
        `invalid status '${body.status}'${hint}. Allowed from the UI: ${UI_TICKET_STATUSES.join(', ')}`,
      );
    }
    if (body.status !== existing.status) {
      if (!UI_TICKET_STATUSES.includes(existing.status)) {
        throw badRequest(
          `illegal status transition ${existing.status} → ${body.status}: UI transitions are limited to TODO ↔ IN_PROGRESS ↔ BLOCKED`,
        );
      }
      recordScalar('status', existing.status, body.status);
    }
  }

  // Assignments: replace-set semantics — the array replaces all rows for the ticket.
  let newAssignments: TicketAssignmentRow[] | null = null;
  if (body.assignments !== undefined) {
    const normalized = normalizeTicketAssignments(db, body.assignments);
    const current = getTicketAssignments(db, id);
    if (!assignmentSetsEqual(current, normalized)) {
      newAssignments = normalized;
      changedFields.push('assignments');
      oldValues.assignments = current;
      newValues.assignments = normalized;
      // Mirror the lead role into tickets.assigned_to (compat for existing queries/UI).
      const leadRole = normalized.find((a) => a.is_lead === 1)!.role;
      if (leadRole !== existing.assigned_to) {
        sets.push('assigned_to=?');
        vals.push(leadRole);
      }
    }
  }

  // Nothing actually changed → succeed without bumping change_seq or writing
  // a revision (an empty diff would only make sessions chase a no-op).
  if (changedFields.length === 0) {
    return { result: { ok: true, ticket: getTicketWithAssignments(db, id) }, changedFields: [] };
  }

  // One transaction: field updates + change flags + revision + pending_action + events.
  const apply = db.transaction(() => {
    if (newAssignments) {
      db.prepare('DELETE FROM ticket_assignments WHERE ticket_id = ?').run(id);
      const ins = db.prepare(
        'INSERT INTO ticket_assignments (ticket_id, role, model, is_lead) VALUES (?, ?, ?, ?)',
      );
      for (const a of newAssignments) ins.run(id, a.role, a.model, a.is_lead);
    }

    sets.push('change_seq = change_seq + 1', 'pending_change = 1', "updated_at = datetime('now')");
    db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

    db.prepare(
      "INSERT INTO ticket_revisions (ticket_id, source, changed_fields, old_values, new_values) VALUES (?, 'ui', ?, ?, ?)",
    ).run(id, JSON.stringify(changedFields), JSON.stringify(oldValues), JSON.stringify(newValues));

    db.prepare(
      "INSERT INTO pending_actions (action, entity_type, entity_id, source, status, payload) VALUES ('ticket_changed', 'ticket', ?, 'dashboard', 'pending', ?)",
    ).run(
      id,
      JSON.stringify({
        changed_fields: changedFields,
        old_values: oldValues,
        new_values: newValues,
      }),
    );

    const logEvent = db.prepare(
      "INSERT INTO event_log (entity_type, entity_id, action, field_name, old_value, new_value, actor) VALUES ('ticket', ?, 'updated', ?, ?, ?, 'dashboard')",
    );
    for (const field of changedFields) {
      if (field === 'assignments') continue; // not scalar — captured in the revision diff
      logEvent.run(
        id,
        field,
        oldValues[field] == null ? null : String(oldValues[field]),
        newValues[field] == null ? null : String(newValues[field]),
      );
    }
  });
  apply();
  if (changedFields.includes('status')) {
    slog('INFO', `dashboard: ticket=${id} status ${oldValues.status}→${newValues.status}`);
  }

  return { result: { ok: true, ticket: getTicketWithAssignments(db, id) }, changedFields };
}
