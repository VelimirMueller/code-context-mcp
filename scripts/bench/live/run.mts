/**
 * `npm run bench:live` — real agent benchmark (PLAN.md task 8).
 *
 * CLI: npm run bench:live -- --provider glm|deepseek|opus [--tasks L1,L2,L3]
 *      [--repeats 1] [--timeout 300] [--data-dir <dir>]
 *
 * For every task × arm (vanilla, cc), the ONE preparation path
 * (prepare.mts prepareArmSession) builds a fresh temp copy of the fixture
 * and ALWAYS writes <ws>/opencode.json with the SANDBOX_PERMISSIONS block:
 *   - cc arm: build <ws>/context.db via the indexer, register ONLY
 *     code-context in the per-workspace opencode.json (node <repo>/dist/server/index.js <db>)
 *   - vanilla arm: no MCP config, no db — same permission block
 * Then the ONE spawn site (runSession) runs the command prepare.mts built —
 * `opencode run --dir <ws> -m <model> --format json "<prompt>"` for glm and
 * deepseek, `claude -p … --output-format stream-json "<prompt>"` for opus — with an
 * isolated HOME (the user's global opencode config — with its own MCP
 * servers — must not leak into either arm) and a MINIMAL child env (only
 * PATH, HOME, TMPDIR, CODE_CONTEXT_ALLOWED_ROOTS and the one provider key;
 * never echoed, never logged). No `--auto`: the per-workspace opencode.json
 * denies bash outright and confines the built-in read/grep/glob/list/edit
 * tools to the workspace (`external_directory: deny`), so nothing outside
 * it is reachable and every refusal is non-interactive.
 *   - parse the event stream (task 7), run the deterministic checker (task 6)
 *
 * Emits the run JSON (kind agent-<provider>) into <data-dir>/runs/ and
 * rebuilds index.json + latest.json there. Publish goes through the same
 * `npm run bench:publish` — this script never pushes.
 *
 * Costs real tokens. Requires `npm run build` first (dist server for the cc arm).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, pickLatest, runFileProblem } from '../lib/index-builder.mts';
import { formatStamp } from '../lib/stamp.mts';
import {
  normalizeLive,
  RUN_ID_PREFIX,
  type LiveProvider,
  type LiveSessions,
} from '../normalize-live.mts';
import { DEFAULT_LIVE_TASKS, tasksByIds, renderPrompt, type LiveTask } from './tasks.mts';
import { runChecker } from './checkers.mts';
import { parseEventStream, type SessionUsage } from './parse-events.mts';
import { parseClaudeStream } from './parse-claude.mts';
import { ARMS, prepareArmSession, type Arm, type PreparedArm } from './prepare.mts';
import { stripProviderKeys } from './sandbox.mts';
import type { SessionResult } from '../lib/types.mts';

/**
 * Verified with one live capture per provider (opencode 1.18.30):
 * glm answers on zai-coding-plan/glm-5.3, but that provider only appears and
 * authenticates when the key is exported as ZHIPU_API_KEY (the rig's mapping:
 * ZAI_API_KEY → ZHIPU_API_KEY) — with ZAI_API_KEY alone opencode fails with
 * ProviderModelNotFoundError. deepseek needs the pinned provider block
 * (opencode-config.mts) and answers on deepseek/deepseek-v4-pro with
 * DEEPSEEK_API_KEY. `keyEnv` is the documented SOURCE name (run JSON auth);
 * `exportAs` is the name the opencode child actually reads.
 */
const PROVIDERS: Record<
  LiveProvider,
  { model: string; keyEnv: string; exportAs: string; strictCache: boolean }
> = {
  // strictCache=false: z.ai caches the tool definitions across sessions and
  // no prompt change reaches that prefix (probe 2026-10-11: 2,752 cached
  // tokens on a nonce session). Recorded, flagged in the run notes.
  glm: {
    model: 'zai-coding-plan/glm-5.3',
    keyEnv: 'ZAI_API_KEY',
    exportAs: 'ZHIPU_API_KEY',
    strictCache: false,
  },
  deepseek: {
    model: 'deepseek/deepseek-v4-pro',
    keyEnv: 'DEEPSEEK_API_KEY',
    exportAs: 'DEEPSEEK_API_KEY',
    strictCache: true,
  },
  // Claude Code headless with a long-lived token (`claude setup-token`), so
  // each session can start from an empty CLAUDE_CONFIG_DIR.
  opus: {
    model: 'claude-opus-5-5',
    keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    exportAs: 'CLAUDE_CODE_OAUTH_TOKEN',
    strictCache: true,
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const DIST_SERVER = path.join(repoRoot, 'dist', 'server', 'index.js');

function fail(message: string): never {
  console.error(`bench:live: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  provider: LiveProvider;
  tasks: string;
  repeats: number;
  timeoutSec: number;
  dataDir: string;
} {
  const out = {
    provider: '',
    tasks: DEFAULT_LIVE_TASKS,
    repeats: 1,
    timeoutSec: 300,
    dataDir: path.join(repoRoot, 'data'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    /** Consume and return the next argv value; fails on a missing value. */
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) fail(`${a} needs a value`);
      i++;
      return v;
    };
    /** Whole-number next value; rejects non-numeric input (NaN never passes). */
    const whole = (min: number): number => {
      const raw = next().trim();
      if (!/^\d+$/.test(raw) || Number(raw) < min) {
        fail(`${a} must be a whole number >= ${min} (got "${raw}")`);
      }
      return Number(raw);
    };
    if (a === '--provider') out.provider = next();
    else if (a === '--tasks') out.tasks = next();
    else if (a === '--repeats') out.repeats = whole(1);
    else if (a === '--timeout') out.timeoutSec = whole(1);
    else if (a === '--data-dir') out.dataDir = path.resolve(next());
    else fail(`unknown argument ${a} (--provider, --tasks, --repeats, --timeout, --data-dir)`);
  }
  if (!Object.hasOwn(PROVIDERS, out.provider)) {
    fail('--provider glm|deepseek|opus is required');
  }
  return out as {
    provider: LiveProvider;
    tasks: string;
    repeats: number;
    timeoutSec: number;
    dataDir: string;
  };
}

/** Env value only — never printed, never logged; goes straight to the child env. */
function resolveKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const rigKeys = path.join(os.homedir(), '.config', 'rig', 'keys.env');
  try {
    const m = new RegExp(`^${name}=(.+)$`, 'm').exec(fs.readFileSync(rigKeys, 'utf-8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no rig key store (CI) — env was the only chance */
  }
  return undefined;
}

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

interface SessionOutcome {
  result: SessionResult;
  checkDetail: string;
  /** Model id the CLI reported (claude init event); null for opencode. */
  model: string | null;
}

/**
 * The ONE agent spawn site. Consumes a PreparedArm (prepare.mts) — the
 * command, the workspace it reads, the config that confines it and the env
 * it runs with were all built together, so no arm can reach this spawn
 * without its sandbox in place.
 */
async function runSession(opts: {
  task: LiveTask;
  prep: PreparedArm;
  timeoutSec: number;
  /** false for subscription plans whose CLI reports cost 0 (GLM coding plan). */
  costKnown: boolean;
  eventsFile: string;
  stderrFile: string;
}): Promise<SessionOutcome> {
  const t0 = Date.now();
  let timedOut = false;
  let spawnError = ''; // e.g. ENOENT when opencode is not spawnable

  const child = spawn(
    opts.prep.command.bin,
    [...opts.prep.command.args, renderPrompt(opts.task, { fakeHome: opts.prep.fakeHome })],
    {
      cwd: opts.prep.ws, // claude works in its cwd; opencode also gets --dir
      env: opts.prep.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let killTimer: NodeJS.Timeout | undefined;
  let closed = false; // set on close so a late SIGKILL timer never hits a recycled pid
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      if (closed) return;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 5_000);
  }, opts.timeoutSec * 1_000);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  await new Promise<void>((resolve) => {
    child.on('close', () => {
      closed = true;
      clearTimeout(killTimer);
      resolve();
    });
    child.on('error', (err: Error) => {
      spawnError = err.message;
      resolve();
    });
  });
  clearTimeout(killer);

  const wallMs = Date.now() - t0;
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  fs.writeFileSync(opts.eventsFile, stdout);
  fs.writeFileSync(
    opts.stderrFile,
    spawnError ? `${stderr.toString('utf-8')}spawn error: ${spawnError}\n` : stderr,
  ); // diagnostics only, never printed
  // fakeHome/ws removal is owned by PreparedArm.cleanup() in the main loop.

  if (spawnError) {
    // The child never ran (nothing spawned): not a model FAIL — record the
    // cause and mark the session unsuccessful.
    return {
      result: {
        task_id: opts.task.id,
        success: false,
        timeout: false,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        first_call_cache_read: 0,
        tool_calls: 0,
        mcp_tool_calls: 0,
        wall_ms: wallMs,
        session_id: '',
        events_path: path.basename(opts.eventsFile),
      },
      checkDetail: `${opts.prep.command.bin} failed to start: ${spawnError}`,
      model: null,
    };
  }

  const lines = stdout.toString('utf-8').split('\n');
  let usage: SessionUsage;
  let model: string | null = null;
  if (opts.prep.command.bin === 'claude') {
    const cu = parseClaudeStream(lines);
    usage = cu;
    model = cu.model;
  } else {
    usage = parseEventStream(lines);
  }
  const check = await runChecker(opts.task, opts.prep.ws, usage.assistantText);

  return {
    result: {
      task_id: opts.task.id,
      success: !timedOut && check.pass,
      timeout: timedOut,
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cache_read: usage.cacheReadTokens,
        cache_write: usage.cacheWriteTokens,
      },
      first_call_cache_read: usage.firstCallCacheRead,
      // The GLM coding plan is a subscription: opencode reports cost 0, which is not a price.
      cost_usd: opts.costKnown ? usage.costUsd : null,
      tool_calls: usage.toolCalls,
      mcp_tool_calls: usage.mcpToolCalls,
      wall_ms: wallMs,
      session_id: usage.sessionId ?? '',
      events_path: path.basename(opts.eventsFile),
    },
    checkDetail: check.detail,
    model,
  };
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    fail('bench:live requires a POSIX platform — timeout handling kills whole process groups.');
  }
  const args = parseArgs(process.argv.slice(2));
  const providerMeta = PROVIDERS[args.provider];
  const tasks = tasksByIds(
    args.tasks
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const key = resolveKey(providerMeta.keyEnv);
  if (!key) {
    fail(
      `${providerMeta.keyEnv} is not set — export it (locally it lives in ~/.config/rig/keys.env) and retry. No partial run was started.`,
    );
  }
  // Drop every provider key from the parent env now that the one we need is in
  // `key`: later children (checkers, git, diagnostics) must never inherit it.
  stripProviderKeys();
  if (!fs.existsSync(DIST_SERVER)) {
    fail(
      'dist/server/index.js is missing — run `npm run build` first (the cc arm serves the MCP server from dist).',
    );
  }

  const agentBin = args.provider === 'opus' ? 'claude' : 'opencode';
  let agentVersion = 'unknown';
  try {
    agentVersion = execFileSync(agentBin, ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    fail(
      agentBin === 'claude'
        ? 'claude CLI not found on PATH — install Claude Code.'
        : 'opencode CLI not found on PATH — install it (brew install sst/tap/opencode).',
    );
  }

  const start = Date.now();
  const stamp = new Date();
  const runId = `${RUN_ID_PREFIX[args.provider]}${formatStamp(stamp)}`;

  // The indexer sandbox (src/server/indexer.ts) only allows the process cwd by
  // default; the temp workspaces need an explicit allowance, both for the
  // in-process pre-index here and for the cc arm's MCP server child below.
  const allowedRoots = [os.tmpdir(), ...(process.env.CODE_CONTEXT_ALLOWED_ROOTS?.split(',') ?? [])]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(',');
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = allowedRoots;

  const artefactDir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-live-${runId}-`));
  console.log(
    `run:      ${runId} (${providerMeta.model}, tasks ${tasks.map((t) => t.id).join(',')}, repeats ${args.repeats})`,
  );
  console.log(`artefacts: ${artefactDir}`);

  const vanilla: SessionResult[] = [];
  const cc: SessionResult[] = [];
  const ccGuided: SessionResult[] = [];
  // Typed per arm: adding an arm to ARMS without a bucket is a compile error.
  const bucket: Record<Arm, SessionResult[]> = { vanilla, cc, 'cc-guided': ccGuided };
  const indexMsSamples: number[] = [];
  const dbBytesSamples: number[] = [];
  const firstCallCacheReads: number[] = [];
  let reportedModel: string | null = null;

  for (const task of tasks) {
    for (let r = 1; r <= args.repeats; r++) {
      for (const arm of ARMS) {
        // The ONE preparation path — every arm gets its sandbox opencode.json
        // here (prepare.mts), before the ONE spawn site below consumes it.
        const prep = prepareArmSession({
          provider: args.provider,
          arm,
          model: providerMeta.model,
          fixture: task.fixture ?? 'sample',
          distServer: DIST_SERVER,
          keyExportName: providerMeta.exportAs,
          key,
          allowedRoots: process.env.CODE_CONTEXT_ALLOWED_ROOTS,
        });

        const suffix = args.repeats > 1 ? `-r${r}` : '';
        let outcome: SessionOutcome;
        try {
          outcome = await runSession({
            task,
            prep,
            timeoutSec: args.timeoutSec,
            costKnown: args.provider !== 'glm',
            eventsFile: path.join(artefactDir, `${arm}-${task.id}${suffix}.jsonl`),
            stderrFile: path.join(artefactDir, `${arm}-${task.id}${suffix}.stderr.log`),
          });
        } finally {
          prep.cleanup();
        }
        if (prep.indexInfo) {
          indexMsSamples.push(prep.indexInfo.indexMs);
          dbBytesSamples.push(prep.indexInfo.dbBytes);
        }
        bucket[arm].push(outcome.result);
        if (outcome.model) {
          if (reportedModel && reportedModel !== outcome.model) {
            fail(
              `${arm} ${task.id}: model changed mid-run (${reportedModel} → ${outcome.model}). No run file written.`,
            );
          }
          reportedModel = outcome.model;
        }

        const res = outcome.result;
        const firstRead = res.first_call_cache_read ?? 0;
        firstCallCacheReads.push(firstRead);
        // Fresh-session rule: a session whose FIRST model call reads cache did
        // not start cold. For strict providers that voids the whole run — no
        // run file is written, nothing can be published by accident.
        if (providerMeta.strictCache && firstRead > 0) {
          fail(
            `${arm} ${task.id}: first model call read ${firstRead} cached tokens — the session did not start fresh. ` +
              `No run file written. Artefacts: ${artefactDir}`,
          );
        }
        console.log(
          `  ${arm.padEnd(9)} ${task.id}${suffix ? ` r${r}` : ''}  ` +
            `${res.success ? 'PASS' : res.timeout ? 'TIMEOUT' : 'FAIL'}  ` +
            `tok ${res.tokens.input}+${res.tokens.cache_read}c→${res.tokens.output} (1st call cache ${firstRead})  ` +
            `tools ${res.tool_calls} (mcp ${res.mcp_tool_calls})  ` +
            (typeof res.cost_usd === 'number' ? `$${res.cost_usd.toFixed(4)}  ` : '') +
            `${(res.wall_ms / 1000).toFixed(1)}s  — ${outcome.checkDetail}`,
        );
      }
    }
  }

  // Indexing stats: mean over every cc workspace built for this run (each
  // task × repeat rebuilds the db), not just the last one measured.
  const meanOf = (xs: number[]): number | null =>
    xs.length > 0 ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
  const sessions: LiveSessions = {
    vanilla,
    cc,
    ccGuided,
    indexMs: meanOf(indexMsSamples),
    dbBytes: meanOf(dbBytesSamples),
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
    version: string;
  };
  const firstCallCacheTotal = firstCallCacheReads.reduce((a, b) => a + b, 0);
  const freshNote =
    agentBin === 'claude'
      ? 'fresh sessions: new fixture copy, HOME, TMPDIR and empty CLAUDE_CONFIG_DIR per session; DISABLE_PROMPT_CACHING=1; only the MCP servers on the command line; first-call cache read 0 in every session (enforced)'
      : providerMeta.strictCache
        ? 'fresh sessions: new fixture copy, HOME and TMPDIR per session; per-session nonce first in the system prompt; first-call cache read 0 in every session (enforced)'
        : `fresh sessions: new fixture copy, HOME and TMPDIR per session; per-session nonce first in the system prompt. The provider caches tool definitions across sessions and offers no off switch: ${firstCallCacheTotal} cached tokens read on first calls (both arms)`;
  const run = normalizeLive(args.provider, reportedModel ?? providerMeta.model, tasks, sessions, {
    trigger: 'manual',
    git: {
      commit: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: git('status', '--porcelain').length > 0,
    },
    now: stamp, // one clock for the artefact dir name and the run_id
    durationMs: Date.now() - start,
    codeContextVersion: pkg.version,
    agentVersion,
    agentName: agentBin === 'claude' ? 'claude-code' : 'opencode',
    notes: [
      freshNote,
      'arms: vanilla (no server) · cc (server attached, no hint) · cc-guided (server + "use code-context first" in the system prompt); both cc arms run CODE_CONTEXT_TOOLSETS=code (11 tools)',
      'task prompts are neutral: they name no tools, only that bash is disabled',
      agentBin === 'claude'
        ? 'cost: Claude Code total_cost_usd at list price with prompt caching off (upper bound)'
        : args.provider === 'glm'
          ? 'cost: not known (GLM coding plan is a subscription)'
          : 'cost: opencode step cost',
      agentBin === 'claude'
        ? 'agent prompt: Claude Code default system prompt'
        : 'agent prompt: bench prompt (opencode-config.mts benchAgentPrompt), not the opencode default',
      'tokens total = input + cache_read + output (every token the model processed)',
      agentBin === 'claude'
        ? 'tokens from Claude Code stream-json usage, counted once per API message'
        : 'tokens from opencode step-finish events; reasoning tokens folded into output',
      `key ${providerMeta.keyEnv} exported to ${agentBin} as ${providerMeta.exportAs}`,
      // No absolute temp paths in the run JSON (machine-dependent, diff-noisy):
      // the artefact dir is only printed to the runner console above.
      `artefacts retained by the runner for run ${runId}`,
    ],
  });

  const runsDir = path.join(args.dataDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runPath = path.join(runsDir, `${run.run_id}.json`);
  fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

  const allRuns = fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const p = path.join(runsDir, f);
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch (e) {
        throw new Error(`bench:live: invalid JSON in data/runs/${f}: ${(e as Error).message}`);
      }
      const problem = runFileProblem(data);
      if (problem) {
        console.warn(`bench:live: skipping data/runs/${f}: ${problem}`);
        return [];
      }
      return [data];
    });
  const index = buildIndex(allRuns);
  const latest = pickLatest(allRuns);
  fs.writeFileSync(path.join(args.dataDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  fs.writeFileSync(path.join(args.dataDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);

  const h = run.headline;
  const row = (label: string, value: string): string =>
    `│ ${label.padEnd(22)} ${value.padStart(9)} │`;
  console.log('┌───────────────────────────────────┐');
  console.log(row('success vanilla', `${h.success_vanilla_pct} %`));
  console.log(row('success cc', `${h.success_cc_pct} %`));
  console.log(row('tokens saved', `${h.tokens_saved_pct} %`));
  console.log(row('tool calls saved', `${h.tool_calls_saved_pct} %`));
  if (typeof h.success_cc_guided_pct === 'number') {
    console.log(row('success cc-guided', `${h.success_cc_guided_pct} %`));
    console.log(row('tokens saved guided', `${h.guided_tokens_saved_pct} %`));
  }
  const mc = run.aggregate as { mcp_tool_calls?: { cc: number; cc_guided?: number } };
  if (mc.mcp_tool_calls) {
    console.log(
      row('mcp calls cc / guided', `${mc.mcp_tool_calls.cc} / ${mc.mcp_tool_calls.cc_guided ?? 0}`),
    );
  }
  console.log('└───────────────────────────────────┘');
  console.log(`run:    ${path.relative(process.cwd(), runPath)}`);
  console.log(
    `index:  ${path.relative(process.cwd(), path.join(args.dataDir, 'index.json'))} (${index.runs.length} run${index.runs.length === 1 ? '' : 's'})`,
  );
  console.log(
    `latest: ${path.relative(process.cwd(), path.join(args.dataDir, 'latest.json'))} (${run.run_id})`,
  );
  console.log('publish with: npm run bench:publish');
}

main().catch((e: Error) => fail(e.message));
