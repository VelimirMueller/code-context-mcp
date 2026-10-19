# How to improve code-context — research (CCA-41, #186)

**Date:** 2026-10-19 · **Server:** vlm-code-context-mcp 2.13.0 · **Feeds:** epic CCA-33 (#185)

**Result first:**

- The lean `code` profile saves tokens on cross-file tasks. On small lookups it costs tokens. Break-even is near **6k uncached vanilla tokens per task**.
- The default profile (97 tools) costs more tokens than it saves whenever the client loads the tool definitions upfront. On the old 2.9.0 runs, 15 of 18 model×task cells used more uncached tokens (median +263 %).
- The GLM success drop (95.8 % → 87.5 %) is mostly a **measurement error**. 5 of the 6 failed cc sessions gave correct answers that the checker rejected. Corrected success: vanilla 95.8 %, cc 95.8 %, cc-guided 100 %.
- The Opus gain is small for four reasons: Opus checks every tool result again with Grep, Opus vanilla already uses few tokens, n = 1–2 per task, and Claude Code puts a ToolSearch round trip in front of the tools.
- Real sessions use the sprint process, not the code index: **91 % of 896 code-context calls** in the last 30 days were sprint tools. 54 of 85 sprint tools were never called.
- The #183 v2 run (Opus, NestJS, both profiles) is **in progress, results pending** (see [v2 run](#the-183-v2-run)).

## Method

| Source        | What                                                                                                                                                                  | Where                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Live runs     | 14 `ccc-bench/1` runs, 3 models, tasks L1–L6 (this repo, small fixture) and I1–I6 (683-file synthetic TS fixture)                                                     | `bench-results` branch, `data/runs/*.json`                           |
| Run artefacts | Per-session event streams of every live run                                                                                                                           | runner temp dirs `bench-live-<run_id>-*` (local only, not published) |
| Re-check      | The current checkers (`scripts/bench/live/checkers.mts`) re-run on the saved final answers of `glm-20261011-184607`. No API calls                                     | this research                                                        |
| Tool lists    | `tools/list` of the installed 2.13.0 server, default and `CODE_CONTEXT_TOOLSETS=code`                                                                                 | this research                                                        |
| Census        | All `mcp__code-context__*` calls in Claude Code transcripts (`~/.claude/projects`, 2026-09-21 → 2026-10-19, 1,295 sessions) and `context.db` tables, opened read-only | this research                                                        |
| Prior art     | Aider, Serena, Sourcegraph, Claude Code tool search                                                                                                                   | links in [Comparable tools](#how-comparable-tools-solve-this)        |

Token figures are **uncached tokens** (input + output + cache writes) per session, the figure the bench headline uses. "Saved" is `(vanilla − cc) / vanilla`; negative means cc used more.

Profiles in the old runs: 2.9.0 runs used the default profile (no `CODE_CONTEXT_TOOLSETS`). 2.10.0 runs used `code` with 11 tools. 2.11.0+ runs used `code` with 6 tools (run notes).

## Findings

### 1. For which task types do tokens drop, and for which do they rise?

`code` profile (6 tools), uncached tokens per session, cc vs vanilla:

| Task | Type                                 | vanilla size | Opus      | DeepSeek v4 pro | GLM 5.3   |
| ---- | ------------------------------------ | ------------ | --------- | --------------- | --------- |
| L1   | find one symbol, small fixture       | 2–5k         | −22 %     | −21 %           | −92 %     |
| L2   | small edit, small fixture            | 2–7k         | −17 %     | −45 %           | −15 %     |
| I5   | find one declaration among decoys    | 3–4k         | −16 %     | −12 %           | **+48 %** |
| I1   | importers of a module                | 5–13k        | −47 %     | **+26 %**       | **+35 %** |
| I2   | importers of a module                | 7–15k        | **+40 %** | **+12 %**       | **+35 %** |
| I3   | importers of one symbol, via barrels | 6–23k        | **+6 %**  | **+47 %**       | −19 %     |
| I4   | unused exports of a directory        | 14–27k       | **+56 %** | **+24 %**       | **+52 %** |
| I6   | two-hop dependents                   | 7–27k        | −30 %     | **+41 %**       | **+21 %** |
| L4   | importers, this repo                 | 12k          | —         | **+16 %**       | —         |
| L6   | dead exports, this repo              | 149k         | —         | **+18 %**       | —         |

(Opus: n = 1 per I task, n = 3 for I1 and L1. DeepSeek and GLM: n = 3–8.)

- **Tokens drop** on cross-file graph questions: importers, unused exports, two-hop dependents. In these tasks one `who_imports` / `exports_in` call replaces many grep and read rounds.
- **Tokens rise** on single-file lookups and small edits (L1, L2, I5). There, one Read or Grep is already the cheapest answer. The tool call, its framing text and the extra reasoning cost more than they save.
- Threshold: with vanilla below ~6k uncached tokens, 8 of 9 model×task cells rose. At or above 6k, 15 of 18 dropped.
- One exception: GLM I3 rose 19 %. `who_imports src/core/money.ts` returns 44 direct importers plus 53 through re-exports. The model then checks the long list with grep.

### 2. Break-even between tool-definition overhead and savings, per profile

Measured `tools/list` of 2.13.0:

| Profile | Tools | Definition size | ≈ tokens per model call                        |
| ------- | ----- | --------------- | ---------------------------------------------- |
| default | 97    | 56,624 chars    | ~12,300–14,000 (CHANGELOG 2.11.0 says ~12,300) |
| `code`  | 6     | 3,362 chars     | ~840                                           |

What the overhead costs depends on the client:

- **Upfront clients** (OpenCode, Claude Code with `ENABLE_TOOL_SEARCH=false`, most other MCP clients): every model call carries the definitions. The first call pays them uncached. Later calls read them from the cache at about 0.1× cost. A 10-call session therefore pays about `O × (1 + 0.1 × 9) ≈ 1.9 × O`.
  - default: ≈ 1.9 × 12.3k ≈ **23k weighted tokens per session**. That is more than a whole vanilla session on every task in the table above (2k–27k), except L6. **The default profile cannot break even on a single task.** The 2.9.0 runs confirm this: 15 of 18 model×task cells on L1–L6 rose, by 11 % to 474 % (median +263 %).
  - `code`: ≈ 1.9 × 0.84k ≈ **1.6k per session**. The server must save more than about 1.6k tokens, about one read of a mid-sized file. That matches the ~6k threshold in finding 1: below it, there is not 1.6k left to save.
- **Claude Code with tool search (the default since 2.1.x):** MCP definitions are deferred. Only tool names load at start (97 names in the v2 transcript, about 1k tokens). The model must call `ToolSearch` first, which costs one extra model round trip per session. This is why v1 had 0 of 12 sessions call the server. In the first v2 session the model did call `ToolSearch` once and then made 7 code-context calls.

### 3. Why the Opus gain is small

Data: `opus-20261011-134112` (−46 % uncached, n = 2) and `opus-20261011-145449` (+11.2 % uncached, +15.4 % guided; cost +7.9 % / +13.5 %).

- **Opus checks every tool result again.** In all 7 I-task cc sessions of `145449`, Opus made 1 code-context call and then 1–3 Grep calls on the same question. The server adds a step instead of replacing one.
- **Opus vanilla is already efficient.** Vanilla Opus used 3–14k uncached tokens per I task; DeepSeek used 4–27k. Less spend means less to save.
- **The sample is too small.** n = 1 per I task in `145449`. Per-task results range from −47 % to +56 %. The headline is mostly noise.
- **Claude Code adds a step.** Tool search puts a `ToolSearch` call before the first code-context call (finding 2).
- **The published treatment count is wrong.** `scripts/bench/live/parse-events.mts` `CODE_CONTEXT_TOOLS` does not list `who_imports` and `exports_in`, the two tools used most. `145449` reports 2/8 cc sessions with MCP calls. The transcripts show **7/8**. This bug affects every run since 2.11.0 (GLM `184607`: reported 15/24, real 21/24).

### 4. Why GLM success drops in `glm-20261011-184607`

The current checkers, re-run on the saved answers, reproduce all 7 failures. Per failed session:

| Session         | Answer correct?             | Why the checker failed it                                                                                         |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| cc I3 r3        | yes, 12/12 files            | Also names 5 files it **excluded** ("not counted: `src/core/index.ts` …"). `maxExtra: 1` counts every named path. |
| cc-guided I3 r2 | yes, 12/12                  | same: 5 excluded files named in the explanation                                                                   |
| cc I4 r3        | yes, 7/7 in the final block | The per-file prose above the block names 3 used exports. The checker counts them as claims.                       |
| cc-guided I4 r2 | yes, 7/7 in the final block | The "Used" and "Decoy cases" sections confuse the section parser. 0/7 parsed.                                     |
| cc-guided L1 r1 | yes                         | "Dependencies: None — … has no import statements" does not match the dependency regex                             |
| cc I6 r2        | **no**                      | Lists the second hop as prose ("the loyalty api files"), not as paths. 0/16 parsed.                               |
| vanilla I1 r3   | **no**                      | Misses `worker.ts`, adds a barrel                                                                                 |

- Corrected success: **vanilla 23/24 (95.8 %), cc 23/24 (95.8 %), cc-guided 24/24 (100 %)**. No real drop.
- Why only the cc arms: the tool output is rich (re-export counts, "complete list from the import graph"). GLM checks it with grep, finds the decoys, and **explains its exclusions**. Each explanation names extra paths or symbols. The strict checkers count those names as answers.
- The one real cc failure (I6) is an output-format problem, not a wrong graph.

### 5. How comparable tools solve the same problems

| Tool                                                                               | Approach                                                                                                                                                                                                                            | Lesson for code-context                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Aider repo map](https://aider.chat/docs/repomap.html)                             | Tree-sitter tags, a file dependency graph ranked by PageRank, rendered to a **token budget** (`--map-tokens`, default 1k) and pushed with every request. No tool calls.                                                             | Give results a size budget. Rank and cut long lists (finding 1, GLM I3).                                                                                |
| [Serena](https://github.com/oraios/serena)                                         | Symbol tools on top of LSP language servers (40+ languages). Tool sets per context and mode in YAML. Inside a harness like Claude Code it turns off its own `read_file`/`search_for_pattern`, because the harness already has them. | Ship a small default and let the client context add tools (#178). Do not duplicate the harness tools. Use a compiler-grade backend for accuracy (#182). |
| [Sourcegraph code graph / Cody](https://sourcegraph.com/resources/context-compare) | Precise code intelligence from SCIP indexes built by real compilers in CI, plus keyword search.                                                                                                                                     | Precision comes from compiler indexes, not regex. Results that models can trust do not need a grep check afterwards (#182).                             |
| [Claude Code tool search](https://code.claude.com/docs/en/mcp)                     | Defers MCP definitions by default. `_meta["anthropic/alwaysLoad"]: true` on a tool, or `alwaysLoad` per server, loads it upfront. Server instructions steer the search.                                                             | Mark the 6 code tools `alwaysLoad`: ~840 tokens upfront and no ToolSearch round trip. Keep server instructions short and keyword-rich.                  |

### 6. Which sprint-process tools real sessions call

Claude Code transcripts, 2026-09-21 → 2026-10-19. Transcripts older than 30 days are deleted, so "all time" equals the last 30 days here.

- 1,295 sessions; **30** called code-context. **896** calls in total.
- Sprint tools: **812 calls (91 %)** in 27 sessions. Code tools: 58 (6.5 %) in 17 sessions. Admin tools (`execute`, `health`, `index_directory`): 26.
- Top tools: `update_ticket` 266 · `create_ticket` 128 · `add_tag` 89 · `log_decision` 41 · `update_discovery` 41 · `list_tickets` 40 · `query` 38 · `advance_sprint` 21 · `get_ticket` 21 · `create_discovery` 21 · `get_resume_state` 18 · `search_files` 15.
- 31 of 85 sprint tools were called at least once. **54 were never called**, among them `get_burndown`, `get_velocity_trends`, `log_time`, `log_token_usage`, `handle_run_*`, `record_mood`, `export_sprint_report`.
- `find_symbol` 3, `get_file_context` 1, `who_imports` 1, `exports_in` 0: real sessions hardly use the code index.

`context.db` (read-only, all time since 2026-07-22):

- `event_log`: 677 rows, 395 in the last 30 days; 626 with actor `mcp`. Mostly ticket status changes (316) and ticket updates (147).
- `token_usage`: **0 rows**. `log_token_usage` is never called.
- `ticket_revisions`, `workflow_runs`, `workflow_step_log`, `subtasks`, `projects`: 0 rows. `agent_mood_history`: last row 2026-07-23. `blockers`, `bugs`: none since July.
- Active tables: `tickets` 304 (143 in 30 d), `decisions` 91 (40), `discoveries` 50 (20), `retro_findings` 40 (18), `sprints` 26 (15), `ticket_tags` 179 (94).

## Recommendations (ranked)

| Rank | Recommendation                                                                                                                                                                                                            | Expected effect (evidence)                                                                                                                                   | Cost | Breaking            | Feeds      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------- | ---------- |
| 1    | Fix the bench measurement first: count `who_imports`/`exports_in` in `CODE_CONTEXT_TOOLS`. Score only the final answer block (one fenced list), so excluded names in prose do not count. Then rescore the published runs. | GLM `184607` cc 87.5 % → 95.8 %, cc-guided → 100 %. Opus treatment rate 25 % → 88 %. Every later verdict depends on this.                                    | S    | no                  | #183       |
| 2    | Make `code` the default profile; sprint tools only after `/kickoff` or an explicit toolset.                                                                                                                               | Upfront clients: −11.5k tokens per model call, −~21k weighted per 10-call session. Default-profile runs: 15 of 18 cells rose, median +263 % uncached tokens. | M    | yes                 | #178       |
| 3    | Set `_meta["anthropic/alwaysLoad"]: true` on the 6 code tools.                                                                                                                                                            | Removes the `ToolSearch` round trip in Claude Code (the cause of 0/12 calls in v1). Costs ~840 tokens upfront.                                               | S    | no                  | #178, #180 |
| 4    | Add a size budget to list results (`who_imports`, `exports_in`): a `limit`, ranked by relevance, with a count of the rest. Answer a symbol query before the module query.                                                 | GLM I3, the only I task that got more expensive (+19 %): the module query returned 97 rows where the symbol query returned 13.                               | S–M  | no (optional param) | #180       |
| 5    | Tell the model when to use the tools: cross-file questions yes, one-file lookups no. Put it in the server instructions and in the hint.                                                                                   | Small tasks (vanilla < 6k) rose in 8 of 9 cells, by 12 % to 92 %. The guided arm already saves more (GLM 38.4 % vs 27.8 %, DeepSeek I4 40 % vs 24 %).        | S    | no                  | #178       |
| 6    | Measure and publish import-graph precision/recall. Then state it in the output so models stop checking results with grep.                                                                                                 | Grep checks are the remaining cost: 1–3 extra calls in 7/7 Opus I sessions, and the cause of the GLM explanations.                                           | M–L  | no                  | #182       |
| 7    | Split the index from the sprint process, and keep the sprint process first-class. Hide the 54 never-called sprint tools behind optional toolsets.                                                                         | Real use is 91 % sprint tools. A sprint profile of ~31 tools instead of 85 cuts its definitions by about two thirds.                                         | L    | yes                 | #179       |
| 8    | Freeze profiles, tool names and answer formats in the contract tests.                                                                                                                                                     | 2.12.0 cut `code` from 11 to 6 tools in a minor release, so old runs cannot be compared.                                                                     | M    | yes (policy)        | #180       |

## The #183 v2 run

- **Status: in progress, results pending.** Started 2026-10-19 16:56 on this Mac under `caffeinate -i`.
- Harness: overdrive bench 0.2.1, `run.sh --weekly --model claude-opus-5-5`, NestJS v12.1.1 fixture, PREREGISTRATION v2.
- Run 1, default profile: log `~/.claude/.local_ai_setup_logs/bench-v2-opus-default-20261019.log`.
- Run 2, `code` profile (`BENCH_CC_TOOLSETS=code`), queued after run 1: log `~/.claude/.local_ai_setup_logs/bench-v2-opus-code-20261019.log`.
- Results: `~/.claude/.local_ai_setup_logs/bench/runs/<run_id>.json`. Transcripts: `bench/last-default/` and `bench/last-code/`.
- Treatment check: in the first cc session the server connected (97 tools listed), and the model made 1 `ToolSearch` and 7 code-context calls.
- Harness change for this run (bench 0.2.1): the `BENCH_CC_TOOLSETS` env sets the server's `CODE_CONTEXT_TOOLSETS` for the cc arm and is recorded as `config.cc_toolsets`. `who_imports` and `exports_in` were added to the allowlist of both arms. Without that, every call to them would have been denied.

## How to update this doc when the v2 run lands

1. Read both run files: `verdict`, `valid`, `treatment_received_rate`, `nv`, and `criteria[].delta` for `tokens` and `time`.
2. Replace the v2 section above with a 2-row table (default, `code`): verdict, NV with CI, treatment rate, token Δ, time Δ.
3. Check findings 2 and 3 against it. A `code` run with a lower token Δ than the default run confirms recommendations 2 and 3. If both runs are INVALID, the treatment was not received: re-rank recommendation 3 first.
4. If the verdict changes a ranking, move the row and say why in one line under the table.
5. Publish both runs (`publish.sh`) and link them from #183. Publish negative verdicts too (PREREGISTRATION §6).
