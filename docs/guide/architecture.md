# Architecture

## Project Structure

### `src/` — TypeScript source code

The server has two halves — codebase context/indexing and a scrum/agent workflow — plus the bridge, dashboard, and Remotion modules. Five subdirectories: `server/`, `scrum/`, `dashboard/`, `bridge/`, `remotion/`.

#### `src/server/` — Core MCP server logic

Tool definitions, database schema, file indexer, setup script, and the SQL guard. 5 files, all TypeScript.

| File           | Lines | Size | Description                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ----: | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`     |   477 | 24KB | MCP server entry point. Registers the 11 code-context tools (`index_directory`, `find_symbol`, `get_file_context`, `set_description`, `set_directory_description`, `set_change_reason`, `get_changes`, `search_files`, `query`, `execute`, `health`), calls `registerScrumTools()` to add the scrum toolset onto the same server, and connects via stdio transport. |
| `schema.ts`    |    82 |  4KB | SQLite schema definitions for the code-context half. Creates tables for files, exports, dependencies, directories, and changes with appropriate indexes for fast lookups.                                                                                                                                                                                           |
| `indexer.ts`   |   895 | 36KB | Core indexing engine. Walks directories (with path-traversal containment), parses JS/TS imports and exports, extracts summaries from comments/JSDoc, resolves dependency graphs, computes diffs between index runs, and aggregates directory metadata.                                                                                                              |
| `setup.ts`     |   222 | 12KB | One-time setup script (`npx code-context-mcp setup [path]`). Runs a 6-step flow: init DB, index the target directory, seed factory defaults, configure the MCP client (`.mcp.json`), configure the bridge hook (`.claude/settings.json`), and install Claude commands (`.claude/commands/`).                                                                        |
| `sql-guard.ts` |    93 |  4KB | SQL safety guard for the `query`/`execute` tools. `query` allows a single read-only `SELECT`/`WITH`; `execute` allows a single `INSERT`/`UPDATE`/`DELETE`. Rejects stacked statements, comments, DDL, `PRAGMA`, and `ATTACH`.                                                                                                                                       |

#### `src/scrum/` — Scrum / agent workflow

The scrum and agent-team system: 83 MCP tools (sprints, tickets, epics, milestones, retros, mood, burndown, the 9-agent team) registered onto the server via `registerScrumTools()`.

| File                                   | Lines |  Size | Description                                                                                                                                                                                    |
| -------------------------------------- | ----: | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.ts`                             | 3,035 | 168KB | Defines and registers all 83 scrum tools via `registerScrumTools(server, db)`. Backs the slash commands (`/kickoff`, `/sprint`, `/ticket`, `/milestone`, `/retro`) and the dashboard.          |
| `schema.ts`                            |   528 |  28KB | SQLite schema for the scrum half — ~26 tables (sprints, tickets, epics, milestones, agents, retros, mood, decisions, events, skills, and more).                                                |
| `defaults.ts`                          |   350 |  16KB | Factory defaults seeded by `seedDefaults` — the 9 agents (fe-engineer, be-engineer, developer, devops, qa, security, architect, team-lead, product-owner), sprint config, and frontend skills. |
| `agent-model.ts`                       |    23 |   4KB | Maps each agent role to its model tier (dev roles + qa default to `claude-opus-4-8`; the rest to `claude-sonnet-4-6`), driving v1.3.0 model routing for ticket execution.                      |
| `frontend-playbook.ts`                 |    52 |   4KB | Builds the Frontend Playbook (house-style primer + skill index) injected by `load_phase_context` for `fe-engineer` tickets.                                                                    |
| `frontend-skill-defaults.generated.ts` |     — | 220KB | Generated module of seeded frontend skill bodies (build artifact from `vendor/skills/`).                                                                                                       |

#### `src/dashboard/` — Web dashboard

HTTP server, API endpoints, bearer-token auth, and the dashboard UI. The live UI is a React SPA (`app/`) served from `dist/dashboard/index.html`; `dashboard.html` is a single-file fallback only.

| File             | Lines |  Size | Description                                                                                                                                                                                                                                            |
| ---------------- | ----: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dashboard.ts`   | 2,105 | 100KB | HTTP server for the dashboard on port 3333. Serves the built SPA from `dist/dashboard/` (with `index.html` as the SPA fallback route), exposes JSON `/api/*` endpoints, and includes SSE for live updates. All `/api/*` routes require a bearer token. |
| `auth.ts`        |    68 |   4KB | Dashboard auth. Generates a bearer token on first run, persists it to `.code-context/dashboard.token`, and verifies it on `/api/*` requests.                                                                                                           |
| `dashboard.html` | 1,654 | 100KB | Single-file dashboard UI used only as a fallback when the built SPA is unavailable.                                                                                                                                                                    |
| `app/`           |     — |     — | React SPA (Vite + Zustand) — 6 top-level tabs (Dashboard, Planning, Code, Team, Retro, Benchmark) backed by 9 Zustand stores. Built into `dist/dashboard/`.                                                                                            |

#### `src/bridge/` — Claude Code bridge

| File      | Lines | Size | Description                                                                                                                                                            |
| --------- | ----: | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook.ts` |   166 |  8KB | Claude Code hook installed into `.claude/settings.json` by setup. Bridges the running Claude session to the dashboard/scrum data so live session activity is surfaced. |

#### `src/remotion/` — Vision animation rendering

Remotion compositions used to render the project vision animation (driven by the `generate_vision_animation` scrum tool).

| File              | Lines | Size | Description                                       |
| ----------------- | ----: | ---: | ------------------------------------------------- |
| `index.tsx`       |    32 |    — | Remotion entry point registering the composition. |
| `VisionVideo.tsx` |   135 |    — | The vision video composition.                     |
| `types.ts`        |     6 |    — | Shared types for the composition props.           |

#### `docs/` — VitePress documentation site

Guides, tool references, ADRs, and architecture docs. ~20 markdown files (excluding `node_modules`), including `docs/guide/`, `docs/tools/`, `docs/adr/`, and `docs/ux/`.

| Subdirectory  | Description                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/guide/` | Getting started guide and architecture overview (`index.md`, `architecture.md`)                                                        |
| `docs/tools/` | Reference pages for the code-context MCP tools — parameters, examples, and usage (7 files; `query`/`execute` share `query-execute.md`) |
| `docs/adr/`   | Architecture decision records (e.g. the Claude Code bridge)                                                                            |
| `docs/ux/`    | UX notes and navigation design docs                                                                                                    |

## Data Model

### files

Stores metadata for every indexed file: path, language, size, line count, summary, and full content.

### exports

Tracks named exports from JS/TS files (functions, classes, types, constants).

### dependencies

Maps import relationships between files with the imported symbols.

### changes

Append-only log of file changes: add, change, delete events with before/after snapshots and inline diffs.

## How Indexing Works

1. **Walk** the directory tree, skipping ignored dirs (`node_modules`, `.git`, `dist`, etc.)
2. **Parse** each file for imports, exports, and a summary (JSDoc, comments, or export list)
3. **Upsert** file metadata into SQLite
4. **Resolve** import paths to build the dependency graph
5. **Diff** the before/after snapshots and log changes

### Frontend skills

Frontend skills are vendored from `claude_development_skills` into `vendor/skills/` (build input), compiled by `scripts/compile-skills.mjs` into a generated defaults module, and seeded into the project DB `skills` table (`owner_role='fe-engineer'`) by `seedDefaults`. They are served — not copied: during `/kickoff`, `load_phase_context` detects `fe-engineer` tickets and injects a Frontend Playbook (editable house-style primer + skill index), and the agent fetches full skill bodies on demand via `get_skill`.
