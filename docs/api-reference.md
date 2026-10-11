# MCP Tools API Reference

Key tool reference for `vlm-code-context-mcp`. The server exposes **97 MCP tools** in the default profile (103 with `CODE_CONTEXT_TOOLSETS=all`, 6 with `code`): codebase-context tools (registered in `src/server/index.ts`) and scrum/workflow tools (registered in `src/scrum/tools.ts` and `src/scrum/tools/`). This page documents the most commonly used tools; for the full list use the MCP tool inspector or browse the source directly.

## Table of Contents

- [Codebase Indexing Tools](#codebase-indexing-tools)
- [File Context & Search](#file-context--search)
- [Scrum Management](#scrum-management)
- [Query & Execute](#query--execute)
- [Project Status](#project-status)

---

## Codebase Indexing Tools

### `index_directory`

Scan a directory, parse all files, extract metadata/exports and build a dependency graph.

**Parameters:**
```typescript
{
  path: string  // Absolute path to the directory to index
}
```

**Returns:** Structured markdown with directories, files, exports, and summaries.

**Example:**
```javascript
// Index your project
await index_directory({ path: "/home/user/my-project" });

// Returns summary like:
// "Indexed 174 files, 328 exports, 59 dependencies"
// ## Directories
// ### src/
// - **index.ts** — Main entry point
// - **utils/** (12 files) — Utility functions
```

---

### `find_symbol`

Find which file(s) export a given function, component, type, or constant.

**Parameters:**
```typescript
{
  name: string  // Symbol name to search for (supports % wildcards)
}
```

**Returns:** List of files with matching exports, including file path and summary.

**Example:**
```javascript
// Find where useEffect is exported
await find_symbol({ name: "useEffect" });
// Returns: "useEffect (hook) — src/hooks/index.ts
//          Custom React useEffect hook with cleanup handling"

// Wildcard search
await find_symbol({ name: "%Service" });
// Returns all symbols ending in "Service"
```

---

## File Context & Search

### `get_file_context`

What a file exports (one-line signatures with line numbers), its raw import lines, what it imports (dependencies), and what imports it (dependents). Full reference: [tools/get-file-context.md](tools/get-file-context.md).

**Parameters:**
```typescript
{
  path: string,               // Repo-relative or absolute file path
  snippet?: boolean,          // Add each export's source (≤ 20 lines each, ≈ 2 KB total)
  include_changes?: boolean,  // Add recent diffs
  change_limit?: number,      // Max diffs (default 3)
  absolute_paths?: boolean    // Print absolute paths
}
```

**Example:**
```javascript
await get_file_context({ path: "src/services/api.ts" });
// Returns:
// "# src/services/api.ts
// typescript | 1.0 KB | 39 lines | modified … | indexed …
// API service for making HTTP requests
// ## Exports (2)
// - L5 class ApiClient
// - L36 function createApiClient(baseUrl: string): ApiClient
// ## Import lines (2)
// L2 import { HttpMethod } from "../types.js";
// L3 import type { ApiResponse, User } from "../types.js";
// ## Imports from (1)
// - src/types.ts [HttpMethod]
// ## Imported by (1)
// - src/index.ts [ApiClient, createApiClient]"
```

---

### `search_files`

Search indexed files by path or summary (supports `%` wildcards).

**Parameters:**
```typescript
{
  query: string  // Search term (matched against path and summary)
}
```

**Returns:** List of matching files with metadata.

**Example:**
```javascript
await search_files({ query: "test" });
// Returns all files with "test" in path or summary

await search_files({ query: "%.test.ts" });
// Returns files ending in ".test.ts"
```

---

### `set_description`

Set a manual description for a file (persists across re-indexes).

**Parameters:**
```typescript
{
  path: string,        // Absolute file path
  description: string  // Description of what the file does
}
```

**Example:**
```javascript
await set_description({
  path: "/home/user/project/src/core.ts",
  description: "Core business logic for order processing"
});
```

---

### `set_directory_description`

Set a manual description for a directory (persists across re-indexes).

**Parameters:**
```typescript
{
  path: string,        // Absolute directory path
  description: string  // Description of what the directory contains
}
```

---

### `get_changes`

Get recent file changes grouped by file path, showing what changed (size, lines, exports, summary diffs).

**Parameters:**
```typescript
{
  file_path?: string,  // Filter to specific file (supports % wildcards)
  limit?: number       // Max changes to return (default 50)
}
```

**Returns:** Grouped changes by file with before/after comparisons.

---

## Scrum Management

### `get_project_status`

Check project setup status and return what is configured vs missing.

**Parameters:** None

**Returns:** Project health including file count, agent count, sprint count, and setup status.

**Example:**
```javascript
await get_project_status();
// Returns:
// "Files indexed: 195
//  Agents: 9
//  Sprints: 2
//  Tickets: 19
//  Skills: 5
// Project is set up and ready."
```

---

### `list_sprints`

List all sprints with status and ticket counts.

**Parameters:**
```typescript
{
  status?: string  // Filter by status: preparation|kickoff|planning|implementation|qa|refactoring|retro|review|closed|rest|done
}
```

**Returns:** All sprints with goal, ticket counts, and completion status.

---

### `get_sprint_summary`

Get a one-line summary per sprint — name, status, velocity, and ticket progress. Ultra-compact for quick overviews.

**Parameters:**
```typescript
{
  last_n?: number  // Number of recent sprints to return (default 5)
}
```

**Returns:** One line per sprint: name, status, velocity completed/committed with %, and ticket counts.

**Example:**
```javascript
await get_sprint_summary({ last_n: 3 });
// Returns:
// "sprint-21 [closed] 19/19pts (100%) 8/8 tickets
//  sprint-20 [closed] 15/19pts (79%) 6/8 tickets
//  sprint-19 [planning] 0/19pts (0%) 0/6 tickets"
```

---

### `get_sprint`

Get full sprint details with tickets, bugs, blockers, and retro findings.

**Parameters:**
```typescript
{
  sprint_id: number  // Sprint ID
}
```

**Returns:** Complete sprint information including all tickets and their status.

---

### `create_sprint`

Create a new sprint.

**Parameters:**
```typescript
{
  name: string,           // Sprint name (e.g. 'sprint-2026-04-07')
  goal: string,           // Sprint goal
  start_date?: string,    // Start date (ISO 8601)
  end_date?: string,      // End date (ISO 8601)
  milestone_id?: number   // Milestone ID to associate with
}
```

---

### `start_sprint`

Create a sprint with tickets in one call. Creates the sprint, creates tickets, assigns agents, links to milestone/epic.

**Parameters:**
```typescript
{
  name: string,
  goal: string,
  milestone_id?: number,
  epic_id?: number,
  velocity?: number,
  start_date?: string,
  end_date?: string,
  tickets: Array<{
    title: string,
    description?: string,
    priority?: "P0" | "P1" | "P2" | "P3",
    assigned_to?: string,
    story_points?: number
  }>
}
```

**Example:**
```javascript
await start_sprint({
  name: "Sprint 4 — Feature X",
  goal: "Complete user authentication flow",
  velocity: 19,
  tickets: [
    { title: "Add login form", story_points: 5, assigned_to: "fe-engineer" },
    { title: "Implement auth API", story_points: 5, assigned_to: "be-engineer" }
  ]
});
```

---

### `advance_sprint`

Advance sprint to the next phase. Checks all gates, advances if they pass, returns summary + next actions.

**Parameters:**
```typescript
{
  sprint_id: number,
  velocity_completed?: number  // Required when advancing to closed
}
```

**Returns:** Sprint status after phase transition with any warnings or next actions required.

---

### `update_ticket`

Update a ticket's status, assignment, milestone, epic, or QA verification.

**Parameters:**
```typescript
{
  ticket_id: number,
  status?: "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "PARTIAL" | "NOT_DONE",
  assigned_to?: string,
  qa_verified?: boolean,
  verified_by?: string,
  notes?: string,
  milestone_id?: number | null,
  epic_id?: number | null
}
```

**Example:**
```javascript
// Mark ticket as done and QA verified
await update_ticket({
  ticket_id: 42,
  status: "DONE",
  qa_verified: true,
  verified_by: "qa"
});
```

---

### `create_ticket`

Create a new ticket in a sprint.

**Parameters:**
```typescript
{
  sprint_id: number,
  title: string,
  ticket_ref?: string,      // Reference ID (e.g. T-021)
  description?: string,
  priority?: "P0" | "P1" | "P2" | "P3",
  assigned_to?: string,
  story_points?: number,
  milestone?: string,
  milestone_id?: number,
  epic_id?: number
}
```

---

### `list_tickets`

List tickets with optional filters.

**Parameters:**
```typescript
{
  sprint_id?: number,
  status?: "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "PARTIAL" | "NOT_DONE",
  assigned_to?: string
}
```

---

### `get_ticket`

Get full ticket details with subtasks and linked bugs.

**Parameters:**
```typescript
{
  ticket_id: number
}
```

---

### `get_skill`

Fetch the full content of a single skill by name.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Skill name — e.g. `fe:set-up-auth`, the primer `fe:_house-style`, a companion `fe:set-up-auth/auth-patterns.md`, or a shared ref `fe:_shared/<file>` |

Frontend skills are surfaced as an index by `load_phase_context` during `/kickoff` (when a sprint has `fe-engineer` work); call `get_skill` to pull the full guidance for a specific one on demand.

---

### `load_phase_context`

Single-call phase context loader. Bundles all data needed for a specific workflow phase into one response, replacing 2–5 separate tool calls. Used internally by `/kickoff`, `/sprint`, and other slash commands.

**Parameters:**
```typescript
{
  phase: "discovery" | "epics" | "tickets" | "implementation" | "retro",
  sprint_id?: number,  // Required for implementation and retro phases
  ticket_id?: number   // For implementation phase — includes full ticket detail + model routing directive
}
```

**Returns:** A combined markdown bundle:
- `discovery` — active discoveries, recent decisions, discovery coverage counts
- `epics` — active epics with ticket progress, agent roster
- `tickets` — velocity trend (last 5 sprints), backlog, active epics
- `implementation` — sprint progress, ticket list, open blockers, and (when fe-engineer tickets exist) the frontend skills index with a `Model routing` directive for the assigned agent
- `retro` — sprint summary, burndown snapshots, mood averages, retro patterns, recent velocity

**Example:**
```javascript
await load_phase_context({ phase: "implementation", sprint_id: 5, ticket_id: 42 });
// Returns combined sprint progress + ticket detail + model routing directive
```

---

## Epics & Milestones

### `create_epic`

Create a new epic to group related tickets.

**Parameters:**
```typescript
{
  name: string,
  description?: string,
  milestone_id?: number,
  color?: string,    // Hex color (default #3b82f6)
  priority?: number  // 0-4 (default 0)
}
```

---

### `update_epic`

Update an existing epic's fields, or archive / unarchive it.

**Parameters:**
```typescript
{
  epic_id: number,
  name?: string,
  description?: string,
  status?: string,
  color?: string,
  priority?: number,
  archived?: boolean,   // true = archive, false = unarchive
  force?: boolean       // archive even if status is not "completed"
}
```

Only `completed` epics archive without `force`. Archived epics are hidden from `list_epics`, `load_phase_context` and the dashboard until unarchived. Setting `status: "completed"` and `archived: true` in one call works; if the archive is rejected, nothing in the call is applied.

---

### `link_ticket_to_epic`

Link a ticket to an epic, or unlink by passing null epic_id.

**Parameters:**
```typescript
{
  ticket_id: number,
  epic_id: number | null
}
```

---

### `list_epics`

List epics with optional status and milestone filters, including ticket progress counts. Archived epics are hidden by default.

**Parameters:**
```typescript
{
  status?: string,
  milestone_id?: number,
  compact?: boolean,          // id, name, status only
  include_archived?: boolean  // default false; archived rows are marked "(archived)"
}
```

---

### `create_milestone`

Create a new milestone for the product roadmap.

**Parameters:**
```typescript
{
  name: string,             // Must be unique
  description?: string,
  target_date?: string,     // ISO 8601
  status?: "planned" | "active" | "completed"
}
```

---

### `update_milestone`

Update a milestone's status, progress, or details, or archive / unarchive it.

**Parameters:**
```typescript
{
  milestone_id: number,
  status?: "planned" | "active" | "completed",
  description?: string,
  progress?: number,    // 0-100
  target_date?: string,
  archived?: boolean,   // true = archive, false = unarchive
  force?: boolean       // archive even if status is not "completed"
}
```

Same archive rules as `update_epic`. Dashboard equivalent: `POST /api/milestone/:id/archive` and `/unarchive` (no `force`).

---

### `list_milestones`

List milestones with ticket progress. Archived milestones are hidden by default.

**Parameters:**
```typescript
{
  status?: "planned" | "active" | "completed",
  include_archived?: boolean,  // default false
  compact?: boolean            // id, name, status only
}
```

---

## Query & Execute (SQL Escape Hatches)

### `query`

Run a read-only SELECT query against the context database.

**Parameters:**
```typescript
{
  sql: string  // A SELECT SQL statement
}
```

**Returns:** JSON array of query results.

**Example:**
```javascript
await query({ sql: "SELECT * FROM tickets WHERE status = 'DONE'" });
// Returns: [{ id: 1, title: "...", status: "DONE" }, ...]
```

---

### `execute`

Run an INSERT, UPDATE, or DELETE against the context database.

**Parameters:**
```typescript
{
  sql: string,                // A write SQL statement
  params?: Array<any>          // Optional positional parameters
}
```

**Returns:** Rows affected and last insert ID.

**Example:**
```javascript
await execute({
  sql: "UPDATE tickets SET status = ? WHERE id = ?",
  params: ["DONE", 42]
});
// Returns: "Rows affected: 1, last id: 127"
```

---

## Agents

### `list_agents`

List all scrum team agents with their roles and capabilities.

**Parameters:** None

**Returns:** All agents with role, name, description, and model.

---

### `get_agent`

Get full details of a scrum agent by role.

**Parameters:**
```typescript
{
  role: string  // e.g. 'backend-developer'
}
```

---

### `update_agent`

Update a roster agent's model, tools, system prompt, name, description or department. Omitted fields stay unchanged. The model drives the **Model routing** directive that `load_phase_context` appends to a ticket (`claude-fable*` → fable, `claude-opus*` → opus, `claude-haiku*` → haiku, anything else → sonnet), so only known Claude ids are accepted — non-Claude runtimes belong on the ticket as a tag (e.g. `impl:glm`), not in the roster.

**Parameters:**
```typescript
{
  role: string,             // see list_agents
  model?: string,           // claude-fable-5 | claude-opus-5 | claude-sonnet-5 | claude-haiku-4-5 (+ superseded claude-opus-4-8, claude-sonnet-4-6)
  tools?: string | null,    // free-text tool inventory (null clears)
  system_prompt?: string | null,
  name?: string,
  description?: string,
  department?: string
}
```

**Returns:** the agent's new model and the tier it routes to.

> `create_ticket` / `update_ticket` reject an `assigned_to` that is not a roster role (unless the roster is empty) for the same reason: an unknown assignee silently routes to sonnet.

---

### `record_mood`

Record an agent's mood for a sprint (1-5 scale) for burnout detection.

**Parameters:**
```typescript
{
  agent_id: number,
  sprint_id: number,
  mood: number,        // 1-5 (1=burned out, 5=energized)
  workload_points?: number,
  notes?: string
}
```

---

### `get_mood_trends`

Get mood history for an agent or all agents — detects burnout patterns.

**Parameters:**
```typescript
{
  agent_id?: number,
  last_n_sprints?: number
}
```

---

## Blockers & Bugs

### `create_blocker`

Report a blocker on a sprint.

**Parameters:**
```typescript
{
  sprint_id: number,
  description: string,
  ticket_id?: number,
  reported_by?: string,
  escalated_to?: string
}
```

---

### `resolve_blocker`

Mark a blocker as resolved.

**Parameters:**
```typescript
{
  blocker_id: number
}
```

---

### `log_bug`

Log a bug against a sprint.

**Parameters:**
```typescript
{
  sprint_id: number,
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  description: string,
  ticket_id?: number,
  steps_to_reproduce?: string,
  expected?: string,
  actual?: string
}
```

---

## Retrospective

### `add_retro_finding`

Add a retrospective finding to a sprint.

**Parameters:**
```typescript
{
  sprint_id: number,
  category: "went_well" | "went_wrong" | "try_next",
  finding: string,
  role: string,
  action_owner?: string
}
```

---

### `list_retro_findings`

List retrospective findings with optional filters.

**Parameters:**
```typescript
{
  sprint_id?: number,
  category?: "went_well" | "went_wrong" | "try_next"
}
```

---

### `analyze_retro_patterns`

Analyze retrospective findings across all sprints — category breakdown, recurring issues, and action follow-through rate.

**Parameters:** None

---

## Decisions

### `log_decision`

Log an architectural or process decision with rationale and alternatives considered.

**Parameters:**
```typescript
{
  title: string,          // Decision title
  rationale?: string,     // Why this decision was made
  alternatives?: string,  // Alternatives considered
  outcome?: string,       // Expected or actual outcome
  category?: string       // e.g. "technical", "process", "product" (default: "technical")
}
```

**Example:**
```javascript
await log_decision({
  title: "Use SQLite for local persistence",
  rationale: "Zero-dependency, file-based, works offline",
  alternatives: "PostgreSQL (too heavy for local tooling), JSON files (no query support)",
  category: "technical"
});
// Returns: "Decision logged: #7 — Use SQLite for local persistence"
```

---

### `list_decisions`

List logged decisions with optional category filter.

**Parameters:**
```typescript
{
  category?: string,  // Filter by category
  limit?: number      // Max results (default 20)
}
```

---

## Dependencies

### `add_dependency`

Add a dependency between two tickets.

**Parameters:**
```typescript
{
  source_ticket_id: number,
  target_ticket_id: number,
  dependency_type: "blocks" | "blocked_by" | "related"
}
```

---

### `remove_dependency`

Remove a dependency between two tickets.

**Parameters:**
```typescript
{
  source_ticket_id: number,
  target_ticket_id: number
}
```

---

### `get_dependency_graph`

Get all dependencies for a ticket or sprint.

**Parameters:**
```typescript
{
  ticket_id?: number,
  sprint_id?: number
}
```

---

## Discoveries

### `create_discovery`

Log a finding from a discovery sprint.

**Parameters:**
```typescript
{
  sprint_id: number,
  finding: string,
  resolution_plan: string,
  category?: "architecture" | "ux" | "performance" | "testing" | "integration" | "general",
  priority?: "P0" | "P1" | "P2" | "P3",
  created_by?: string
}
```

---

### `update_discovery`

Update a discovery's status, priority, or drop reason.

**Parameters:**
```typescript
{
  discovery_id: number,
  status?: "discovered" | "planned" | "implemented" | "dropped",
  priority?: "P0" | "P1" | "P2" | "P3",
  drop_reason?: string,
  resolution_plan?: string
}
```

---

### `list_discoveries`

List discovery findings with optional filters.

**Parameters:**
```typescript
{
  sprint_id?: number,
  status?: "discovered" | "planned" | "implemented" | "dropped",
  category?: "architecture" | "ux" | "performance" | "testing" | "integration" | "general"
}
```

---

## Time Tracking

### `log_time`

Log estimated or actual hours on a ticket.

**Parameters:**
```typescript
{
  ticket_id: number,
  estimated_hours?: number,
  actual_hours?: number
}
```

---

### `get_time_report`

Get time tracking report for a sprint — estimated vs actual hours per agent.

**Parameters:**
```typescript
{
  sprint_id: number
}
```

---

## Velocity & Metrics

### `get_burndown`

Get burndown data for a sprint — daily snapshots of remaining vs completed points.

**Parameters:**
```typescript
{
  sprint_id: number
}
```

---

### `get_velocity_trends`

Get velocity trend data across sprints — committed vs completed, completion rate, bugs.

**Parameters:**
```typescript
{
  last_n_sprints?: number,
  status?: string
}
```

---

## Vision & Skills

### `update_vision`

Create or update the PRODUCT_VISION skill content.

**Parameters:**
```typescript
{
  content: string  // Markdown product vision content
}
```

---

## Database Management

### `dump_database`

Export the entire database to JSON for backup/restore.

**Parameters:**
```typescript
{
  tables?: Array<string>  // Specific tables to export (default: all)
}
```

---

### `restore_database`

Restore database from a JSON dump.

**Parameters:**
```typescript
{
  dump_json: string  // The full JSON dump string
}
```

---

### `export_to_file`

Export database to a JSON file on disk.

**Parameters:**
```typescript
{
  output_path?: string  // File path (default: ./code-context-dump.json)
}
```

---

### `import_from_file`

Restore database from a JSON dump file on disk.

**Parameters:**
```typescript
{
  input_path: string  // Path to the JSON dump file
}
```

---

## Full Reference

The server registers **101 tools** in total (13 codebase-context + 88 scrum). This page covers the key tools; the authoritative source for the full set is the source code:

- Codebase tools: `src/server/index.ts` (11 tools: `index_directory`, `search_files`, `get_file_context`, `find_symbol`, `get_changes`, `query`, `execute`, `set_description`, `set_directory_description`, `set_change_reason`, `health`)
- Scrum/workflow tools: `src/scrum/tools.ts` + `src/scrum/tools/` (88 tools)

You can also use the MCP tool inspector or call `list_agents` to see the 9 configured team agents and their model assignments.
