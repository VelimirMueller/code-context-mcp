<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/banner/hero-v3-light.svg">
  <img alt="code-context-mcp. Read less. Know more. Stable, v2.11.0. MCP, code index, sprints, dashboard." src="assets/banner/hero-v3-dark.svg" width="100%">
</picture>

<p align="center">

[![npm version](https://img.shields.io/npm/v/vlm-code-context-mcp.svg?style=flat-square&labelColor=0a0a0b&color=10b981)](https://www.npmjs.com/package/vlm-code-context-mcp) ![VM. flagship](https://img.shields.io/badge/VM.-flagship-6366f1?style=flat-square&labelColor=0a0a0b) [![npm downloads](https://img.shields.io/npm/dt/vlm-code-context-mcp.svg?style=flat-square&labelColor=0a0a0b&color=a1a1aa)](https://www.npmjs.com/package/vlm-code-context-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-a1a1aa.svg?style=flat-square&labelColor=0a0a0b)](LICENSE)

</p>

> Read less. Know more.

```text
 █████   ████   █████   ██████
██      ██  ██  ██  ██  ██
██      ██  ██  ██  ██  █████   █████
██      ██  ██  ██  ██  ██
 █████   ████   █████   ██████
 █████   ████   ██  ██  ██████  ██████  ██  ██  ██████
██      ██  ██  ███ ██    ██    ██       ████     ██
██      ██  ██  ██████    ██    █████     ██      ██    █████
██      ██  ██  ██ ███    ██    ██       ████     ██
 █████   ████   ██  ██    ██    ██████  ██  ██    ██
██   ██   █████  █████
███ ███  ██      ██  ██
███████  ██      █████
██ █ ██  ██      ██
██   ██   █████  ██      ██
```

An MCP server that gives AI coding agents a memory of your codebase and a sprint process.
Your agents forget everything between sessions. This one file does not.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/stats-v3-dark.svg">
  <img alt="93 MCP TOOLS. 43.7% FEWER TOKENS, SIMULATED. 1 SQLITE FILE. 0 API KEYS" src="assets/readme/stats-v3-light.svg" width="100%">
</picture>

<br>

## // 01 WHAT IT DOES

<img alt="01 WHAT IT DOES. AGENTS STOP RE-READING THE REPO." src="assets/readme/divider-what-v3.svg" width="100%">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/features-v3-dark.svg">
  <img alt="CODE INDEX: File roles, exports and dependents in one context.db. Checked against the disk on every answer. SPRINT PROCESS: A 9-agent team. Vision to retro, with gates. 93 MCP tools, 6 slash commands. LIVE DASHBOARD: React on :3333. SSE updates, no polling. Edit tickets, the session sees it." src="assets/readme/features-v3-light.svg" width="100%">
</picture>

- Gives AI coding agents **persistent memory**. The memory survives the session.
- Indexes your codebase into one SQLite file, `context.db`. Agents query file roles, exports and dependents. In real agent runs on import-graph questions (683-file fixture, n=5) it used 28–47 % fewer uncached tokens (GLM 5.3 and DeepSeek v4 pro; DeepSeek cost −29 %) at equal or better success, every repeat above 0. With Claude Code (Opus) on two tasks it used more. The 43.7 % figure is simulated; see [Benchmark](#benchmark).
- Runs a full sprint process for a 9-agent team: vision, discovery, milestones, epics, tickets, gates and retros. It uses 97 MCP tools and 6 slash commands.
- Shows everything on a live React dashboard at `:3333`. Zero API keys.

<br>

## // 02 QUICK START

<img alt="02 QUICK START. TWO COMMANDS. ONE RESTART." src="assets/readme/divider-start-v3.svg" width="100%">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/start-v3-dark.svg">
  <img alt="Terminal: $ npm install vlm-code-context-mcp | $ npx code-context-mcp setup . | # restart Claude Code. setup wrote .mcp.json | $ npx code-context-dashboard ./context.db | # http://localhost:3333" src="assets/readme/start-v3-light.svg" width="100%">
</picture>

```bash
npm install vlm-code-context-mcp
npx code-context-mcp setup .
npx code-context-dashboard ./context.db   # optional — live dashboard on :3333
```

Two commands, then restart Claude Code. Zero API keys. One `context.db` file.

1. **Install.** `npm install vlm-code-context-mcp`
2. **Initialize.** `npx code-context-mcp setup .`
   - Creates `context.db` and indexes your codebase.
   - Seeds a 9-agent team and the frontend skill library into the project database.
   - Writes `.mcp.json`. Offers to wire the sprint statusline into `.claude/settings.json`. Pass `--defaults` to skip the prompts.
   - Run it again later and it switches to **update mode**: migrate (with automatic backup) and config repair. It never touches your data.
   - `--force` renames the old database. It does not delete it.
3. **Restart your AI client.** Claude Code (or any MCP client) loads the server from `.mcp.json`. Verify with `get_project_status`.
   - Manual registration instead: `claude mcp add code-context -- node node_modules/vlm-code-context-mcp/dist/server/index.js ./context.db`
4. **Launch the dashboard.** `npx code-context-dashboard ./context.db`
   - Opens at `http://localhost:3333` with live SSE updates.
   - File watching and auto-reindex on save are on by default (derived from the indexed files).
   - Pass a directory as the 4th argument only to override it, for example on a database with nothing indexed yet:

     ```bash
     npx code-context-dashboard ./context.db 3333 .
     ```
5. **Run your first sprint.** Type `/kickoff` in Claude Code.

   ```
   /kickoff
   ```

   - The orchestrator walks you through vision → discovery → milestone → epics → tickets → sprint → implementation → retro.
   - It asks one question at a time. Smart resume lets you stop and continue later.

<br>

## // 03 HOW IT WORKS

<img alt="03 HOW IT WORKS. ONE SQLITE FILE. NO MAGIC." src="assets/readme/divider-how-v3.svg" width="100%">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/flow-v3-dark.svg">
  <img alt="AGENT -&gt; MCP SERVER -&gt; CONTEXT.DB -&gt; DASHBOARD. Load context from the database first. Read the file second." src="assets/readme/flow-v3-light.svg" width="100%">
</picture>

Every command follows the same pattern: **load context from the database before doing anything.**

```
search_files("auth middleware")       → find the right file
get_file_context("src/auth.ts")      → understand role, exports, dependents
Read("src/auth.ts")                  → only now read the actual code
```

No agent holds the full project in its context window. Agents query a shared SQLite brain and write results back.

```text
┌─────────────────────────────────────────────────────┐
│               Claude Code / MCP Client              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ /kickoff │  │ /sprint  │  │ /ticket  │  ...     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       └──────────────┼─────────────┘                │
│                      ▼                              │
│     97 MCP Tools (103 with all toolsets)            │
│      (reads · writes · ceremony cards)              │
│                      │                              │
│                      ▼                              │
│  ┌─────────────────────────────────────┐            │
│  │       context.db (SQLite)           │            │
│  │  30 tables · WAL mode · <5ms reads  │            │
│  └──────────────────┬──────────────────┘            │
│                     │ WAL watcher                   │
│                     ▼                               │
│  ┌─────────────────────────────────────┐            │
│  │    React Dashboard (Vite)           │            │
│  │  62 components · SSE live updates   │            │
│  └─────────────────────────────────────┘            │
└─────────────────────────────────────────────────────┘
```

The full picture with the repo and the re-index loop: [docs/REFERENCE.md](docs/REFERENCE.md#architecture-the-full-picture).

<br>

## // 04 USAGE

<img alt="04 USAGE. THE LONG PART, FOLDED." src="assets/readme/divider-usage-v3.svg" width="100%">

Long reference (skill sets, agent roles, sprint gates, release highlights): [docs/REFERENCE.md](docs/REFERENCE.md).

### Benchmark

Benchmarks run on demand, never from a timer. Every published run lands on the live site:

**[Benchmark site](https://velimirmueller.github.io/code-context-mcp/)** — the latest run is the headline; the history lists all runs.

Kinds:

- `simulated` — context efficiency from scripted replays. No model runs. This is the source of the 43.7 % figure (simulated, 2026-10-11).
- `agent-glm` / `agent-deepseek` / `agent-opus` — a real model, the same task in three arms: without the server, with it, and with it plus the instruction to use it first. Task sets L1–L6 (sample project and this repo) and I1–I6 (generated 683-file fixture).
- `agent-claude` — pre-registered external harness (Claude Code sessions). Read-only.

Real agent numbers (proof runs, 2026-10-11, rescored and renormalized). "Saved" compares each arm with vanilla (no server); positive means fewer. Range = min … max over repeats.

| Model · tasks | n | Success vanilla / cc / guided | Uncached tokens saved, cc | Uncached tokens saved, guided | Cost saved cc / guided | Uncached tokens per PASS vanilla / cc / guided |
| --- | --- | --- | --- | --- | --- | --- |
| GLM 5.3 · I1–I6 (683 files) | 5 | 26/30 · 26/30 · 28/30 | +33.7 % [+11.1 … +45.2] | +47.1 % [+34.7 … +61.2] | n/a (subscription) | 12,213 · 8,091 · 5,997 |
| DeepSeek v4 pro · I1–I6 (683 files) | 5 | 25/30 · 29/30 · 30/30 | +28.4 % [+24.1 … +34.5] | +34.7 % [+15.1 … +49.1] | +29.1 % / +34.5 % | 22,342 · 13,800 · 12,153 |
| DeepSeek v4 pro · L1, L4, L6 | 3 | 9/9 · 9/9 · 8/9 | +16.4 % [−11.1 … +54.1] | +7.3 % [+0.1 … +16.8] | +16.4 % / +8.4 % | 55,259 · 46,206 · 57,635 |
| Opus (Claude Code) · L1, I1 | 2 | 4/4 · 4/4 · — | −46.0 % [−82.5 … −31.9] | — | −36.5 % / — | 4,508 · 6,579 · — |

- Caveats: small n, fixed fixtures (L1 sample project, L4/L6 this repo, I-tasks the generated fixture), one day. GLM caches tool definitions across sessions with no off switch, so its uncached counts leave out that prefix. Opus is a smoke check: n=2 per task and arm (one cold, one warm), no guided arm. The guided DeepSeek miss is an L6 timeout (300 s).
- Agent runs before 2026-10-11 00:00 UTC told every arm to use the built-in file tools. They do not show the server in use.

<details>
<summary>Run it yourself</summary>

```bash
# Simulated (no model, no cost)
npm run bench

# Agent (real model, real tokens; needs ZAI_API_KEY or DEEPSEEK_API_KEY)
npm run bench:live -- --provider glm

# Publish the run to the bench-results branch (rebuilds the site)
npm run bench:publish
```

In GitHub Actions, run the **Benchmark** workflow by hand (Run workflow). It has no timer trigger.

Method and limits: [BENCHMARK-GUIDE.md](BENCHMARK-GUIDE.md).

</details>

### Dashboard

**7 pages. Live SSE updates. Zero polling.**

<img width="3840" height="2585" alt="Dashboard overview showing sprint board with kanban, phase stepper, and completion checklist" src="https://github.com/user-attachments/assets/52e2fbca-1e65-4ec9-a0fe-f11f000b1510" />

- **Dashboard:** kanban board, phase gate stepper, burndown, velocity, sprint checklist.
- **Planning:** milestone tracker, epic progress, discovery pipeline.
- **Code:** file tree, dependency graph, export/import map, change history.
- **Team:** agent cards, model badges, mood trends, workload bars.
- **Retro:** bento grid insights, cross-sprint patterns, recurring themes.
- **Benchmark:** MCP vs vanilla comparison with animated metrics.
- **Velocity:** sprint-by-sprint trends, committed vs completed.

Every database mutation triggers an instant refresh through SQLite WAL monitoring. Since 2.0 the board is **live-editable**: title, description, points, status and multi-agent assignments (with per-assignment models). Every edit raises a change flag. The Claude session sees it and acknowledges it at its next context load. The UI can never set DONE or `qa_verified`. Completion stays earned.

### Slash commands

Type these in Claude Code.

- `/kickoff`: full guided lifecycle, vision to retro. **Start here.**
- `/sprint`: sprint-only loop. Plan → implement → QA → retro → archive.
- `/ticket`: move tickets through their lifecycle with full context.
- `/milestone`: create, update, close milestones with epic verification.
- `/retro`: data-backed retrospectives with burndown and velocity analysis.
- `/sprint-connect`: bridge the dashboard UI to your Claude session.

`/kickoff` loads the frontend skill playbook into the session when a sprint has `fe-engineer` work. Pull the full guidance of any skill with `get_skill`.

### Skill sets (server-provided)

- Three libraries: **Frontend** (22 skills plus an editable house-style primer), **Landing pages** and **Workflow**.
- The MCP server serves them into your live session. They are not copied into your repo.
- Source: [`claude_development_skills`](https://github.com/VelimirMueller/claude_development_skills), vendored under `vendor/skills/`.
- Storage: the project DB `skills` table (`fe:*`, `la:*`, `wf:*`). Edit them. Re-seeds never overwrite your edits.
- Opt-in: `/kickoff` asks once. `update_skill_sets({ landing: true, ... })` changes it any time.
- Update: `CODE_CONTEXT_SKILLS_AUTOSYNC=1` syncs from the latest upstream release at boot. `npm run sync:skills` re-vendors the offline fallback.
- Details: [docs/REFERENCE.md](docs/REFERENCE.md#skill-sets-server-provided).

### The agent team

- 9 configurable agents: Product Owner, Team Lead, Architect, Backend Developer, Frontend Developer, Developer, QA Engineer, Security Engineer, DevOps.
- Dev roles default to `claude-fable-5`, QA to `claude-opus-5`, the rest to `claude-sonnet-5`.
- Change a model, tools or system prompt with the `update_agent` MCP tool or in the dashboard.
- The model **routes execution**: during `/kickoff` and `/sprint`, a subagent at the assigned model tier (`fable`/`opus`/`sonnet`/`haiku`) implements each ticket.
- Since 2.0, a ticket can have several agents. The lead implements, supporters verify, QA needs every verdict.
- Roles and focus: [docs/REFERENCE.md](docs/REFERENCE.md#the-agent-team).

### Sprint process

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/phases-v3-dark.svg">
  <img alt="PLANNING -&gt; IMPLEMENTATION -&gt; DONE -&gt; REST. 4 phases. Each one has a gate. The gates do not negotiate." src="assets/readme/phases-v3-light.svg" width="100%">
</picture>

```
planning → implementation → done → rest
```

- **Planning** (1 day): tickets assigned, velocity committed.
- **Implementation** (3 days): all tickets DONE or NOT_DONE, blockers resolved.
- **Done** (0.5 day): retro findings recorded, QA verified.
- **Rest** (0.5 day): automatic after retro.
- Change phases, durations and gates with `update_sprint_config`.
- Since 2.0, `start_sprint` and `advance_sprint` refuse while untriaged retro `try_next` findings or escalated discoveries exist. Override with `acknowledge_open_items: true`.
- Since 2.2, `qa_verified` needs commits with `Why:/What:/How:` body groups.

### Tech stack and engine numbers

- Runtime: Node.js 24 LTS. Build: TypeScript strict mode.
- Database: SQLite via better-sqlite3, WAL mode. 33 tables (27 scrum + 6 code).
- MCP protocol: @modelcontextprotocol/sdk. 97 MCP tools by default, 103 with `CODE_CONTEXT_TOOLSETS=all`, 6 with `CODE_CONTEXT_TOOLSETS=code` (`find_symbol`, `get_file_context`, `who_imports`, `exports_in`, `search_files`, `query`). The server sends short MCP `instructions` (about 90 tokens) on when to use the graph tools.
- Output env vars: `OVERDRIVE_FLAIR` (flair header/footer on text results: on by default, off under `code`; `0`/`1` force it), `CODE_CONTEXT_TIMESTAMPS=1` (adds `modified`/`indexed` timestamps; off by default), `CODE_CONTEXT_ABSOLUTE_PATHS=1` (absolute paths). See [REFERENCE](docs/REFERENCE.md).
- Dashboard: React 19 + Vite + Zustand + Framer Motion. CSS variables + Tailwind, dark theme. 75 React components.
- Live updates: SSE via WAL file watcher.
- Testing: Vitest. 992 backend tests and 93 dashboard tests.
- 9 agent roles (configurable). 4 sprint phases with gate checks + planning gate. 6 slash commands.
- 4 CLI bins: `code-context-mcp`, `code-context-dashboard`, `code-context-statusline`, `code-context-reindex`.

### Manual MCP server setup

If the automatic `.mcp.json` setup doesn't work:

```bash
# Add to current project
claude mcp add code-context npx -y vlm-code-context-mcp ./context.db

# Add globally
claude mcp add --scope user code-context node /path/to/node_modules/vlm-code-context-mcp/dist/server/index.js ./context.db

# Remove
claude mcp remove code-context
```

### Development

```bash
# MCP server
npm run dev

# Dashboard (Vite dev server with HMR)
npm run dashboard:dev
```

<br>

## // 05 STATUS

<img alt="05 STATUS. TESTED. NOT BY VIBES." src="assets/readme/divider-status-v3.svg" width="100%">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/status-v3-dark.svg">
  <img alt="Release: 2.11.0 on npm. Python index: since 2.8. Tests: 1052, vitest. Dashboard: 7 pages, live. Fun + stream: hidden unless opted in" src="assets/readme/status-v3-light.svg" width="100%">
</picture>

- **Stable.** 2.11.0 on npm. The npm badge shows the live version.
- Tests: `npm test` (backend) · `npm run test:all` (backend + frontend).
- Changes: [`CHANGELOG.md`](CHANGELOG.md). Release highlights 2.0 to 2.8: [docs/REFERENCE.md](docs/REFERENCE.md#release-highlights).
- License: MIT.

<br>

```text
-- EOF ------------------------------------ CONTEXT LOADED. READ LESS. --
```

---

<sub>VM. studio / flagship · open source · look per <code>vm-brand</code> playbook</sub>
