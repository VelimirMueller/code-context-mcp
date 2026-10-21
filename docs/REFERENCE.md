# code-context-mcp reference

The long version. The [README](https://github.com/VelimirMueller/code-context-mcp/blob/main/README.md) has the short one.

## Architecture, the full picture

```text
  agent  ·  Claude Code or any MCP client
     │  search_files · get_file_context · find_symbol · /kickoff · /sprint
     ▼
  ┌────────────────────┐   stat + git diff   ┌────────────────────┐
  │  code-context      │ ──────────────────▸ │  your repo         │
  │  6 tools · +sprint │ ◂────────────────── │  git ls-files only │
  │  compact cards     │   re-index changed  └────────────────────┘
  └─────────┬──────────┘
            │  reads · writes
            ▼
  ┌────────────────────┐   WAL watcher   ┌────────────────────┐
  │  context.db        │ ──────────────▸ │  dashboard :3333   │
  │  SQLite, WAL mode  │ ◂────────────── │  live-editable     │
  └────────────────────┘   ticket edits  └────────────────────┘
```

## Entry points

One npm package, two MCP entry points over the same server code and the same `context.db` (#179). The frozen public surface of both, and how to change it, is in [CONTRACT.md](CONTRACT.md) (#180):

| Bin                   | File                    | Default profile | Tools | Use it for                                     |
| --------------------- | ----------------------- | --------------- | ----- | ---------------------------------------------- |
| `code-context`        | `dist/server/index.js`  | `code`          | 6     | Reading code. The frozen tool contract.        |
| `code-context-sprint` | `dist/server/sprint.js` | `full`          | 97    | The sprint process, `/kickoff`, the dashboard. |

- **`vlm-code-context-mcp`** is an alias of `code-context`, so `npx -y vlm-code-context-mcp ./context.db` starts the index. **`code-context-mcp`** stays the setup command.
- **A known `CODE_CONTEXT_PROFILE` wins on both entries.** `code-context-sprint` only changes the default: unset, empty or unknown becomes `full`.
- **`setup` installs the sprint entry** with `CODE_CONTEXT_PROFILE=full` in `env`, because it seeds the sprint process. `--profile code` installs `code-context` instead. The env stays explicit: `health` shows it, and the same `.mcp.json` entry still works when pointed at `index.js`.
- **Module boundary.** The index code in `src/server` (entry, index/search/graph tools, indexer, policy, gitignore) never imports `src/scrum`, `src/dashboard` or `src/bridge`. A sprint toolset (`scrum`, `fun`, `stream`) loads them through `src/server/sprint-toolsets.ts`. `test/boundary.test.ts` enforces it.
- **Shared `context.db`, split ownership.** The index entry owns the code-index tables (`files`, `exports`, `dependencies`, `directories`, `changes`, `indexed_repos`) and creates only those. The sprint entry owns the scrum tables and the `schema_versions` stamp: it creates, migrates and seeds them. A database the index created gets its scrum tables, stamped at the latest version, on the first start of the sprint entry. Both entries refuse a database stamped by a newer version.

## Tool profiles

Every listed tool costs model context on every call. Since 3.0.0 the server lists only the code tools unless you turn the sprint process on.

| Profile (`CODE_CONTEXT_PROFILE`) | Toolsets                      | Tools | Tool definitions per call     |
| -------------------------------- | ----------------------------- | ----- | ----------------------------- |
| `code` (default, nothing set)    | `code`                        | 6     | about 3,300 chars, 850 tokens |
| `full` (the 2.x default)         | `code`, `code-admin`, `scrum` | 97    | about 12,300 tokens           |
| `all`                            | every toolset                 | 103   | a little more than `full`     |

| Toolset      | Tools                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `code`       | `find_symbol`, `get_file_context`, `who_imports`, `exports_in`, `search_files`, `query`. Always on.                        |
| `code-admin` | `index_directory`, `get_changes`, `set_description`, `set_directory_description`, `set_change_reason`, `execute`, `health` |
| `scrum`      | Every other tool: sprints, tickets, retros, milestones, epics, agents, skills, the dashboard bridge, dump and restore      |
| `fun`        | `record_mood`, `get_mood_trends`, `generate_vision_animation`                                                              |
| `stream`     | `send_step_progress`, `send_claude_output`, `send_claude_step`                                                             |

- **Turn the sprint process on:** use the `code-context-sprint` entry, or `CODE_CONTEXT_PROFILE=full` in the server `env`. `npx code-context-mcp setup .` writes both into `.mcp.json` (`--profile code|full|all` picks another one; an existing setting is kept).
- **Add single toolsets:** `CODE_CONTEXT_TOOLSETS` is a comma list added to the profile, for example `code-admin`, `scrum`, `fun,stream` or `all`. It only adds; it never removes a toolset of the profile. `code` and `default` (2.x spellings) change nothing.
- **Check what is on:** `health` (toolset `code-admin`) reports `profile` and `toolsets`. `/kickoff` reads it first and stops with the exact setting when the sprint tools are off. Unknown values are ignored, listed under `ignored_settings` and logged as a WARN line.
- **Flair** (the `● code-context ▸ <tool>` header and the kaomoji footer) is on when the `scrum` toolset is on and off otherwise; `OVERDRIVE_FLAIR=0`/`1` forces it.
- **The data stays.** A hidden tool is only not listed: the tables, the dashboard and the HTTP API keep working in every profile.

## Skill sets (server-provided)

The server ships three predefined skill libraries — **Frontend** (22 skills: React 19 / Vue 3 scaffolding, routing, state, forms, auth, i18n, testing, accessibility, performance, design systems, motion, PWA, plus an editable **house-style primer**), **Landing pages** (structure, SEO, lead capture, content audits), and **Workflow** (write-pull-requests, write-commit-messages).

Unlike a plugin, these are **served by the MCP server into your live session**, not copied into your repo. `/kickoff` asks once which sets to enable (frontend is on by default; `update_skill_sets` changes it any time). When a sprint has `fe-engineer` work, `load_phase_context` injects the house-style primer and the enabled skill indexes — workflow skills inject for every implementer; your agent then pulls any skill's full guidance on demand with `get_skill({ name })`. No restart, no files to manage.

|         |                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source  | [`claude_development_skills`](https://github.com/VelimirMueller/claude_development_skills) — vendored under `vendor/skills/` (build input)        |
| Storage | seeded into the project DB `skills` table (`fe:*`, `la:*`, `wf:*`); **edit them to make them yours** — re-seeds never overwrite your edits        |
| Opt-in  | `/kickoff` Phase 1b asks once; `update_skill_sets({ landing: true, ... })` any time                                                               |
| Trigger | fe/la on `fe-engineer` tickets, wf on any implementation work during `/kickoff`                                                                   |
| Load    | index + primer up front; full body via `get_skill({ name })`                                                                                      |
| Update  | opt-in boot-time sync from the latest upstream release (`CODE_CONTEXT_SKILLS_AUTOSYNC=1`); `pnpm run sync:skills` re-vendors the offline fallback |

## The agent team

9 configurable agents, each with a role, model, and mood score. Dev roles default to the strongest model (`claude-fable-5-1`), QA to `claude-opus-5-5`; the rest use `claude-sonnet-5-5`. Change a model, tools or system prompt with the `update_agent` MCP tool or in the dashboard.

| Role               | Focus                                                          |
| ------------------ | -------------------------------------------------------------- |
| Product Owner      | Vision, priorities, stakeholder alignment                      |
| Team Lead          | Coordination, code review, quality                             |
| Architect          | System design, technology decisions, structural integrity      |
| Backend Developer  | APIs, database, server logic                                   |
| Frontend Developer | Dashboard components, UI/UX                                    |
| Developer          | Full-stack features across frontend and backend                |
| QA Engineer        | Testing, verification, quality gates                           |
| Security Engineer  | Vulnerability review, threat modeling, security best practices |
| DevOps             | CI/CD, builds, deployment                                      |

Add, remove, or swap models through MCP tools or with a single click in the dashboard — and the choice **routes execution**: during `/kickoff` and `/sprint`, each ticket is implemented by a subagent spawned at its assigned agent's model tier (`fable`/`opus`/`sonnet`/`haiku`).

Since 2.0, tickets can carry **multiple agents with per-assignment model overrides**: the lead implements, supporting agents verify the diff in parallel from their role's perspective, and the QA gate requires every verdict before a ticket counts as done.

## Sprint process

4 phases with enforced gate checks:

```
planning → implementation → done → rest
```

| Phase              | Duration | Gate                                            |
| ------------------ | -------- | ----------------------------------------------- |
| **Planning**       | 1 day    | Tickets assigned, velocity committed            |
| **Implementation** | 3 days   | All tickets DONE or NOT_DONE, blockers resolved |
| **Done**           | 0.5 day  | Retro findings recorded, QA verified            |
| **Rest**           | 0.5 day  | Automatic after retro                           |

Phases, durations, and gates are fully customizable via `update_sprint_config`.

Since 2.0, planning is **gated**: `start_sprint` and `advance_sprint` refuse to proceed while untriaged retro `try_next` findings or escalated open discoveries (P0/P1 older than 3 sprints) exist — triage them, or override explicitly with `acknowledge_open_items: true`. Retro learnings stop being write-only.

Since 2.2, the QA gate also checks **commit discipline**: a ticket can't reach `qa_verified` while its referencing commits lack the `Why:/What:/How:` body groups — and closes feed the burndown automatically.

## Release highlights

### Unreleased 3.0.0 — Lean by Default 🪶

- **Breaking: `code` is the default profile.** A server with no setting lists the 6 reading tools (about 850 tokens of definitions) instead of 97 (about 12,300 tokens). Every positive benchmark run used this profile.
- **The sprint process is opt-in.** `CODE_CONTEXT_PROFILE=full` lists the 2.x default again; `all` lists every tool. `CODE_CONTEXT_TOOLSETS` still adds single toolsets. See [Tool profiles](#tool-profiles).
- **Setup and `/kickoff` handle it.** `setup` writes `CODE_CONTEXT_PROFILE=full` into `.mcp.json` (or keeps the existing setting; `--profile code` for code reading only). `/kickoff` checks `health` first and names the setting when the sprint tools are off.
- **Breaking: two entry points.** `code-context` is the code index with a frozen contract; `code-context-sprint` adds the sprint process on the same `context.db`. `setup` installs the sprint entry. See [Entry points](#entry-points).

### New in 2.13 — PHP in the Index 🐘

- **`find_symbol`, `who_imports`, `exports_in` and `get_file_context` work for PHP repos.** `.php` files get exports with one-line signatures and lines: `class` (incl. `abstract`/`final`/`readonly`), `interface`, `trait`, `enum`, top-level `function` and `const`. `exports.name` is the short name, `exports.description` the namespace-qualified name, so `find_symbol` and `who_imports` take either (`OrderService`, `App\Services\OrderService`).
- **Edges resolve through `composer.json` PSR-4.** `use` (grouped, aliased, `use function`, `use const`), `extends`, `implements`, trait `use` and class names in code (`new`, `::`, `::class`, type hints, `\A\B`) resolve via the nearest `composer.json` `autoload` / `autoload-dev` PSR-4 maps (a `composer.json` in a subdirectory such as `laravel/` works), then via the indexed declarations. Same-namespace classes need no `use`. Vendor namespaces land in `external_imports`; `vendor/` and Laravel `storage/` stay unindexed. `files.import_lines` holds the `use` lines.
- **Comments, strings, heredoc/nowdoc and inline HTML never create exports or edges.** A small TypeScript state machine blanks them before the declarations are read. No PHP runtime and no new dependency. A synthetic 1,501-file tree (7.9 MB) indexes in about 0.8 s.

### New in 2.12 — GitHub Sync & Code-only Profile 🔁

- **Project key.** `set_project` maps a short key to a GitHub repo and Project board. Milestones, sprints, epics and tickets take `project`; tickets inherit it from their sprint, milestone or epic. The list tools filter by it. Schema v26 leaves existing rows unassigned.
- **`sync_github`** mirrors one project's milestones and tickets to GitHub: issues with `P0`–`P2`, type and origin labels, the owner as assignee, board Status from the ticket status, closed when DONE. Idempotent through `tickets.github_issue`; `dry_run: true` prints the plan. About 2 GitHub reads per run. Details: [sync_github](tools/sync-github.md).
- **Live writes need an allowlist outside MCP.** A live sync writes only to the exact targets in `CODE_CONTEXT_GITHUB_SYNC_REPOS`; no tool sets it. A board needs the exact `owner/repo@board-owner/N` entry. The assignee must be the repo owner or listed in `CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES`. `set_project` refuses to re-point a project that already synced, unless `force: true` and the new target is allowlisted. Dry runs need nothing. A text that holds a secret (API keys, tokens, JWTs, private keys, credentials; raw or encoded) is refused with the field and secret type named. Every published text is scrubbed of local paths in any encoding (`file://`, `%2F`, `&#47;`, `\/`, `C:/Users/…`), and an independent guard refuses what survives.

  | Env var                              | Default                                                                     | Effect                                                                                                                                         |
  | ------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
  | `CODE_CONTEXT_GITHUB_SYNC_REPOS`     | unset: every live `sync_github` / `code-context-sync-github` run is refused | `owner/repo`: issues and milestones in that repo, no board. `owner/repo@board-owner/N`: also that one Project board. Comma or space separated. |
  | `CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES` | unset: only the repo owner may be assigned                                  | `login[,login…]`: these logins may also be the project's issue assignee                                                                        |

- **Code-only profile.** `CODE_CONTEXT_TOOLSETS=code` lists only the six reading tools: `find_symbol`, `get_file_context`, `who_imports`, `exports_in`, `search_files` and `query` (about 3,300 characters, about 850 tokens, of tool definitions instead of about 12,300 tokens). `query` carries the code-index schema in its description and caps its output at 50 rows or about 8 KB (see [query / execute](tools/query-execute.md)). Use it for sessions that read code but never run the sprint process. `code,code-admin` adds the index maintenance tools (`index_directory`, `get_changes`, `set_description`, `set_directory_description`, `set_change_reason`, `execute`, `health`). `all` overrides both. The maintenance tools stay in the default profile.
- **Paths an agent can read back.** The index stores every file by its realpath, so a symlinked root (macOS `/var/folders/…` → `/private/var/folders/…`) and its target are one index. `find_symbol`, `get_file_context`, `search_files` and `get_changes` print paths relative to the indexed root that holds the server's working directory (`src/utils/helpers.ts`); files of other repos in a shared database stay absolute. `absolute_paths: true` or `CODE_CONTEXT_ABSOLUTE_PATHS=1` prints absolute paths. Tools take the relative form, the realpath and the symlinked spelling.
- **Server instructions and compact results.** The server sends short MCP `instructions` (about 370 characters, about 90 tokens): which graph tool answers "who imports X", "where is S defined", "what does this file export or import" and "what does dir D export or leave unused", that results never hold full code (`read` the file; `get_file_context` has signatures and import lines, `snippet: true` short bodies), and that paths are project-relative. Only listed tools are named; the path sentence drops with `CODE_CONTEXT_ABSOLUTE_PATHS=1`.

  | Env var                                                                                                     | 2.x default (now `full`) | `code` profile (now the default) |
  | ----------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------- |
  | `OVERDRIVE_FLAIR` (header `● code-context ▸ <tool> ░▒▓` + `<kaomoji> <ms> ms` footer on text results)       | on; `0` turns it off     | off; `1` turns it on             |
  | `CODE_CONTEXT_TIMESTAMPS` (`modified …` / `indexed …` in `find_symbol`, `get_file_context`, `search_files`) | off; `1` turns it on     | off; `1` turns it on             |

  The read-time freshness check does not change: a changed or deleted file is re-indexed or dropped before the answer, and the `↻ fresh: …` / `⚠ STALE …` notice still leads the result. `index_directory` prints each directory's file and line counts once.

### New in 2.8 — Python in the Index 🐍

- **`find_symbol` and the dependency graph work for Python repos.** `.py`/`.pyi` files now get `exports` rows and `dependencies` edges: module-level `def`/`async def`, `class` and `UPPER_CASE =` constants, with the first docstring line as description. `_`-prefixed names are skipped unless `__all__` lists them; `__all__` filters the list.
- **Imports resolve inside the repo.** `import a.b`, `from .mod import x`, multi-line `from` imports and `from . import mod` resolve to `<path>.py` or `<path>/__init__.py` from the repo root or `root/src`; stdlib and third-party imports land in `external_imports`. Regex-based like the JS/TS parsers, no new dependencies; JS/TS behaviour is unchanged.
- **Skill sync follows the claude_development_skills 0.7.0 layout.** The `workflow` set now reads `skills/core/` (names stay `wf:*`), so the `wf:` rows no longer freeze at 0.6.0. `scripts/sync-skills.mjs` vendors only the catalogues `skill-set-registry.json` names.

### New in 2.7 — Archive Milestones & Epics 🗄️

- **Done is out of sight** — completed milestones and epics can be archived like sprints: `update_milestone` / `update_epic` take `archived: true` (`force: true` for unfinished work), and `archived: false` brings them back.
- **Lists stay short** — `list_epics` and the new `list_milestones` hide archived rows unless `include_archived: true`; the Planning page tucks them into a collapsed **Archived** section with one-click **Archive** / **Unarchive**.
- **Safe upgrade** — schema v24 only adds a nullable `archived_at` column to both tables; nothing existing is archived.

### New in 2.6 — Fresh Index 🧊

- **Answers are checked against the disk.** `search_files`, `find_symbol` and `get_file_context` stat every row they return: a changed file is re-indexed and a deleted one dropped _before_ the answer goes out, and each row carries its `indexed_at`. Per repo, a moved git `HEAD` re-indexes exactly the files `git diff --name-only <indexed>..HEAD` lists and says so in one `⚠ STALE` line; above 500 changed files it warns on every call instead of blocking.
- **Only your code is indexed.** Git checkouts are listed with `git ls-files` (every `.gitignore`, at any depth), on top of a hard deny: `node_modules`, `vendor`, `dist`, `build`, `.next`, `coverage`, Laravel `storage/`, dot-dirs (`.git`, `.worktrees`), lockfiles, minified bundles, source maps, binaries, files over 512 KB (`CODE_CONTEXT_MAX_FILE_KB`).
- **Secret-shaped files are never indexed.** On top of the dot rule, `isDeniedFileName` refuses these basenames (case-insensitive): the extensions `.pem .key .p12 .pfx .jks .keystore .asc .gpg .tfstate .tfstate.backup .kdbx .ovpn`, and the names `id_rsa*` `id_dsa*` `id_ecdsa*` `id_ed25519*` `credentials` `credentials.json` `credentials.yml` `credentials.yaml` `secrets.yml` `secrets.yaml` `secrets.json` `service-account*.json` `*-service-account*.json` `terraform.tfvars` `*.tfvars` `token.json` `oauth*.json` `.netrc` `.htpasswd` `.pgpass` `.npmrc` `.pypirc` `.git-credentials` `known_hosts` `authorized_keys`. Set `CODE_CONTEXT_INDEX_ALLOW` (comma-separated basenames or `*.ext` globs) to opt a name back in.
- **`code-context-reindex`** re-indexes every repo under a root: `[--all | <repo>…] [--root <dir>] [--db <file>] [--prune-missing] [--vacuum]`. `--root` defaults to the current directory. A `.code-context-ignore` file in a repo keeps it out (and purges its rows). Exit 0/1.
- **Fewer tools in context.** The gamification (`record_mood`, `get_mood_trends`, `generate_vision_animation`) and the dashboard live-output stream (`send_step_progress`, `send_claude_output`, `send_claude_step`) are hidden unless `CODE_CONTEXT_TOOLSETS=fun,stream` (or `all`). No data is removed.

### New in 2.4 — Roster Control 🎛️

- **`update_agent`** — change a role's model, tools, system prompt, name, description or department from a single MCP call, and the reply names the Task-tool tier the new model routes to. No raw SQL and no dashboard detour. The sprint instructions used to advertise a `create_agent` tool that never existed; they now point here.
- **One model catalog** — `claude-opus-5` is offered and accepted everywhere, and seeds the QA role. `KNOWN_AGENT_MODELS` is the single source of truth the dashboard re-exports, so server and UI can no longer drift; `claude-opus-4-8` joins `claude-sonnet-4-6` as a legacy id that still renders and edits.
- **`assigned_to` is validated** — a model or provider name such as `opus` or `glm` used to find no agent and route silently to the sonnet fallback. Both ticket tools now reject anything that is not a roster role and point at `impl:*` tags for the runtime.

### New in 2.3 — Current-Gen Models & Hardening 🧭

- **Sonnet 5 defaults** — support roles seed on `claude-sonnet-5`; the dashboard offers the full current generation (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5) from one shared model catalog, and Fable agents finally render (and are pickable) everywhere.
- **Reset tools un-broken** — `reset_agents`/`reset_skills` no longer crash with `require is not defined`, and a reset preserves agent departments.
- **Backups you can trust** — `--force` checkpoints the WAL before renaming and uses SQLite-pairable backup names, so the `.bak` alone holds every committed write.
- **Groomed fatal errors** — a DB from a newer version refuses the boot with a clean two-line error (no stack trace, no stray `-wal`/`-shm` files), and `--help` finally tells the truth about setup-vs-update.

### New in 2.2 — Discipline & Telemetry 📐

- **Commit contract, injected and enforced** — delegated implementation prompts carry the `Why:/What:/How:` commit-body contract (derived live from the `wf:write-commit-messages` skill), and `update_ticket` refuses `qa_verified` while a ticket's commits don't follow it — offending hashes named, docs-only tickets exempt, always fail-open.
- **Telemetry without ceremony** — closing a ticket auto-snapshots the burndown and can log `actual_hours` against the assigned agent; phase transitions snapshot too. Retros quote real numbers instead of `0h`.
- **Leaner internals** — `tools.ts` and `dashboard.ts` both decomposed into domain modules (dashboard server −37%), with byte-identical tool/route surfaces pinned by mutation-verified parity tests.
- **Claude Fable 5 tier** — dev roles default to `claude-fable-5`; ticket routing gains the `fable` tier.

### New in 2.0 — Process 2.0 🚦

- **Planning gates that close the retro loop** — sprints refuse to start while retro `try_next` learnings sit untriaged; adopt, drop, or defer each one (`triage_retro_finding`), and adopted items auto-flag as applied when their ticket lands.
- **Honest velocity** — commitment freezes when implementation starts; mid-sprint scope shows as `+added / removed` instead of inflating completion rates.
- **Terminal cockpit** — tools render width-locked progress cards in colored ```diff fences, and the `code-context-statusline` bin puts a live sprint HUD in Claude Code's status line at zero token cost.
- **Live-editable board + session reaction** — edit tickets on the dashboard; the Claude session sees a `⚠ CHANGED TICKETS` diff block and acknowledges your changes.
- **Multi-agent tickets** — several agents per ticket with per-assignment model overrides: the lead implements, supporters verify in parallel, QA aggregates the verdicts.
