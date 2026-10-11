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
- Both cc arms run `CODE_CONTEXT_TOOLSETS=code` (11 tools, about 1,300 tokens of definitions).
- Task prompts are neutral: they name no tools, only that bash is disabled. Runs before 2026-10-11 told every arm to use the built-in file tools; they are not comparable.
- Run the ladder with 3 repeats: `npm run bench:live -- --provider <p> --tasks ladder --repeats 3 --timeout 900`.
- **Cost** comes from the agent CLI: opencode's step cost (DeepSeek), Claude Code's `total_cost_usd` (Opus, at list price with prompt caching off, so an upper bound). GLM's coding plan is a subscription, so its cost is `null`.
- **Ratios:** the site shows `cc = N× vanilla` for uncached tokens and cost. Below 1× is a saving. See [Metrics](#metrics).

## Fresh sessions

Every agent session starts with nothing to read from. Vanilla and cc never share state.

- **Workspace:** a new copy of the fixture per session. Only the cc arm gets an index, built fresh. The runner refuses a vanilla workspace that holds `context.db` or `.code-context`.
- **Agent CLI state:** a new HOME with its own TMPDIR per session, deleted afterwards. opencode caches, model catalogue and session store live there. For opus, `CLAUDE_CONFIG_DIR` is a new empty directory: no CLAUDE.md, memory, settings, hooks or plugins. Only the MCP servers on the command line load (`--strict-mcp-config`).
- **Provider prompt cache:** providers cache prompt prefixes across sessions. Every session records `first_call_cache_read`, the cached tokens its first model call read.
  - **DeepSeek:** a per-session nonce is the first line of the system prompt, so no prefix repeats. A first-call cache read above 0 aborts the run; no run file is written.
  - **Opus:** `DISABLE_PROMPT_CACHING=1`. Same hard check.
  - **GLM:** z.ai caches the tool definitions across sessions, and no prompt change reaches them. GLM runs with the nonce; the run notes give the cached first-call tokens. It hits both arms on the same built-in tools.
- Inside one session, later calls may still read the session's own earlier prefix from cache. It changes cost and speed, not the answer.
- **Token metric:** `total = input + cache_read + output`, every token the model processed. Runs before 2026-10-11 count `input + output`. It is not the headline; see [Metrics](#metrics).

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

## Sandbox model

A live agent run executes untrusted code — a model through the OpenCode CLI, then vitest over the code that model wrote. The runner hardens this but it is **not a full container sandbox**:

- **The agent may** read, grep, glob and edit files inside its own temp workspace (built-in tools only) and call the code-context MCP server. It may not edit `opencode.json`, its own sandbox config.
- **The agent may not run any shell command**: `bash` is denied outright — no command allowlist at all (a `grep`/`head`/`find` allowlist would bypass the workspace boundary, because opencode does not apply `external_directory` to those commands). No `npm`, `npx`, `node`, `tsx`, `vitest`, `sh`, `python` either. Task correctness is decided by the checker, not by the agent running tests.
- **The agent may not** fetch or search the web, ask the user, spawn sub-agents, spawn language servers, or read/write anything outside the workspace (`external_directory: deny`, enforced by the built-in read/grep/glob/edit tools).
- **The agent sees a minimal environment**: `PATH`, `HOME`, `TMPDIR`, `CODE_CONTEXT_ALLOWED_ROOTS`, and the single provider key it needs. No `GITHUB_TOKEN`, no other provider keys, nothing else from the runner's environment.
- Every arm — vanilla and cc, glm and deepseek — gets the same sandbox `opencode.json` from one preparation path (`scripts/bench/live/prepare.mts`) before anything spawns.
- The checker runs vitest on the model's code with a scrubbed environment, a harness-owned vitest config outside the workspace (`--config`/`--root`, so an agent-planted `vitest.config.*` is ignored), and a hard timeout.

For local runs, use throwaway provider keys with spending limits: the checker executes code a model wrote (in a scrubbed environment), and a hostile or buggy model could spend tokens or write files inside its own workspace. The sandbox narrows blast radius; it does not isolate the process like a container would.

## Where the results go

- Run files land in `data/runs/<run_id>.json` (schema `ccc-bench/1`).
- `npm run bench:publish` commits `data/` to the `bench-results` branch and pushes. The branch holds `data/runs/`, `data/index.json` (all runs, newest first), and `data/latest.json` (the newest run of any kind).
- The Pages site at <https://velimirmueller.github.io/code-context-mcp/> rebuilds after each push. The latest run is the headline. The history lists every run. Run files on `bench-results` are append-only: they are never rewritten or deleted.

## Cost

- `simulated` costs nothing. No model runs.
- `bench:live` spends real tokens. Each task runs twice: once without the server, once with it. The default task set is small on purpose. Use `--tasks` to cut it further. A full run costs task count × 2 sessions of prompt and tool traffic.
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
Single-file lookup                 1 │      161     2 │      467     2 │    66%    0%
Symbol search                      1 │       31     1 │      360     2 │    91%   50%
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
      "mcp": { "tokens": 161, "calls": 2, "files": 1 },
      "vanilla": { "tokens": 467, "calls": 2, "files": 1 },
      "tokenSavingsPct": 65.5,
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

- "In a 10-task simulated benchmark, MCP tools consumed ~45% fewer estimated tokens than raw file reading"
- "Token counts are whitespace-based estimates, not Claude API measurements"
- "Results are from a small fixture (11 files) — production codebases may differ"

**Don't:**

- "MCP reduces token usage by 45%" (implies measured API tokens)
- "MCP is 45% more efficient" (conflates token reduction with efficiency)
- "Proven 45% savings" (simulated, not measured in production)

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

### Results

```
Trials: 200  Seed: 42

MCP wins: 181/200 (90.5%)
Savings: 49.7% (95% CI: [17.9%, 44.9%])

Wilcoxon signed-rank: z=11.688, p<0.001
Effect size: r=0.953 (large)
Verdict: REJECT H₀ — MCP savings are statistically significant
```

**Interpretation:** Across 200 randomized trials with exploration noise, MCP won 90.5% of the time. The Wilcoxon test rejects the null hypothesis (p < 0.001) with a large effect size (r=0.953). The 95% CI lower bound is 17.9% — even in the worst case, MCP saves tokens.

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
