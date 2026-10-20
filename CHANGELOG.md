# Changelog

All notable changes to `vlm-code-context-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The VitePress docs build passes again.** The three dead links that failed `npm run build` in `docs/` — `../README` in `docs/ARCHITECTURE.md` and `docs/REFERENCE.md`, `../BENCHMARK-GUIDE` in `docs/user-guide.md` — point at the GitHub files now, and CI builds the docs on pull requests that touch `docs/`, so a dead link cannot land unnoticed again. (#264)
- **The MCP server and the dashboard share one auth token again.** Both read or create `.code-context/dashboard.token` in the directory of the `context.db` they open (`dashboardTokenRoot` in `src/dashboard/auth.ts`); earlier each used its own cwd, so the two processes held different tokens and every MCP notify call got `401` and the dashboard did not refresh live. The MCP server passes its db path to the notify code at start (`setDashboardDbPath`); the cwd is used only when no db path is known. `CODE_CONTEXT_DASHBOARD_TOKEN` still wins when set. Migration: an old `.code-context/dashboard.token` beside a launcher cwd stays in place and is now ignored; delete it, or set `CODE_CONTEXT_DASHBOARD_TOKEN` for both processes. (#235)
- **Restore and import never replace an existing row.** `restore_database`, `import_from_file` and `POST /api/restore` share one restore (`src/scrum/restore.ts`) that inserts with `ON CONFLICT DO NOTHING` instead of `INSERT OR REPLACE`. Earlier a dump row with a clashing id, or since v27 a clashing ticket ref, silently replaced the existing ticket, and the delete behind REPLACE also removed the children of a replaced row (a replaced sprint lost its tickets). A row equal to the existing one counts as unchanged; any other clash is listed and the existing row stays. By default a clash refuses the whole restore (MCP error, HTTP 409) and nothing is written; `on_conflict: "skip"` keeps the existing rows and restores the rest; `dry_run: true` only reports. (#230)
- **Every ticket ref is unique across the database.** Schema v27 adds a unique index on `tickets.ticket_ref`; earlier only `UNIQUE(sprint_id, ticket_ref)` held, so two tickets without a sprint could share a `T-<n>`. The MCP `create_ticket` and `start_sprint` tools and `POST /api/tickets` take refs from one function (`nextTicketRef`, in the locked transaction from #215); `create_ticket` without `ticket_ref` now gets the next free `T-<n>`, and a hand-set ref that another ticket has is refused. Existing installs migrate on the next start: per shared ref the oldest ticket keeps it, the others get the next free ref, and the ticket history (`event_log`) keeps the old ref. All installs that share one database must update together, because an older version refuses a v27 database. (#222)
- **The ticket notes and description e2e specs pass without retries.** `test/e2e/ticket-notes.spec.ts` and `test/e2e/ticket-description.spec.ts` each create their own done sprint and ticket and open the board on that sprint; earlier they added tickets to the shared seeded sprint with `Date.now()` titles, and failed 6 of 20 runs under `--repeat-each=10 --retries=0`. The sprint setup moves to `createOwnSprint` in `test/e2e/helpers.ts`, which the Kanban spec uses too. (#229)
- **The Kanban drag e2e spec passes without retries.** `test/e2e/kanban-drag.spec.ts` creates its own sprint and ticket, opens the board on that sprint and drags with the mouse on the card's row; earlier it shared the seeded sprint with the other specs, so the card moved below the fold and the drop missed when it ran after them or with `--repeat-each`. (#220)
- **Every dashboard view shows the stored milestone status.** The MILESTONES skill fallback maps an `ACTIVE` or `IN PROGRESS` heading to `active`, and the Planning page milestone card has no `in_progress` colour; the dashboard now uses only `planned`, `active` and `completed`. (#221)
- **A milestone update never reports success for a deleted milestone.** `PUT /api/milestone/:id` checks the row and writes it in one statement (`UPDATE … WHERE deleted_at IS NULL RETURNING *`) and answers 404 when no row changed; earlier a delete between the check and the update gave 200 for a write that changed nothing. The handler moves to `src/dashboard/handlers/planning.ts`. (#214)
- **An active milestone on the Dashboard sprint list shows the active colour.** `SprintList` colours each milestone header and progress bar by the status the database stores (`planned`, `active`, `completed`); earlier it checked `in_progress`, which the database never stores, so active milestones showed the planned colour. (#211)
- **A new ticket never gets the ref of a deleted ticket.** `POST /api/tickets` counts all ticket rows, deleted rows too, to make the next `T-<n>` ref, and skips a ref that a row already has; earlier a soft-deleted newest ticket gave its ref again and the insert failed with 500. (#210)
- **A ticket description can be cleared from the dashboard editor.** `PATCH /api/ticket/:id` accepts `description` as a string or null, the same rule as `notes`; earlier it refused the `null` that the editor sends for an empty description, so the old text stayed. The change gets a revision row and an event log row with a NULL new value. (#206)
- **A milestone edit from the dashboard is saved.** Each milestone card on the Planning page has an **Edit** form for the status and the target date. The store sends `status` and `target_date` to `PUT /api/milestone/:id`, with the values the database accepts (`planned`, `active`, `completed`); earlier it sent `targetDate`, which the route ignored, and `in_progress`, which the route refused. `null` clears the target date or the description. The route returns the saved row and answers 404 for a missing milestone. (#205)
- **A new ticket without a priority is saved.** `POST /api/tickets` uses `P2`, the default of the database column and of the MCP `create_ticket` tool; earlier it used `0`, which the database rule refuses. An empty or unknown priority gets 400. The route returns the saved row. (#204)
- **A new milestone from the dashboard is saved.** The Planning page has a **New milestone** form (name, optional target date). It sends `name` and `target_date`, the fields `POST /api/milestones` parses; earlier the store sent `title`, so the route answered 400. The route returns the saved row. (#199)
- **A Kanban drag changes the ticket status.** The board sends `PATCH /api/ticket/:id` with the new status, the same route as the ticket editor. Earlier it called `PATCH /api/ticket/:id/status`, which does not exist. A drop on Done or Not Done goes back to its column with the server error, because the QA gate sets these statuses. (#198)
- **Ticket notes from the dashboard edit form are saved.** `PATCH /api/ticket/:id` accepts `notes` (a string or null) and records the change like the other fields. The edit form sends the notes through this route; earlier it sent them to a route without a `notes` field, so the edit was lost. (#197)
- **A bad POST body no longer stops the dashboard.** `/api/notify/event`, `/api/claude-output` and `/api/claude-step` answer 400 on invalid JSON, an empty body or a body that is not an object, and 413 on a body over 5 MB. Other `/api/*` write routes answer 400 on invalid JSON instead of 500. An outer guard answers any other request error with 500, so the process never gets an unhandled rejection. (#188)
- **`reset_agents` and `reset_skills` do not run `npm run build` in your project.** The tools spawn no process, so they work in a project without a `build` script and write nothing to the JSON-RPC stream. The delete and the re-seed run in one transaction; when a step fails, the old rows stay. (#187)

### Changed

- **CLI change: `code-context-reindex --root` defaults to the current directory.** Earlier the default was `~/Desktop/Workspace/dev`, a path that exists only on the author's machine. Pass `--root <dir>` to scan another directory. The help text (`--help`) names the default. (#176)
- **Current Claude models in the agent catalog.** `KNOWN_AGENT_MODELS` (`src/scrum/agent-model.ts`) and the dashboard picker (`src/dashboard/app/src/lib/constants.ts`) offer `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`. Factory seeds move to `claude-fable-5-1` (dev roles), `claude-opus-5-5` (QA) and `claude-sonnet-5-5` (other roles, and the default for a new agent without a model). The earlier ids (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-8`, `claude-sonnet-4-6`) stay accepted, so existing agents keep their model. Seeding never overwrites an existing agents table: existing installs keep their models until you change them with `update_agent`, in the dashboard, or with `reset_agents`. Tier routing is unchanged. (#174)
- **Node.js 22 or newer is the supported range.** `package.json` declares `"engines": { "node": ">=22" }`; Node.js 24 LTS is recommended. CI tests 22, 24 and the current LTS. The minimum stays 22 until 3.0.0. (#173)
- **`@remotion/player` is no longer a direct dev dependency, and the stale navigation guide is gone.** Only the deleted `VisionPlayer` imported the player; `@remotion/cli` still installs it for `npx remotion render`. `docs/ux/navigation-migration-guide.md` is deleted, because its samples imported removed modules; the UX index, CONTRIBUTING, STYLEGUIDE and two dated plans no longer name removed modules. (#231)
- **Unreachable dashboard modules are removed, and CI fails on new ones.** 27 files that no page reached are deleted, among them `CapacityPlanningView`, `GanttChart`, `GoogleAdsStrategy`, `SprintPlanner`, `VisionPlayer`, `hooks/usePlanning.ts` and the `components/molecules`, `components/organisms`, `hooks` and `stores` barrel files. The new `npm run check:dashboard-reachable` follows the imports from `src/main.tsx` with the TypeScript module resolver and the app tsconfig, and the CI lint job runs it. No page changes. (#223)
- **The pre-commit hook type-checks, and `package.json` drops unused entries.** lint-staged (now `lint-staged.config.mjs`) runs `tsc --noEmit` once per commit when a staged file is under `src/` (`-p src/dashboard/app` for dashboard app files), then ESLint and Prettier on the staged files; it never runs `npm run build`. Earlier the hook ran only ESLint and Prettier, while CONTRIBUTING.md and STYLEGUIDE.md said it ran `tsc --noEmit` and `npm run build`; the docs now match the hook. The unused `gemma-brain` dev dependency and the `start-gemma` script are removed. The Remotion dev dependencies stay: `generate_vision_animation` prints `npx remotion` commands for `src/remotion/`, and `docs/guide/architecture.md` now says so. (#175)
- **CI type-checks the dashboard app.** The `test` job runs `npm run typecheck:dashboard` (`tsc --noEmit -p src/dashboard/app`), so a type error in the dashboard app fails CI; the root `tsc --noEmit` does not include the app. The 9 type errors it found are fixed: Vite client types for `import.meta.env`, the `steps(2)` easing function instead of a string, the optional `sprint_id` on `RetroFinding`, a margin wrapper instead of an unknown `Skeleton` prop, and an agent check in `TeamManagementModal`. (#213)
- **Unused planning components are removed from the dashboard.** `SprintPlanningView`, `PlanningWizard`, `MilestoneList`, `PlanningDashboard` with `EnhancedGanttChart`, `SprintBurndownView`, `EnhancedCapacityView` and `SprintTableView`, and `PlanningInsights` were not shown on any page and still used the old milestone status `in_progress` and `PUT` for ticket edits. No page changes. (#212)
- **CI runs lint, format, the dashboard tests and the Playwright specs on every PR.** A new `lint` job fails on ESLint errors and runs Prettier on the files the change touches (`npm run format:changed`). The `test` job runs `npm run test:frontend`. A new `e2e` job runs the 35 Playwright specs against a seeded dashboard on a throwaway database (`npm run test:e2e`, port 4317, never a reused server). Every workflow declares `permissions:` and pins actions by commit SHA. A tracked `.husky/pre-commit` runs lint-staged (ESLint + Prettier on staged files). (#191)
- **One transactional function moves a sprint to its next phase.** `update_sprint`, `advance_sprint` and the dashboard advance and sprint update routes call `transitionSprint` (`src/scrum/sprint-transition.ts`). It writes the status, the frozen commitment, `velocity_completed`, one auto-analysis finding (role `system`), the discovery archive, completed epics and milestone progress in one transaction. When a step fails, nothing changes and the error names the step; the dashboard answers 500. The MCP tools now also complete epics and update milestone progress on `rest`. `get_discovery_coverage` writes nothing. (#189)
- **Typed rows and request bodies in the MCP server, the scrum tools and the dashboard write routes.** `src/scrum/rows.ts` has one row type per scrum table, and the queries in `src/server` and `src/scrum` use them; `@typescript-eslint/no-explicit-any` is an error there. Each dashboard POST, PUT and PATCH route parses its body with zod and answers 400 with the field name when a type is wrong; earlier a wrong type gave a 500 or a bad row. (#190)

### Security

- **The indexer refuses secret-shaped files.** `isDeniedFileName` now denies the extensions `.pem .key .p12 .pfx .jks .keystore .asc .gpg .tfstate .tfstate.backup .kdbx .ovpn` and the names `id_rsa*` `id_dsa*` `id_ecdsa*` `id_ed25519*` `credentials` `credentials.json` `credentials.yml` `credentials.yaml` `secrets.yml` `secrets.yaml` `secrets.json` `service-account*.json` `*-service-account*.json` `terraform.tfvars` `*.tfvars` `token.json` `oauth*.json` `.netrc` `.htpasswd` `.pgpass` `.npmrc` `.pypirc` `.git-credentials` `known_hosts` `authorized_keys`, matched case-insensitively on the basename, so a key, certificate or credential never reaches `context.db` or agent context. A reindex drops rows the new rule refuses, and `CODE_CONTEXT_INDEX_ALLOW` (comma-separated basenames or `*.ext` globs) opts a name back in. (#249)
- **A repo-local `.git/config` cannot run commands during indexing.** Every git call the server makes passes `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null`, and diff calls also pass `--no-ext-diff --no-textconv`, so a repo that arrives as an archive with `core.fsmonitor = <command>` cannot run that command on `ls-files`, `diff`, `log` or `rev-parse`. One helper (`gitArgs` in `src/server/git.ts`) builds the args; the indexer, the freshness guard, `checkCommitFormat` and the dashboard all use it. (#251)
- **The database, its sidecars, every backup and the export dump are created with mode 0600.** The MCP server, the dashboard, setup and reindex open `context.db` through `openDbSecure` (`src/secure-file.ts`), which creates the db and its `-wal`/`-shm` siblings owner-only whatever the process umask is — SQLite creates the siblings lazily with 0644 & ~umask, so the helper pre-creates them as 0600 before the open. Earlier macOS defaults gave 0644, so every other OS user could read the full content of every indexed file and the scrum data (TM-08). The pre-migration `context.db.bak`, the `--force` backup `context.db.bak-<ts>` and the `export_to_file` dump are 0600 too. An existing db with group/other read bits is never chmod'ed silently: it gets one WARN line in the session log telling you to run `chmod 600`. (#248)
- **Docs site dependencies:** vite >= 6.4.3 and esbuild >= 0.25.0 in `docs/package-lock.json`, closing the four Dependabot alerts (GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3, GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99). (#262)
- **`execute` cannot write the gate columns.** The tool refuses any `INSERT`, `UPDATE`, `REPLACE` or upsert that writes `tickets.status`, `tickets.qa_verified`, `tickets.verified_by`, a `tickets.github_*` column, `tickets.deleted_at`, `sprints.status`, `sprints.deleted_at`, `sprints.archived_at`, a `milestones.github_*` column, `milestones.archived_at`, `epics.archived_at` or a `projects.github_*` column. `DELETE` on `tickets` and `sprints`, `REPLACE` / `OR REPLACE` on these tables and an `INSERT` into them without a column list are refused too, because they reset the gate columns. The error names the column and the tool that runs the gates (`update_ticket`, `update_sprint` / `advance_sprint`, `update_milestone`, `update_epic`, `set_project`, `sync_github`, or the dashboard delete and archive actions). Earlier a free `UPDATE` set a ticket to `DONE`, verified it or pointed it at any GitHub issue, which the dashboard and the gate tools refuse. The check (`src/server/sql-gate-columns.ts`) parses tokens, not text: quoted names (`"x"`, `` `x` ``, `[x]`, `'x'`), schema prefixes, aliases, row-value `SET (a, b) = …`, `UPDATE … FROM`, `IS [NOT] DISTINCT FROM` and `ON CONFLICT … DO UPDATE SET` resolve to the real column; a statement it cannot read on a gated table is refused, and so is an `UPDATE` or upsert with a top-level comma anywhere after its `SET` list, or a `name =` before its `WHERE`. A hand-written parser cannot match SQLite's grammar exactly (`RETURNING`, for one, is also a valid column name), so unknown shapes are refused. Writes to other columns and every `SELECT` stay free. (#181)
- **`execute` also gates the archive preconditions, the `sync_github` target and the parent deletes.** The tool now refuses writes to `milestones.status` and `epics.status` (the archive check of `update_milestone` / `update_epic` reads them), to `projects.name` and `projects.repo` (with the already gated `projects.github_*` columns, `sync_github` resolves its owner/repo and board from them), and `DELETE` on `projects`, `milestones` and `epics`. A milestone or epic `DELETE` set `tickets.milestone_id` / `tickets.epic_id` to `NULL` (`ON DELETE SET NULL`); a deleted and re-created project key skipped the `set_project` check that keeps a synced project on its repo. The error names `update_milestone`, `update_epic` or `set_project`. The `execute` tool description now lists the gated columns and these tools. (#263)

## [2.13.0] - 2026-10-12

- 2.12.0 was not published to npm; 2.13.0 contains its changes too.

### Added

- **Rule-based verdict in ASD-STE100 on the dashboard and the site.** Each agent run gets `headline.verdict`: BENEFICIAL, NO CLEAR EFFECT or SUBOPTIMAL per arm vs vanilla, from success change, uncached saved % and its spread, cost saved % and wall time change. SUBOPTIMAL: success drops by more than 5 pp, tokens increase in every repeat, or more than 25 % slower. Fewer than 3 repeats mark the verdict "indicative". Fixed templates make short sentences, e.g. "With guidance, code-context decreases the token use by 28 %." The dashboard shows a chip on the latest cards and a Verdict section in the run detail; the site shows a verdict card, the label in the history and per group on private-suite cards. Older runs and summaries get the verdict computed from the same fields, so no published file changes. Private summaries carry `verdict` per run and group; the shape check accepts only the text the rule makes from the block's numbers. Rule and constants: `scripts/bench/lib/verdict.mts`, documented in BENCHMARK-GUIDE.md "Verdict rule". (#156)
- **Private suite runs in the local dashboard.** `CODE_CONTEXT_BENCH_PRIVATE_DIRS` (path list of suite dirs or their `data/` dirs) merges private runs into the Benchmark page with a **private** chip and the suite alias, plus an All / Public / Private filter. `/api/bench/run/:id?suite=pN` serves them under the same id, index and realpath rules, per dir. The files are read from disk only and sent nowhere. (#154)
- **`bench:publish --private-summary <suite-dir> [--runs id,id]` publishes a redacted summary.** Schema `ccc-bench-private-summary/1` holds only the suite alias, scope counts, and per run and per group: success, uncached tokens per session and per PASS, cost, wall time, uncached saved % with min–max spread and cost saved %. A guard refuses the summary on any suite name, path, commit, task id, prompt token, answer item, hash, absolute path or secret, and names only the JSON path. Only `data/private/<alias-slug>.json` and `data/private/index.json` are written, through the usual temp worktree; `--dry-run` prints the summary. Full private runs stay refused. New optional suite fields: `alias`, `groups`, `tasks[].group`, `groupByPrefix`, `publicTaskIds`. The site shows each summary as a "Real-world private suite" card with the caption that task texts and code are private. (#154)
- **`bench:live --suite <dir>` runs private suites from outside the repository.** A suite (`suite.json`, schema `ccc-bench-suite/1`, plus `answers.json`) pins local git clones by commit; each session workspace comes from `git archive`, so the clone's working tree is never read. New checkers `path-set` and `symbol-set` compare the answer with the suite's answer key. Results go to `<dir>/data/`. A private suite refuses a `--data-dir` inside the repository, its run JSON carries `suite.private: true`, and `bench:publish` refuses such runs. With `redact` (default for private suites), the run JSON stores tasks by id and sha256 only. `npm run bench:suite-check -- <dir>` validates a suite and builds and indexes one workspace without a model. (#149)
- **PHP in the code index.** `.php` files get exports with one-line signatures and lines (class incl. abstract/final/readonly, interface, trait, enum, top-level function and const; short name in `exports.name`, namespace-qualified name in `exports.description`), `use` lines in `import_lines`, and dependency edges from `use` (grouped, aliased, `use function`, `use const`), `extends`, `implements`, trait `use` and class names in code. Names resolve through the nearest `composer.json` PSR-4 maps (`autoload` and `autoload-dev`, also in a subdirectory), then through the indexed declarations; same-namespace classes resolve without `use`. Vendor namespaces are external packages, not edges. Comments, strings, heredoc/nowdoc and inline HTML (Blade) never create exports or edges. `find_symbol` and `who_imports` also take a qualified name (`App\Models\User`). A synthetic 1,501-file PHP tree indexes in about 0.8 s. (#148)

### Fixed

- **tsconfig/jsconfig path aliases make import-graph edges.** `import … from "@/lib/x"` (and `baseUrl` imports such as `components/Button`) now resolve through the nearest `tsconfig.json`/`jsconfig.json`, its `extends` chain (relative and `node_modules` package configs) and, for Vite-style solution configs, the `references` entry whose `include` covers the file. `paths` follow TypeScript's rules (exact key, then longest `*` prefix, targets in order, relative to `baseUrl` or the defining config); files probe like relative imports, incl. `.d.ts` and `.js` → `.ts`. `who_imports`, `exports_in`, `get_file_context` and `search_files` see the new edges, and resolved aliases leave `External packages`. Configs are parsed with comments and trailing commas by a linear scanner, capped at 1 MB, and cached per index run. On a 475-file Vite React SPA: 952 of 952 alias imports resolve, edges 179 → 1,094. A 6,000-file synthetic tree indexes in ~3.1 s instead of ~2.5 s (27,119 edges instead of 8,872). Vite `resolve.alias` is not read. Re-index to get the edges. (#151)
- **`bench:live` timeouts end a session at the limit.** The deadline runs on the wall clock, and SIGTERM then SIGKILL reach the agent's whole process tree; the runner no longer waits on output pipes a leftover process holds. A timed-out session keeps its partial usage. Root cause of the ~900 s sessions: the Mac idle-slept on battery, and the old monotonic timer stopped in sleep. The runner now holds `caffeinate -i` on macOS. (#146)

### Changed

- **The benchmark page opens with one simple table for the latest run.** The dashboard and the site show one row per model (GLM, Opus, DeepSeek) with the verdict chip, success, tokens, cost, speed and repeats in plain words ("25 % less", "23 % faster"), a caption and one result sentence per model. All other views move into one collapsed "Show details" block. (#160)
- **The lowest benchmark verdict is SUBOPTIMAL, and few repeats can show it.** The verdict code and label change from HARMFUL to SUBOPTIMAL; the text says "Result: code-context is suboptimal for these tasks." With fewer than 3 repeats, a token increase of 10 % or more gives SUBOPTIMAL (indicative), e.g. "The token use increases by 12 % in 1 repeat." The dashboard, the site, the index builder and the private-summary check read a stored HARMFUL verdict as SUBOPTIMAL. (#158)
- **`bench:live` retries a failed session once.** A provider error, 0 model calls or a machine sleep during the session gets one retry with a fresh workspace and HOME; the run notes list every retry. The run is void only when the retry fails too. A timeout with model calls stays a model FAIL. (#146)

## [2.12.0] - 2026-10-11

### Highlights

- **Honest benchmark headline.** Agent runs lead with success per arm, uncached tokens saved % with its min–max spread, cost saved % and uncached tokens per PASS. The cache-read-heavy all-tokens total is no longer the headline. (#138)
- **Proof runs on a 683-file fixture (n=5, 2026-10-11):** the server saves 33.7 % uncached tokens with GLM 5.3 and 28.4 % with DeepSeek v4 pro (guided: 47.1 % / 34.7 %; DeepSeek cost −29.1 %), with success equal or better and every repeat above 0. Smaller tasks save less (DeepSeek L1/L4/L6: 16.4 %), and an Opus smoke check on two tasks uses 46 % more. (#139, #144)
- **Lean code toolset with graph tools.** `CODE_CONTEXT_TOOLSETS=code` lists 6 tools; the new `who_imports` and `exports_in` answer import-graph questions in one call. `get_file_context` shows signatures, lines and import lines. The server sends short MCP `instructions`. (#132, #133, #134, #136, #137)
- **Realpaths in the index, project-relative paths in the output.** A symlinked root (macOS `/var/folders` vs `/private/var/folders`) indexes once, and results print `src/…` paths an agent can use as-is. (#131)
- **One-way GitHub sync with authorization.** `sync_github` mirrors one project to GitHub milestones, issues and a Project board. Live writes need an allowlist in the server's environment, touch only objects the sync created or adopted, and refuse texts with local paths or secrets. (#140, #143)

### Upgrade notes

- **Schema v24 → v26** (v25 in #134, v26 in #140). The first start migrates the database. 2.11.0 and older refuse a v26 database, so update every code-context install that shares one `context.db` at the same time. (#134, #140)
- **The `code` toolset has 6 tools** (`find_symbol`, `get_file_context`, `who_imports`, `exports_in`, `search_files`, `query`). Use `CODE_CONTEXT_TOOLSETS=code,code-admin` to get the maintenance tools (`index_directory`, `get_changes`, `execute`, `health`, `set_description`, `set_directory_description`, `set_change_reason`) back. The default profile has 97 tools, `all` 103. (#132, #136, #140)
- **Tool output is project-relative.** Files under the indexed root that holds the server's working directory print as `src/…`. Pass `absolute_paths: true` or set `CODE_CONTEXT_ABSOLUTE_PATHS=1` for absolute paths. (#131)
- **Flair and timestamps are off in the `code` profile.** `OVERDRIVE_FLAIR=1` turns the flair header and footer back on; `CODE_CONTEXT_TIMESTAMPS=1` brings back the `modified` / `indexed` timestamps (now off in every profile). (#137)
- **GitHub sync needs `CODE_CONTEXT_GITHUB_SYNC_REPOS` for live writes.** Without it, only dry runs work. Set it in the environment of the server or CLI process; no tool or flag can set it. (#140)

### Added

- **`who_imports` and `exports_in` answer graph questions in one call.** `who_imports(target)` takes a file path (relative, absolute, old spelling, unique suffix or bare module name) or an exported symbol and lists every importing file with the symbols it takes and its import line numbers. A barrel is flagged `(re-export)`, and the files that import the target through it are listed under "Via re-export". `exports_in(dir, unused?)` lists the exports under a directory with signatures and lines; `unused: true` keeps the ones no indexed file imports. Namespace imports, `export * as`, and dynamic imports or requires without names count as a use of every export, so an imported export is never called unused. Lists stop at 100 importers / 150 exports with `+N more`. Both tools re-check the listed files against the disk before answering. On this repo, `who_imports src/server/schema.ts` matches the bench L4 checker exactly, and `exports_in src/server unused` holds all 46 dead exports of the L6 checker plus 4 names other files only mention in text. (#136)
- **`get_file_context` shows signatures, line numbers and import lines.** Each export reads `L6 function formatDate(date: Date): string` (one line, no body, max 160 chars); a new `Import lines` section lists the file's `import`/`export … from`/`require` (JS/TS) and `import`/`from … import` (Python) statements with line numbers. Lists stop at 40 exports / 30 import lines with `+N more`. Optional `snippet: true` adds each export's source (≤ 20 lines each, ≈ 2 KB total). In bench transcripts 60 % of `get_file_context` calls were followed by a read of the same file. (#134)
- **Schema v25:** `exports.signature`, `exports.line`, `files.import_lines`. Existing databases gain the columns on open; a row indexed before v25 is re-indexed on its first `get_file_context` call, else it renders as before. (#134)
- **The server sends MCP `instructions`** (about 370 characters, about 90 tokens): "Code index of this project; prefer it to grep. Who imports X: who_imports. Where is S defined: find_symbol. What a file exports or imports: get_file_context. What dir D exports or leaves unused: exports_in. Results never hold full code: read the file for that. get_file_context gives signatures and import lines, snippet:true short bodies. Paths are project-relative." Only tools the active profile lists are named; the path sentence drops with `CODE_CONTEXT_ABSOLUTE_PATHS=1`. A test pins the length (≤ 400 characters). (#137)
- `CODE_CONTEXT_TIMESTAMPS=1` puts the `modified …` / `indexed …` timestamps back into `find_symbol`, `get_file_context` and `search_files`. (#137)
- **`sync_github` mirrors one project to GitHub.** It creates or updates the GitHub milestone and one issue per ticket: title `<ticket_ref>: <title>`, body with `## Why` and `## Done when`, labels `P0`–`P2`, one type label and `ai_issue` (or `issue` for `origin: "human"`), the owner as assignee. It adds each issue to the GitHub Project and sets Status: DONE → Done (issue closed), review pending → In review, IN_PROGRESS → In progress, TODO in an open sprint → Ready, else Backlog. Idempotent through the stored issue number: a rerun with no local change makes no write. It never sends tickets of another project, ambiguous tickets or issues of another repo. `dry_run: true` prints the plan; `offline: true` adds no GitHub call. Labels the sync does not own stay. Same sync as a CLI: `code-context-sync-github` (`--dry-run` runs on an in-memory copy of the db and never writes the file). (#140)
- **Rate limits:** one sync reads GitHub about twice (1 REST milestone list, 1 GraphQL call per 50 linked issues that returns the issues, their board items and Status). Project and Status option ids are cached in the `projects` row. Board adds and Status changes go as aliased GraphQL mutations, 20 per request; new issues are paced 1 s apart; a plan above `max_writes` (default 100) is refused before any write. The `gh` CLI holds the token; nothing reads or stores it. (#140)
- **Adopt step for hand-made issues and milestones.** `sync_github adopt: [N…]` / CLI `--adopt 116-128` takes over an unmarked issue only on a live, allowlisted run, only when exactly one ticket of the project links it and its GitHub title starts with `<ticket_ref>:`; the run writes the marker. Milestones: `adopt_milestones: [{milestone_id, github_milestone}]` / CLI `--milestone <id>=<N>`. Dry runs show `~ adopt` and write nothing. The marker check reuses the body of the existing GraphQL read: a no-change sync of 13 issues still costs 2 gh calls, and adopting 13 issues adds no read. (#143)
- **Project key.** `set_project` maps a key to a repo (`owner/name`), a Project number and an assignee. `create_*` / `update_*` for milestones, sprints, epics and tickets take `project`; an unknown key is refused. A ticket without its own key inherits it from its sprint, milestone or epic. `list_tickets`, `list_sprints`, `list_milestones` and `list_epics` filter by `project`. `create_ticket` / `update_ticket` take `type` (`feat`, `fix`, `chore`, `infra`, `improvement`) and `origin` (`ai`, `human`); `update_ticket` takes `github_issue`, `update_milestone` takes `github_milestone`. (#140)
- **Schema v26:** table `projects`; `project` on `milestones`, `sprints`, `epics`, `tickets`; `tickets.type`, `origin`, `github_issue`, `github_repo`; `milestones.github_milestone`; `tickets.github_node_id`, `milestones.github_node_id`. Existing rows keep `project = NULL` (never guessed). On the upgrade, tickets whose notes hold `GitHub: owner/repo#N` get `github_issue = N` once. An older server refuses a v26 db, so update every code-context install that shares the db. (#140, #143)
- **Honest benchmark headline.** Agent runs lead with success per arm, uncached tokens saved % (`input + output + cache_write`), cost saved % (`null` when a cost is unknown) and uncached tokens per PASS per arm. The uncached saved % carries its min–max spread over repeats. Per-task rows carry the paired delta vs vanilla (repeat k against repeat k) with min–max. The all-tokens saved % stays in the run JSON for old consumers; the site and dashboard show it in the run detail only. Reason: the total was mostly cache-read volume, billed at about 1 % of input. (#138)
- **`npm run bench:renormalize -- --out <dir> <run.json…>`** recomputes `aggregate` and `headline` of saved agent runs from their sessions. No API calls; never writes over an input file. `bench:rescore` recomputes the same fields after a verdict changes. (#138)
- **`npm run bench:rescore -- --run <run.json> [--artefacts <dir>] [--out <dir>]`** re-checks saved final answers with zero API calls and writes a corrected run file; edit tasks (L3, L5) keep their recorded result. For L4/L6 it rebuilds `src/` from the run's git commit; it reproduced every recorded L6 result. (#130)
- **Large bench fixture and index-shaped live tasks I1–I6.** A seeded generator writes a 683-file TypeScript codebase (597k characters, 20 domains with barrels, type-only and dynamic imports, import cycles, dead exports and grep decoys) into each session workspace; `copyFixture('large')` refuses a tree whose sha256 differs from `scripts/bench/live/large-fixture/answers.json`. The answers come from the TypeScript compiler API, never from code-context, and are pinned in the same file. Tasks: direct importers of two modules (one also re-exported by a barrel), importers of a symbol through a barrel, unused exports of a folder, where a symbol is declared, and two-hop dependents. Prompts name no tools. `npm run bench:dry` checks, without a model, that the server's `who_imports`, `exports_in` and `find_symbol` return the pinned answers: 6 of 6 do. (#139)
- **`bench:live --cache-mode cold-warm`:** repeat 1 per task and arm is cold (new nonce, fresh index, strict first-call cache check; for cc arms the index build time counts in `wall_ms` and is stored as `index_ms`), repeats 2…N are warm (same nonce and paths, the repeat-1 index is reused, provider prompt caching allowed). The run JSON gets `aggregate.by_phase` and the dashboard run detail a "Cold vs warm" table. The default `--cache-mode cold` output is byte-identical to before. First result: index build is 39–71 ms, and cost per arm stays within 4 % in both phases (`dsk-20261011-090622`). (#129)

### Changed

- **`CODE_CONTEXT_TOOLSETS=code` lists 6 tools, not 11:** `find_symbol`, `get_file_context`, `search_files`, `query` (#132) and `who_imports`, `exports_in` (#136). `code,code-admin` adds the 7 maintenance tools back. `tools/list` went from 5,888 to 1,881 characters with the 4-tool set (about 1,500 to 500 tokens per model call) and is 3,326 characters with all 6 (bound 3,400, pinned by a test). Default profile and `all` keep their tools; with the new tools the default profile has 97 and `all` 103. The bench `cc-guided` prompt names `who_imports`. (#132, #136, #140)
- **Code tool descriptions lead with the question they answer** and drop the freshness boilerplate. The freshness check itself does not change. (#132)
- **Tool results print project-relative paths.** `find_symbol`, `get_file_context`, `search_files`, `get_changes` and `set_description` show `src/utils/helpers.ts` for files under the indexed root that holds the server's working directory (or under the working directory, when it sits above the indexed roots). Files of other repos in a shared database stay absolute, so a relative path is never ambiguous. `absolute_paths: true` or `CODE_CONTEXT_ABSOLUTE_PATHS=1` restores absolute output. (#131)
- **`query` describes and bounds itself.** The description lists the columns of `files`, `exports` and `dependencies` and the two common joins (the `code` profile `tools/list` grew from 1,881 to 2,376 characters). `PRAGMA table_info(<table>)` and `PRAGMA table_list` run; other PRAGMAs stay rejected, and the message says what is allowed instead of pointing at `execute`. Output stops at 50 rows or about 8 KB, cells at 1,000 characters, each with a note on how to narrow. `files.content` leaves only when the SELECT list names it, so `SELECT * FROM files` no longer returns whole files. Guessed column names get a pointer to the schema. (#133)
- `query` lists the schema v25 columns; the `absolute_paths` parameter description is shorter. (#134)
- **Compact model-facing results.** Under `CODE_CONTEXT_TOOLSETS=code` the flair header and footer are off by default; `OVERDRIVE_FLAIR=1` turns them on. The default profile keeps flair on (`OVERDRIVE_FLAIR=0` still turns it off). `find_symbol`, `get_file_context` and `search_files` drop the `modified`/`indexed` timestamps in every profile. The read-time freshness check and its `↻ fresh` / `⚠ STALE` notice do not change. A typical `get_file_context` result shrinks by about 115 characters (about 28 tokens): `services/api.ts` of the sample project 673 → 562 characters, `src/server/tool-wrap.ts` 2,209 → 2,092. (#137)
- **`index_directory` prints each directory's stats once.** Before: `typescript modules. 1 file, 167 lines. 1 files, 167 lines.. [{"lang":"typescript","count":1}]`. Now the heading reads `### server/ — 1 file, 167 lines (typescript)` and the description loses its auto-generated stats suffix; bold markers and blank lines are gone. On the sample project the output drops from 176 to 136 tokens (simulated estimate). (#137)
- **The import graph holds re-exports, type imports and dynamic imports.** `export { a } from`, `export * from`, `export * as ns from`, `import type`, `import X, { a } from`, `import('…')` and `require('…')` now create dependency edges; before, the graph of this repo's `src/` missed 84 importer edges, mostly barrels; now it misses 1 (a file the index skips for size). Two statements to the same file merge their symbols into the one edge. Re-exports read `export a`, `export a as b` or `export *` in the symbols. Existing databases gain the edges on the next full re-index. (#136)
- **The simulated benchmarks print what the real tools print.** One shared formatter (`test/helpers/benchmark-fixture.ts`) mirrors `get_file_context` (project-relative paths, #134 signatures and import lines), `find_symbol` and `search_files`; a test compares it with the real tools over MCP stdio, byte for byte since #137. The vanilla arm and the token-efficiency "old" format print fixed absolute paths, so no number depends on the checkout path any more. Measured on 2026-10-11, the numbers first drop: 10-task simulated savings 46.3 % → 33.1 %, stochastic aggregate 54.2 % → 41.3 % (per-trial 95 % CI [20.4, 49.0] → [0.3, 35.2]), token-efficiency old → new format 21.0 % → 10.7 %. Two causes weigh about the same: the longer #134 output (alone: 46.3 % → 40.5 %) and the 5 correct import edges of the sample project, was 3 (alone: 46.3 % → 37.6 %). (#136)
- **Simulated benchmark numbers rise again** because the simulated outputs mirror the compact results (no timestamps, compact `index_directory`): 10-task simulated savings 33.1 % → 43.7 %; stochastic aggregate 41.3 % → 50.1 %, per-trial 95 % CI [0.3, 35.2] → [19.6, 45.9]; token-efficiency old → new format 10.7 % → 21.9 %. Test floors sit just under these values. (#137)
- **Published simulated numbers regenerated** with `npm run bench` on current main: 10-task savings 44.9 % → 43.7 % (`benchmark-results.json`; README and readme kit showed 46.3 %), calls saved 27.9 % (same), stochastic MCP wins 90.5 % → 92.5 %, aggregate 49.7 % → 50.1 %, per-trial 95 % CI [17.9, 44.9] → [19.6, 45.9], r 0.953 → 0.955. Updated: README, `benchmark-results.json`, `benchmark-stochastic-results.json`, `brand/readme-kit.json`, `assets/readme/alt-v3.json`, site demo data, BENCHMARK-GUIDE.md; every figure is labelled simulated. The stats and bench SVG panels follow in the 2.12.0 re-cut. (#144)
- **README shows the proof runs, not the earlier agent bullets.** One table, one row per model and task set (GLM 5.3 I1–I6 n=5, DeepSeek v4 pro I1–I6 n=5 and L1/L4/L6 n=3, Opus L1/I1 n=2, all 2026-10-11, rescored and renormalized): success per arm, uncached tokens saved % with min … max over repeats, cost saved % where known, uncached tokens per PASS. On the large fixture GLM saves 33.7 % (cc) and 47.1 % (guided) uncached tokens and DeepSeek 28.4 % / 34.7 % (cost 29.1 % / 34.5 %), with every repeat above 0; DeepSeek on L1/L4/L6 16.4 % / 7.3 %; Opus on two tasks uses 46 % more. Caveats are in two lines under the table. (#144)
- **Opus bench sessions keep prompt caching on, cold and warm.** `DISABLE_PROMPT_CACHING` is gone from every opus session. A cold session is fresh by its new HOME, empty `CLAUDE_CONFIG_DIR`, new workspace path and a per-session nonce as the first line of `--append-system-prompt` (every arm; cc-guided adds its rule after it). A first-call cache read of Claude Code's static prefix is now legitimate, so opus no longer aborts on it (`strictCache: false`, as GLM); the run notes give the first-call total. Cache writes (`cache_creation_input_tokens`) count as the cold cost. Cost stays the result event's `total_cost_usd`; the run notes say the overhead is priced at cache-read rates after the call that wrote it. Reason: the 2.9.0 Opus runs had caching off and all 93 tools, so 65 % of L6 input was tool definitions (cc $1.04 vs vanilla $0.24, 0 MCP calls), about 10× what a real session pays. Opus runs from before this change are not comparable. (#141)
- Every opus cc arm runs `CODE_CONTEXT_TOOLSETS=code`; a test starts the server with the generated `--mcp-config` env and checks it lists only the 6 code tools. (#141)
- `bench:live --arms vanilla,cc[,cc-guided]` picks the arms (vanilla and cc required). BENCHMARK-GUIDE.md has a cheap Opus check: L1 + I1, cold-warm, 2 repeats, 8 sessions. The session console line shows cache writes. (#141)
- **`bench:live` runs the smoke set (L1, L2) plus the index-shaped set (I1–I6) by default**, was L1, L2. `--tasks` takes the set names `smoke`, `index`, `ladder` and `default`, alone or mixed with ids. L5 (a rename, the same grep-and-edit work in every arm) left the ladder (now L1, L3, L4, L6) and runs by id only. (#139)
- `data/index.json` derives the new headline fields from the sessions of an agent run that lacks them; recorded fields are never overwritten. (#138)
- The site's per-task table shows uncached tokens per arm and the paired delta vs vanilla with min … max; success shows as a rate over repeats. (#138)
- Vendored skills (`vendor/skills/`) and the generated frontend skill defaults synced from claude_development_skills `main`. (#135)

### Fixed

- **The index stores realpaths.** A symlinked root and its target index identically, one row per file. On macOS `os.tmpdir()` is `/var/folders/…` (a symlink to `/private/var/folders/…`); agents resolve their cwd to the realpath and refused every path copied from a result as outside the workspace. Rows an older version stored under the symlinked spelling move to the realpath at server boot and on the next `index_directory`, with descriptions and change history. Tools accept the relative form, the realpath and the old spelling. `index_directory` accepts either spelling of an allowed root. (#131)
- `export { a, b }` inside a comment or string no longer creates `re-export` exports: the re-export patterns match only at the start of a line. (#136)
- **L1 and L4 checkers stop failing correct answers.** L1 accepts "no internal / module / local / project imports or dependencies", "leaf module" and "depends on nothing"; Markdown bold no longer breaks matching. L4 judges the answer list, not every path in the text: lines with a narrow negation cue ("excluded", "false positive", "not imported", "unrelated" …) and lists under a negating heading are dropped, and absolute workspace paths map to `src/…`. All 4 L1 fails and all 3 GLM vanilla L4 fails of the four runs before were correct answers. Regression tests use the 7 real answers. (#130)
- **L1 checker accepts "doesn't import anything." and "no file dependencies".** The old pattern needed a space after "anything", so a claim at the end of a sentence failed, and "no file dependencies" was not a listed form. The Opus proof run `opus-20261011-134112` cc-L1-r2 failed only for this; rescored, Opus cc goes 3/4 → 4/4. "Does not depend on src/types.ts" still fails ("on" alone no longer counts). Regression fixture: `test/fixtures/bench/cca-12-false-negatives.json`. (#144)

### Security

- **Live GitHub writes need `CODE_CONTEXT_GITHUB_SYNC_REPOS`.** A live `sync_github` or `code-context-sync-github` run writes only to the exact targets in this env var of the server or CLI process; no MCP tool or CLI flag sets it, so a prompt-injected agent cannot point a project at another repo or board and publish there. `owner/repo` allows issues and milestones only; `owner/repo@board-owner/N` also allows that one Project board, never another board of the same owner. The assignee must be the repo owner or a login in `CODE_CONTEXT_GITHUB_SYNC_ASSIGNEES`. Only the fixed label set is sent. A live run resolves the Project id from the allowed board and never trusts the cached id. Dry runs need nothing. `set_project` refuses to change the repo or board of a project that already synced, unless `force: true` and the new target is allowlisted. The path guard normalizes encodings (`file://`, percent, HTML entities, escaped slashes, `C:/Users/…`) on its own and refuses any local path outside an http(s) URL path; the scrubber handles the same forms. (#140)
- **No local paths reach GitHub.** Titles, bodies and milestone texts lose `/Users/…`, `/home/…`, `/var/folders/…`, `/private/…`, `/tmp/…`, `/Volumes/…` and `C:\Users\…` paths (`…/<last segment>` stays); a text that still holds one is refused. The scrubber and the guard split tokens at the same characters, so `,` `*` `|` `{}` neighbours cannot hide a path from the guard. (#140)
- **No secrets reach GitHub.** A ticket title, description, acceptance criterion or milestone text that holds a secret is refused, never scrubbed; the message names the field and the secret type, never the value. Detected: GitHub, Anthropic, OpenAI, AWS (key id and secret), Slack (token and webhook), Google and Stripe keys, JWTs, PEM private keys, `Authorization: Bearer|Basic`, passwords in URLs, `.env`-style `*_KEY=` / `*_SECRET=` / `*_TOKEN=` / `*_PASSWORD=` lines, and `key/secret/token/password = <16+ key-like chars>`. The check runs on the raw text and on a decoded copy (percent, HTML entities, escapes, invisible characters, markdown marks). Words like "token", issue numbers, git SHAs, UUIDs and run ids like `dsk-20261011-090622` pass. (#140)
- **`sync_github` writes only issues and milestones it created.** Each created issue body ends with `<!-- code-context-sync: project=<project> ticket=<ticket_ref> -->`, each created milestone description with `<!-- code-context-sync: project=<project> milestone=<local id> -->`. A live run updates, closes, relabels, assigns or moves on the board only an issue whose current body carries the marker of the same project and ticket; an unmarked issue or one with another project's or ticket's marker is skipped with a plan note. Milestones work the same and are never linked by title. Reason: `update_ticket github_issue=N`, `update_milestone github_milestone=N` or `execute` could point a ticket at any issue of an allowlisted repo, and the next sync overwrote it. (#143) Note added for #181: `execute` can no longer write the `github_*` columns; use `update_ticket`, `update_milestone` or `sync_github`.
- **Ownership does not rest on the marker alone.** A live run writes an existing issue or milestone only when, in the same read: its marker names this project and ticket (or local milestone), the authenticated `gh` user created it (issue author / milestone creator = GraphQL `viewer`), and its node id matches the one the db recorded at create or adopt time (columns `tickets.github_node_id`, `milestones.github_node_id`; objects synced before get it recorded on their first verified run). Reason: on a public repo anyone can open an issue and paste the marker; a ticket pointed at it (`update_ticket github_issue=N`, `execute`) made the sync edit, assign, label and board that stranger's issue. Note added for #181: the `execute` path is closed. Adopt needs the `gh` user as author too. `update_ticket github_issue` and `update_milestone github_milestone` clear the recorded node id. (#143)
- **Fail closed on anything the read cannot verify.** A stored number the live read did not return, returned for another repo (transfer), with another number or without a node id, a read without viewer login, two tickets (or two local milestones) linking one object: skipped with a note, never written. Before this, an issue missing from the GraphQL result fell into the offline branch and got a full unverified update. The milestone list reads every page (refused past 1,000 milestones) instead of the first 100; an issue with more labels than one read returns keeps its labels. A live run refuses any update whose ownership this run's read did not verify, and never applies an offline plan. A no-change sync of 13 issues still costs 2 gh calls. (#143)
- **One gate for the MCP tool, the CLI and the engine.** `syncGithub` checks the request (`offline` needs `dry_run`, positive `max_writes`, at most 500 adopt issues and 100 milestone mappings), the allowlist (`liveSyncGate`, which the CLI also uses for its rollback), board, assignee and every ownership and adopt rule. Before, the MCP tool ran `offline: true` without `dry_run` as a live run, and the CLI stored a `--milestone <id>=<N>` mapping before the engine decided on it. Milestone adopt now has the same bar as an issue adopt: created by the `gh` user, unmarked, linked by no other local milestone, GitHub title equal to the local name. A test runs one matrix through all three entry points and expects the same writes and db state. (#143)

## [2.11.0] - 2026-10-11

### Added

- **Dashboard Benchmark page shows real ccc-bench runs:** the latest run per kind with its date and age, the run list, and per-task detail. New `/api/bench/index` and `/api/bench/run/:id` read from `CODE_CONTEXT_BENCH_DIR`, then `<db dir>/bench/`, then `origin/bench-results` in the package's own git checkout; otherwise an explicit empty state. The June simulated data stays as a "Simulated (2026-06)" tab. (#114)
- **`CODE_CONTEXT_TOOLSETS=code`**: a profile that lists only the 11 code-index tools (`index_directory`, `find_symbol`, `get_file_context`, `search_files`, `get_changes`, `query`, `execute`, `health`, `set_description`, `set_directory_description`, `set_change_reason`). Tool definitions drop from about 12,300 to about 1,300 tokens per model call. For sessions that read code but never run the sprint process. `all` still wins. The default does not change. (#109)
- **Fair benchmark arms:** task prompts name no tools, a third `cc-guided` arm adds the "use code-context first" rule to the system prompt, both code-context arms run `CODE_CONTEXT_TOOLSETS=code`, and sessions record the cost the CLI reports. (#111)

### Changed

- `bench:publish` copies the merged `data/` to `CODE_CONTEXT_BENCH_DIR` when set (never in Actions), so the dashboard gets new runs without a manual copy. (#114)
- README token claim quotes the fair agent runs; the 46.3 % figure is labelled as simulated in the stats and bench panels. The site notes that agent runs before 2026-10-11 used grep-steering prompts. (#113)

### Fixed

- **Repo-relative paths work.** `get_file_context` and `set_description` accept `src/server/schema.ts` as well as absolute paths: relative to the server's working directory first, then a unique suffix match in the index. With several repos in one database, the match under the working directory wins, otherwise the tool lists the candidates. Before, a relative path answered "not in index", and agents fell back to grep. (#109)
- A provider error or a session with 0 model calls voids a live benchmark run: no run file, the artefacts stay for diagnosis. (#112)
- The dashboard build clears old hashed chunks in `dist/dashboard/assets`; the 2.10.0 pack held three copies of each. (#110)

## [2.10.0] - 2026-10-11

### Added

- **Benchmark task ladder S → XL** on the sample project and on this repo's `src/`; prompts state exactly what counts, and the checker uses the same whole-word rule. (#105)
- **Fresh agent sessions and an Opus provider** for agent benchmarks; cache reads count as tokens; a run fails when the model changes mid-run, and the agent prompt is recorded. (#102)
- `docs/CLAUDE-PROJECT.md`: steps and paste-ready instructions for a Claude project about this repo. Not part of the docs site or the npm package. (#104)

### Changed

- **Dashboard in the D-41 look:** Inter and Space Mono bundled with the app (Geist from a CDN removed), Space Mono logo, headings and upper-case nav labels, a 32 px grid, white pill for primary actions, card radius 24, and the literal palette mapped to the token values. (#107)
- **Benchmark site** serves Inter and Space Mono from `site/assets/fonts`; still no third-party request. (#107)
- Agent benchmarks run locally; Actions skips them when secrets are missing. (#101)

### Fixed

- Claude token totals come from the result event. (#106)
- Local `bench:publish` starts the Pages build. (#103)
- Every regex metacharacter is escaped in `wordRe` (CodeQL). (#105)

## [2.9.0] - 2026-10-10

### Added

- **On-demand benchmarks.** `npm run bench` (simulated, no model), `npm run bench:live` (an OpenCode agent with and without code-context) and `npm run bench:publish`. A new `Benchmark` workflow (`workflow_dispatch`, inputs `kind` and `provider`) pushes runs to `bench-results`, which rebuilds Pages. A guard test fails when a workflow gets a `schedule:` trigger. (#94)
- **Benchmark site in the flagship look:** indigo tokens, dark and light theme, latest run first, full history, a brand hero and section dividers. (#94, #95)

### Changed

- **Dashboard accent is indigo** (`--accent: #818cf8`, new `--accent-fill: #6366f1`). Green (`--green`) now means status only: done, passed, verified, on track, saved, live. The legacy `dashboard.html` keeps its own tokens. (#96)
- README benchmark numbers come from the clean run `sim-20261010-203937`. (#98)
- CI: tests take OS-assigned ports; artifact actions run on Node 24. (#99)

### Fixed

- The benchmark records the git state before the simulated tests run, so a run is no longer marked dirty by its own files. (#97)

### Security

- The live benchmark agent runs in a sandbox: one preparation path for every arm, no shell, no web, no access outside its workspace. A `run_id` must match `^[a-z0-9][a-z0-9-]{0,80}$`. (#94)

## [2.8.0] - 2026-10-09

### Fixed

- **Skill sync follows the claude_development_skills 0.7.0 layout.** Upstream moved the commit and PR skills from `skills/workflow/` to `skills/core/`. The runtime sync skipped a missing set without a word, so after the upstream `v0.7.0` tag the `wf:` rows would have frozen at 0.6.0. The `workflow` set now reads `skills/core/` (names stay `wf:write-commit-messages` etc.; the set also brings `wf:set-up-stack-profile`, `wf:extend-skillset`, `wf:audit-toolchain`, `wf:audit-security`).
- `scripts/sync-skills.mjs` vendors only the catalogues `skill-set-registry.json` names (upstream now ships eight).
- The commit contract reads the first sentence of the subject paragraph, so re-wrapped markdown no longer cuts the rule. The body line stays "exactly three labeled bullet groups": the QA commit gate (`COMMIT_BODY_LABELS`) enforces all three. The workflow playbook heading is "Core Skills".

### Added

- **Python symbols and import edges in the indexer** (`src/server/indexer.ts`, regex-based like the JS/TS parsers, no new dependencies). `.py`/`.pyi` files now get rows in `exports` and edges in `dependencies`, so `find_symbol` and the dependency graph work for Python repos.
  - **Exports:** module-level `def`/`async def` (`function`), `class` (`class`) and `UPPER_CASE =` constants (`const`), with the first line of the symbol's docstring as description. `_`-prefixed names are skipped unless listed in `__all__`. `__all__ = [...]`/`(...)` filters the list and adds unknown listed names as `re-export`. Symbols inside module-level triple-quoted strings are ignored.
  - **Imports:** `import a.b.c`, `import a.b as x`, comma lists, `from .mod import x, y as z`, parenthesised multi-line `from` imports and `from . import mod` (relative sources keep their leading dots), at module level and inside functions.
  - **Resolution:** relative sources go up one directory per extra dot; absolute ones are tried from the repo root and `root/src`; candidates are `<path>.py` then `<path>/__init__.py`, always contained in the indexed root (`isPathInside`). Unresolved absolute imports (stdlib, third-party) land in `external_imports` as their top-level package. JS/TS behaviour is unchanged.
  - `search_files` summaries and auto-generated file descriptions now include Python exports/imports.

## [2.7.0] - 2026-10-09

### Added

- **Archive milestones and epics** — finished milestones and epics no longer stay on the dashboard forever. Same model as sprint archiving: archive state is separate from status and from soft-delete, the server enforces eligibility, and every change writes one `event_log` row (`field_name = 'archived_at'`, actor `mcp` or `dashboard`).
  - **MCP:** `update_milestone` and `update_epic` take `archived: true | false` and `force: boolean`. Only `completed` rows archive unless `force: true`. `status: "completed"` and `archived: true` work in one call; a rejected archive rolls back the whole call. Re-archiving keeps the first timestamp.
  - **MCP:** new `list_milestones` tool (`status`, `include_archived`, `compact`). `list_milestones` and `list_epics` hide archived rows unless `include_archived: true`, and mark them `(archived)` when shown. `get_resume_state` and `load_phase_context` ignore force-archived planned/active work.
  - **Dashboard:** `POST /api/milestone/:id/archive|unarchive` and `POST /api/epic/:id/archive|unarchive` (completed only, `400` otherwise, `404` for missing or deleted rows). The routes sit behind the existing Host (`421`), Origin (`403`) and bearer-token (`401`) gates.
  - **Dashboard UI:** the Planning page lists milestones as Active, Completed (with **Archive**) and a collapsed **Archived** section (with **Unarchive**), and now shows epics with the same sections. Milestone and epic pickers skip archived rows unless one is already selected.

### Changed

- **Schema v24** — `milestones.archived_at` and `epics.archived_at` (`TEXT DEFAULT NULL`, indexed). The migration is additive and idempotent; existing rows stay unarchived. A DB migrated to v24 is refused by 2.6.x and older (downgrade guard), so update every install that shares one `context.db` together.

## [2.6.0] - 2026-10-09

- 2.6.0 has no git tag and was not published to npm; 2.7.0 contains its changes too.

### Added

- **Read-time freshness guard** (`src/server/freshness.ts`). `search_files`, `find_symbol` and `get_file_context` stat every row before answering: size or mtime differ from what was indexed → the file is re-indexed (exports, deps, change log); gone → dropped; the query then re-runs. Every row shows `indexed <ts>`. `get_file_context` on a file inside an indexed repo that is not in the index yet indexes it on the fly (unless denied or git-ignored).
- **Per-repo HEAD check.** `index_directory` records the commit it indexed in the new `indexed_repos` table. At most every 2 s, each repo's HEAD is read straight from `.git` (no process spawn); when it moved, the files `git diff --name-only <old>..HEAD` lists are re-indexed and the response leads with one `⚠ STALE <repo>: HEAD a→b — re-indexed N changed files` line. Over 500 files (or an unknown old commit) it does not block: the warning repeats on every call until `code-context-reindex.sh <repo>` runs.
- **`code-context-reindex` CLI** (`dist/server/reindex-cli.js`): re-indexes every git repo under `--root` (default `~/Desktop/Workspace/dev`) or the repos given, skips dot-dirs and repos with a `.code-context-ignore` file (purging their rows), purges rows the ignore policy now denies, `--prune-missing` drops repos/files gone from disk, `--vacuum` compacts. Prints before/after files, dependency share, repos covered and db size; exit 0 = all indexed, 1 = a repo failed, 2 = bad usage.
- **Toolsets.** `CODE_CONTEXT_TOOLSETS` (comma list, or `all`) enables optional tool groups; by default `fun` (`record_mood`, `get_mood_trends`, `generate_vision_animation`) and `stream` (`send_step_progress`, `send_claude_output`, `send_claude_step`) are not registered — 92 instead of 98 tools in every session's context. Tables, dashboard and HTTP API are untouched.
- **Overdrive flair** (FLAIR.md) through one wrapper at registration (`src/server/tool-wrap.ts`): text responses get one `● code-context ▸ <tool> ░▒▓` header and one `<kaomoji> <ms> ms` footer; JSON responses get none; errors keep their text first with a fail kaomoji; `OVERDRIVE_FLAIR=0` turns it off. Each finished call writes `done <tool> in N ms` to the session log.

### Changed

- **Indexer honours `.gitignore` the way git does.** Inside a git work tree files come from `git ls-files --cached --others --exclude-standard` (nested `.gitignore`, `info/exclude`, global excludes; submodules and nested checkouts recursed with their own rules); outside git the old walk remains. Rows a `.gitignore` now excludes are pruned on the next index.
- **Hard deny on top** (`src/server/index-policy.ts`, indexer only — the watcher policy in `src/shared/ignore.ts` is unchanged, so watcher ⊇ indexer still holds): lockfiles, `*.min.js`/`*.min.css`, source maps, more binary types, NUL-byte sniffing, a 512 KB size cap (`CODE_CONTEXT_MAX_FILE_KB`, was 5 MB), and Laravel `storage/` wherever an `artisan` file sits next to it.
- Change-log snapshots are scoped to the indexed root instead of reading every stored file's content twice per run; directory stats reuse the line counts from phase 1.
- `busy_timeout = 5000` on the server connection, so a read-time refresh waits for a running reindex instead of failing.

### Measured (shared db, 2026-10-09)

- Files 26 749 → 16 388; node_modules/vendor 19 085 (71.3 %) → 0; repos covered under `~/Desktop/Workspace/dev` 9 → 19; db + WAL 411.7 MB → 155 MB after VACUUM; full reindex of 19 repos 8 s.
- `search_files` p50 on the same post-reindex data 0.95 → 1.08 ms (+14 %, 5×400 calls alternating); on the old data +7 %.

## [2.5.1] - 2026-10-09

### Security

- **Session log refuses anything but a regular file** (overdrive contract rule 2). `src/sessionlog.ts` now opens the log with `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK` (mode `0600`) and checks the open handle with `fstat` before its one write. A symlink planted at the log path no longer redirects the append into its target; a directory or fifo at the log path gets nothing written and never blocks. Errors stay swallowed. On a platform without `O_NOFOLLOW` the helper writes nothing.

## [2.5.0] - 2026-10-09

- 2.5.0 has a git tag and a GitHub release but is not on npm; 2.5.1 contains its changes too.

### Added

- **Overdrive session log** — the MCP server and the dashboard append one-line breadcrumbs to the shared per-session log `${OVERDRIVE_SESSION_LOG_DIR:-~/.claude/.local_ai_setup_logs/sessions}/<CLAUDE_CODE_SESSION_ID>.log` (`_nosession-YYYY-MM-DD.log` without a session id), in the overdrive contract format `<ts>\t<LEVEL>\tcode-context@<version>\tpid=<pid>\t<message>`. New helper `src/sessionlog.ts` (node stdlib only): one `O_APPEND` write per line, dir `0700` / file `0600`, every error swallowed, never prints (stdout is the MCP transport), `OVERDRIVE_SESSION_LOG=0` turns it off.
  - `INFO` — server and dashboard start (version, port, db basename), sprint phase transitions, ticket status changes, discovery/sprint archive counts, `index_directory` runs (file count, duration).
  - `WARN` — advisory gate warnings from `advance_sprint` / `update_sprint` (counts), gate-blocked ticket edits (ticket id + rule), planning-gate blocks (counts), rejected dashboard requests (401/403/421, never the token or query string; at most one line per status+path per minute, with a `suppressed=<n>` count), dashboard routes that throw a 4xx error (status + error class), schema migrations applied.
  - `CRITICAL` — exceptions escaping any MCP tool handler, dashboard routes failing with a 5xx (error class only), DB open/migration failure.
  - Only ids, counts, phases and durations are logged — never titles, descriptions, retro text, file contents, the dashboard token or SQL values. Read paths stay silent.
- The test suite runs with `OVERDRIVE_SESSION_LOG=0` so it never writes into a real session log.

## [2.4.2] - 2026-10-07

### Fixed

- The file watcher skips CocoaPods `Pods/` directories. (#73)

### Changed

- Vendored skills re-synced from upstream `main`. (#74)

## [2.4.1] - 2026-10-07

### Security

- **Dashboard DNS-rebinding guard** — every request must carry a `localhost`/`127.0.0.1`/`[::1]` Host on the listening port (else `421`), and writes from a non-loopback `Origin` get `403`. Before, a hostile page that rebound its hostname to 127.0.0.1 could read the token injected into `/` and queue `/api/bridge/actions`, which the PreToolUse hook feeds into the agent. The no-op `requireLocalAccess` gate is gone (the server only binds 127.0.0.1).
- **Skill auto-sync is opt-in** — the MCP server no longer pulls the latest upstream skills release into agent prompts on every boot; set `CODE_CONTEXT_SKILLS_AUTOSYNC=1` to enable it.
- **`setup` adds `context.db*` to the project `.gitignore`** — the index stores the full content of indexed files.
- **Dependencies** — `@modelcontextprotocol/sdk` → ^1.32.0, `npm audit` clean; Remotion and `gemma-brain` move to devDependencies, so installs no longer pull them.

### Fixed

- Downgrade-guard errors told users to install `code-context-mcp`, a different package; they now name `vlm-code-context-mcp`.
- The MCP server reported version `1.0.0`; it now reads `package.json`.
- `/health` crashed into its fallback on `require is not defined` (ESM) and always reported the build as `unknown`.
- README benchmark is labelled as simulated tasks on a fixture, and the tool counts agree (98).

## [2.4.0] - 2026-09-03

### Added

- **`update_agent` MCP tool** — change a roster agent's `model`, `tools`, `system_prompt`, `name`, `description` or `department` without raw SQL or the dashboard; omitted fields stay unchanged, `null` clears the nullable ones, and the reply names the Task-tool tier the new model routes to. Models are validated against the new single source of truth `KNOWN_AGENT_MODELS` (`src/scrum/agent-model.ts`), which the dashboard's `ALLOWED_AGENT_MODELS` now re-exports, so the server and the dashboard can no longer drift. The sprint-instructions text and the empty-team hint advertised a `create_agent` tool that never existed; they now point at `update_agent` / `reset_agents`.
- **Claude Opus 5 in the model catalog** — `claude-opus-5` is offered by the dashboard picker and accepted everywhere; the QA factory seed moves `claude-opus-4-8` → `claude-opus-5`. `claude-opus-4-8` joins `claude-sonnet-4-6` as a legacy id (rendered and editable, not offered for new picks).

### Fixed

- **A model or provider name in `assigned_to` silently routed to sonnet** — `create_ticket` and `update_ticket` accepted any string on the single-assignee path (only the `agents[]` path validated roles), so a ticket assigned to `"opus"` or `"glm"` found no agent in `buildModelRoutingSection` and got the sonnet fallback with no error anywhere. Both tools now reject an `assigned_to` that is not a roster role (message lists the valid roles and points at `impl:*` tags for the runtime); an empty roster (agentless mode) still accepts anything. (`unknownRosterRole`)

## [2.3.0] - 2026-07-15

### Added

- **Claude Sonnet 5 in the model catalog (Sprint 30)** — factory seeds for the five support roles (`devops`, `security`, `architect`, `team-lead`, `product-owner`) move `claude-sonnet-4-6` → `claude-sonnet-5`; `ALLOWED_AGENT_MODELS` accepts `claude-sonnet-5` (and keeps `claude-sonnet-4-6` so pre-refresh agents stay editable); the dashboard picker offers the current generation (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5) and the agent-create API defaults to the new shared `DEFAULT_AGENT_MODEL`. Seeding never overwrites a non-empty `agents` table, so existing teams are untouched.
- **Fable 5 everywhere in the dashboard** — `AgentCard` and `TeamManagementModal` carried their own model lists that predated the fable tier: fable agents rendered unstyled and the card's inline model dropdown couldn't select `claude-fable-5` at all. All three dashboard model lists are now derived from one source (`lib/constants.ts`: options, colors, short labels, legacy entries), with fable's badge color `#f472b6`. Tier-routing test coverage extends to the full current catalog, tied to `AGENT_DEFAULTS` so the next refresh is covered automatically.

### Fixed

- **`reset_agents` / `reset_skills` crash: "require is not defined" (discovery #33)** — the pre-build check did a lazy CJS `require("child_process")` inside an ESM module; unreachable under vitest (VITEST-skipped), so only live callers crashed. Both functions now share an `ensureFreshBuild` helper using a top-level ESM import, and `resetAgents` re-seeds the `department` column its INSERT used to drop. Guarded by a department-preservation test plus a source tripwire (no `require(` in `defaults.ts`).
- **`--force` backup could silently lose tail writes (discovery #27)** — the rename path skipped the WAL checkpoint that update mode already did, so committed writes still in `context.db-wal` were missing from the backup, and the WAL sibling was renamed to `context.db-wal.bak-<ts>` — a name SQLite never re-pairs. `--force` now checkpoints first (shared `checkpointWalForBackup`, warn-and-continue on corrupt DBs) and names siblings `context.db.bak-<ts>-wal`. Regression test holds a writer with `wal_autocheckpoint=0` across the run and proves the `.bak` alone contains the tail write.
- **Groomed fatal errors on downgrade + backup IO (discoveries #28/#23)** — booting the MCP server or dashboard against a DB from a newer code-context version now prints setup's two-line `ERROR:` and exits 1 **before** the read-write open (new `peekSchemaVersion`), instead of a raw `runMigrations` stack trace — and no longer litters empty `-wal`/`-shm` files next to the refused DB. Setup's pre-migration backup copy failure (disk/permissions) is a groomed "migration aborted, nothing was changed" error instead of a stack trace.
- **Stale `--help` (discovery #29)** — bare `code-context-mcp [path]` is now documented as what it does (full setup on a fresh directory, migrate-and-refresh update mode on an existing `context.db`), `--defaults` and the `--force` backup naming are documented, and the brittle hardcoded tool count is gone.
- **Stale index rows for deleted files (`index_directory` prune)** — the indexer upserted every file it found but never removed rows for files deleted from disk, so `search_files`/`find_symbol` kept returning ghosts until a manual SQL sweep (observed in the wild: a 104-file dead-code purge left 311 ghost file rows, 643 orphaned exports and 154 dangling dependency edges across re-indexes). `indexDirectory` now diffs the scanned path set against stored rows and deletes files and directories that vanished — scoped to the indexed root so indexing a subdirectory never evicts sibling rows, with export/dependency child rows removed explicitly (no reliance on the caller's `foreign_keys` pragma), and pruned files recorded as `delete` events in the changes log (that branch of `diffAndLogChanges` was previously unreachable). Stats gain `prunedFiles`/`prunedDirs`; the `index_directory` summary reports the prune when nonzero. The dashboard file-watcher re-index inherits the fix.

### Security

- **brace-expansion moderate advisory (discovery #32, GHSA-jxxr-4gwj-5jf2)** — lockfile-only `npm audit fix` moves the transitive dev dependency out of the vulnerable 5.0.2–5.0.5 range; root and dashboard-app audits both report zero vulnerabilities.

## [2.2.0] - 2026-06-12

### Added

- **Commit discipline, enforced end-to-end (Sprint 28)** — with the workflow skill set enabled, `load_phase_context({ phase: "implementation", ticket_id })` appends a compact **Commit contract** block (subject convention + the `Why:/What:/How:` body template + trailer note) to the Model-routing directive, derived **live** from the stored `wf:write-commit-messages` skill — edit the skill and the injected contract follows, no second copy. At close, `update_ticket` **refuses `qa_verified: true`** while branch commits referencing the ticket ref lack the three labeled body groups: the ⛔ message names the offending hashes with an amend-vs-squash remediation hint. Zero referencing commits → exempt (docs/process tickets never block); merge commits exempt; missing git/repo/base branch → fail-open skip. (`buildCommitContract`, `checkCommitFormat`)
- **Auto-telemetry on ticket close (Sprint 29, adopts try_next #122)** — `update_ticket` transitioning a ticket to DONE auto-snapshots sprint metrics through the new shared `snapshotSprintMetrics` helper (the `snapshot_sprint_metrics` tool now routes through the same path), `advance_sprint` snapshots at every phase transition, and `update_ticket` accepts **`actual_hours`**, recorded against the ticket's assigned agent via the same column `log_time` writes. Burndown and time reports populate from normal ceremony flow — no manual snapshot ceremony. Telemetry writes are fail-open (`[audit]` to stderr; they can never block or roll back a close).
- **Claude Fable 5 model tier** — `modelToTier` maps `claude-fable*` to the new `fable` tier for subagent routing; `fe-engineer`/`be-engineer`/`developer` defaults move to `claude-fable-5` (QA stays on `claude-opus-4-8`, pinned by test); the dashboard model picker lists Fable 5 as "Most capable".

### Changed

- **tools.ts decomposed (Sprint 27, discovery #16)** — new shared data-access layer `src/scrum/queries.ts` (sprint/ticket lookups deduplicated); the analytics (7 reporting tools) and skills (6 tools) handlers extracted byte-identical into `src/scrum/tools/{analytics,skills}.ts` behind `registerAnalyticsTools`/`registerSkillsTools` — tool surface unchanged. The skill-set registry is single-sourced into `src/scrum/skill-set-registry.json`: the TS server imports it, `compile-skills.mjs` fs-reads it (it runs pre-tsc), and a mutation-verified parity test guards derivation drift between the two readers.
- **dashboard.ts decomposed, slice 1 (Sprint 29, discovery #17)** — the stalled `handlers/` migration revived along its own documented plan: code-intel routes (`handlers/code.ts`) and the full scrum API domain including `PATCH /api/ticket/:id` (`handlers/sprint.ts`) moved out via the registry barrel; `dashboard.ts` drops **2,350 → 1,473 lines** with a byte-identical route surface, pinned by a 76-route golden parity test (`test/dashboard-route-parity.test.ts`, sentinel-404 mechanism, mutation-verified).

### Fixed

- **Silent audit-trail loss around `event_log` writes (Sprint 27)** — 5 bare `catch {}` sites (`update_sprint`, `update_ticket` ×2, `log_bug`, `start_sprint`) now log `[audit] <context>: <error>` to stderr instead of swallowing the failure; the primary mutation still commits, the trail loss becomes visible. Regression-tested including the forced-failure stderr path.

## [2.1.0] - 2026-06-11

### Added

- **Landing + workflow skill sets, served & opt-in (discovery #21)** — the vendored `landing/` (build-landing-page, set-up-seo, set-up-lead-capture, audit-content-quality, audit-copy-compliance) and `workflow/` (write-pull-requests, write-commit-messages) categories are now compiled, seeded, and boot-synced alongside frontend, as `la:*` / `wf:*` skills. Serving is **per-project opt-in**: new **`update_skill_sets`** tool (partial update; missing config = frontend-only, so existing projects are unchanged), `get_skill` refuses disabled sets with an enable hint, `/kickoff` gains **Phase 1b** asking which predefined sets to enable (AskUserQuestion, resume-aware via the new `skill_sets` line in `get_resume_state`). Enabled sets index into implementation phase context: landing rides the Frontend Playbook; workflow injects once per sprint for every implementer.

## [2.0.0] - 2026-06-11

**Process 2.0** — one consolidated release for Sprints 22–24 plus the skill auto-sync and infrastructure work landed the same day (the 1.4.0–1.6.0 entries that briefly existed here were PR-stage versions, never tagged or published).

**Why a major version:** behavior and defaults changed. Several tools now return compact output unless `verbose: true` is passed, `get_file_context` no longer includes change history by default, sprint ceremonies can **refuse** to proceed (planning gates on `start_sprint` / `advance_sprint`, overridable with `acknowledge_open_items`), and the dashboard can no longer set tickets to DONE or `qa_verified` — completion is process-controlled behind the QA gate.

### Added

- **Planning gates that close the retro loop** — try_next retro findings now have a lifecycle (`open`/`adopted`/`dropped`, migration v21). The new **`triage_retro_finding`** tool adopts a finding into a ticket (auto-flagged applied when that ticket lands), drops it with a reason, or defers it for one planning cycle. `start_sprint` **refuses to start** while untriaged try_next findings or escalated open discoveries (P0/P1 older than 3 sprints) exist — `acknowledge_open_items: true` overrides, explicitly. `load_phase_context({ phase: "tickets" })` injects the open-items blocks with a triage directive, and `analyze_retro_patterns` reports real triage/applied rates instead of the always-0% owner metric.
- **Honest velocity** — `advance_sprint` runs the planning gate on planning → implementation (pre-created sprints can no longer bypass it) and **freezes `velocity_committed` at gate passage**. Added/removed scope is derived (`getScopeDeltas`) and reported in `get_velocity_trends` and `export_sprint_report` as `committed (+added / removed)`; completion rates measure against the frozen commitment, so 100% is earnable, not guaranteed.
- **Real recurring-issue analysis** — `analyze_retro_patterns` clusters went_wrong findings (stopword-filtered unigrams/bigrams, recurring = present in ≥2 distinct sprints, bigram-shadowing) instead of counting words. "because (5x)" can no longer be a top issue.
- **Design Language 2.0 — server-rendered terminal cards** (`src/scrum/cards.ts`): `update_ticket`, `advance_sprint`, `start_sprint`, `get_sprint_playbook`, and `get_burndown` accept `format: "card"` and return a pre-rendered, width-locked card (progress bar, burndown sparkline, ticket counts, warning lines) inside a ready-to-print ` ```diff ` fence — `+` lines render green, `-` warnings red in Claude Code. Cards include compact state inline, eliminating the follow-up `get_ticket` round-trip (discovery #12).
- **`code-context-statusline`** — new bin for Claude Code's `statusLine`: reads the session payload from stdin, finds `context.db` upward from the workspace, and prints a one-line ANSI sprint HUD (phase, day, points bar, ticket counts, blockers, mood) with zero token cost. Setup gains a merge-safe `[7/7]` step that wires it into `.claude/settings.json` without clobbering an existing statusline. Honors `NO_COLOR`; never breaks the host UI.
- **AskUserQuestion-native `/kickoff`** — every enumerable choice (discovery type, backlog confirmation, gate triage, archive decisions) goes through Claude Code's native question UI with a wizard → AskUserQuestion → plain-text fallback chain; server cards render verbatim; new **Phase 5b — Planning Gate Triage**. All hand-drawn ASCII boxes removed (441 → 243 lines).
- **Dashboard live mirror** — `start_sprint`, `advance_sprint`, `update_ticket`, and `create_ticket` auto-emit typed `step_progress`/`entity_changed` events server-side, so the wizard timeline follows terminal-driven ceremonies with zero extra LLM tool calls.
- **Token diet** (discoveries #8–#11, #13): `list_discoveries` compact by default (open items, truncated one-liners; `verbose: true` for everything), `get_burndown` shows the last 5 snapshots by default, `get_sprint_playbook` drops the lifecycle tutorial after the third sprint, the retro mood query aggregates in SQL, the frontend house-style primer injects only with the sprint's first fe ticket, and `get_file_context` `include_changes` defaults to **false**. Measured on the canned ceremony replay (`scripts/measure-tokens.mts`): **2807 → 1702 output tokens (−39%)**.
- **Live-editable board tickets with session reaction** — tickets are fully editable from the dashboard (`PATCH /api/ticket/:id`: title, description, points, priority, status within TODO ↔ IN_PROGRESS ↔ BLOCKED, assignments). Every UI edit transactionally bumps `change_seq`, sets the **`pending_change` flag**, writes a field-level `ticket_revisions` diff, queues a `ticket_changed` bridge action, and emits SSE (migration v23). The Claude session reacts: `load_phase_context(implementation)` and `get_sprint_playbook` prepend a **`⚠ CHANGED TICKETS`** block with per-field diffs, and the new **`acknowledge_ticket_changes`** tool clears the flags once the session has adjusted.
- **Multi-agent ticket assignments with per-assignment model selection** — `ticket_assignments` (role, optional model override, lead flag; existing `assigned_to` backfilled as lead). `create_ticket`/`update_ticket` accept `agents: [{ role, model?, lead? }]` (exactly one lead, validated roles/models, replace-set; the single-agent path keeps working and re-points the lead). The routing directive becomes **`Model routing (multi-agent)`**: the lead implements via a subagent at its resolved model, supporting assignments verify in parallel at theirs, and the QA gate requires every supporting verdict. Dashboard ticket editor gains agent chips with star-to-lead and a per-assignment model dropdown; board cards render assignment chips lead-first.
- Inline ticket editing UI: click-to-edit title/description in the detail modal, quick-edit from board cards and table rows, optimistic updates reconciled from the PATCH response, server 400s reverted and surfaced.
- **Boot-time skill auto-sync** — the server syncs the `fe:*` skill set from the latest upstream skills release on boot, so new skill releases reach existing installs without a package update.
- **Canonical fresh-install schema + downgrade guard** — `initScrumSchema` creates the final schema directly (absorbing migrations v6–v23), and fresh databases are **baseline-stamped** at `LATEST_SCHEMA_VERSION` instead of replaying all 23 migrations. Parity is enforced two ways: structurally against the incremental path, and against **real legacy databases** — pre-versioning / v1.2.1 / v1.3.1 SQL fixtures generated from git history (`scripts/make-legacy-fixture.mts`), each proven to migrate without error, preserve data, reach structural parity, and stay idempotent. Opening a database written by a newer server fails fast instead of risking corruption.
- **Setup update mode — existing databases are never overridden**: running `code-context-mcp` on a project that already has a `context.db` now does **migrate + config repair only**. Schema migrations run with an automatic rolling `context.db.bak` backup when migrations are pending (with a WAL-checkpoint warning if another process is writing, and a pointer to the backup if a migration fails); then `.mcp.json`, the bridge hook, commands, and statusline are refreshed idempotently. No re-indexing, no re-seeding, no wizard — a `[1/2]`/`[2/2]` update flow replaces the 7-step pipeline. The MCP server reports `[schema] vN` on stderr at boot.
- **Stale-dist warning** (adopts Sprint 1's try_next): `get_resume_state` and `health` warn when `src/` is newer than the compiled `dist/` — the silent-missing-tools failure mode is now announced.
- **Benchmark hygiene** (adopts Sprint 19's try_next): benchmark tests write to tmpdir by default; tracked result JSONs only update with `BENCHMARK_WRITE_RESULTS=1`. `npm test` leaves a clean tree.
- **Commands-structure CI check** (adopts Sprint 5's try_next): `npm run check:commands` validates `.claude/commands/*` (phase headers, rules, output contracts, no box-drawing, line ceiling) and runs in CI.

### Changed

- `/kickoff` Phase 7 documents multi-agent delegation (lead implements first, supporters review the diff in parallel, failed verdicts mean `log_bug()` and back to the lead); `/retro` documents the try_next lifecycle (capture at retro, adopt/drop/defer decision at the next planning, gate-enforced).
- `code-context-mcp --force` renames the old database (and its `-wal`/`-shm` siblings) to `context.db.bak-<timestamp>` instead of deleting it — a full reset is now recoverable.
- Vendored skill set updated to claude_development_skills v0.5.1.
- CI: GitHub Actions bumped to Node 24-ready majors (checkout v6, setup-node v6, create-pull-request v8); sync-skills cron unblocked (repo setting allowed Actions to create PRs).

### Fixed

- **Silent audit-trail loss** (migration v22): `event_log`'s CHECK constraints rejected `retro_finding`/`triaged` rows and the catch-and-ignore pattern hid it. The table is rebuilt with extended constraints; triage audit inserts are no longer silenced.
- **`tickets.review_status` only existed on dashboard-touched databases** — the column was created by an ad-hoc dashboard patch while migration v7 was a false no-op, so server-only databases were missing it. The migration engine now owns `review_status` (and the `deleted_at` safety net); the dashboard's ad-hoc ALTERs are gone.
- **Pre-2.0 databases could lose all tickets during migration**: with `foreign_keys = ON` (the production default), the v5 `sprints` rebuild's `DROP TABLE` fired `ON DELETE CASCADE` into `tickets` and `retro_findings`. FK enforcement is now disabled around the migration transaction (the canonical SQLite pattern) and restored afterwards. Oldest-era databases also crashed during init on a missing `deleted_at` column. Both failure modes are pinned by the legacy fixture suite.

## [1.3.1] - 2026-06-10

### Added

- **Sprint archiving** — finished sprints (status `closed`/`rest`/`done`) can be archived from the dashboard: Archive/Unarchive button in the sprint detail header (with an `Archived` badge), plus a bulk **"Archive all completed (n)"** action in the sidebar behind a confirm dialog. Archived sprints move behind the sidebar's "Show Archive" toggle and stay out of default views while remaining in **all metrics** (velocity trends, retro aggregation, insights). Unarchive restores them unchanged.
- New nullable `archived_at` column on `sprints` (migration v20) — orthogonal to `status` and `deleted_at`, so archiving never rewrites sprint history.
- Three dashboard endpoints behind the existing bearer auth: `POST /api/sprint/:id/archive` (400 unless the sprint is finished — eligibility is enforced server-side), `POST /api/sprint/:id/unarchive`, and `POST /api/sprints/archive-completed` (single-transaction bulk, returns `{ archived: n }`). Every archive/unarchive writes an audit-trail event, so changes appear in the activity feed.

### Changed

- The sidebar archive section is now driven by the explicit `archived_at` flag instead of the implicit "milestone completed + all sprints closed/rest" heuristic. This also fixes `done`-status sprints never counting as finished in the old grouping.

## [1.3.0] - 2026-06-09

### Added

- **Server-provided frontend skills** — the frontend skill set is now served by the MCP server straight into a live `/kickoff` session instead of being copied into each project. When a sprint has `fe-engineer` work, `load_phase_context` injects a house-style primer plus an index of available skills; the agent pulls any skill's full body on demand via the new **`get_skill`** tool. No restart, no slash-skill registration.
- **`get_skill({ name })`** — read tool returning one skill's full content from the DB (e.g. `fe:set-up-auth`, or a companion/shared ref like `fe:set-up-auth/auth-patterns.md` / `fe:_shared/<file>`).
- **`seedFrontendSkills()`** — idempotently seeds the frontend skills + the editable `fe:_house-style` primer into the project DB `skills` table (`owner_role: 'fe-engineer'`); per-skill insert-if-absent, so your edits survive re-seeds.
- **`npm run compile:skills`** (`scripts/compile-skills.mjs`) — compiles the vendored `vendor/skills/frontend/**` into `src/scrum/frontend-skill-defaults.generated.ts`, shipped compiled in the package.
- **Per-agent model routing via subagent delegation** — each ticket's implementation is delegated to a subagent spawned (Task tool) at its assigned agent's model tier (`opus`/`sonnet`/`haiku`). `load_phase_context` (implementation) and `get_ticket` emit a **Model routing** directive, and the `/kickoff` and `/sprint` flows act on it. This is what makes a ticket's assigned-agent model actually take effect (the dashboard model field was previously advisory only).

### Changed

- Frontend skills now live in the server DB (single source of truth, editable per project) rather than as files in your repo. Vendored source moved from `skills/` to `vendor/skills/` (build input only); `package.json` `files[]` no longer ships it.
- `setup` no longer copies skills into `.claude/skills/`; the former step is removed (setup is now a 6-step flow). Skills are seeded into the DB by `seedDefaults`.
- Agent model defaults updated to current IDs: `fe-engineer`, `be-engineer`, `developer`, and `qa` default to the strongest model (`claude-opus-4-8`); other roles use `claude-sonnet-4-6`. The dashboard model picker and `/api/agent` validation now offer `claude-opus-4-8`, replacing the outdated `claude-opus-4-6`.

### Fixed

- Dashboard `SprintPlanningView` had a malformed conditional (`cond ? (<jsx/>)` with no `:` branch) that failed the TypeScript parser and ESLint; completed it as a `cond && (<jsx/>)` render. `npm run lint` now reports 0 errors.

### Removed

- The `.claude/skills/<skill>/` file-copy install (added in 1.2.0) and the dead `src/server/skills-install.ts`.

### Notes

- Existing projects may still have `.claude/skills/<frontend-skill>/` files from 1.2.0 — these are harmless leftovers and can be deleted; the server no longer manages them.

## [1.2.1] - 2026-06-09

### Security

- **Path traversal in the indexer (#14)** — `resolveImportPath()` now rejects any import resolving outside the project root (containment check via `path.relative`), and `index_directory` enforces a sandbox: only `process.cwd()` is indexable by default, extended via `CODE_CONTEXT_ALLOWED_ROOTS`. Prevents reading arbitrary files (e.g. `~/.ssh`) into the queryable store.
- **SQL injection in `query`/`execute` (#15a)** — replaced the keyword denylist with allowlist validators plus better-sqlite3's `stmt.reader` check (`src/server/sql-guard.ts`). `query` accepts only a single read-only `SELECT`/`WITH` (no stacked statements, comments, or CTE-prefixed writes); `execute` accepts only a single `INSERT`/`UPDATE`/`DELETE`. Closes the semicolon, comment, and subquery bypasses.
- **Unauthenticated dashboard API (#15b)** — all `/api/*` routes now require a bearer token (`Authorization` header, or `?token=` for the SSE stream). The token is auto-generated and persisted to a gitignored `.code-context/dashboard.token` (override with `CODE_CONTEXT_DASHBOARD_TOKEN`), injected into the served page for the same-origin app, and sent by the MCP server on its notify calls. The page and static assets stay public so the browser can bootstrap.

### Removed

- **npm publish workflow** (`.github/workflows/publish.yml`) — CI no longer publishes to npm; a release is a git tag + GitHub release. The package is still on npm: 1.2.1 and most later versions were published outside CI.

## [1.2.0] - 2026-06-09

### Added

- **Bundled frontend skills** — the 22 Claude Code skills from [`claude_development_skills`](https://github.com/VelimirMueller/claude_development_skills) now ship inside the package (`skills/`). `code-context-mcp setup` installs them into the project's `.claude/skills/<skill>/`, so Claude Code discovers them automatically. Existing skill files are never overwritten.
- **`npm run sync:skills`** (`scripts/sync-skills.mjs`) — re-vendors the skills from the plugin repo's `main` and records provenance in `skills/.source.json` (source, ref, commit, timestamp, count).
- **Scheduled sync workflow** (`.github/workflows/sync-skills.yml`) — runs daily and on demand; re-vendors the skills and opens a PR whenever upstream `main` changes.
- **User-perspective install test** (`test/skills-package-install.test.ts`) plus a CI step validating that `skills/.source.json` `skillCount` matches the actual `SKILL.md` count.

### Changed

- `package.json` `files[]` now ships the `skills/` directory.
- `setup` is now a 7-step flow with a new "Installing Claude skills" step; step labels normalized.

### Notes

- Skills install **flat** at `.claude/skills/<skill>/SKILL.md`. Claude Code discovers project skills one level deep, so the upstream `frontend/` domain wrapper is stripped on install while `_shared/` is kept as a sibling so the skills' `../_shared/` references still resolve.

## [1.1.5] - 2026-04-22

- Version bump only; no code changes since 1.1.4. First version with a git tag (`v1.1.5`).

## [1.1.4] - 2026-04-22

### Changed

- `package.json` `repository`, `bugs` and `homepage` point to `github.com/VelimirMueller/vlm-code-context-mcp` (was `mcp-server`).
- `hono` bumped in the lockfile (Dependabot, #19).

## [1.1.3] - 2026-04-16

### Fixed

- Package description still referenced "7-agent scrum team" — now ships with 9 agents (Security Engineer + Architect added in 1.1.2)

## [1.1.2] - 2026-04-16

- 1.1.2 was not published to npm; 1.1.3 contains its changes too.

### Added

- **Security Engineer** and **Architect** agent roles — 7→9 default agents. Existing 7-agent databases auto-migrate on startup.
- Benchmark JSON files (`benchmark-results.json`, `benchmark-stochastic-results.json`) now included in npm package

### Changed

- Setup no longer auto-creates "M1 — Getting Started" milestone — milestones are created via `/kickoff` or MCP tools for a clean starting state

### Fixed

- **Flaky CI benchmark test** — "larger tasks save more" assertion compared group totals (4 small vs 3 large tasks) instead of per-task averages, causing failures on CI where indexer output differs slightly across Node versions

## [1.1.1] - 2026-04-16

### Fixed

- Flaky CI benchmark test: "larger tasks save more" compares per-task averages, not group totals. The 1.1.2 entry lists the same fix.

## [1.1.0] - 2026-04-16

### Added

- **10-task deterministic benchmark** (`test/benchmark.test.ts`) — MCP vs vanilla comparison across 6 categories (retrieval, analysis, exploration, implementation, debugging, refactoring), 32 story points total. Replaces the old 3-task hand-estimated comparison. Outputs `benchmark-results.json` for dashboard consumption.
- **200-trial stochastic benchmark** (`test/benchmark-stochastic.test.ts`) — random file role assignment, Poisson exploration noise (λ=1.5), Wilcoxon signed-rank test, bootstrap 95% CI, seeded PRNG for reproducibility. Result: 90.5% MCP win rate, p < 0.001, effect size r=0.953.
- **Benchmark guide** (`BENCHMARK-GUIDE.md`) — methodology, task descriptions, how to add tasks, honest reporting guidelines
- `/api/benchmark` and `/api/benchmark-stochastic` dashboard endpoints serving new benchmark data
- `benchmarkStore` (Zustand) for fetching deterministic + stochastic results

### Changed

- **Benchmark dashboard page** rewritten — now shows 10-task card grid, category breakdown, statistical proof panel with Wilcoxon results, hypothesis testing, and per-template savings
- **README benchmark section** updated with reproducible numbers (44.9% token savings, 27.9% fewer calls, p < 0.001) and `npm test` commands to verify

## [1.0.2] - 2026-04-15

- 1.0.2 was not published to npm; 1.1.0 contains its changes too.

### Removed

- **Velocity tab** — removed `Velocity` page, `velocityStore`, `/api/velocity` endpoint, and navigation entry. Sprint velocity data (committed/completed points, badges) remains available on sprint cards and Gantt chart.

### Fixed

- `comparison.json` now ships in npm package and dashboard falls back to bundled copy when not found next to database — fixes empty Benchmark page on npm installs

## [1.0.1] - 2026-04-15

### Fixed

- `comparison.json` ships in the npm package, and the dashboard falls back to the bundled copy (the 1.0.2 entry lists the same fix). The README was rewritten for the 1.0 launch.

## [1.0.0] - 2026-04-14

### Added

- Composite database indexes on `tickets(sprint_id, deleted_at)` and `sprints(status, deleted_at)` for faster soft-delete queries
- Migration v19 for existing databases to add ticket composite index
- `DASHBOARD_PORT` env var support in dashboard.ts (previously only accepted CLI arg)

### Changed

- **Transactional database operations** — `runMigrations`, `start_sprint`, `update_ticket`, and `advance_sprint` now wrap multi-step writes in `db.transaction()` for atomicity; partial failures roll back cleanly
- **Token efficiency** — `get_file_context` output consolidated (removed redundant `Indexed` timestamp, merged metadata to single line, removed dependency summaries); `index_directory` output reduced structural padding
- Version bumped to 1.0.0 for launch readiness
- ESLint `no-console` rule enabled (warn level, allowing `warn`/`error`)
- All documentation reconciled: tool count 76/81/83 → 93, agent count 9/16 → 7, stale sprint/ticket/milestone numbers removed from LAUNCH.md
- Setup and dashboard console output now respects `DASHBOARD_PORT` env var instead of hardcoding `localhost:3333`

### Fixed

- `retro_findings.linked_ticket_id` FK now uses `ON DELETE SET NULL` (fresh installs)
- Sprints table rebuild (`sprints_v3` migration) now always includes `deleted_at` column — previously dropped by migration 5 and never restored, causing broken `velocity_trends` view on fresh databases
- Removed 5 noisy debug `console.log` statements from dashboard.ts (SSE change notifications, re-index, marketing stats rebuild, client connect)

## [0.3.1] - 2026-04-14

- 0.3.1 was not published to npm; 1.0.0 contains its changes too.

### Added

- `update_sprint_config` and `get_sprint_config` MCP tools for runtime sprint configuration
- `department` field on agents (development, quality, business) for team organization
- Agent mood history seeding with per-sprint workload data on first startup
- TeamGrid dashboard component now displays agent department badges

### Changed

- Default agent team updated from 4/6/15-agent presets to a focused 7-agent roster (FE Engineer, BE Engineer, Developer, DevOps, QA, Team Lead, Product Owner)
- Agent seed migration auto-detects and upgrades old 4-, 6-, and 15-agent factory defaults
- Dashboard `/api/comparison` endpoint returns live benchmark data from `comparison.json`

### Fixed

- Agent reset validation now asserts exactly 7 agents and 5 skills after re-seed

## [0.3.0] - 2026-04-13

### Added

- **Benchmark comparison interface** — new `Benchmark` page visualizing MCP vs traditional development metrics (token usage, context switches, tool calls, completion time)
- **Velocity tracking** — new `Velocity` page with sprint-over-sprint throughput charts (story points completed, planned vs actual, trend lines)
- `comparisonStore` (Zustand) for fetching and caching benchmark data from `/api/comparison`
- `velocityStore` (Zustand) for fetching sprint velocity trends from `/api/velocity`
- Benchmark and Velocity tabs added to the top navigation
- `comparison.json` data file for persisting MCP vs traditional run results
- Dashboard API routes: `/api/comparison` and `/api/velocity`

### Changed

- Navigation updated to include Benchmark and Velocity as top-level tabs
- README updated with benchmark findings and efficiency metrics

## 0.2.1 – 0.2.9 - 2026-04-08 to 2026-04-09

Patch releases on npm without their own entry; the 0.2.0 and 0.3.0 entries describe the work. One line each, from the git log:

- 0.2.1 – 0.2.4 (2026-04-08): dashboard UI overhaul steps.
- 0.2.5 (2026-04-09): skills overhaul.
- 0.2.6: smaller tool output to reduce tokens.
- 0.2.7: fix an install bug in `settings.json`.
- 0.2.8: README update and scrum tool changes.
- 0.2.9: MCP tool coverage test and a README note.

## [0.2.0] - 2026-04-12

### Added

#### React Dashboard

- Full React rewrite — Vite + React 19 + TypeScript + Tailwind CSS 4 single-page application replacing the original HTML dashboard
- 5 Zustand stores (`fileStore`, `sprintStore`, `agentStore`, `planningStore`, `uiStore`) with typed API client
- 8 custom React hooks (`useFiles`, `useSprints`, `useAgents`, `usePlanning`, `useSearch`, `useHashRouter`, `useEventSource`, `useKeyboard`)
- **Code Explorer** page with collapsible file tree, search, and tabbed detail panel (imports, exports, metadata)
- **Sprint** page with kanban board, team workload grid, and bento insight cards
- **Project Management** page with milestone progress, epic tracking, and Gantt timeline
- **Planning** page with velocity analytics, health metrics, and capacity insights
- **Kanban board** with HTML5 drag-and-drop, optimistic updates, and atomic rollback on failure
- Planning wizard with step-aware workflow and inline ticket editing
- Sprint lifecycle automation — dashboard buttons advance sprints through phases without requiring Claude
- Animated hero text with count-up stat numbers on each tab
- Micro-interactions and landing animation polish
- Error boundaries and toast notification system
- SSE (Server-Sent Events) live-reload for real-time dashboard updates
- MCP-to-Dashboard HTTP notification bridge for instant UI refresh

#### MCP Server & Tools

- 27+ MCP tools organized across codebase intelligence and scrum management
- `create_sprint`, `start_sprint`, `advance_sprint`, `plan_sprint` — full sprint lifecycle
- `create_ticket`, `update_ticket`, `get_ticket`, `list_tickets` — ticket CRUD
- `create_epic`, `update_epic`, `list_epics` — epic management
- `create_milestone`, `update_milestone`, `link_ticket_to_milestone` — milestone tracking
- `create_blocker`, `resolve_blocker` — blocker management
- `create_discovery`, `update_discovery`, `link_discovery_to_ticket` — discovery tracking with resolution plans
- `add_retro_finding`, `list_retro_findings`, `analyze_retro_patterns` — retrospective tooling
- `record_mood`, `get_mood_trends` — agent mood and workload tracking
- `log_time`, `get_time_report` — time logging per ticket
- `log_decision`, `list_decisions` — architectural decision records
- `log_event`, `list_recent_events` — audit trail
- `get_sprint_summary`, `get_sprint_playbook`, `export_sprint_report` — sprint reporting
- `get_velocity_trends`, `get_burndown`, `snapshot_sprint_metrics` — analytics
- `dump_database`, `restore_database`, `export_to_file`, `import_from_file` — data portability
- `get_onboarding_status`, `run_onboarding` — guided project setup
- `get_backlog`, `get_dependency_graph`, `search_scrum` — backlog and dependency tools
- `add_tag`, `remove_tag`, `list_tags`, `add_dependency`, `remove_dependency` — metadata management
- `reset_agents`, `reset_skills`, `reset_sprint_process` — factory reset tools
- `get_agent`, `list_agents` — agent introspection
- `get_audit_trail`, `get_token_usage`, `log_token_usage` — observability

#### Scrum System

- 9-agent virtual scrum team (later refined to 7: FE Engineer, BE Engineer, Developer, DevOps, QA, Team Lead, Product Owner)
- 4-phase sprint process: Planning → Implementation → Done → Rest
- Sprint process stored as configurable skill (`SPRINT_PROCESS_JSON`)
- Agent assignment to tickets with workload tracking
- SQLite-backed persistence for all scrum data (sprints, tickets, epics, milestones, discoveries, mood history)

#### Infrastructure

- `code-context-mcp` CLI with `--help`, `--force`, `--name` flags for project setup
- `code-context-dashboard` CLI binary for launching the dashboard server
- `postinstall` script for npm — shows setup hint when installed as a dependency
- Automatic port detection — finds next open port when 3333 is blocked
- CI pipeline with ESLint, Prettier, and Husky pre-commit hooks
- 58+ unit tests (Vitest) covering MCP tools and dashboard API
- 23 Playwright E2E tests covering all dashboard tabs
- BentoGrid made fully dynamic — no hardcoded project data on clean installs
- Claude Code bridge hook for bidirectional dashboard–Claude communication

### Changed

- Dashboard architecture migrated from single HTML file to component-based React app with atomic design (atoms → molecules → organisms → pages)
- Sprint phases simplified from multi-step ceremony model to 4 clear phases
- Default agent count reduced from 15 to 4, then made configurable (assignment optional)
- Navigation flattened to single-level with persistent quick actions
- Standardized API error responses across all dashboard endpoints
- Removed Linear integration code (external dependency eliminated for MVP)
- Removed Marketing section from dashboard

### Fixed

- API response shape mismatches that crashed the React dashboard
- SSE plain-text event handling for live reload
- Milestone loading from skill content and vision fetch
- Sprint sorting by status then date in Gantt timeline
- File tree default collapsed state with auto-expand on search
- `dragLeave` flicker in kanban drag-and-drop
- Object-shaped `imports`/`importedBy` handling in Code Explorer detail tab
- Null safety guards in Code Explorer to prevent crashes
- Ticket milestone/epic assignment and discovery archiving
- Team workload/mood and Retro tab reactivity

### Removed

- 461 lines of dead and duplicated code identified and cleaned up
- Original single-file HTML dashboard (replaced by React app)
- Linear integration (all external sync code removed)

## [0.1.1] - 2026-04-06

### Fixed

- The BentoGrid shows the project's own data instead of hard-coded data, so clean npm installs render. (#8)
- The ProcessFlow page gets its `'use client'` directive.

## [0.1.0] - 2026-04-08

### Added

#### MCP Server

- SQLite-backed codebase indexer — scans and indexes file metadata, exports, imports, and dependencies
- `index_directory` — recursively index a project directory into the SQLite database
- `get_file_context` — retrieve file metadata, exports, imports, and dependency graph
- `find_symbol` — search for symbols (functions, classes, variables) across indexed files
- `search_files` — full-text search across indexed file content and descriptions
- `get_changes` — track file changes grouped by path with size and line diffs
- `query` / `execute` — raw SQL access to the underlying SQLite database
- `set_description` — set a human-readable description for any indexed file
- `set_directory_description` — set a description for any indexed directory
- `set_change_reason` — annotate why a file changed
- Pre-indexed file and folder descriptions written automatically on first install
- Relative path support for portable project references

#### Dashboard

- HTML-based dashboard with file tree browser and detail panel
- Directory and file description display in the detail panel
- Portfolio-aligned styling and design

#### Infrastructure

- TypeScript codebase with Vitest test suite (parser and smoke tests)
- `better-sqlite3` for zero-dependency embedded database
- `@modelcontextprotocol/sdk` integration for MCP server protocol
- `chokidar` file watcher for detecting changes
- `zod` schema validation
- MIT license

<!-- Tagged versions link to a compare view. Versions without a git tag (tags start at v1.1.5; 1.3.0, 2.6.0 and 2.12.0 have none) link to their version-bump commit. -->

[Unreleased]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.13.0...HEAD
[2.13.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.11.0...v2.13.0
[2.12.0]: https://github.com/VelimirMueller/code-context-mcp/commit/e23b7670826929286516cd10a8cf45a7747c4581
[2.11.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.5.1...v2.7.0
[2.6.0]: https://github.com/VelimirMueller/code-context-mcp/commit/cdb93fab43d09ce390c2c0fa25b2a214c1d8dfcd
[2.5.1]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.4.2...v2.5.0
[2.4.2]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v1.3.1...v2.0.0
[1.3.1]: https://github.com/VelimirMueller/code-context-mcp/compare/v1.2.1...v1.3.1
[1.3.0]: https://github.com/VelimirMueller/code-context-mcp/commit/6330a8a63631f17ab6272489f2ee864d7414c26c
[1.2.1]: https://github.com/VelimirMueller/code-context-mcp/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/VelimirMueller/code-context-mcp/compare/v1.1.5...v1.2.0
[1.1.5]: https://github.com/VelimirMueller/code-context-mcp/releases/tag/v1.1.5
[1.1.4]: https://github.com/VelimirMueller/code-context-mcp/commit/dcfaa0accf93ae1b8a79d8ed52e32961ddd6cf8a
[1.1.3]: https://github.com/VelimirMueller/code-context-mcp/commit/888a355f45d7bf1301cd980c6a4676d76aa35b46
[1.1.2]: https://github.com/VelimirMueller/code-context-mcp/commit/c3d0b8458c4b8cc1a466ba1d2f92bd1b37d6900f
[1.1.1]: https://github.com/VelimirMueller/code-context-mcp/commit/2b4b5a649e5f7cb1f40191501d9520bb1dd148e8
[1.1.0]: https://github.com/VelimirMueller/code-context-mcp/commit/0149d4463525a884c25b4e5ca2973ce49ecead42
[1.0.2]: https://github.com/VelimirMueller/code-context-mcp/commit/2889447906d211a7628eaeea69ed77d0e35dd0e8
[1.0.1]: https://github.com/VelimirMueller/code-context-mcp/commit/28f3b9da45ea71e8e87fbe649e304147f16a3edf
[1.0.0]: https://github.com/VelimirMueller/code-context-mcp/commit/de88bce6967c0859897a0a579202f830ab64d7ff
[0.3.1]: https://github.com/VelimirMueller/code-context-mcp/commit/0c23205b6bb9d16d6200172631c01e891b115d6a
[0.3.0]: https://github.com/VelimirMueller/code-context-mcp/commit/6581a345d97ffdd90c30787956b06add1e415d3a
[0.2.0]: https://github.com/VelimirMueller/code-context-mcp/commit/1243cc51c328c06b5f678551696e2d937dd33a0d
[0.1.1]: https://github.com/VelimirMueller/code-context-mcp/commit/cc7abe2f80088d912f45a91f28b1ccacd192a52c
[0.1.0]: https://github.com/VelimirMueller/code-context-mcp/commit/eb56b1a5d61a838e50f9cb9e4c689a2a86969c84
