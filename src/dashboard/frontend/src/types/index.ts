export interface File {
  id: number;
  path: string;
  language: string;
  extension: string;
  size_bytes: number;
  line_count: number;
  summary: string;
  external_imports: string | null;
  created_at: string;
  modified_at: string;
  indexed_at: string;
  export_count: number;
  imports_count: number;
  imported_by_count: number;
}

export interface Directory {
  id: number;
  path: string;
  name: string;
  parent_path: string | null;
  depth: number;
  file_count: number;
  total_size_bytes: number;
  total_lines: number;
  language_breakdown: string;
  description: string | null;
  indexed_at: string;
}

export interface Sprint {
  id: number;
  name: string;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  archived_at: string | null;
  milestone_id?: number;
  velocity_committed: number;
  velocity_completed: number;
  created_at: string;
  updated_at: string;
  ticket_count: number;
  done_count: number;
  qa_count: number;
  retro_count: number;
  open_blockers: number;
}

export interface TicketAssignment {
  role: string;
  model: string | null;
  is_lead: number;
}

export interface Ticket {
  id: number;
  ticket_ref: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  assigned_to: string | null;
  story_points: number | null;
  milestone: string | null;
  milestone_id?: number;
  milestone_name?: string;
  epic_id?: number;
  epic_name?: string;
  qa_verified: number;
  verified_by: string | null;
  acceptance_criteria: string | null;
  notes: string | null;
  change_seq?: number;
  pending_change?: number;
  assignments?: TicketAssignment[];
}

export interface Agent {
  role: string;
  name: string;
  description: string;
  model: string;
  department: string;
  done_tickets: number;
  active_tickets: number;
  blocked_tickets: number;
  active_points: number;
  mood: number;
  mood_emoji: string;
  mood_label: string;
}

export interface Epic {
  id: number;
  name: string;
  description: string | null;
  status: string;
  milestone_id: number | null;
  color: string;
  priority: number;
  ticket_count: number;
  done_count: number;
  created_at: string;
  /** Set when archived (schema v24); hidden from default views. */
  archived_at?: string | null;
}

export interface RetroFinding {
  id: number;
  role: string | null;
  category: string;
  finding: string;
  action_owner: string | null;
  action_applied: number;
  /** Set by GET /api/retro/all (apiAllRetroFindings), not by the per-sprint route. */
  sprint_id?: number;
}

export interface MilestoneSprint {
  id: number;
  name: string;
  status: string;
  velocity_committed: number;
  velocity_completed: number;
  ticket_count: number;
  done_count: number;
}

export interface Milestone {
  id: number;
  name: string;
  description: string | null;
  status: string;
  target_date: string | null;
  progress: number;
  ticket_count: number;
  done_count: number;
  sprints?: MilestoneSprint[];
  /** Set when archived (schema v24); hidden from default views. */
  archived_at?: string | null;
}

export interface MilestoneSprintGroup {
  milestone: Milestone | null;
  sprints: Sprint[];
}

export interface Stats {
  files: number;
  exports: number;
  deps: number;
  totalLines: number;
  totalSize: number;
  languages: Array<{ language: string; c: number }>;
  extensions: Array<{ extension: string; c: number }>;
}

export interface Discovery {
  id: number;
  discovery_sprint_id: number;
  finding: string;
  category: string;
  status: 'discovered' | 'planned' | 'implemented' | 'dropped';
  priority: string;
  resolution_plan: string | null;
  implementation_ticket_id: number | null;
  drop_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  sprint_name: string;
  ticket_title: string | null;
  ticket_status: string | null;
}

export interface BurndownMetric {
  date: string;
  remaining_points: number;
  completed_points: number;
  added_points: number;
  removed_points: number;
}

export interface BurndownData {
  sprint_name: string;
  committed: number;
  start_date: string | null;
  end_date: string | null;
  current: { remaining: number; completed: number; total: number };
  metrics: BurndownMetric[];
}

export interface Blocker {
  id: number;
  sprint_id: number;
  ticket_id: number | null;
  description: string;
  reported_by: string | null;
  escalated_to: string | null;
  status: 'open' | 'resolved';
  resolved_at: string | null;
  created_at: string;
  ticket_title?: string | null;
}

export interface Bug {
  id: number;
  sprint_id: number;
  ticket_id: number | null;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  steps_to_reproduce: string | null;
  expected: string | null;
  actual: string | null;
  status: 'open' | 'fixed' | 'deferred';
  created_at: string;
  ticket_title?: string | null;
}

export interface DiscoveryCoverage {
  total: number;
  discovered: number;
  planned: number;
  implemented: number;
  dropped: number;
}

export interface DiscoverySprint {
  id: number;
  name: string;
}
