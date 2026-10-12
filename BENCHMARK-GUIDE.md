# Benchmark Guide

How to run, interpret, and extend the benchmarks.

---

## On demand only

A benchmark runs when a person starts it. Nothing in this repo starts a run from a timer. Do not add a time schedule to any workflow. A guard test (`test/bench-guard.test.ts`) fails the build if a workflow gains one.

## The three kinds

| Kind                           | What it measures                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simulated`                    | Context efficiency from scripted replays. No model runs. Deterministic, plus a stochastic block with fixed seed.                                            |
| `agent-glm` / `agent-deepseek` | A real model through the OpenCode CLI, same task with and without the code-context MCP server. One repeat per arm. Results are indicative, not statistical. |
| `agent-claude`                 | Pre-registered external harness (Claude Code sessions, pre-registration v1/v2). The old run files are read-only. The site renders them unchanged.           |

## How to run

```bash
# Simulated: refreshes the two tracked result files, writes a run JSON into data/
npm run bench

# Agent: real model, real tokens. Provider picks the model and the key it reads
npm run bench:live -- --provider glm       # reads ZAI_API_KEY
npm run bench:live -- --provider deepseek  # reads DEEPSEEK_API_KEY
npm run bench:live -- --provider opus      # Claude Code headless, reads CLAUDE_CODE_OAUTH_TOKEN
npm run bench:live -- --provider glm --tasks L1,L2   # narrower task set
npm run bench:live -- --provider glm --tasks index   # named set: smoke, index, ladder, default
npm run bench:live -- --provider opus --tasks L1,I1 --arms vanilla,cc --cache-mode cold-warm --repeats 2   # cheap Opus check, below

# Free dry check of the index-shaped tasks: no model, no key (needs the build)
npm run bench:dry

# Publish: commit data/ to the bench-results branch and push (builds the site)
npm run bench:publish
```

Notes:

- `bench:live` needs `npm run build` first. It refuses to run without the dist server.
- The key variables hold secret values. The scripts never print them. Run JSON files carry the variable name only.
- Every `npm run bench` rewrites the two tracked files `benchmark-results.json` and `benchmark-stochastic-results.json`. This is the intended refresh path.

Where each kind runs:

- **Simulated:** anywhere. In GitHub Actions open the **Benchmark** workflow (`.github/workflows/benchmark.yml`), **Run workflow**, `kind=simulated`. It publishes the run and rebuilds the site.
- **Agent (glm, deepseek):** locally, by hand. Export the provider key in your shell, run `npm run build`, `npm run bench:live -- --provider <glm|deepseek|opus>`, then `npm run bench:publish`. Publish also starts the Pages build through `gh`; `--no-site` skips that. The provider keys stay on your machine.
- **Agent in Actions:** only when the repository secret `ZAI_API_KEY` or `DEEPSEEK_API_KEY` is set. The repo keeps none by default, so `kind=agent` prints a notice with the local command, ends green and publishes nothing.

## Arms

- **vanilla:** no code-context server.
- **cc:** the server is attached and the agent gets no hint. Shows whether an agent finds the tools by itself.
- **cc-guided:** the server is attached, and the system prompt carries the rule the owner's rig gives every session ("use code-context before you read or search files"). Shows what the server does when it is used.
- Every cc arm runs `CODE_CONTEXT_TOOLSETS=code` (6 tools, about 850 tokens of definitions), for every provider. For opus the variable sits in the generated `--mcp-config` server `env`; a test starts the server the way Claude Code does and checks that it lists only these tools.
- `--arms` picks the arms (default `vanilla,cc,cc-guided`). `vanilla` and `cc` are required.
- Task prompts are neutral: they name no tools, only that bash is disabled. Runs before 2026-10-11 told every arm to use the built-in file tools; they are not comparable.
- Run the ladder with 3 repeats: `npm run bench:live -- --provider <p> --tasks ladder --repeats 3 --timeout 900`.
- **Cost** comes from the agent CLI: opencode's step cost (DeepSeek), Claude Code's `total_cost_usd` from the final `result` event (Opus, list price, prompt caching on as in real use). GLM's coding plan is a subscription, so its cost is `null`.
- **Opus before CCA-10 (#125) overstates the overhead.** The 2.9.0 Opus runs had prompt caching off and the full 93-tool server: 65 % of L6 input was tool definitions (cc $1.04 vs vanilla $0.24, 0 MCP calls). Real sessions read that prefix from cache at 0.1× input. Do not compare those runs with newer ones.
- **Ratios:** the site shows `cc = N× vanilla` for uncached tokens and cost. Below 1× is a saving. See [Metrics](#metrics).

## Live task set

Three fixtures, three task groups. `--tasks` takes ids, set names, or both (`--tasks smoke,I4`).

| Set      | Tasks             | Fixture                                         | Purpose                                                   |
| -------- | ----------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `smoke`  | L1, L2            | `test/fixtures/sample-project` (10 files)       | The harness works end to end: one lookup, one edit.       |
| `index`  | I1–I6             | generated large fixture (683 files, 597k chars) | Questions an import graph answers and grep answers badly. |
| `ladder` | L1, L3, L4, L6    | sample project, then a copy of this repo's src/ | Size ladder S → XL.                                       |
| default  | `smoke` + `index` |                                                 | What `npm run bench:live` runs without `--tasks`.         |

- **L5 left the ladder (2026-10-11, CCA-09).** It is a rename: grep plus edits, the same work in every arm, so it cannot show an index. It still runs by id: `--tasks L5`. S1 (sandbox probe) also runs by id only.

### Why a large fixture

- The sample project has 10 files (215 lines). Two reads beat any index there.
- Only L4 and L6 (on this repo's `src/`) were index-shaped; their answers move with every commit.
- The large fixture is a **generated** TypeScript codebase: 20 business domains under `src/<domain>/` (model, repo, service, api, helpers, events, validation, jobs, tests, an `index.ts` barrel), a shared kernel `src/core/` with a barrel, platform layers `src/platform/`, a composition root `src/app/`. It has `export *` and `export { … } from` barrels, `import type`, `.js` specifiers, namespace imports, dynamic `import()`, cross-domain import cycles and many dead exports. It type-checks under `tsc --strict`.
- **Why generated, not a vendored open-source repo:** the answers must be exact and fixed, the git repo must not grow by megabytes, and unit tests must run offline. The generator (`scripts/bench/live/large-fixture/generate.mts`) is seeded; it writes the same bytes on every machine in about 70 ms. No third-party code is in it, so the repo's licence covers it. The cost: the code is plausible but repetitive.
- **Pinned:** `large-fixture/answers.json` holds the file count, the sha256 of the tree, and every answer. The workspace preparation refuses a tree whose hash differs.
- **Independent answers:** `large-fixture/answer-key.mts` computes the answers with the TypeScript compiler API (its parser, `ts.resolveModuleName` with Bundler resolution, and the checker's alias resolution through barrels). It never uses code-context's parser, resolver or index.
- **Change the generator:** run `npx tsx scripts/bench/live/large-fixture/answer-key.mts --write`, review the `answers.json` diff, commit both. A unit test fails when you forget.

### The index-shaped tasks

Prompts name no tools. Each defines its terms, because "imports" and "unused" are ambiguous without that. Path answers are scored with the CCA-07 `answerPaths` rules: lines that start with a path are the claims, commentary does not count.

| Id  | Question                                                                   | Answer size | Traps                                                                                                                 | Checker               |
| --- | -------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| I1  | Files whose import statements name `src/platform/http/retry.ts` (it moves) | 11 files    | type-only and `.js` imports, an `export … from`, a dynamic `import()`, sibling `retry-budget.ts`, a local `withRetry` | all, ≤ 1 extra        |
| I2  | Same for `src/orders/model/order-line.ts`                                  | 10 files    | the orders barrel re-exports it: files that import through the barrel are wrong                                       | all, ≤ 1 extra        |
| I3  | Files that import the function `formatMoney`, directly or through a barrel | 12 files    | 8 of 12 import through `src/core/index.ts`, one under an alias; `formatMoneyRange` importers; a same-named local      | all, ≤ 1 extra        |
| I4  | Unused exports of `src/catalog/utils/`                                     | 7 of 17     | a barrel re-export nobody imports, a whole-module `import()`, a type-only use, a comment mention, same-named locals   | all, ≤ 1 wrong        |
| I5  | The file that declares the exported function `resolveTaxRate`              | 1 file      | 2 same-named locals, an interface member, a barrel re-export, a stale comment that names the wrong file               | first path must be it |
| I6  | Files that depend on `src/loyalty/utils/points-math.ts` in 1 or 2 hops     | 16 files    | an import cycle back into the target; "via re-export" files are 3 hops                                                | all, ≤ 1 extra        |

- **What grep costs here** (measured 2026-10-11): grepping each task's key string and reading every hit is 5k–27k characters (I2 27k, I3 23k, I4 19k, I1 17k, I5 12k, I6 5k), plus the turns to chase barrels and hops. The matching graph-tool output is 0.25k–3.6k characters. The traps decide correctness more than the reading cost decides tokens; expect the arms to differ mostly in success rate and turns.
- **Dry check** (`npm run bench:dry`, free): builds a real cc workspace per I-task with the same preparation path as a live run, starts `dist/server/index.js` over stdio in it, calls `who_imports`, `exports_in` or `find_symbol`, and compares the result with the pinned answers and the task's checker. It proves that the server can answer each task; it says nothing about whether a model will.

## Fresh sessions

Every agent session starts with nothing to read from. Vanilla and cc never share state.

- **Workspace:** a new copy of the fixture per session. Only the cc arm gets an index, built fresh. The runner refuses a vanilla workspace that holds `context.db` or `.code-context`.
- **Agent CLI state:** a new HOME with its own TMPDIR per session, deleted afterwards. opencode caches, model catalogue and session store live there. For opus, `CLAUDE_CONFIG_DIR` is a new empty directory: no CLAUDE.md, memory, settings, hooks or plugins. Only the MCP servers on the command line load (`--strict-mcp-config`).
- **Provider prompt cache:** providers cache prompt prefixes across sessions. Every session records `first_call_cache_read`, the cached tokens its first model call read.
  - **DeepSeek:** a per-session nonce is the first line of the system prompt, so no prefix repeats. A first-call cache read above 0 aborts the run; no run file is written.
  - **Opus (since CCA-10, #125):** prompt caching stays **on**, cold and warm, as in real Claude Code use. Cold means: new HOME, empty `CLAUDE_CONFIG_DIR`, new workspace path, no session persistence, and a per-session nonce as the first line of `--append-system-prompt`. Claude Code has no slot before its own system prompt, so the nonce is the first text after the static prefix. The static prefix (built-in system prompt and tool definitions) is the same in every session, so the first call can read it from cache; that read is legitimate. The run is **not** aborted on a first-call read (`strictCache: false`, as GLM); the run notes give the first-call total. Cache writes (`cache_write` = `cache_creation_input_tokens`) are the honest cold cost and count as uncached tokens.
  - **GLM:** z.ai caches the tool definitions across sessions, and no prompt change reaches them. GLM runs with the nonce; the run notes give the cached first-call tokens. It hits both arms on the same built-in tools.
- Inside one session, later calls may still read the session's own earlier prefix from cache. It changes cost and speed, not the answer.
- **Token metric:** `total = input + cache_read + output`, every token the model processed. Runs before 2026-10-11 count `input + output`. It is not the headline; see [Metrics](#metrics).

## Timeouts and retries

- **`--timeout <s>` (default 300) ends a session at its limit.** The deadline runs on the wall clock. At the limit the runner sends SIGTERM, then SIGKILL after 5 s, to the agent's process group and to every descendant (also one in its own group, such as an MCP server). It stops reading the output pipes 2 s after the agent exits, so a leftover process cannot hold the session open. The session is recorded with `timeout: true` and the usage parsed up to the kill.
- **Machine sleep (macOS).** The runner holds `caffeinate -i` while it runs, so a Mac on battery does not idle-sleep mid-run. A closed lid still sleeps. A session that the machine slept through is flagged and retried (below). Root cause of the ~900 s "stalls" on 2026-10-11: the Mac idle-slept on battery and woke for ~20 s every ~15 min (`pmset -g log`); the old timer ran on the monotonic clock, which stops in sleep, so it never fired.
- **One retry.** A session with a provider error, 0 model calls (also a timeout with 0 model calls) or a machine sleep is not a model result. The runner runs it again once, with a fresh workspace and HOME. A retried cold session stays cold with a new nonce; a retried warm session keeps the warm seed. The retry replaces the failed attempt, and the run notes list every retry (`retry: <arm> <task> r<N> — <reason>`, or `retries: none`). Artefacts of the failed attempt stay as `<arm>-<task>…-retry1.*` next to the first attempt's files.
- **Void.** When the retry fails too, the run is void: no run file is written (#112).
- **A timeout with model calls is a model FAIL.** No retry.

## Cache modes

- `--cache-mode cold` (default): every session is cold (above).
- `--cache-mode cold-warm`: per task and arm, repeat 1 is cold and repeats 2..N are warm. A warm session gets a fresh fixture copy and HOME at the cold session's paths, the same nonce and the cold session's index (copied, not rebuilt). Repeats run right after their cold session, inside the 5-minute cache TTL. Sessions carry `cache_phase`; `aggregate.by_phase` compares the phases.
- Opus args and env are the same in both phases. Only the paths and the nonce decide whether the cache matches.

### Cheap Opus check (warm, code toolset, L1 + I1)

```bash
rig quota            # exit 1 = the 5h/7d window is hot: wait
npm run build
npm run bench:live -- --provider opus --tasks L1,I1 --arms vanilla,cc \
  --cache-mode cold-warm --repeats 2 --timeout 600
```

- **Sessions:** 2 tasks × 2 arms × 2 repeats = **8** (4 cold, 4 warm). The first console line prints the count. Add `cc-guided` to `--arms` for 12.
- **Rough cost at list price:** about $1–4 for the whole run. L1 (10-file fixture, about 3 calls) about $0.05–0.20 per session; I1 (683-file fixture, 10–30 calls) about $0.20–1.00 per cold session and less warm. Cold sessions pay the cache write (1.25× input) of the prefix; warm sessions read it at 0.1×. The CLI's `total_cost_usd` per session is in the console line and the run JSON.
- **Quota:** the token from `claude setup-token` uses your Claude plan. 8 short sessions, about 10–25 minutes wall time.
- **Read:** the console line per session shows `input+cache_read c+cache_write w→output` and `1st call cache`. Compare `cost_usd` and uncached tokens of cc vs vanilla, cold vs warm (`aggregate.by_phase`), and `mcp` calls of the cc arm.
- The run writes into `data/` like any run. Publish is a separate step (`npm run bench:publish`); use `--data-dir <dir>` to keep the result out of `data/`.

## Metrics

The headline of an agent run (since CCA-08) reads in this order: success per arm, uncached tokens saved, cost saved, uncached tokens per PASS per arm.

| Field | Definition |
|---|---|
| `success_<arm>_pct` | Passing sessions / sessions of the arm, × 100. |
| uncached tokens | `input + output + cache_write` per session: the tokens no cache served. |
| `uncached_saved_pct` | `(vanilla − cc) / vanilla × 100` on uncached tokens, summed over all sessions. `guided_uncached_saved_pct` is the same for cc-guided. |
| `uncached_saved_spread` | `{ min, max, repeats }`: the same saved % computed per repeat (repeat k of every task, both arms), min and max over repeats. `null` with one repeat. |
| `cost_saved_pct` | `(vanilla − cc) / vanilla × 100` on the USD the agent CLI reports. `null` when any session of either arm has no cost (GLM coding plan). |
| `uncached_per_pass` | Uncached tokens of all sessions of an arm / its passing sessions. `null` when no session passed. Failed sessions count in the numerator: an arm that fails more is not cheaper. |
| `tokens_saved_pct` | Demoted. Saved % on `total = input + cache_read + output`. Kept for old consumers. |

`aggregate` also carries:

- `per_pass.<arm>`: `sessions`, `passes`, `tokens_total`, `uncached_tokens`, `cost_usd`, `tokens_per_pass`, `uncached_per_pass`, `cost_per_pass`.
- `uncached_tokens`: per-arm sums, `saved_pct`, `spread` (and the guided values).
- `cost_saved_pct`: `{ cc, cc_guided }`.
- `per_task[i].uncached_tokens` per arm, and `per_task[i].delta.<arm>` = `{ pairs, saved_pct, min, max }`: repeat k of the arm against repeat k of vanilla (by the `-rN` suffix of the events file), saved % on the summed pairs, min and max over the pairs.

Why not the total:

- Providers bill a cache read at about 1 % of an input token (DeepSeek: about $0.004/M against $0.435/M). The total is mostly cache-read volume. Total-token savings of −13 % and −26 % came with costs equal within 3 %.
- At 3 repeats, differences in total tokens below about 30 % are inside the run-to-run spread (L6 totals 202k–918k within one arm). Read the spread before the mean.

Old run files keep their recorded fields. `data/index.json` derives the uncached, cost and per-PASS headline fields from the sessions of an older run, so the site and dashboard show them without a rewrite. To recompute a run file itself:

```bash
# Recompute aggregate + headline from the recorded sessions. No API calls.
npm run bench:renormalize -- --out <dir> data/runs/glm-*.json data/runs/dsk-*.json
```

- Session facts (tokens, success, cost, calls) stay as recorded; only derived fields change. `--out` never writes over an input file.
- A pre-2026-10-11 run gets `total = input + cache_read + output` like every newer run.
- `bench:rescore` recomputes the same fields after it changes a verdict.

The opus provider needs a long-lived token: run `claude setup-token` and store it as `CLAUDE_CODE_OAUTH_TOKEN`. It uses your Claude plan quota.

## Verdict rule

Every agent run gets a rule-based verdict (CCA-20): `headline.verdict` in the run JSON, and `verdict` per run and per group in a private summary. The owner's rule: a feature that is 5 % better but 25 % slower is not worth it. The rule and its sentences live in one module, `scripts/bench/lib/verdict.mts`; `site/data.js` carries a port that a test runs against the module on the same inputs.

Each code-context arm (cc, cc-guided) is compared with vanilla:

| Verdict | When |
|---|---|
| HARMFUL | The success rate drops by more than 5 percentage points, OR the uncached-token spread is below 0 in every repeat (`max < 0`), OR the mean wall time is more than 25 % slower. |
| BENEFICIAL | Not HARMFUL, AND the success rate does not drop by more than 5 pp, AND the uncached tokens decrease in every repeat (`spread.min > 0`; with fewer than 3 repeats: `uncached_saved_pct >= 10`), AND the tasks are not more than 25 % slower, AND `cost_saved_pct` is `null` or `>= 0`. |
| NO CLEAR EFFECT | Every other case. |

- "More than" is strict: a drop of exactly 5 pp and exactly 25 % slower still pass. A spread with `min = 0` is not BENEFICIAL; `max = 0` is not HARMFUL.
- Fewer than 3 repeats: the verdict is computed and marked **indicative**.
- Wall time change = `(vanilla mean − arm mean) / vanilla mean × 100` from `aggregate.wall_ms`; positive = faster. An unknown wall time blocks nothing; the text says so.
- The run verdict is the verdict of the best arm (BENEFICIAL > NO CLEAR EFFECT > HARMFUL). On a tie, cc-guided wins. The text calls cc-guided "with guidance" and cc "without guidance".
- The thresholds are one frozen object, `VERDICT_RULE`: `minRepeats: 3`, `maxSuccessDropPp: 5`, `maxSlowerPct: 25`, `minSavedPctFewRepeats: 10`, `smallEffectPct: 10` (below it, a NO CLEAR EFFECT arm reads "the effect is small").

The rule in ASD-STE100:

- Code-context is harmful when the success rate decreases by more than 5 percentage points.
- Code-context is harmful when the token use increases in all repeats.
- Code-context is harmful when the tasks are more than 25 % slower.
- Code-context is beneficial when it is not harmful, the token use decreases in all repeats, and the cost does not increase.
- With fewer than 3 repeats, the token use must decrease by 10 % or more. The verdict is then indicative only.
- In all other cases, code-context has no clear effect.

The text comes from fixed templates: short sentences, active voice, present tense, one fact per sentence, whole % values. The same numbers always give the same text. Three realistic cases:

```text
BENEFICIAL, indicative (1 repeat; guided: −28 % tokens, −26 % cost, 25 % faster, 67 % → 75 % success)
  Result: code-context helps when the agent gets the instruction to use it.
  With guidance, code-context decreases the token use by 28 %.
  It decreases the cost by 26 %.
  The tasks complete 25 % faster.
  The success rate increases from 67 % to 75 %.
  Without guidance, the effect is small.
  This result is indicative only: the run has 1 repeat.

NO CLEAR EFFECT (3 repeats; guided spread −2 % … +41 %)
  Result: code-context shows no clear effect.
  With guidance, code-context decreases the token use by 30 %.
  The tasks complete 8 % faster.
  The success rate increases from 67 % to 93 %.
  The result is not stable across repeats.
  Without guidance, the effect is small.

HARMFUL (3 repeats; 5–6 % fewer tokens, 31–40 % slower)
  Result: code-context makes the result worse.
  With guidance, code-context decreases the token use by 6 %.
  It decreases the cost by 5 %.
  The tasks complete 40 % slower.
  The success rate decreases from 80 % to 70 %.
  The success rate decreases by more than 5 percentage points.
  The tasks are more than 25 % slower.
  Without guidance, code-context also makes the result worse.
  The tasks are more than 25 % slower.
```

Where it shows:

- Dashboard: a chip (green BENEFICIAL, grey NO CLEAR EFFECT, red HARMFUL, plus "indicative") on each latest-per-kind card, and a "Verdict" section with the sentences at the top of the run detail.
- Site: a verdict card above the headline numbers and the run detail, the verdict label in each history row, and in a private-suite card the run verdict plus a verdict column per group.
- A run without an uncached-token figure (a pre-CCA-08 index entry without sessions) gets no verdict.
- Older runs and summaries need no rewrite: `data/index.json`, the dashboard and the site compute the verdict from the same fields when a file has none. A recorded verdict is never overwritten.
- Private summaries: the shape check recomputes each `verdict` from the block's own numbers and refuses any other text, so a verdict can never carry a suite-derived word. The guard scans it like every other string.

## Sandbox model

A live agent run executes untrusted code — a model through the OpenCode CLI, then vitest over the code that model wrote. The runner hardens this but it is **not a full container sandbox**:

- **The agent may** read, grep, glob and edit files inside its own temp workspace (built-in tools only) and call the code-context MCP server. It may not edit `opencode.json`, its own sandbox config.
- **The agent may not run any shell command**: `bash` is denied outright — no command allowlist at all (a `grep`/`head`/`find` allowlist would bypass the workspace boundary, because opencode does not apply `external_directory` to those commands). No `npm`, `npx`, `node`, `tsx`, `vitest`, `sh`, `python` either. Task correctness is decided by the checker, not by the agent running tests.
- **The agent may not** fetch or search the web, ask the user, spawn sub-agents, spawn language servers, or read/write anything outside the workspace (`external_directory: deny`, enforced by the built-in read/grep/glob/edit tools).
- **The agent sees a minimal environment**: `PATH`, `HOME`, `TMPDIR`, `CODE_CONTEXT_ALLOWED_ROOTS`, and the single provider key it needs. No `GITHUB_TOKEN`, no other provider keys, nothing else from the runner's environment.
- Every arm — vanilla and cc, glm and deepseek — gets the same sandbox `opencode.json` from one preparation path (`scripts/bench/live/prepare.mts`) before anything spawns.
- The checker runs vitest on the model's code with a scrubbed environment, a harness-owned vitest config outside the workspace (`--config`/`--root`, so an agent-planted `vitest.config.*` is ignored), and a hard timeout.

For local runs, use throwaway provider keys with spending limits: the checker executes code a model wrote (in a scrubbed environment), and a hostile or buggy model could spend tokens or write files inside its own workspace. The sandbox narrows blast radius; it does not isolate the process like a container would.

## Private suites

A private suite runs the live bench on code that must not enter this repository. The suite is a directory outside the repository; the workspace comes from local git clones at pinned commits. (CCA-17, #149)

```bash
npm run bench:suite-check -- ~/bench/my-suite          # free: validate, build one workspace, index it
npm run bench:live -- --suite ~/bench/my-suite --provider deepseek [--tasks T1,T2]
```

**`<dir>/suite.json`** (schema `ccc-bench-suite/1`):

```json
{
  "schema": "ccc-bench-suite/1",
  "id": "my-suite",
  "description": "What the suite measures",
  "private": true,
  "redact": true,
  "sources": [
    { "name": "backend", "repo": "/abs/path/to/clone", "commit": "<sha>", "subdir": "optional/folder" }
  ],
  "tasks": [
    { "id": "T1", "size": "L", "prompt": "… The bash tool is disabled in this environment.",
      "checker": { "type": "path-set", "answer": "t1Paths", "maxExtra": 1 } }
  ]
}
```

- `sources`: each source is extracted with `git archive <commit>[:<subdir>]` into `<ws>/<name>/`. The commit must exist in the clone. Uncommitted changes, untracked files and remotes are ignored, and no network is used. The cc arms index the whole workspace.
- `tasks[].checker`: `path-set` (claimed paths vs a `paths` answer; `first: true` checks only the first path; `ignore` lists paths never counted as extra), `symbol-set` (claimed names vs a `symbols` answer; `App\Jobs\Foo` counts as `Foo`), or `answer` (regex patterns, as in the built-in tasks).
- `redact` defaults to `private`.

**`<dir>/answers.json`** (schema `ccc-bench-suite-answers/1`): `{ "suite": "<id>", "answers": { "<key>": { "kind": "paths", "items": ["backend/app/…"] } } }`. Path items start with a source name. A `symbols` answer also lists its `universe`: every name the checker accepts as a claim, so a wrong name counts as extra. Compute the answer key with a script that does not use code-context.

**Privacy rules:**

- Results go to `<dir>/data/` (`runs/`, `index.json`, `latest.json`). A private suite refuses a `--data-dir` inside this repository, and a private suite directory inside this repository is refused too.
- The run JSON carries `suite: { id, private, redact, sources }` with the source commits.
- With `redact`, the run JSON stores no prompt text, no answers and no source names: tasks by id plus `prompt_sha256` and `answer_sha256`, and sources by commit plus `name_sha256`. A run file shared by mistake leaks no code facts.
- `bench:publish` refuses any run with `suite.private`, and any run file under a private suite directory (also through a symlink). It refuses before it writes or pushes anything.

### Private runs in the local dashboard

List the suite dirs in `CODE_CONTEXT_BENCH_PRIVATE_DIRS` when you start the dashboard (`:`-separated, `;` on Windows; a suite dir or its `data/` dir):

```bash
CODE_CONTEXT_BENCH_PRIVATE_DIRS=~/bench/my-suite npx code-context-dashboard ./context.db
```

- The Benchmark page merges the suite runs with the public runs. Each private run has a **private** chip with the suite `alias` (else its id), and a filter switches between All, Public and Private.
- The run detail works as for public runs. A redacted run shows task ids, never prompts.
- The dashboard reads the files from disk under the same run-id, index and realpath rules as the public dir. It sends them nowhere.

### Redacted summary (`--private-summary`)

A private suite can publish one file: a redacted summary under its public alias.

```bash
npm run bench:publish -- --private-summary ~/bench/my-suite --dry-run      # print it, publish nothing
npm run bench:publish -- --private-summary ~/bench/my-suite [--runs id,id] # publish it
```

Suite fields for the summary (all optional except `alias`, which the summary needs):

| Field | Meaning |
|---|---|
| `alias` | Public display name, e.g. `"Real-world suite A"`. The file is `data/private/<alias-slug>.json`. |
| `groups` | `{ "<group id>": "<public label>" }`, e.g. `{ "spa": "Single-page app" }`. |
| `tasks[].group` | Short group id of a task, e.g. `"spa"`, `"php"`, `"cross-repo"`. |
| `groupByPrefix` | `true`: a task without `group` goes to the group of its id's first letter (`S1` → `S`, mapped through `groups`). Default: group `all`. |
| `publicTaskIds` | `true`: task ids are not secret. Default `false`: task ids are on the denylist. The summary never lists task ids either way. |

What the summary holds (schema `ccc-bench-private-summary/1`), and nothing else:

- `alias`, `generated` (date), `code_context_version`.
- `scope`: number of sources, files and total MB of the sources at their commits (from `git ls-tree`, local; `null` when a clone is missing), task count, task count per group.
- Per run: `model`, `provider_kind`, `date`, `repeats`; per arm `sessions`, `success_pct`, `uncached_per_session`, `uncached_per_pass`, `cost_usd`, `cost_per_pass`, `wall_mean_ms`; per arm vs vanilla `uncached_saved_pct` with its min–max `uncached_saved_spread` and `cost_saved_pct`; the `verdict` (see [Verdict rule](#verdict-rule)). The same per group.

Every number is recomputed from the sessions; the run's own aggregate and notes are not read.

**The guard.** Before anything is written, every key and string of the summary is checked, and the publish refuses on one hit. The error names the JSON path and the kind of hit, never the value:

- A denylist from the suite and its runs: suite id and description, source names, repo paths and their folder names, subdirs, commits (full and 7 chars), task ids (unless `publicTaskIds`), prompts and the code-like tokens in them (paths, dotted, snake and camel names), answer items, universes and patterns, run notes, hashes, session ids and event paths. Matching ignores case and needs a word boundary.
- Local absolute paths and secrets (the GitHub-sync publish guard), any other absolute path, and hex runs of 7+ characters (commits, hashes).
- An allowlist shape check: exact keys at every level, numbers where numbers belong, strict patterns for alias, group labels, model id and dates.

The publish uses the same temp worktree as a run publish, never the current checkout. It writes `data/private/<slug>.json` and `data/private/index.json` (schema `ccc-bench-private-index/1`), runs the guard again on the exact bytes, and refuses when anything else is staged. The site shows each summary as a "Real-world private suite" card.

## Where the results go

- Run files land in `data/runs/<run_id>.json` (schema `ccc-bench/1`).
- `npm run bench:publish` commits `data/` to the `bench-results` branch and pushes. The branch holds `data/runs/`, `data/index.json` (all runs, newest first), and `data/latest.json` (the newest run of any kind).
- `data/private/` holds the redacted private-suite summaries (`--private-summary`), never runs.
- The Pages site at <https://velimirmueller.github.io/code-context-mcp/> rebuilds after each push. The latest run is the headline. The history lists every run. Run files on `bench-results` are append-only: they are never rewritten or deleted.

## Cost

- `simulated` costs nothing. No model runs.
- `bench:live` spends real tokens. Each task runs once per arm (vanilla, cc, cc-guided) and repeat. The default set has 8 tasks (smoke + index), so a default run is 24 sessions per repeat. Use `--tasks` to cut it (`--tasks smoke`, `--tasks I3,I4`).
- `npm run bench:dry` costs nothing: no model runs.
- Single-repeat agent numbers show a direction, not a distribution. Use `--repeats` for more, and expect the cost to scale.

---

## The simulated kind in depth

The sections below describe the simulated benchmark: what it measures, how the tasks are built, and how to read the two result files.

### Quick Start

```bash
# Run the benchmark (writes a published run JSON plus data/index.json, data/latest.json)
npm run bench

# The underlying test suites, verbose
npx vitest run test/benchmark.test.ts --reporter=verbose
npx vitest run test/benchmark-stochastic.test.ts --reporter=verbose
```

---

## What This Benchmark Measures

The benchmark compares two approaches to AI-assisted development:

| Approach    | How it works                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP**     | Agent calls MCP tools (`search_files`, `get_file_context`, `find_symbol`, `index_directory`) which return structured, summarized context  |
| **Vanilla** | Agent reads raw files (`Read`), greps for patterns (`Grep`), and lists directories (`ls`) — the standard Claude Code workflow without MCP |

**Key metric:** How many tokens does an agent's context window consume for the same task?

MCP tools return summaries (exports, dependencies, file metadata) instead of raw file content. This means less context consumed for the same information.

### What this does NOT measure

- **Actual Claude API token counts.** Token estimation uses whitespace+symbol splitting, not Claude's tokenizer. Real counts may differ by 10-20%.
- **Wall-clock time of real sessions.** No AI API calls are made. Tasks are simulated.
- **Code generation quality.** The benchmark measures context consumption, not what the AI does with that context.
- **Cold-start vs warm-session behavior.** All tasks start from a freshly indexed database.

---

## Methodology

### Task Design Principles

1. **10 tasks across 6 categories** — retrieval, analysis, exploration, implementation, debugging, refactoring
2. **Story points from 1 to 8** — covers trivial lookups through full codebase audits
3. **Self-contained** — each task creates its own steps from fresh DB queries, no cross-task state leakage
4. **Realistic workflows** — each task models how an actual AI agent would approach the problem: research → locate → understand → implement → verify
5. **Fair to both sides** — vanilla workflows use the natural tools (Grep, Read, ls) an agent would actually use

### How Tasks Are Simulated

Each task defines two workflows:

**MCP workflow:**

```
search_files("api")       → structured search results (path, language, exports, summary)
get_file_context("api.ts") → file metadata + exports + imports + dependents
find_symbol("ApiClient")   → symbol location with file context
index_directory(".")       → full project structure with summaries
```

**Vanilla workflow:**

```
Grep("api")               → raw matching lines with file paths
Read("src/services/api.ts") → full raw file content
Bash("ls -R")             → plain directory listing
```

The token count of each step's output is estimated and summed per task.

### Session Isolation

The old benchmark (comparison.json) had **session contamination** — the vanilla run happened in the same Claude session as the MCP run, benefiting from residual context. This benchmark eliminates that:

- Each task is a pure function that takes a database and returns results
- No shared mutable state between tasks
- Both MCP and vanilla approaches use the same indexed database and fixture
- Results are deterministic — running the benchmark twice produces identical numbers

### Token Estimation

```typescript
function estimateTokens(text: string): number {
  return text
    .split(/\s+/)
    .flatMap((w) => w.match(/symbols|words/g) ?? [w])
    .filter((t) => t.length > 0).length;
}
```

This is a conservative estimate. Actual Claude tokenization may differ. The benchmark report clearly states this limitation.

---

## The 10 Tasks

| ID  | Task                     | Category       | Points | What it tests                            |
| --- | ------------------------ | -------------- | ------ | ---------------------------------------- |
| T01 | Single-file lookup       | retrieval      | 1      | Find and understand one file             |
| T02 | Symbol search            | retrieval      | 1      | Locate a specific export across codebase |
| T03 | Dependency tracing       | analysis       | 2      | Trace imports/dependents of a module     |
| T04 | Codebase reconnaissance  | exploration    | 2      | Understand project structure cold        |
| T05 | Add utility function     | implementation | 2      | Add export, wire barrel file             |
| T06 | Bug hunt — type mismatch | debugging      | 3      | Find type inconsistency across files     |
| T07 | Add API endpoint         | implementation | 3      | New method + types + integration         |
| T08 | Cross-file refactor      | refactoring    | 5      | Extract pattern, update consumers        |
| T09 | New feature with tests   | implementation | 5      | Full feature across multiple files       |
| T10 | Full codebase audit      | analysis       | 8      | Read everything, assess architecture     |

**Total: 32 story points across 6 categories.**

### Why these tasks?

They cover the spectrum of real development work:

- **Retrieval** (T01, T02): The simplest case — does MCP help you find things faster?
- **Analysis** (T03, T10): Understanding relationships and structure — where MCP's dependency graph shines
- **Exploration** (T04): Cold-start project understanding — index_directory vs reading every file
- **Implementation** (T05, T07, T09): Building features — research + understand + verify cycle
- **Debugging** (T06): Tracing a problem across files
- **Refactoring** (T08): Cross-cutting changes that need full codebase awareness

---

## Reading the Results

### The Report Table

```
Task                             Pts │  MCP tok calls │  Van tok calls │  Saved Δcalls
Single-file lookup                 1 │      136     2 │      387     2 │    65%    0%
Symbol search                      1 │       16     1 │      310     2 │    95%   50%
...
```

- **MCP tok / calls**: Tokens consumed and tool calls made using MCP tools
- **Van tok / calls**: Tokens consumed and tool calls made using vanilla Read/Grep
- **Saved**: Percentage of tokens saved by MCP approach
- **Δcalls**: Percentage of tool calls saved

### Category Breakdown

The report groups tasks by category to show where MCP helps most:

- **Retrieval**: Highest savings — MCP returns structured summaries vs raw files
- **Analysis**: Strong savings — dependency graph replaces multi-file grep+read
- **Implementation**: Moderate savings — MCP reduces research phase but both need verification reads
- **Refactoring**: Lowest savings — both approaches must read all files for cross-cutting changes

### benchmark-results.json

The test writes a JSON file consumed by the dashboard. Structure:

```json
{
  "meta": {
    "fixture": "test/fixtures/sample-project",
    "fileCount": 10,
    "methodology": "...",
    "tokenEstimation": "..."
  },
  "tasks": [
    {
      "id": "T01",
      "label": "Single-file lookup",
      "category": "retrieval",
      "points": 1,
      "mcp": { "tokens": 136, "calls": 2, "files": 1 },
      "vanilla": { "tokens": 387, "calls": 2, "files": 1 },
      "tokenSavingsPct": 64.9,
      "callSavingsPct": 0
    }
  ],
  "summary": { ... }
}
```

---

## Adding New Tasks

To add a task, create a function following this pattern:

```typescript
function task11_yourTask(db: Database.Database) {
  // MCP approach
  const mcp = buildResult('T11', 'Your task name', 'category', 'description', points, [
    step('research', 'search_files', 'query', 'Why this call', mcpSearchFiles(db, 'query')),
    step(
      'understand',
      'get_file_context',
      'file.ts',
      'Why read this',
      mcpFileContext(queryFile(db, filePath)!),
    ),
    // ... more steps
  ]);

  // Vanilla approach — what would an agent do without MCP?
  const vanilla = buildResult('T11', 'Your task name', 'category', 'description', points, [
    step('research', 'Grep', 'pattern', 'Why grep this', vanillaGrep(FIXTURE_DIR, 'pattern')),
    step('understand', 'Read', 'file.ts', 'Why read this', vanillaReadFile(rawPath)),
    // ... more steps
  ]);

  return { mcp, vanilla };
}
```

Then add it to the `allTasks` array in `beforeAll()` and add a test assertion.

### Guidelines for fair tasks

1. **Both workflows must be realistic.** Don't give MCP a shortcut the vanilla approach can't take.
2. **Vanilla should use natural tools.** An agent without MCP would use Grep, Read, and ls — not hand-crafted shortcuts.
3. **MCP should use actual tool functions.** Call the real `mcpSearchFiles`, `mcpFileContext`, etc.
4. **Include all phases.** Research → locate → understand → [implement] → verify.
5. **Count verify reads.** After implementation, both approaches re-read files to confirm changes. Don't skip this for MCP.

### Expanding the fixture

The current fixture has 11 files (5 TypeScript). For more realistic benchmarks:

1. Add files to `test/fixtures/sample-project/`
2. The indexer will automatically pick them up
3. Larger fixtures will show more dramatic differences (MCP scales better because summaries don't grow linearly with file size)

---

## Honest Reporting

The benchmark report and JSON output include methodology disclaimers. When citing results:

**Do:**

- "In a 10-task simulated benchmark, MCP tools consumed ~44% fewer estimated tokens than raw file reading"
- "Token counts are whitespace-based estimates, not Claude API measurements"
- "Results are from a small fixture (11 files) — production codebases may differ"

**Don't:**

- "MCP reduces token usage by 44%" (implies measured API tokens)
- "MCP is 44% more efficient" (conflates token reduction with efficiency)
- "Proven 44% savings" (simulated, not measured in production)

---

## Comparison With Old Benchmark

| Aspect                  | Old (comparison.json)        | New (benchmark.test.ts)       |
| ----------------------- | ---------------------------- | ----------------------------- |
| Tasks                   | 3                            | 10                            |
| Categories              | 1 (implementation)           | 6                             |
| Session isolation       | Same session (contaminated)  | Self-contained functions      |
| Token counting          | Hand-estimated from sessions | Automated regex estimation    |
| Reproducibility         | Cannot reproduce             | `npm test` — deterministic    |
| What it compares        | Old format vs new format     | MCP tools vs raw file reads   |
| Methodology documented  | No                           | Yes (in test + this guide)    |
| Machine-readable output | comparison.json (manual)     | benchmark-results.json (auto) |

The old comparison.json measured output format optimization (old verbose vs new compact). The new benchmark measures the core value proposition: does using MCP tools reduce context consumption compared to not using them?

---

## Stochastic Benchmark (Statistical Proof)

The deterministic benchmark (above) uses 10 hand-crafted tasks. A valid concern: the author chose which files to read and in what order — this could introduce bias.

The stochastic benchmark eliminates this by randomizing everything:

```bash
npx vitest run test/benchmark-stochastic.test.ts --reporter=verbose
```

### How it works

**4 task templates** define workflows with ROLES, not specific files:

- `single-file` — find and understand one file
- `dep-tracing` — trace a file's dependency graph
- `multi-file` — implement a feature touching 2-4 files
- `project-scan` — overview + targeted deep dives

**Each of 200 trials:**

1. Randomly selects a task template
2. Randomly assigns fixture files to roles
3. Adds Poisson-distributed exploration noise to vanilla (lambda=1.5) — models agents reading wrong files before finding the right one
4. Records token counts for both approaches

**Statistical tests:**

- Wilcoxon signed-rank test (non-parametric, no normality assumption)
- Bootstrap 95% confidence intervals (2000 resamples)
- Rank-biserial correlation (effect size)

### Results (simulated, regenerated 2026-10-11)

```
Trials: 200  Seed: 42

MCP wins: 185/200 (92.5%)  Vanilla wins: 14  Ties: 1
Savings: 50.1% (95% CI: [19.6%, 45.9%])

Wilcoxon signed-rank: z=11.684, p<0.001, n=199
Effect size: r=0.955 (large)
Verdict: REJECT H₀ — MCP savings are statistically significant
```

**Interpretation:** Across 200 randomized trials with exploration noise, MCP won 92.5% of the time. The Wilcoxon test rejects the null hypothesis (p < 0.001) with a large effect size (r=0.955). Savings 50.1% is the ratio of total tokens; the 95% CI is for the mean per-trial saving (34.9%), and its lower bound is 19.6%. All of this is simulated (no model runs).

### Reproducibility

- Same seed (42) → identical results every time
- Different seed → different trials, same conclusion (p < 0.05 holds)
- The test verifies both of these automatically

### Seeded PRNG

All randomness uses Mulberry32, a fast 32-bit PRNG. Set `SEED` at the top of the test to reproduce or vary results.

### Methodology debate

The stochastic design was developed through structured debate with Gemma 3:

- Gemma proposed randomizing tool ordering → **rejected** (causal workflow dependency)
- Gemma proposed 500-1000 trials → **reduced to 200** (only 462 possible file combinations with 11 files)
- Gemma proposed paired t-test → **replaced with Wilcoxon** (token distributions aren't normal)
- Opus proposed random file role assignment → **adopted** (eliminates author selection bias)
- Opus proposed Poisson exploration noise → **adopted** (models real agent behavior)

Full debate transcript in `GEMMA-VS-OPUS-DEBATE.md`.

---

## Known Limitations

1. **Small fixture.** 11 files doesn't represent a real codebase. MCP's advantage likely grows with codebase size because summaries stay compact while raw files grow.

2. **JS/TS only.** The fixture only contains JavaScript/TypeScript. For other languages, MCP provides less value (language recognition only, no export/import parsing).

3. **Simulated workflows.** Real AI agents make non-deterministic choices. The stochastic benchmark addresses this partially with Poisson exploration noise, but it's still a simulation.

4. **Token estimation.** Whitespace splitting underestimates actual Claude tokens for code (operators, brackets). Results are directionally correct but not precise.

5. **No network/IO.** Real MCP server has SQLite query time. Real vanilla has file I/O. This benchmark compares output sizes only.

6. **Single developer.** The fixture represents one person's project. Team codebases with more files and more complex dependency graphs may show different patterns.

---

_Generated 2026-04-16. On-demand runs since 2026-10-10._
_Deterministic + stochastic, published run: `npm run bench`_
