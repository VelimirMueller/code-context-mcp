# MCP Tools Overview

The server exposes **103 tools** via the Model Context Protocol (97 by default; `CODE_CONTEXT_TOOLSETS=all` adds 6 optional ones): **13 code-context tools** (codebase indexing and search) and **90 scrum & agent tools** (sprints, tickets, ceremonies, metrics, and the agent workflow). Tool descriptions and directory metadata are maintained by the MCP server itself — the same indexing engine that powers the code-context tools also keeps their documentation up to date.

## Code-context tools

The codebase indexing and search half of the server. These 13 tools scan a directory, build a searchable index, and answer structured queries about files, symbols, and changes.

| Tool | Description |
|------|-------------|
| [`index_directory`](./index-directory) | Scan a directory and build the index |
| [`find_symbol`](./find-symbol) | Find which files export a given symbol |
| [`get_file_context`](./get-file-context) | Get full file context: exports, imports, dependents, changes |
| [`who_imports`](./who-imports) | Which files import a file or symbol: complete list from the import graph |
| [`exports_in`](./exports-in) | What a directory exports, and which exports nothing imports |
| [`get_changes`](./get-changes) | View recent file changes with diffs |
| [`search_files`](./search-files) | Search indexed files by path or summary |
| [`query`](./query-execute) | Run read-only SQL against the database |
| [`execute`](./query-execute) | Run write SQL against the database |
| `set_description` | Set a human-readable description for any indexed file |
| `set_directory_description` | Set a description for an indexed directory |
| `set_change_reason` | Record the reason behind a recorded file change |
| `health` | Report server and index health |

::: tip Read-only by default
`query` and `execute` are guarded: `query` accepts a single read-only `SELECT`/`WITH`, and `execute` accepts a single `INSERT`/`UPDATE`/`DELETE`. Stacked statements, comments, DDL, `PRAGMA`, and `ATTACH` are rejected.
:::

## Scrum & agent tools

The scrum/agent workflow half of the server. These 90 tools drive sprints, tickets, epics, milestones, ceremonies, metrics, and the 9-agent team that the `/kickoff`, `/sprint`, `/ticket`, `/milestone`, and `/retro` commands orchestrate. They are grouped below by area. (These tools do not have dedicated reference pages yet.)

### Agents & onboarding

`list_agents`, `get_agent`, `reset_agents`, `get_onboarding_status`, `run_onboarding`

### Sprints

`create_sprint`, `update_sprint`, `advance_sprint`, `start_sprint`, `list_sprints`, `get_sprint`, `get_sprint_summary`, `get_sprint_config`, `update_sprint_config`, `get_sprint_instructions`, `get_sprint_playbook`, `plan_sprint`, `export_sprint_report`, `reset_sprint_process`, `get_resume_state`, `get_project_status`

### Tickets

`create_ticket`, `update_ticket`, `list_tickets`, `get_ticket`, `get_backlog`, `add_dependency`, `remove_dependency`, `get_dependency_graph`, `add_tag`, `remove_tag`, `list_tags`, `create_blocker`, `resolve_blocker`, `log_bug`

### Epics & milestones

`create_epic`, `update_epic`, `list_epics`, `link_ticket_to_epic`, `create_milestone`, `update_milestone`, `list_milestones`, `link_ticket_to_milestone`, `update_vision`, `generate_vision_animation`

### Ceremonies

`handle_run_kickoff`, `handle_run_review`, `handle_run_retro`, `add_retro_finding`, `list_retro_findings`, `analyze_retro_patterns`, `record_mood`, `get_mood_trends`, `log_decision`, `list_decisions`

### Metrics & events

`get_burndown`, `get_velocity_trends`, `snapshot_sprint_metrics`, `log_time`, `get_time_report`, `log_token_usage`, `get_token_usage`, `log_event`, `list_recent_events`, `get_audit_trail`

### Discoveries

`create_discovery`, `list_discoveries`, `update_discovery`, `link_discovery_to_ticket`, `get_discovery_coverage`

### Skills & phase context

`load_phase_context`, `get_skill`, `reset_skills`

### Data & sync

`dump_database`, `restore_database`, `export_to_file`, `import_from_file`, `sync_scrum_data`, `search_scrum`

### Projects & GitHub

`set_project`, [`sync_github`](./sync-github) — a project key per repo, and a one-way sync of one project's milestones and tickets to GitHub issues and a Project board.

### Session bridge

`request_user_input`, `get_user_response`, `send_step_progress`¹, `send_claude_output`¹, `send_claude_step`¹

¹ Hidden by default since 2.6.0 — toolset `stream`. `record_mood`, `get_mood_trends` and `generate_vision_animation` are toolset `fun`. Enable with `CODE_CONTEXT_TOOLSETS=fun,stream` (or `all`); the data and the dashboard are unaffected.

## Context Efficiency

MCP returns structured metadata (summaries, exports, dependency edges) instead of raw file contents. In practice this yields **~2.7x less context** than reading files directly, allowing AI agents to work with larger codebases without exceeding token limits.
