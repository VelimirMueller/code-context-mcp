# Changelog

All notable changes to `vlm-code-context-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **`query` describes and bounds itself.** The description lists the columns of `files`, `exports` and `dependencies` and the two common joins; the `code` profile `tools/list` grows from 1,881 to 2,376 characters (bound now 2,450). `PRAGMA table_info(<table>)` and `PRAGMA table_list` run; other PRAGMAs stay rejected, and the message says what is allowed instead of pointing at `execute`. Output stops at 50 rows or about 8 KB, cells at 1,000 characters, each with a note on how to narrow. `files.content` leaves only when the SELECT list names it, so `SELECT * FROM files` no longer returns whole files. Guessed column names get a pointer to the schema. (#118)
- **`CODE_CONTEXT_TOOLSETS=code` lists 4 tools, not 11:** `find_symbol`, `get_file_context`, `search_files`, `query`. `tools/list` drops from 5,888 to 1,881 characters (about 1,500 to 500 tokens per model call); a test pins the upper bound. `code,code-admin` adds the 7 maintenance tools back. Default profile and `all` do not change. (#117)
- **Code tool descriptions lead with the question they answer** and drop the freshness boilerplate. The freshness check itself does not change. (#117)
- **Tool results print project-relative paths.** `find_symbol`, `get_file_context`, `search_files`, `get_changes` and `set_description` show `src/utils/helpers.ts` for files under the indexed root that holds the server's working directory (or under the working directory, when it sits above the indexed roots). Files of other repos in a shared database stay absolute, so a relative path is never ambiguous. `absolute_paths: true` or `CODE_CONTEXT_ABSOLUTE_PATHS=1` restores absolute output. (#116)

### Fixed
- **The index stores realpaths.** A symlinked root and its target index identically, one row per file. On macOS `os.tmpdir()` is `/var/folders/…` (a symlink to `/private/var/folders/…`); agents resolve their cwd to the realpath and refused every path copied from a result as outside the workspace. Rows an older version stored under the symlinked spelling move to the realpath at server boot and on the next `index_directory`, with descriptions and change history. Tools accept the relative form, the realpath and the old spelling. `index_directory` accepts either spelling of an allowed root. (#116)

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

### Added
- **Overdrive session log** — the MCP server and the dashboard append one-line breadcrumbs to the shared per-session log `${OVERDRIVE_SESSION_LOG_DIR:-~/.claude/.local_ai_setup_logs/sessions}/<CLAUDE_CODE_SESSION_ID>.log` (`_nosession-YYYY-MM-DD.log` without a session id), in the overdrive contract format `<ts>\t<LEVEL>\tcode-context@<version>\tpid=<pid>\t<message>`. New helper `src/sessionlog.ts` (node stdlib only): one `O_APPEND` write per line, dir `0700` / file `0600`, every error swallowed, never prints (stdout is the MCP transport), `OVERDRIVE_SESSION_LOG=0` turns it off.
  - `INFO` — server and dashboard start (version, port, db basename), sprint phase transitions, ticket status changes, discovery/sprint archive counts, `index_directory` runs (file count, duration).
  - `WARN` — advisory gate warnings from `advance_sprint` / `update_sprint` (counts), gate-blocked ticket edits (ticket id + rule), planning-gate blocks (counts), rejected dashboard requests (401/403/421, never the token or query string; at most one line per status+path per minute, with a `suppressed=<n>` count), dashboard routes that throw a 4xx error (status + error class), schema migrations applied.
  - `CRITICAL` — exceptions escaping any MCP tool handler, dashboard routes failing with a 5xx (error class only), DB open/migration failure.
  - Only ids, counts, phases and durations are logged — never titles, descriptions, retro text, file contents, the dashboard token or SQL values. Read paths stay silent.
- The test suite runs with `OVERDRIVE_SESSION_LOG=0` so it never writes into a real session log.

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
- **Design Language 2.0 — server-rendered terminal cards** (`src/scrum/cards.ts`): `update_ticket`, `advance_sprint`, `start_sprint`, `get_sprint_playbook`, and `get_burndown` accept `format: "card"` and return a pre-rendered, width-locked card (progress bar, burndown sparkline, ticket counts, warning lines) inside a ready-to-print ```diff fence — `+` lines render green, `-` warnings red in Claude Code. Cards include compact state inline, eliminating the follow-up `get_ticket` round-trip (discovery #12).
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
- **npm publish workflow** (`.github/workflows/publish.yml`) — releases are now git tag + GitHub release only; the package is not published to npm.

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

## [1.1.3] - 2026-04-16

### Fixed
- Package description still referenced "7-agent scrum team" — now ships with 9 agents (Security Engineer + Architect added in 1.1.2)

## [1.1.2] - 2026-04-16

### Added
- **Security Engineer** and **Architect** agent roles — 7→9 default agents. Existing 7-agent databases auto-migrate on startup.
- Benchmark JSON files (`benchmark-results.json`, `benchmark-stochastic-results.json`) now included in npm package

### Changed
- Setup no longer auto-creates "M1 — Getting Started" milestone — milestones are created via `/kickoff` or MCP tools for a clean starting state

### Fixed
- **Flaky CI benchmark test** — "larger tasks save more" assertion compared group totals (4 small vs 3 large tasks) instead of per-task averages, causing failures on CI where indexer output differs slightly across Node versions

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

### Removed
- **Velocity tab** — removed `Velocity` page, `velocityStore`, `/api/velocity` endpoint, and navigation entry. Sprint velocity data (committed/completed points, badges) remains available on sprint cards and Gantt chart.

### Fixed
- `comparison.json` now ships in npm package and dashboard falls back to bundled copy when not found next to database — fixes empty Benchmark page on npm installs

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

[1.0.0]: https://github.com/VelimirMueller/mcp-server/compare/v0.3.1...v1.0.0
[0.3.1]: https://github.com/VelimirMueller/mcp-server/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/VelimirMueller/mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/VelimirMueller/mcp-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/VelimirMueller/mcp-server/releases/tag/v0.1.0
