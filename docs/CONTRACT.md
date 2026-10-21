# The public contract (3.x)

This page is the frozen public surface of `vlm-code-context-mcp` for every 3.x release (#180).

**The rule:** a change to anything in this contract needs a **major version bump** and a **`### Breaking` entry in CHANGELOG.md**. CI enforces it (see [How to change the contract](#how-to-change-the-contract)).

- **Normative source:** the JSON snapshots in [`test/contract/snapshots/`](https://github.com/VelimirMueller/code-context-mcp/tree/main/test/contract/snapshots). This page explains them. When the page and a snapshot disagree, the snapshot wins and the page gets a fix.
- **Not in the contract:** tool and parameter descriptions (prose, hashed in `descriptions.json`), the dashboard and its HTTP API, the slash commands and skills, the flair look, log lines, the benchmark tooling, and the outputs of the sprint tools (best effort, see [Sprint profile](#the-sprint-profile)).
- **Why:** 2.12.0, a minor release, changed the default output (project-relative paths, no timestamps) and cut the `code` profile from 11 to 6 tools. Clients that parsed the old output broke without warning. The CHANGELOG entry of 2.12.0 now records it.

## Entry points

One npm package, one server, one `context.db`. Snapshot: `bins.json`.

| Bin                        | File                             | What it is                                                                            |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `code-context`             | `dist/server/index.js`           | The index entry (MCP over stdio). Default profile `code`, 6 tools.                    |
| `vlm-code-context-mcp`     | `dist/server/index.js`           | Alias of `code-context`, so `npx -y vlm-code-context-mcp ./context.db` works.         |
| `code-context-sprint`      | `dist/server/sprint.js`          | The sprint entry (MCP over stdio). Default profile `full`, 97 tools.                  |
| `code-context-mcp`         | `dist/server/setup.js`           | Setup and update of a project.                                                        |
| `code-context-reindex`     | `dist/server/reindex-cli.js`     | Re-index every git repo under a root into one db.                                     |
| `code-context-sync-github` | `dist/server/sync-github-cli.js` | One-way sync of one project to GitHub.                                                |
| `code-context-dashboard`   | `dist/dashboard/dashboard.js`    | The dashboard server. The bin and its arguments are contract; the UI and API are not. |
| `code-context-statusline`  | `dist/server/statusline.js`      | The Claude Code statusline. Reads JSON on stdin, prints one line, always exits 0.     |

- **MCP server identity:** name `code-context`, version = the package version. Transport: stdio.
- **Server argument:** `code-context [db-path]` and `code-context-sprint [db-path]`. Default `./context.db`.
- **A known `CODE_CONTEXT_PROFILE` wins on both MCP entries.** `code-context-sprint` changes only the default: unset, empty or unknown becomes `full`.

### CLI flags

| Bin                        | Arguments and flags                                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-context-mcp`         | `[setup] [path]`, `--force`, `--name <name>`, `--defaults`, `--profile <code\|full\|all>` (also `--profile=<p>`), `--help`/`-h`                                                                                                                                                                                       |
| `code-context-reindex`     | `[--all \| <repo-path>…]`, `--root <dir>`, `--db <file>`, `--prune-missing`, `--vacuum`, `--quiet`/`-q`, `--help`/`-h`. Exit 0 all indexed, 1 a repo failed, 2 bad usage.                                                                                                                                             |
| `code-context-sync-github` | `--project <name>` (required), `--db <file>`, `--dry-run`, `--offline` (needs `--dry-run`), `--repo owner/name`, `--project-number N`, `--project-owner login`, `--assignee login`, `--milestone <id>[=<N>]`, `--adopt N[-M][,…]`, `--max-writes N`, `--force`, `--help`/`-h`. Exit 0 ok, 1 sync failed, 2 bad usage. |
| `code-context-dashboard`   | `[db-path] [port] [watch-dir]`. Defaults `./context.db`, `$DASHBOARD_PORT` or `3333`, none.                                                                                                                                                                                                                           |
| `code-context-statusline`  | No flags. Input: `{ "workspace": { "current_dir": "…" } }` on stdin.                                                                                                                                                                                                                                                  |

## Profiles and env settings

Snapshots: `tools-code.json`, `tools-full.json`, `tools-all.json`, `env.json`.

| Profile (`CODE_CONTEXT_PROFILE`)          | Toolsets                                       | Tools |
| ----------------------------------------- | ---------------------------------------------- | ----- |
| `code` (default of `code-context`)        | `code`                                         | 6     |
| `full` (default of `code-context-sprint`) | `code`, `code-admin`, `scrum`                  | 97    |
| `all`                                     | `code`, `code-admin`, `scrum`, `fun`, `stream` | 103   |

- **`CODE_CONTEXT_PROFILE`:** `code` \| `full` \| `all`, case-insensitive. Unset, empty or unknown = the entry's default; an unknown value is listed in `health.ignored_settings`.
- **`CODE_CONTEXT_TOOLSETS`:** comma list added to the profile: `code-admin`, `scrum`, `fun`, `stream` or `all`; a leading `+` is allowed; `code` and `default` change nothing. It only adds, never removes.
- **Toolset of a tool:** `code` and `code-admin` are fixed lists (`CODE_TOOLS`, `CODE_ADMIN_TOOLS` in `src/server/tool-wrap.ts`), `fun` = `record_mood`, `get_mood_trends`, `generate_vision_animation`, `stream` = `send_step_progress`, `send_claude_output`, `send_claude_step`, `scrum` = every other tool.
- **A hidden tool is not registered:** it is not in `tools/list` and a call fails as an unknown tool. The data stays.

Every env setting the shipped code reads is in `env.json`. A rename or removal is a break; a new setting is additive. The settings a client sees:

| Setting                                                                                                       | Effect                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CODE_CONTEXT_PROFILE`, `CODE_CONTEXT_TOOLSETS`                                                               | Profile and toolsets (above).                                                         |
| `CODE_CONTEXT_ABSOLUTE_PATHS=1`                                                                               | Absolute paths in every result, and no path sentence in the instructions.             |
| `CODE_CONTEXT_TIMESTAMPS=1`                                                                                   | `indexed …` / `modified …` back in `find_symbol`, `get_file_context`, `search_files`. |
| `OVERDRIVE_FLAIR=0` / `1`                                                                                     | Flair off / on. Unset: on when the `scrum` toolset is on.                             |
| `CODE_CONTEXT_ALLOWED_ROOTS`                                                                                  | Directories `index_directory` and the reindex CLI may index.                          |
| `CODE_CONTEXT_MAX_FILE_KB`                                                                                    | Size limit of an indexed file.                                                        |
| `CODE_CONTEXT_INDEX_ALLOW`                                                                                    | Basenames or `*.ext` globs the secret-file deny list lets back into the index.        |
| `CODE_CONTEXT_DB`                                                                                             | Default db of the reindex and sync CLIs.                                              |
| `CODE_CONTEXT_SKILLS_AUTOSYNC=1`                                                                              | Sync skills from upstream at boot (sprint entry).                                     |
| `CODE_CONTEXT_GITHUB_SYNC_REPOS`, `CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES`                                        | Allowlist of live GitHub sync writes.                                                 |
| `CODE_CONTEXT_DASHBOARD_TOKEN`, `DASHBOARD_PORT`, `CODE_CONTEXT_BENCH_DIR`, `CODE_CONTEXT_BENCH_PRIVATE_DIRS` | Dashboard.                                                                            |
| `OVERDRIVE_SESSION_LOG`, `OVERDRIVE_SESSION_LOG_DIR`                                                          | The overdrive session log (`0` = off).                                                |

## Server instructions

Snapshot: `instructions.json`. The MCP `instructions` string names only listed code tools. With the defaults it is, in every profile:

> Code index of this project; prefer it to grep. Who imports X: who_imports. Where is S defined: find_symbol. What a file exports or imports: get_file_context. What dir D exports or leaves unused: exports_in. Results never hold full code: read the file for that. get_file_context gives signatures and import lines, snippet:true short bodies. Paths are project-relative.

`CODE_CONTEXT_ABSOLUTE_PATHS=1` drops the last sentence. The string stays at or under 400 characters.

## The index contract: the 6 `code` tools

Snapshots: `tools-code.json` (names and input schemas), `outputs-code.json` (sample outputs on `test/fixtures/sample-project`).

**Default output format (since 2.12.0), every code tool:**

- **Plain text** in one `text` content item; `query` rows are JSON. No flair header or footer under the `code` profile.
- **Paths are project-relative** (`src/utils/helpers.ts`, forward slashes) under the display base: the indexed root that holds the server's cwd, else the cwd when indexed roots sit below it, else the only indexed root. Files outside the base (another repo in a shared db) print absolute. `absolute_paths: true` or `CODE_CONTEXT_ABSOLUTE_PATHS=1` prints every path absolute (the realpath).
- **No timestamps.** `CODE_CONTEXT_TIMESTAMPS=1` adds them.
- **Freshness notice:** when the read-time check re-indexed changed files, the result starts with one `↻ …` (or `⚠ STALE …`) line.
- **Input paths** take the printed relative form, the absolute realpath, the old unresolved spelling and a unique suffix.
- **Errors** set `isError: true` with a one-line reason (ambiguous path, refused SQL). A missing symbol or file is a normal result, not an error.

| Tool               | Inputs (required in bold)                                                                                                    | Output                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_symbol`      | **`name`** string (`%` wildcard; PHP short or namespace-qualified), `absolute_paths` boolean                                 | Per match, blank-line separated: `<name> (<kind>) — <path>` then `  <file summary>`. None: `No exports matching "<name>" found.`                                                                                                                                                                                                                                                                                                 |
| `get_file_context` | **`path`** string, `snippet` boolean, `include_changes` boolean, `change_limit` number (default 3), `absolute_paths` boolean | `# <path>`, `<language> \| <size> \| <n> lines`, summary lines, then sections `## Exports (n)` (`- L<line> <signature>`, with `snippet` the source indented below, max 20 lines each), `## Import lines (n)` (`L<line> <statement>`), `## Imports from (n)` and `## Imported by (n)` (`- <path> [<symbols>]`). Lists stop at 40 exports, 30 import lines, 30 edges with `+N more`. Not indexed: `File "<path>" not in index. …`. |
| `who_imports`      | **`target`** string (file path or exported symbol), `absolute_paths` boolean                                                 | `# <target>: imported by <n> file(s) [(+m through re-exports)] — complete list from the import graph`, then `- <path> L<lines> [<symbols>] [(re-export)]`, then `## Via re-export (m): …` with `- <path> L<lines> [<symbols>] via <barrel>`. Stops at 100 importers with `+N more`.                                                                                                                                              |
| `exports_in`       | **`dir`** string, `unused` boolean, `absolute_paths` boolean                                                                 | `# Exports in <dir>: <n> in <f> files` (or `# Unused exports in <dir>: <n> of <total> — …` and one rule line), then per file `## <path>` and `- L<line> <signature>` (re-exports: `- L<line> <name> (re-export)`). Stops at 150 exports with `+N more`.                                                                                                                                                                          |
| `search_files`     | **`query`** string (`%` wildcard; matches path or summary, not contents), `absolute_paths` boolean                           | Max 25 files, blank-line separated: `<path> (<language>, <n> lines, <e> exports, <d> deps)` then `  <summary>`. None: `No files matching "<query>".`                                                                                                                                                                                                                                                                             |
| `query`            | **`sql`** string: one `SELECT` / `WITH … SELECT`, `PRAGMA table_info(<t>)` or `PRAGMA table_list`                            | A JSON array, one row object per line. At most 50 rows or about 8,000 chars, cells cut at 1,000 chars, each cut with a note. `files.content` only when the SELECT names it. Stored paths are absolute realpaths. Anything else: `isError` with what is allowed.                                                                                                                                                                  |

The `query` tool reads the code-index tables; their columns are part of the [db contract](#database-compatibility).

## The sprint profile

Snapshots: `tools-full.json`, `tools-all.json` (names and input schemas of all 97 / 103 tools).

- **Frozen:** the tool names and their input schemas (parameter names, types, required, enums).
- **Best effort, may change in minor releases:** the output text of every tool outside the `code` toolset, the `code-admin` tools included. One exception: `health` returns JSON with at least `status`, `database.files_indexed`, `database.sprints`, `profile`, `toolsets` (and `ignored_settings` when set); `/kickoff` reads `profile` and `toolsets`.
- **`code-admin`:** `index_directory`, `set_description`, `set_directory_description`, `set_change_reason`, `get_changes`, `execute`, `health`.
- **`scrum` (84):** `acknowledge_ticket_changes`, `add_dependency`, `add_retro_finding`, `add_tag`, `advance_sprint`, `analyze_retro_patterns`, `create_blocker`, `create_discovery`, `create_epic`, `create_milestone`, `create_sprint`, `create_ticket`, `dump_database`, `export_sprint_report`, `export_to_file`, `get_agent`, `get_audit_trail`, `get_backlog`, `get_burndown`, `get_dependency_graph`, `get_discovery_coverage`, `get_onboarding_status`, `get_project_status`, `get_resume_state`, `get_skill`, `get_sprint`, `get_sprint_config`, `get_sprint_instructions`, `get_sprint_playbook`, `get_sprint_summary`, `get_ticket`, `get_time_report`, `get_token_usage`, `get_user_response`, `get_velocity_trends`, `handle_run_kickoff`, `handle_run_retro`, `handle_run_review`, `import_from_file`, `link_discovery_to_ticket`, `link_ticket_to_epic`, `link_ticket_to_milestone`, `list_agents`, `list_decisions`, `list_discoveries`, `list_epics`, `list_milestones`, `list_recent_events`, `list_retro_findings`, `list_sprints`, `list_tags`, `list_tickets`, `load_phase_context`, `log_bug`, `log_decision`, `log_event`, `log_time`, `log_token_usage`, `plan_sprint`, `remove_dependency`, `remove_tag`, `request_user_input`, `reset_agents`, `reset_skills`, `reset_sprint_process`, `resolve_blocker`, `restore_database`, `run_onboarding`, `search_scrum`, `set_project`, `snapshot_sprint_metrics`, `start_sprint`, `sync_github`, `sync_scrum_data`, `triage_retro_finding`, `update_agent`, `update_discovery`, `update_epic`, `update_milestone`, `update_skill_sets`, `update_sprint`, `update_sprint_config`, `update_ticket`, `update_vision`.
- **`fun`** and **`stream`:** listed above under [Profiles](#profiles-and-env-settings) (`all` only).

## Database compatibility

Snapshot: `db-layout.json` (tables, `name TYPE` columns and the schema version per owner).

- **One file, split ownership.** The index entry owns the code-index tables: `files`, `exports`, `dependencies`, `directories`, `changes`, `indexed_repos` (`src/server/schema.ts`). It creates only those, idempotent on every open. The sprint entry (any sprint toolset) owns the scrum tables and the `schema_versions` stamp (`src/scrum/schema.ts`): it creates, migrates and seeds them.
- **Schema version:** `schema_versions(version, name, …)`, one counter for the whole file. `LATEST_SCHEMA_VERSION` in `src/server/schema-version.ts` (27 at 3.0.0). A database the index entry created has no stamp; the first start of the sprint entry stamps it at the latest version.
- **Downgrade guard:** both entries refuse a database stamped by a newer version and exit 1 before they open it read-write.
- **Migration policy:**
  - A **minor** release may add tables, columns and indexes, and migrate data forward in place. It never drops or renames a table or column, and never changes the meaning of a stored value.
  - A **major** release may drop or rename. Its CHANGELOG names every such change under `### Breaking`.
  - A migration bumps `LATEST_SCHEMA_VERSION`. Every install that shares one `context.db` must update together, because an older version refuses the newer stamp; the CHANGELOG says so under the release's upgrade notes.
- **Stored paths** are absolute realpaths (since 2.12.0). The tools print them relative; `query` returns them as stored.

## How to change the contract

1. **Make the change and run `pnpm run contract:update`.** It rewrites `test/contract/snapshots/`. Review the diff: it is the contract change.
2. **Decide what it is.**
   - **Breaking** (a removed or renamed tool, parameter, bin, env setting, table or column; a new required parameter; a changed default output): bump the **major** version in `package.json` and add a `### Breaking` CHANGELOG entry with a migration note.
   - **Additive** (a new tool, a new optional parameter, a new bin or env setting, a new table or column, a new schema version): no major bump. A maintainer adds the label **`contract-change-approved`** to the PR after review.
   - **Prose only** (a tool or parameter description): only `descriptions.json` changes. The gate ignores that file; no label needed.
3. **CI checks it.** The `contract` job in `.github/workflows/ci.yml` runs:
   - `pnpm run contract:test` (`vitest run test/contract`): the snapshots must match the code. A failing test means the code moved without a snapshot update.
   - `pnpm run contract:check` (`scripts/check-contract-change.mjs`): reads the base commit and the labels from the pull request event, lists the snapshot files the PR changes (`git diff <base>...HEAD`, `descriptions.json` left out) and fails unless the PR's `package.json` major is higher than the base branch's, or the PR carries `contract-change-approved`. Adding or removing the label re-runs CI. Locally: `node scripts/check-contract-change.mjs origin/main` (labels from `CONTRACT_LABELS=a,b`).

The sample outputs run against `test/fixtures/sample-project`. A change to that fixture changes `outputs-code.json` without a contract change: say so in the PR and approve it with the label.
