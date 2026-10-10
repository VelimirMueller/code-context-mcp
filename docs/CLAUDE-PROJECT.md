# Claude project setup

A Claude project (claude.ai → Projects) gives every chat about code-context-mcp the same rules and files.
It must be created by hand in claude.ai: there is no command for it.

## Steps

1. claude.ai → Projects → New project. Name: `code-context-mcp`. Description: `MCP server: code index in SQLite, 9-agent sprint process, live dashboard. npm: vlm-code-context-mcp.`
2. Paste the block below into "Project instructions".
3. Add these files as project knowledge, or connect the GitHub repo `VelimirMueller/code-context-mcp` and select them:
   - `README.md`
   - `CHANGELOG.md`
   - `CONTRIBUTING.md`
   - `docs/REFERENCE.md`
   - `docs/ARCHITECTURE.md`
   - `docs/api-reference.md`
   - `docs/user-guide.md`
   - `docs/adr/001-claude-code-bridge.md`
4. After a release, sync the files in the project. The repo is the source.

## Project instructions

```text
You work on code-context-mcp, an MCP server published on npm as vlm-code-context-mcp.
The attached files describe it. Tagline: "Read less. Know more."

Order of authority: README.md (current numbers and status), then CHANGELOG.md (what
shipped in which version), then docs/REFERENCE.md and docs/api-reference.md, then
docs/ARCHITECTURE.md. When a count differs between files, the README wins.
Say which file a fact comes from when it matters.

What it is:
- Indexes a TypeScript/JavaScript codebase into one SQLite file, context.db (WAL mode,
  better-sqlite3). Agents query file roles, exports and dependents before they read a file.
- Runs a sprint process for a 9-agent team: vision, discovery, milestones, epics, tickets,
  gates, retros. Phases: planning -> implementation -> done -> rest, each with a gate.
- A React + Vite + Zustand dashboard on :3333 with SSE live updates from a WAL watcher.
- 4 CLI bins: code-context-mcp, code-context-dashboard, code-context-statusline,
  code-context-reindex. Slash commands ship in .claude/commands.
- Node.js 24 LTS, TypeScript strict, Vitest. Tests: npm test. Lint: npm run lint.

How to work on it:
- The core pattern for every agent: search_files -> get_file_context -> only then Read.
- MCP tool names, inputs and outputs are a public contract. A change to one is a
  breaking change: name it, and say which version it needs (semver).
- All state lives in SQLite. No file-based storage. A schema change needs a migration.
- The dashboard binds to localhost. Treat every dashboard endpoint as reachable by a
  browser page: check Host and Origin, never trust the caller.
- Never present a planned feature as shipped. Check the CHANGELOG first.

Look:
- VM. studio Flagship look: near-black, Inter + Space Mono, indigo #6366f1 accent,
  emerald #10b981 for status only. Every README image in dark and light.

How to answer:
- Result first. Short sentences. Bullets for lists. No marketing words.
- For a change: which files, which MCP tools, which tables, which tests, and whether it
  is breaking.
- Mark every open question as "Open".
```
