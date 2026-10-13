/**
 * Row types for the scrum tables (#190). One interface per table, with the
 * columns of the schema after all migrations (src/scrum/schema.ts). SQLite
 * returns INTEGER as number, TEXT as string and NULL as null; a nullable
 * column is `T | null`.
 *
 * Use these for `SELECT *` rows: `db.prepare("SELECT * FROM tickets ...").get() as TicketRow | undefined`.
 * For a query that selects some columns, use `Pick<TicketRow, "id" | "title">`;
 * for joins and aggregates, declare the exact shape next to the query.
 */

export interface TicketRow {
  id: number;
  sprint_id: number | null;
  ticket_ref: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  assigned_to: string | null;
  story_points: number | null;
  milestone: string | null;
  milestone_id: number | null;
  epic_id: number | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  review_status: string | null;
  change_seq: number;
  pending_change: number;
  qa_verified: number;
  verified_by: string | null;
  acceptance_criteria: string | null;
  dependencies: string | null;
  notes: string | null;
  deleted_at: string | null;
  project: string | null;
  type: string | null;
  origin: string | null;
  github_issue: number | null;
  github_repo: string | null;
  github_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SprintRow {
  id: number;
  name: string;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  velocity_committed: number | null;
  velocity_completed: number | null;
  milestone_id: number | null;
  deleted_at: string | null;
  archived_at: string | null;
  project: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryRow {
  id: number;
  discovery_sprint_id: number;
  finding: string;
  category: string;
  status: string;
  priority: string | null;
  implementation_ticket_id: number | null;
  resolution_plan: string | null;
  drop_reason: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface EpicRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  milestone_id: number | null;
  color: string | null;
  priority: number;
  deleted_at: string | null;
  archived_at: string | null;
  project: string | null;
  created_at: string;
  updated_at: string;
}

export interface MilestoneRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  target_date: string | null;
  progress: number;
  deleted_at: string | null;
  archived_at: string | null;
  project: string | null;
  github_milestone: number | null;
  github_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: number;
  role: string;
  name: string;
  description: string | null;
  model: string | null;
  tools: string | null;
  system_prompt: string | null;
  department: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetroFindingRow {
  id: number;
  sprint_id: number;
  role: string | null;
  category: string;
  finding: string;
  action_owner: string | null;
  action_applied: number;
  linked_ticket_id: number | null;
  status: string;
  dropped_reason: string | null;
  deferred_at: string | null;
  created_at: string;
}

export interface BlockerRow {
  id: number;
  sprint_id: number;
  ticket_id: number | null;
  description: string;
  reported_by: string | null;
  escalated_to: string | null;
  status: string;
  resolved_at: string | null;
  created_at: string;
}

export interface BugRow {
  id: number;
  sprint_id: number;
  ticket_id: number | null;
  severity: string;
  description: string;
  steps_to_reproduce: string | null;
  expected: string | null;
  actual: string | null;
  status: string;
  created_at: string;
}

export interface SkillRow {
  id: number;
  name: string;
  content: string | null;
  owner_role: string | null;
  created_at: string;
  updated_at: string;
}

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
  created_at: string;
  updated_at: string;
}

export interface EventLogRow {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  actor: string | null;
  created_at: string;
}

export interface DecisionRow {
  id: number;
  title: string;
  rationale: string | null;
  alternatives: string | null;
  outcome: string | null;
  category: string | null;
  created_at: string | null;
}

/** `SELECT COUNT(*) as c ...` */
export interface CountRow {
  c: number;
}

/** The message of a caught value, for `catch (e)` blocks without `any`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
