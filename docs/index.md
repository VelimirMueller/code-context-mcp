---
layout: home
hero:
  name: Code Context MCP
  text: Codebase intelligence and an agent-driven scrum workflow
  tagline: Index your codebase and run a full 9-agent scrum process — sprints, tickets, model routing, and a React dashboard — all via the Model Context Protocol
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: MCP Tools
      link: /tools/
features:
  - title: 94 MCP Tools
    details: 11 code-context tools (index directories, find symbols, search files, set descriptions, query the database, and more) plus 83 scrum tools for sprints, tickets, epics, milestones, retros, mood, and burndown.
  - title: Directory-Aware Indexing
    details: Tracks metadata at both file and directory level, with line counts, sizes, summaries, and dependency graphs.
  - title: Change Tracking
    details: Append-only log of file changes with before/after snapshots, inline diffs, and summary deltas.
  - title: 9-Agent Scrum Workflow
    details: A 9-role agent team (fe-engineer, be-engineer, developer, devops, qa, security, architect, team-lead, product-owner) drives sprints and tickets through slash commands — /kickoff, /sprint, /ticket, /milestone, /retro.
  - title: Model Routing
    details: Each ticket's assigned agent carries a model tier — dev roles and QA on Opus, the rest on Sonnet — and /kickoff and /sprint spawn a subagent at that tier to implement it.
  - title: Server-Provided Frontend Skills
    details: Frontend skills are seeded into the database and served into the live session via load_phase_context and the get_skill tool — no copying into .claude/skills/.
  - title: React Dashboard
    details: A 6-page React SPA at :3333 — Dashboard, Planning, Code, Team, Retro, and Benchmark. The folder tree, file detail, change history, and dependency graph live inside the Code tab; live SSE updates keep it current as you edit.
  - title: Hardened by Default
    details: Path-traversal containment in the indexer, query/execute guarded as single read-only and write-only statements, and a bearer-token gate on every dashboard /api/* route.
    link: /security/threat-model
    linkText: Threat model
---
