# Architecture

## Overview

vlm-code-context-mcp is an MCP server that pre-indexes TypeScript/JavaScript codebases into SQLite, plus a React dashboard for visualization and sprint management.

## System Components

### MCP Server (src/server/)

- TypeScript parser indexes files, exports, imports, dependencies
- SQLite database stores all metadata
- MCP tools expose read/write operations to AI agents

### Scrum System (src/scrum/)

- Database tables (the current count is in the README, "Tech stack and engine numbers"): agents, sprints, tickets, subtasks, retro_findings, blockers, bugs, skills, processes, milestones, decisions, epics, sprint_metrics, ticket_dependencies, tags, ticket_tags, agent_mood_history, event_log, discoveries, token_usage, pending_actions, workflow_runs, workflow_step_log, schema_versions, and migration shadow tables
- 99 MCP tools are registered: 88 for the sprint lifecycle in `src/scrum/` (75 in `tools.ts`, 7 in `tools/analytics.ts`, 6 in `tools/skills.ts`) and 11 code-context tools in `src/server/index.ts`.
- 6 of them are optional (toolsets `fun` and `stream` in `src/server/tool-wrap.ts`) and hidden by default. A client sees 93 tools; `CODE_CONTEXT_TOOLSETS=all` shows all 99.
- All data lives in SQLite (context.db) — no file-based storage

### Dashboard (src/dashboard/)

- **App**: Vite 8 + React 19 + TypeScript + Tailwind CSS 4 (src/dashboard/app/)
- **Server**: Node.js HTTP server serving APIs + static files (src/dashboard/dashboard.ts)
- **State**: 9 Zustand stores (fileStore, sprintStore, agentStore, planningStore, uiStore, benchmarkStore, bridgeStore, comparisonStore, toastStore)
- **Animation**: Framer Motion for transitions + micro-interactions

## Component Architecture (Atomic Design)

```
atoms/       → AnimatedNumber, Badge, BridgeStatusBadge, Button, ClaudeOutputStream,
               DiscoveryCoverageBar, Dot, ErrorBoundary, Skeleton, Stat,
               StatusBadge, SyncButton, Toast, ToastContainer
molecules/   → AgentCard, AlertDialog, BentoCard, Breadcrumb, DiscoveryRow,
               EnterpriseTable, FileItem, FolderItem, HeroText, InlineEditForm,
               MarkdownRenderer, MeSection, PhaseGateStepper, QuickActionsBar,
               QuickFilters, SearchBar, SprintCard, StatGroup, SubTabBar,
               TabBar, TeamMemberForm, TicketCard, TopNav, WizardModal
organisms/   → BentoGrid, BurndownChart, BurndownMetrics, CapacityPlanningView,
               DashboardTour, DependencyGraph, DiscoveryList, EnhancedCapacityView,
               EnhancedGanttChart, EnterpriseDataTable, EpicList, FileTree,
               GanttChart, InsightsDashboard, KanbanBoard, LandingAnimation,
               MilestoneList, PlanningDashboard, PlanningInsights, PlanningWizard,
               ProcessFlow, SprintBurndownView, SprintCompletionPanel, SprintDetail,
               SprintList, SprintPlanner, SprintPlanningView, SprintTableView,
               TeamGrid, TeamManagementModal, TicketDetailModal, Topbar,
               VisionEditor, VisionPlayer
pages/       → Benchmark, CodeExplorer, Dashboard, ProjectManagement, Retro, Team
```

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

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/files` | GET | All indexed files with export/import counts |
| `GET /api/file/:id` | GET | Full file context: exports, imports, importedBy |
| `GET /api/file/:id/changes` | GET | Per-file change history with diffs |
| `GET /api/directories` | GET | All directory metadata |
| `GET /api/stats` | GET | Aggregate counts, language breakdown, extensions |
| `GET /api/graph` | GET | Dependency graph nodes and edges |
| `GET /api/changes` | GET | Recent changes across all files (with `?limit=`) |
| `GET /api/events` | SSE | Server-Sent Events stream for live reload |

### Skills & Agents

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/skills` | GET | All skills with name, content, owner_role |
| `GET /api/skill/:name` | GET | Single skill by name |
| `GET /api/agents` | GET | Agent health + computed mood scores |

### Scrum (Sprint 8 additions)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/sprints` | GET | All sprints with ticket/done/qa/retro/blocker counts |
| `GET /api/sprint/:id` | GET | Single sprint detail |
| `GET /api/sprint/:id/tickets` | GET | Tickets for a sprint |
| `GET /api/sprint/:id/retro` | GET | Retro findings for a sprint |
| `GET /api/milestones` | GET | All milestones with ticket counts |
| `POST /api/milestones` | POST | Create a new milestone |
| `PUT /api/milestone/:id` | PUT | Update milestone status/progress/description |
| `GET /api/backlog` | GET | Unassigned and carried-over tickets |
| `POST /api/sprints/plan` | POST | Create sprint and assign tickets in one call |
| `PUT /api/vision` | PUT | Update PRODUCT_VISION skill content |

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
