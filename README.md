<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/banner/hero-v3-light.svg">
  <img alt="code-context-mcp. Read less. Know more. Stable, v3.0.0. MCP, code index, sprints, dashboard." src="assets/banner/hero-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/lead-v3-light.svg">
  <img alt="An MCP server that gives AI coding agents a memory of your codebase and a sprint process. Your agents forget everything between sessions. This one file does not." src="assets/readme/lead-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/stats-v3-light.svg">
  <img alt="97 MCP TOOLS. 43.7% FEWER TOKENS, SIMULATED. 1 SQLITE FILE. 0 API KEYS" src="assets/readme/stats-v3-dark.svg" width="100%">
</picture>
</p>

<p align="center">
<a href="https://www.npmjs.com/package/vlm-code-context-mcp"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-1-v3-light.svg"><img alt="npm (https://www.npmjs.com/package/vlm-code-context-mcp)" src="assets/readme/links-1-v3-dark.svg" width="32%"></picture></a>
<a href="LICENSE"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-2-v3-light.svg"><img alt="License (LICENSE)" src="assets/readme/links-2-v3-dark.svg" width="32%"></picture></a>
<a href="https://velimirmueller.github.io/code-context-mcp/"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-3-v3-light.svg"><img alt="Benchmark site (https://velimirmueller.github.io/code-context-mcp/)" src="assets/readme/links-3-v3-dark.svg" width="32%"></picture></a>
</p>

<br>

<p>
<img alt="01 WHAT IT DOES. AGENTS STOP RE-READING THE REPO." src="assets/readme/divider-what-v3.svg" width="100%">
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/features-v3-light.svg">
  <img alt="CODE INDEX: File roles, exports and dependents in one context.db. Checked against the disk on every answer. SPRINT PROCESS: A 9-agent team. Vision to retro, with gates. 97 MCP tools, 6 slash commands. LIVE DASHBOARD: React on :3333. SSE updates, no polling. Edit tickets, the session sees it" src="assets/readme/features-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/what-v3-light.svg">
  <img alt="Persistent memory: Gives AI coding agents persistent memory. The memory survives the session. One index, one file: Indexes your codebase into one SQLite file, context.db. Agents query file roles, exports and dependents. Fewer tokens in real agent runs: On import-graph questions (683-file fixture, n=5) it used 28-47 % fewer uncached tokens (GLM 5.3 and DeepSeek v4 pro; DeepSeek cost -29 %) at equal or better success, every repeat above 0. With Claude Code (Opus) on two tasks it used more. The 43.7 % figure is simulated: see the benchmark in 04 USAGE. A sprint process: Runs a full sprint process for a 9-agent team: vision, discovery, milestones, epics, tickets, gates and retros. It uses 97 MCP tools and 6 slash commands. A live dashboard: Shows everything on a live React dashboard at :3333. Zero API keys" src="assets/readme/what-v3-dark.svg" width="100%">
</picture>
</p>

<br>

<p>
<img alt="02 QUICK START. TWO COMMANDS. ONE RESTART." src="assets/readme/divider-start-v3.svg" width="100%">
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/start-v3-light.svg">
  <img alt="Terminal: $ npm install vlm-code-context-mcp | # the code index: 6 tools, the default | $ npx code-context-reindex . --db ./context.db | $ claude mcp add code-context -- npx code-context ./context.db | # or the sprint process instead (adds 91 tools): | $ npx code-context-mcp setup .  # code-context-sprint | $ npx code-context-dashboard ./context.db  # :3333" src="assets/readme/start-v3-dark.svg" width="100%">
</picture>
</p>

<details>
<summary><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-13-v3-light.svg"><img alt="Plain text" src="assets/readme/links-13-v3-dark.svg" width="32%"></picture></summary>

```bash
# Requires Node.js 22 or newer. Node.js 24 LTS is recommended.
npm install vlm-code-context-mcp

# The code index (default): 6 tools
npx code-context-reindex . --db ./context.db
claude mcp add code-context -- npx code-context ./context.db

# Or the sprint process instead: setup installs code-context-sprint, /kickoff, the dashboard
npx code-context-mcp setup .
npx code-context-dashboard ./context.db   # optional: live dashboard on :3333
```

```bash
# override the watch directory (4th argument)
npx code-context-dashboard ./context.db 3333 .
```

```text
/kickoff
```

</details>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/setup-v3-light.svg">
  <img alt="Install: npm install vlm-code-context-mcp. Zero API keys. One context.db file. Two entry points: code-context is the code index (6 tools, the default). code-context-sprint adds the sprint process and the dashboard on the same database. Initialize: npx code-context-mcp setup . creates context.db, indexes your codebase and installs code-context-sprint. It seeds a 9-agent team and the frontend skill library into the project database. --profile code installs code-context instead. Config: Setup writes .mcp.json. It offers to wire the sprint statusline into .claude/settings.json. Pass --defaults to skip the prompts. Run setup again: It switches to update mode: migrate (with automatic backup) and config repair. It never touches your data. --force renames the old database. It does not delete it. Restart your AI client: Claude Code (or any MCP client) loads the server from .mcp.json. Verify with get_project_status. Manual registration instead: see MANUAL SETUP in 04 USAGE. Launch the dashboard: npx code-context-dashboard ./context.db opens at http://localhost:3333 with live SSE updates. Watch and reindex: File watching and auto-reindex on save are on by default (derived from the indexed files). Pass a directory as the 4th argument only to override it, for example on a database with nothing indexed yet: npx code-context-dashboard ./context.db 3333 . Run your first sprint: Type /kickoff in Claude Code. The orchestrator walks you through vision -&gt; discovery -&gt; milestone -&gt; epics -&gt; tickets -&gt; sprint -&gt; implementation -&gt; retro. It asks one question at a time. Smart resume lets you stop and continue later" src="assets/readme/setup-v3-dark.svg" width="100%">
</picture>
</p>

<br>

<p>
<img alt="03 HOW IT WORKS. ONE SQLITE FILE. NO MAGIC." src="assets/readme/divider-how-v3.svg" width="100%">
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/flow-v3-light.svg">
  <img alt="AGENT -&gt; MCP SERVER -&gt; CONTEXT.DB -&gt; DASHBOARD. Load context from the database first. Read the file second." src="assets/readme/flow-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/pattern-v3-light.svg">
  <img alt="Terminal: # every command: load context from the database before doing anything | search_files(&quot;auth middleware&quot;)    # find the right file | get_file_context(&quot;src/auth.ts&quot;)    # understand role, exports, dependents | Read(&quot;src/auth.ts&quot;)                # only now read the actual code" src="assets/readme/pattern-v3-dark.svg" width="100%">
</picture>
</p>

<details>
<summary><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-13-v3-light.svg"><img alt="Plain text" src="assets/readme/links-13-v3-dark.svg" width="32%"></picture></summary>

```text
search_files("auth middleware")       → find the right file
get_file_context("src/auth.ts")      → understand role, exports, dependents
Read("src/auth.ts")                  → only now read the actual code
```

</details>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/arch-v3-light.svg">
  <img alt="MCP CLIENT -&gt; 97 MCP TOOLS -&gt; CONTEXT.DB -&gt; DASHBOARD. No agent holds the full project in its context window. Agents query a shared SQLite brain and write results back." src="assets/readme/arch-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/how-v3-light.svg">
  <img alt="Database first: Every command follows the same pattern: load context from the database before doing anything. The full picture: The repo and the re-index loop are in docs/REFERENCE.md (architecture, the full picture)" src="assets/readme/how-v3-dark.svg" width="100%">
</picture>
</p>

<p align="center">
<a href="docs/REFERENCE.md"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-4-v3-light.svg"><img alt="Reference (docs/REFERENCE.md)" src="assets/readme/links-4-v3-dark.svg" width="32%"></picture></a>
<a href="docs/REFERENCE.md#architecture-the-full-picture"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-5-v3-light.svg"><img alt="Architecture (docs/REFERENCE.md#architecture-the-full-picture)" src="assets/readme/links-5-v3-dark.svg" width="32%"></picture></a>
</p>

<br>

<p>
<img alt="04 USAGE. THE LONG PART, FOLDED." src="assets/readme/divider-usage-v3.svg" width="100%">
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/bench-about-v3-light.svg">
  <img alt="On demand only: Benchmarks run on demand, never from a timer. Every published run lands on the live benchmark site. Benchmark site: The latest run is the headline. The history lists all runs. Long reference: Skill sets, agent roles, sprint gates and release highlights are in docs/REFERENCE.md. Method and limits: In BENCHMARK-GUIDE.md" src="assets/readme/bench-about-v3-dark.svg" width="100%">
</picture>
</p>

<p align="center">
<a href="https://velimirmueller.github.io/code-context-mcp/"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-3-v3-light.svg"><img alt="Benchmark site (https://velimirmueller.github.io/code-context-mcp/)" src="assets/readme/links-3-v3-dark.svg" width="32%"></picture></a>
<a href="BENCHMARK-GUIDE.md"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-6-v3-light.svg"><img alt="Bench guide (BENCHMARK-GUIDE.md)" src="assets/readme/links-6-v3-dark.svg" width="32%"></picture></a>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/bench-kinds-v3-light.svg">
  <img alt="simulated: Context efficiency from scripted replays. No model runs. This is the source of the 43.7 % figure (simulated, 2026-10-11). agent-glm / agent-deepseek / agent-opus: A real model, the same task in three arms: without the server, with it, and with it plus the instruction to use it first. Task sets L1-L6 (sample project and this repo) and I1-I6 (generated 683-file fixture). agent-claude: Pre-registered external harness (Claude Code sessions). Read-only" src="assets/readme/bench-kinds-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/bench-runs-v3-light.svg">
  <img alt="GLM 5.3 · I1-I6 (683 files) · n=5: Success vanilla / cc / guided: 26/30 · 26/30 · 28/30. Uncached tokens saved: cc +33.7 % [+11.1 .. +45.2], guided +47.1 % [+34.7 .. +61.2]. Cost saved: n/a (subscription). Uncached tokens per PASS: 12,213 · 8,091 · 5,997. DeepSeek v4 pro · I1-I6 (683 files) · n=5: Success vanilla / cc / guided: 25/30 · 29/30 · 30/30. Uncached tokens saved: cc +28.4 % [+24.1 .. +34.5], guided +34.7 % [+15.1 .. +49.1]. Cost saved cc / guided: +29.1 % / +34.5 %. Uncached tokens per PASS: 22,342 · 13,800 · 12,153. DeepSeek v4 pro · L1, L4, L6 · n=3: Success vanilla / cc / guided: 9/9 · 9/9 · 8/9. Uncached tokens saved: cc +16.4 % [-11.1 .. +54.1], guided +7.3 % [+0.1 .. +16.8]. Cost saved cc / guided: +16.4 % / +8.4 %. Uncached tokens per PASS: 55,259 · 46,206 · 57,635. GLM 5.3 · L1, L2, I1-I6 · n=3 · glm-20261011-184607: Success vanilla / cc / guided: 23/24 · 21/24 · 21/24. Uncached tokens saved: cc +27.8 % [+19.4 .. +40.4], guided +38.4 % [+33.4 .. +43.5]. Cost saved: n/a (subscription). Uncached tokens per PASS: 8,919 · 7,054 · 6,020. Verdict SUBOPTIMAL: success drops from 95.8 % to 87.5 %. Opus (Claude Code) · L1, I1 · n=2 · opus-20261011-134112: Success vanilla / cc / guided: 4/4 · 4/4 · none. Uncached tokens saved: cc -46.0 % [-82.5 .. -31.9], guided none. Cost saved cc / guided: -36.5 % / none. Uncached tokens per PASS: 4,508 · 6,579 · none. Opus (Claude Code) · L1, L2, I1-I6 · n=1 · opus-20261011-145449: Success vanilla / cc / guided: 6/8 · 6/8 · 7/8. Uncached tokens saved: cc +11.2 %, guided +15.4 % (n=1, no range). Cost saved cc / guided: +7.9 % / +13.5 %. Uncached tokens per PASS: 10,070 · 8,946 · 7,306" src="assets/readme/bench-runs-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/bench-read-v3-light.svg">
  <img alt="Proof runs: Real agent numbers from proof runs on 2026-10-11, rescored and renormalized. &quot;Saved&quot; compares each arm with vanilla (no server); positive means fewer. Range = min .. max over repeats. Caveats: Small n, fixed fixtures (L1/L2 sample project, L4/L6 this repo, I-tasks the generated fixture), one day. The guided DeepSeek miss is an L6 timeout (300 s). GLM caching: GLM caches tool definitions across sessions with no off switch, so its uncached counts leave out that prefix. Opus is a smoke check: opus-20261011-134112: n=2 per task and arm (one cold, one warm), no guided arm. opus-20261011-145449: 8 tasks, n=1, no range. The two runs disagree on the sign. Read both as indicative. Verdict: The bench verdict compares each arm with vanilla. A success drop of more than 5 points is SUBOPTIMAL, also when the tokens go down. glm-20261011-184607 is SUBOPTIMAL for this reason. Older runs: Agent runs before 2026-10-11 00:00 UTC told every arm to use the built-in file tools. They do not show the server in use" src="assets/readme/bench-read-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/bench-run-v3-light.svg">
  <img alt="npm run bench: Simulated. No model, no cost. npm run bench:live -- --provider glm: Agent: real model, real tokens. Needs ZAI_API_KEY or DEEPSEEK_API_KEY. npm run bench:publish: Publish the run to the bench-results branch. This rebuilds the site. Benchmark workflow: In GitHub Actions, run the Benchmark workflow by hand (Run workflow). It has no timer trigger" src="assets/readme/bench-run-v3-dark.svg" width="100%">
</picture>
</p>

<details>
<summary><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-13-v3-light.svg"><img alt="Plain text" src="assets/readme/links-13-v3-dark.svg" width="32%"></picture></summary>

```bash
# Simulated (no model, no cost)
pnpm run bench

# Agent (real model, real tokens; needs ZAI_API_KEY or DEEPSEEK_API_KEY)
pnpm run bench:live --provider glm

# Publish the run to the bench-results branch (rebuilds the site)
pnpm run bench:publish
```

</details>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/pages-v3-light.svg">
  <img alt="Dashboard: Kanban board, phase gate stepper, burndown, velocity, sprint checklist. Planning: Milestone tracker, epic progress, discovery pipeline. Code: File tree, dependency graph, export/import map, change history. Team: Agent cards, model badges, mood trends, workload bars. Retro: Bento grid insights, cross-sprint patterns, recurring themes. Benchmark: MCP vs vanilla comparison with animated metrics" src="assets/readme/pages-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/board-v3-light.svg">
  <img alt="Instant refresh: Every database mutation triggers an instant refresh through SQLite WAL monitoring. Live-editable since 2.0: Title, description, points, status and multi-agent assignments (with per-assignment models). Change flags: Every edit raises a change flag. The Claude session sees it and acknowledges it at its next context load. Completion stays earned: The UI can never set DONE or qa_verified" src="assets/readme/board-v3-dark.svg" width="100%">
</picture>
</p>

<p align="center">
<a href="https://github.com/user-attachments/assets/52e2fbca-1e65-4ec9-a0fe-f11f000b1510"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-7-v3-light.svg"><img alt="Screenshot (https://github.com/user-attachments/assets/52e2fbca-1e65-4ec9-a0fe-f11f000b1510)" src="assets/readme/links-7-v3-dark.svg" width="32%"></picture></a>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/slash-v3-light.svg">
  <img alt="/kickoff: Full guided lifecycle, vision to retro. Start here. /sprint: Sprint-only loop. Plan -&gt; implement -&gt; QA -&gt; retro -&gt; archive. /ticket: Move tickets through their lifecycle with full context. /milestone: Create, update, close milestones with epic verification. /retro: Data-backed retrospectives with burndown and velocity analysis. /sprint-connect: Bridge the dashboard UI to your Claude session" src="assets/readme/slash-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/skills-v3-light.svg">
  <img alt="Three libraries: Frontend (22 skills plus an editable house-style primer), Landing pages and Workflow. Served, not copied: The MCP server serves them into your live session. They are not copied into your repo. Source: claude_development_skills (https://github.com/VelimirMueller/claude_development_skills), vendored under vendor/skills/. Storage: The project DB skills table (fe:*, la:*, wf:*). Edit them. Re-seeds never overwrite your edits. Opt-in: /kickoff asks once. update_skill_sets({ landing: true, ... }) changes it any time. Update: CODE_CONTEXT_SKILLS_AUTOSYNC=1 syncs from the latest upstream release at boot. npm run sync:skills re-vendors the offline fallback. Frontend playbook: /kickoff loads the frontend skill playbook into the session when a sprint has fe-engineer work. Full guidance: Pull the full guidance of any skill with get_skill. Details: docs/REFERENCE.md (skill sets)" src="assets/readme/skills-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/team-v3-light.svg">
  <img alt="9 configurable agents: Product Owner, Team Lead, Architect, Backend Developer, Frontend Developer, Developer, QA Engineer, Security Engineer, DevOps. Default models: Dev roles default to claude-fable-5-1, QA to claude-opus-5-5, the rest to claude-sonnet-5-5. Change an agent: Change a model, tools or system prompt with the update_agent MCP tool or in the dashboard. The model routes execution: During /kickoff and /sprint, a subagent at the assigned model tier (fable/opus/sonnet/haiku) implements each ticket. Several agents per ticket: Since 2.0. The lead implements, supporters verify, QA needs every verdict. Roles and focus: In docs/REFERENCE.md (the agent team)" src="assets/readme/team-v3-dark.svg" width="100%">
</picture>
</p>

<p align="center">
<a href="https://github.com/VelimirMueller/claude_development_skills"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-8-v3-light.svg"><img alt="Skills source (https://github.com/VelimirMueller/claude_development_skills)" src="assets/readme/links-8-v3-dark.svg" width="32%"></picture></a>
<a href="docs/REFERENCE.md#skill-sets-server-provided"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-9-v3-light.svg"><img alt="Skill sets (docs/REFERENCE.md#skill-sets-server-provided)" src="assets/readme/links-9-v3-dark.svg" width="32%"></picture></a>
<a href="docs/REFERENCE.md#the-agent-team"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-10-v3-light.svg"><img alt="Agent team (docs/REFERENCE.md#the-agent-team)" src="assets/readme/links-10-v3-dark.svg" width="32%"></picture></a>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/phases-v3-light.svg">
  <img alt="PLANNING -&gt; IMPLEMENTATION -&gt; DONE -&gt; REST. 4 phases. Each one has a gate. The gates do not negotiate." src="assets/readme/phases-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/sprint-v3-light.svg">
  <img alt="Planning (1 day): Tickets assigned, velocity committed. Implementation (3 days): All tickets DONE or NOT_DONE, blockers resolved. Done (0.5 day): Retro findings recorded, QA verified. Rest (0.5 day): Automatic after retro. Order: Planning -&gt; implementation -&gt; done -&gt; rest. Each phase has a gate check. Configurable: Change phases, durations and gates with update_sprint_config. QA gate (since 2.2): qa_verified needs commits with Why:/What:/How: body groups. Open-items gate (since 2.0): start_sprint and advance_sprint refuse while untriaged retro try_next findings or escalated discoveries exist. Override with acknowledge_open_items: true" src="assets/readme/sprint-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/stack-v3-light.svg">
  <img alt="Runtime: Node.js 22 or newer, 24 LTS recommended. Build: TypeScript strict mode. Languages: Exports and import edges for TypeScript/JavaScript, Python and PHP (classes, interfaces, traits, enums, functions, constants; use statements resolved through composer.json PSR-4 maps). Other files are indexed with a summary only. Database: SQLite via better-sqlite3, WAL mode. 33 tables (27 scrum + 6 code). MCP protocol: @modelcontextprotocol/sdk. The server sends short MCP instructions (about 90 tokens) on when to use the graph tools. Dashboard: React 19 + Vite + Zustand + Framer Motion. CSS variables + Tailwind, dark theme. 75 React components. Live updates: SSE via WAL file watcher. Testing: Vitest. 2423 backend tests and 142 dashboard tests. Process: 9 agent roles (configurable). 4 sprint phases with gate checks + planning gate. 6 slash commands. CLI bins: 7: code-context (index), code-context-sprint (sprint process), code-context-mcp (setup), code-context-dashboard, code-context-statusline, code-context-reindex, code-context-sync-github. Alias: vlm-code-context-mcp = code-context" src="assets/readme/stack-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/env-v3-light.svg">
  <img alt="default (code): 6 tools: find_symbol, get_file_context, who_imports, exports_in, search_files, query. CODE_CONTEXT_PROFILE=full: 97 MCP tools: the sprint process. The 2.x default. setup writes it. CODE_CONTEXT_PROFILE=all: 103 MCP tools. CODE_CONTEXT_TOOLSETS: Adds toolsets: code-admin, scrum, fun, stream. OVERDRIVE_FLAIR: Flair header/footer on text results. On with the sprint tools, off under code. 0/1 force it. CODE_CONTEXT_TIMESTAMPS=1: Adds modified/indexed timestamps. Off by default. CODE_CONTEXT_ABSOLUTE_PATHS=1: Absolute paths" src="assets/readme/env-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/manual-v3-light.svg">
  <img alt="Terminal: # the code index (default), after npm install | $ claude mcp add code-context -- npx code-context ./context.db | # or the sprint process instead (same server name) | $ claude mcp add code-context -- npx code-context-sprint ./context.db | # without a local install (the index) | $ claude mcp add code-context -- npx -y vlm-code-context-mcp ./context.db | # remove | $ claude mcp remove code-context" src="assets/readme/manual-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/dev-v3-light.svg">
  <img alt="npm run dev: MCP server. npm run dashboard:dev: Dashboard (Vite dev server with HMR). npm test: Backend tests. npm run test:all: Backend + frontend tests" src="assets/readme/dev-v3-dark.svg" width="100%">
</picture>
</p>

<details>
<summary><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-13-v3-light.svg"><img alt="Plain text" src="assets/readme/links-13-v3-dark.svg" width="32%"></picture></summary>

```bash
# The code index (default), after npm install
claude mcp add code-context -- npx code-context ./context.db

# Or the sprint process instead (same server name, same context.db; includes the code tools)
claude mcp add code-context -- npx code-context-sprint ./context.db

# Without a local install (the index)
claude mcp add code-context -- npx -y vlm-code-context-mcp ./context.db

# Add globally (the index; dist/server/sprint.js for the sprint process)
claude mcp add --scope user code-context node /path/to/node_modules/vlm-code-context-mcp/dist/server/index.js ./context.db

# Remove
claude mcp remove code-context
```

```bash
# Profiles (default: code, 6 tools)
CODE_CONTEXT_PROFILE=full     # 97 tools: the sprint process (setup writes it)
CODE_CONTEXT_PROFILE=all      # 103 tools
CODE_CONTEXT_TOOLSETS=scrum   # add toolsets: code-admin, scrum, fun, stream

# Output
OVERDRIVE_FLAIR=0              # flair off (1 forces it on)
CODE_CONTEXT_TIMESTAMPS=1      # add modified/indexed timestamps
CODE_CONTEXT_ABSOLUTE_PATHS=1  # absolute paths

# Skills
CODE_CONTEXT_SKILLS_AUTOSYNC=1 # sync skills from upstream at boot
```

```bash
# Contributors use pnpm (pnpm-lock.yaml); install once
pnpm install

# MCP server
pnpm run dev

# Dashboard (Vite dev server with HMR)
pnpm run dashboard:dev

# Tests
pnpm test          # backend
pnpm run test:all  # backend + frontend

# Maintainers: publish to the npm registry (runs prepublishOnly = pnpm run build)
pnpm publish
```

</details>

<br>

<p>
<img alt="05 STATUS. TESTED. NOT BY VIBES." src="assets/readme/divider-status-v3.svg" width="100%">
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/status-v3-light.svg">
  <img alt="Release: 3.0.0 on npm. Python index: since 2.8. Tests: 2423, vitest. Dashboard: 6 pages, live. Fun + stream: hidden unless opted in" src="assets/readme/status-v3-dark.svg" width="100%">
</picture>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/release-v3-light.svg">
  <img alt="Stable: 3.0.0 on npm. The npm chip links the live version and downloads. License: MIT. Changes: In CHANGELOG.md. Release highlights 2.0 to 2.8: In docs/REFERENCE.md (release highlights)" src="assets/readme/release-v3-dark.svg" width="100%">
</picture>
</p>

<p align="center">
<a href="CHANGELOG.md"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-11-v3-light.svg"><img alt="Changelog (CHANGELOG.md)" src="assets/readme/links-11-v3-dark.svg" width="32%"></picture></a>
<a href="docs/REFERENCE.md#release-highlights"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-12-v3-light.svg"><img alt="Release highlights (docs/REFERENCE.md#release-highlights)" src="assets/readme/links-12-v3-dark.svg" width="32%"></picture></a>
<a href="https://www.npmjs.com/package/vlm-code-context-mcp"><picture><source media="(prefers-color-scheme: light)" srcset="assets/readme/links-1-v3-light.svg"><img alt="npm (https://www.npmjs.com/package/vlm-code-context-mcp)" src="assets/readme/links-1-v3-dark.svg" width="32%"></picture></a>
</p>

<p>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/footer-v3-light.svg">
  <img alt="VM. studio / flagship · open source · MIT · look per vm-brand playbook · -- EOF -- context loaded. read less. --" src="assets/readme/footer-v3-dark.svg" width="100%">
</picture>
</p>
