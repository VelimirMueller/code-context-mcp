# Getting Started

## Project Overview

`vlm-code-context-mcp` is an MCP server with two halves that share one SQLite database:

1. **Codebase context & indexing** — index a project, search files, resolve symbols, track changes, and run guarded SQL against the index. Exposed through 11 code-context tools.
2. **A scrum / agent workflow** — sprints, tickets, epics, milestones, retros, mood and burndown tracking, a 9-agent team, slash commands, and a React dashboard. Exposed through 83 scrum tools.

In total the server registers **94 MCP tools** (11 code-context + 83 scrum). The scrum tools are registered onto the same server via `registerScrumTools()` in `src/scrum/tools.ts`.

Here is the directory breakdown:

| Directory        | Description                                                                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bridge/`    | The bridge hook that connects the live AI session to the dashboard (`hook.ts`).                                                                                                                                                                                                                                 |
| `src/dashboard/` | Web dashboard — HTTP server (`dashboard.ts`), bearer-token auth (`auth.ts`), a static fallback page (`dashboard.html`), and the React SPA under `app/`.                                                                                                                                                         |
| `src/remotion/`  | Remotion video composition for the vision animation (`index.tsx`, `types.ts`, `VisionVideo.tsx`).                                                                                                                                                                                                               |
| `src/scrum/`     | The scrum/agent system — 83 tools (`tools.ts`), the ~26-table schema (`schema.ts`), factory defaults including the 9 agents (`defaults.ts`), model-routing helpers (`agent-model.ts`), and the frontend skill playbook and generated defaults (`frontend-playbook.ts`, `frontend-skill-defaults.generated.ts`). |
| `src/server/`    | Core MCP server — the 11 code-context tools (`index.ts`), the file indexer (`indexer.ts`), the index schema (`schema.ts`), the SQL guard (`sql-guard.ts`), and the `setup` CLI (`setup.ts`).                                                                                                                    |
| `docs/`          | VitePress documentation site — guides, tool references, and architecture docs.                                                                                                                                                                                                                                  |
| `docs/guide/`    | This getting-started guide and the architecture overview.                                                                                                                                                                                                                                                       |
| `docs/tools/`    | Reference pages for the MCP tools — parameters, examples, and usage.                                                                                                                                                                                                                                            |

## The code-context tools

The 11 code-context tools (defined in `src/server/index.ts`):

`index_directory`, `search_files`, `get_file_context`, `find_symbol`, `get_changes`, `query`, `execute`, `set_description`, `set_directory_description`, `set_change_reason`, and `health`.

`query` and `execute` are guarded by `src/server/sql-guard.ts`: `query` accepts a single read-only `SELECT`/`WITH`; `execute` accepts a single `INSERT`/`UPDATE`/`DELETE`. Neither allows stacked statements, comments, DDL, `PRAGMA`, or `ATTACH`.

## The scrum / agent system

The scrum half manages a full sprint lifecycle from the same database. It ships with a **9-agent team** (defined in `src/scrum/defaults.ts`):

| Agent           | Default model       |
| --------------- | ------------------- |
| `fe-engineer`   | `claude-opus-4-8`   |
| `be-engineer`   | `claude-opus-4-8`   |
| `developer`     | `claude-opus-4-8`   |
| `qa`            | `claude-opus-4-8`   |
| `devops`        | `claude-sonnet-4-6` |
| `security`      | `claude-sonnet-4-6` |
| `architect`     | `claude-sonnet-4-6` |
| `team-lead`     | `claude-sonnet-4-6` |
| `product-owner` | `claude-sonnet-4-6` |

**Model routing.** A ticket's assigned-agent model routes execution. `load_phase_context` (implementation phase) and `get_ticket` emit a "Model routing" directive, and `/kickoff` / `/sprint` implement each ticket by spawning a subagent at that tier.

**Frontend skills.** Frontend skills are server-provided: they are seeded into the database and served into the live session via `load_phase_context` and the `get_skill` tool. Vendored skill source lives under `vendor/skills/`.

### Slash commands

Setup installs Claude commands into `.claude/commands/`:

- `/kickoff` — interactive, guided full sprint lifecycle
- `/sprint` — automated sprint tool chain
- `/ticket` — ticket management
- `/milestone` — milestone management
- `/retro` — retrospective and cumulative learnings

## Installation

```bash
npm install
npm run build
```

## Setup

Run the setup CLI against your project directory:

```bash
npx code-context-mcp setup /path/to/your/project
```

The path is optional and defaults to the current directory. Setup runs a **6-step** flow:

1. Initialize the SQLite database
2. Index the target directory
3. Seed factory defaults (the 9 agents and frontend skills)
4. Configure the MCP client (`.mcp.json`)
5. Configure the bridge hook in `.claude/settings.json`
6. Install the Claude commands in `.claude/commands/`

Restart your AI client afterward to load the MCP tools.

## Running the MCP Server

The server starts automatically when your AI client reads `.mcp.json`. You can also start it manually:

```bash
npm start
```

## Dashboard

View the indexed data and the scrum board in a browser:

```bash
npm run dashboard
```

Open [http://localhost:3333](http://localhost:3333). The dashboard is a React SPA served from `dist/dashboard/index.html` (`dashboard.html` is a fallback only), with six tabs: **Dashboard**, **Planning**, **Code**, **Team**, **Retro**, and **Benchmark** (the Kanban board is a sub-tab of Dashboard).

Requests to `/api/*` require a bearer token. The token is auto-generated on first run and persisted to `.code-context/dashboard.token` in the directory of the `context.db` in use, so the MCP server and the dashboard share it from any working directory.
