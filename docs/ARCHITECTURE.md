# Architecture

## Overview

vlm-code-context-mcp is an MCP server that pre-indexes codebases into SQLite, plus a React dashboard for visualization and sprint management.

Indexed languages (exports and import edges): TypeScript/JavaScript, Python (since 2.8) and PHP (since 2.13). Other files get a summary only.

Tool and table counts live in the [README](../README.md) (stack and environment panels) and nowhere else, so this file cannot drift from them.

Security: see the [threat model](security/threat-model.md) for the dashboard, the bridge and the index.

## System Components

### MCP Server (src/server/)

- Regex-based parsers for TS/JS, Python and PHP index files, exports, imports, dependencies (no language runtime needed)
- SQLite database stores all metadata
- MCP tools expose read/write operations to AI agents

### Two entry points (since 3.0.0, #179)

One package, one server, two bins over the same `context.db`:

- **`code-context`** (`src/server/index.ts`, alias bin `vlm-code-context-mcp`): the code index. Default profile `code`, 6 tools; the tool contract is frozen. It creates and owns the code-index tables only (`src/server/schema.ts`).
- **`code-context-sprint`** (`src/server/sprint.ts`): sets `CODE_CONTEXT_PROFILE=full` when no known profile is set, then loads `index.ts`. 97 tools. It is what `setup` installs.
- **The seam:** `index.ts` loads `src/server/sprint-toolsets.ts` with a dynamic import only when a sprint toolset (`scrum`, `fun`, `stream`) is on. That file creates, migrates and seeds the scrum tables and registers the scrum tools (`src/scrum`, which reaches the dashboard bridge). No other index file imports `src/scrum`, `src/dashboard` or `src/bridge`; `test/boundary.test.ts` walks the imports and fails otherwise. Allowed besides the two sprint files: `setup.ts` and `sync-github-cli.ts`, the sprint process CLIs.
- **Shared helpers moved to the index side:** `schema-version.ts` (`LATEST_SCHEMA_VERSION`, `peekSchemaVersion`: the downgrade guard of both entries) and `dist-freshness.ts` (`checkDistFreshness`, reported by `health`). `src/scrum` re-exports both.

### Scrum System (src/scrum/)

- Scrum tables: agents, sprints, tickets, subtasks, retro_findings, blockers, bugs, skills, milestones, epics, discoveries, projects and more (table count: see the README)
- The `scrum`, `fun` and `stream` toolsets (src/scrum/tools.ts and src/scrum/tools/), registered through src/server/sprint-toolsets.ts; the code-context tools live in src/server/index.ts (`code` + `code-admin`). `CODE_CONTEXT_PROFILE` picks the profile (default `code`, `full`, `all`; tool counts: see the README)
- All data lives in SQLite (context.db) — no file-based storage

### Dashboard (src/dashboard/)

- **App**: Vite + React 19 + TypeScript + Tailwind CSS (src/dashboard/app/)
- **Server**: Node.js HTTP server serving APIs + static files (src/dashboard/dashboard.ts)
- **State**: 9 Zustand stores (fileStore, sprintStore, agentStore, planningStore, uiStore, benchmarkStore, bridgeStore, comparisonStore, toastStore)
- **Animation**: Framer Motion for transitions + micro-interactions

## Component Architecture (Atomic Design)

```
atoms/       → AnimatedNumber, Badge, BridgeStatusBadge, Button, ClaudeOutputStream,
               Dot, ErrorBoundary, Skeleton, Stat, StatusBadge, Toast, ToastContainer
molecules/   → AgentCard, AlertDialog, AssignmentChips, AssignmentEditor, BentoCard,
               Breadcrumb, FileItem, FolderItem, HeroText, PhaseGateStepper,
               QuickActionsBar, SearchBar, SprintCard, StatGroup, SubTabBar, TabBar,
               TicketCard, TopNav, WizardModal
organisms/   → BentoGrid, BurndownChart, DashboardTour, DependencyGraph, EpicList,
               FileTree, KanbanBoard, LandingAnimation, SprintCompletionPanel,
               SprintDetail, SprintList, TeamGrid, TeamManagementModal,
               TicketDetailModal
pages/       → Benchmark, CodeExplorer, Dashboard, ProjectManagement, Retro, Team
```

## Pages

The hash router (`src/dashboard/app/src/hooks/useHashRouter.ts`) maps `#<page>/<tab>` to six pages, in nav order:

| Nav label | Hash         | Page component    |
| --------- | ------------ | ----------------- |
| Dashboard | `#dashboard` | Dashboard         |
| Planning  | `#planning`  | ProjectManagement |
| Code      | `#code`      | CodeExplorer      |
| Team      | `#team`      | Team              |
| Retro     | `#retro`     | Retro             |
| Benchmark | `#benchmark` | Benchmark         |

Legacy hashes `#explorer` and `#sprint` redirect to `#code` and `#dashboard`.

## State Management

9 Zustand stores:

- **fileStore** — files, directories, selected file detail, graph, stats
- **sprintStore** — sprints, tickets, retro findings
- **agentStore** — agent health and mood
- **planningStore** — milestones, vision, gantt, backlog (read + write)
- **uiStore** — page navigation, tabs, sidebar, search, folder expand state
- **benchmarkStore** — benchmark runs and comparison results
- **bridgeStore** — bridge/hook connection status
- **comparisonStore** — MCP vs traditional comparison data
- **toastStore** — toast notification queue

## API Endpoints

### Code Context (read-only)

| Endpoint                    | Method | Description                                      |
| --------------------------- | ------ | ------------------------------------------------ |
| `GET /api/files`            | GET    | All indexed files with export/import counts      |
| `GET /api/file/:id`         | GET    | Full file context: exports, imports, importedBy  |
| `GET /api/file/:id/changes` | GET    | Per-file change history with diffs               |
| `GET /api/directories`      | GET    | All directory metadata                           |
| `GET /api/stats`            | GET    | Aggregate counts, language breakdown, extensions |
| `GET /api/graph`            | GET    | Dependency graph nodes and edges                 |
| `GET /api/changes`          | GET    | Recent changes across all files (with `?limit=`) |
| `GET /api/events`           | SSE    | Server-Sent Events stream for live reload        |

### Skills & Agents

| Endpoint               | Method | Description                               |
| ---------------------- | ------ | ----------------------------------------- |
| `GET /api/skills`      | GET    | All skills with name, content, owner_role |
| `GET /api/skill/:name` | GET    | Single skill by name                      |
| `GET /api/agents`      | GET    | Agent health + computed mood scores       |

### Scrum (Sprint 8 additions)

| Endpoint                      | Method | Description                                          |
| ----------------------------- | ------ | ---------------------------------------------------- |
| `GET /api/sprints`            | GET    | All sprints with ticket/done/qa/retro/blocker counts |
| `GET /api/sprint/:id`         | GET    | Single sprint detail                                 |
| `GET /api/sprint/:id/tickets` | GET    | Tickets for a sprint                                 |
| `GET /api/sprint/:id/retro`   | GET    | Retro findings for a sprint                          |
| `GET /api/milestones`         | GET    | All milestones with ticket counts                    |
| `POST /api/milestones`        | POST   | Create a new milestone                               |
| `PUT /api/milestone/:id`      | PUT    | Update milestone status/progress/description         |
| `GET /api/backlog`            | GET    | Unassigned and carried-over tickets                  |
| `POST /api/sprints/plan`      | POST   | Create sprint and assign tickets in one call         |
| `PUT /api/vision`             | PUT    | Update PRODUCT_VISION skill content                  |

### Benchmark

| Endpoint                                              | Method | Description                                                                                                                           |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/bench/index`                                | GET    | Real bench runs index (`ccc-bench-index/1`) + source; `index: null` and a how-to `message` when no data                               |
| `GET /api/bench/run/:id`                              | GET    | One run file (`ccc-bench/1`); id must match `^[a-z0-9][a-z0-9-]{0,80}$` and be listed in the index                                    |
| `GET /api/bench/run/:id?suite=pN`                     | GET    | One run of private suite dir N of `CODE_CONTEXT_BENCH_PRIVATE_DIRS` (key `^p[0-9]{1,3}$`); same id, index and realpath rules, per dir |
| `GET /api/benchmark`, `GET /api/benchmark-stochastic` | GET    | Simulated June 2026 benchmark (the "Simulated (2026-06)" tab)                                                                         |

Bench source order (`src/dashboard/handlers/bench.ts`): env `CODE_CONTEXT_BENCH_DIR` → `<dirname(dbPath)>/bench/` → `git show origin/bench-results:data/…` in the dashboard package's own checkout (local ref only, no fetch, 5 min cache) → empty state.

Private suites (CCA-19): `CODE_CONTEXT_BENCH_PRIVATE_DIRS` is a path list (`:`, `;` on Windows) of private suite dirs or their `data/` dirs. `/api/bench/index` merges their runs (newest first) with `private: true`, `suite: <alias>` and `source_key: pN`, and lists `private: [{ key, alias, runs }]`. Read from disk only; never sent anywhere.

## Build Pipeline

```
npm run build
  → node scripts/compile-skills.mjs (compiles vendored skills into generated defaults module)
  → tsc (compiles MCP server to dist/)
  → cp src/dashboard/dashboard.html dist/dashboard/ (copies fallback HTML)
  → vite build (compiles React app to dist/dashboard/)

npm run dashboard:dev
  → vite dev server on :5173, proxies /api/* to :3333

npm run dashboard
  → tsx src/dashboard/dashboard.ts (full server on :3333)
```

### Frontend skills

Frontend skills are vendored from `claude_development_skills` into `vendor/skills/` (build input), compiled by `scripts/compile-skills.mjs` into a generated defaults module, and seeded into the project DB `skills` table (`owner_role='fe-engineer'`) by `seedDefaults`. They are served — not copied: during `/kickoff`, `load_phase_context` detects `fe-engineer` tickets and injects a Frontend Playbook (editable house-style primer + skill index), and the agent fetches full skill bodies on demand via `get_skill`.
