/**
 * `pnpm run bench:live` — real agent benchmark (PLAN.md task 8).
 *
 * CLI: pnpm run bench:live --provider glm|deepseek|opus [--tasks L1,L2,L3]
 *      [--repeats 1] [--timeout 300] [--data-dir <dir>] [--cache-mode cold|cold-warm]
 *      [--arms vanilla,cc,cc-guided] [--suite <dir>]
 *
 * --suite <dir> (CCA-17): run the tasks of an external suite (<dir>/suite.json,
 * answers in <dir>/answers.json, see suite.mts) on a workspace built from its
 * pinned git sources. --tasks then picks suite task ids (default: all), and
 * results go to <dir>/data/ unless --data-dir says otherwise. A private
 * suite refuses a --data-dir inside this repository.
 *
 * --timeout (default 300 s): wall-clock limit per session; the agent's whole
 * process tree is killed at the limit (session.mts). A provider error, 0 model
 * calls or a machine sleep is retried once; a second failure voids the run.
 *
 * --arms (default all three): which arms run; vanilla and cc are required.
 * `--arms vanilla,cc` drops cc-guided for a cheaper run (BENCHMARK-GUIDE.md,
 * "Cheap Opus check").
 *
 * --cache-mode cold (default): every session starts cold (below).
 * --cache-mode cold-warm: per (task, arm), repeat 1 is cold — fresh index,
 * new nonce, the strict first-call cache check (strict providers only) —
 * and its index build time is added to its wall_ms (also recorded as
 * index_ms). Repeats 2..N run right
 * after it and are warm for every arm alike: same nonce, same workspace and
 * HOME paths (fresh contents), the cold session's index snapshot instead of a
 * re-index; cache reads are expected, so the strict check is skipped.
 * Claude Code runs with prompt caching ON in both phases (CCA-10).
 * Sessions carry cache_phase; the run JSON adds aggregate.by_phase. See prepare.mts for the mechanism.
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
 * `pnpm run bench:publish` — this script never pushes.
 *
 * Costs real tokens. Requires `pnpm run build` first (dist server for the cc arm).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, pickLatest, runFileProblem } from '../lib/index-builder.mts';
import { formatStamp } from '../lib/stamp.mts';
import {
  normalizeLive,
  RUN_ID_PREFIX,
  type AgentAggregate,
  type ByPhaseAgg,
  type LiveProvider,
  type LiveSessions,
  type PhaseAgg,
  type PhaseArmAgg,
} from '../normalize-live.mts';
import { DEFAULT_LIVE_TASKS, tasksByIds, renderPrompt, type LiveTask } from './tasks.mts';
import { isInside, loadSuite, type LoadedSuite } from './suite.mts';
import { runChecker } from './checkers.mts';
import { parseEventStream, type SessionUsage } from './parse-events.mts';
import { parseClaudeStream } from './parse-claude.mts';
import {
  ARMS,
  CACHE_MODES,
  cachePhaseFor,
  parseArms,
  prepareArmSession,
  type Arm,
  type CacheMode,
  type PreparedArm,
  type WarmSeed,
} from './prepare.mts';
import { stripProviderKeys } from './sandbox.mts';
import { attemptFault, preventIdleSleep, runAgentProcess } from './session.mts';
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
  // strictCache=false (CCA-10, #125): prompt caching stays ON in cold
  // sessions, as in real use. Claude Code's built-in system prompt and tool
  // definitions are identical in every session, so a first-call read of
  // that static prefix is legitimate. The per-session nonce and fresh paths
  // stop any match beyond it. Recorded, flagged in the run notes.
  opus: {
    model: 'claude-opus-5-5',
    keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    exportAs: 'CLAUDE_CODE_OAUTH_TOKEN',
    strictCache: false,
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
// BENCH_LIVE_DIST_SERVER: tests only (fake agent binaries never start the server).
const DIST_SERVER =
  process.env.BENCH_LIVE_DIST_SERVER || path.join(repoRoot, 'dist', 'server', 'index.js');

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
  cacheMode: CacheMode;
  arms: Arm[];
  suiteDir: string | null;
  tasksGiven: boolean;
  dataDirGiven: boolean;
} {
  const out = {
    provider: '',
    tasks: DEFAULT_LIVE_TASKS,
    suiteDir: null as string | null,
    tasksGiven: false,
    dataDirGiven: false,
    repeats: 1,
    timeoutSec: 300,
    dataDir: path.join(repoRoot, 'data'),
    cacheMode: 'cold' as CacheMode,
    arms: [...ARMS] as Arm[],
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
    else if (a === '--tasks') {
      out.tasks = next();
      out.tasksGiven = true;
    } else if (a === '--suite') out.suiteDir = path.resolve(next());
    else if (a === '--repeats') out.repeats = whole(1);
    else if (a === '--timeout') out.timeoutSec = whole(1);
    else if (a === '--data-dir') {
      out.dataDir = path.resolve(next());
      out.dataDirGiven = true;
    } else if (a === '--cache-mode') {
      const m = next();
      if (!(CACHE_MODES as readonly string[]).includes(m)) {
        fail(`--cache-mode must be ${CACHE_MODES.join('|')} (got "${m}")`);
      }
      out.cacheMode = m as CacheMode;
    } else if (a === '--arms') {
      try {
        out.arms = parseArms(next());
      } catch (e) {
        fail((e as Error).message);
      }
    } else
      fail(
        `unknown argument ${a} (--provider, --tasks, --repeats, --timeout, --data-dir, --cache-mode, --arms, --suite)`,
      );
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
    cacheMode: CacheMode;
    arms: Arm[];
    suiteDir: string | null;
    tasksGiven: boolean;
    dataDirGiven: boolean;
  };
}

/** The suite's tasks by id (all when `ids` is empty), in the order asked. */
function suiteTasksByIds(suite: LoadedSuite, ids: string[]): LiveTask[] {
  if (ids.length === 0) return suite.tasks;
  return ids.map((id) => {
    const t = suite.tasks.find((x) => x.id === id);
    if (!t) {
      fail(
        `unknown task id ${id} in suite ${suite.id} (known: ${suite.tasks.map((x) => x.id).join(', ')})`,
      );
    }
    return t;
  });
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
  /** Provider/API error the CLI reported; null when none. */
  providerError: string | null;
  /** Model calls that reported usage; 0 = the model never answered. */
  modelCalls: number;
  /** Model id the CLI reported (claude init event); null for opencode. */
  model: string | null;
  /** The machine slept while the session ran (wall-clock gap; #146). */
  slept: boolean;
}

/**
 * The ONE agent spawn site. Consumes a PreparedArm (prepare.mts) — the
 * command, the workspace it reads, the config that confines it and the env
 * it runs with were all built together, so no arm can reach this spawn
 * without its sandbox in place. session.mts runAgentProcess owns the child:
 * own process group, wall-clock deadline, SIGTERM then SIGKILL to the whole
 * tree, no unbounded wait on the pipes (#146).
 */
async function runSession(opts: {
  task: LiveTask;
  prep: PreparedArm;
  timeoutSec: number;
  /** false for subscription plans whose CLI reports cost 0 (GLM coding plan). */
  costKnown: boolean;
  eventsFile: string;
  stderrFile: string;
  /** SIGTERM → SIGKILL grace (BENCH_LIVE_KILL_GRACE_MS; tests only). */
  graceMs?: number;
}): Promise<SessionOutcome> {
  const proc = await runAgentProcess({
    bin: opts.prep.command.bin,
    args: [...opts.prep.command.args, renderPrompt(opts.task, { fakeHome: opts.prep.fakeHome })],
    cwd: opts.prep.ws, // claude works in its cwd; opencode also gets --dir
    env: opts.prep.env,
    timeoutMs: opts.timeoutSec * 1_000,
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
  });
  const { stdout, stderr, timedOut, slept, spawnError } = proc;

  const wallMs = proc.wallMs;
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
      providerError: `${opts.prep.command.bin} failed to start: ${spawnError}`,
      modelCalls: 0,
      slept,
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
    providerError: usage.providerError ?? null,
    modelCalls: usage.modelCalls,
    slept,
  };
}

/** Cold vs warm per arm, per-session means (cold-warm runs). */
function printPhaseSummary(phases: ByPhaseAgg): void {
  const per = (a: PhaseArmAgg | undefined, f: (x: PhaseArmAgg) => number): string =>
    a && a.sessions > 0 ? String(Math.round(f(a) / a.sessions)) : '–';
  console.log('cold vs warm (means per session; cold wall includes the index build):');
  console.log(
    `  ${'arm'.padEnd(10)} ${'phase'.padEnd(5)} ${'n'.padStart(3)} ${'tokens'.padStart(9)} ${'uncached'.padStart(9)} ${'calls'.padStart(6)} ${'mcp'.padStart(5)} ${'wall s'.padStart(7)} ${'success'.padStart(8)}`,
  );
  const armKeys: Array<[string, keyof PhaseAgg]> = [
    ['vanilla', 'vanilla'],
    ['cc', 'cc'],
    ['cc-guided', 'cc_guided'],
  ];
  for (const [label, key] of armKeys) {
    for (const phase of ['cold', 'warm'] as const) {
      const a = phases[phase]?.[key];
      if (!a) continue;
      console.log(
        `  ${label.padEnd(10)} ${phase.padEnd(5)} ${String(a.sessions).padStart(3)} ` +
          `${per(a, (x) => x.tokens.total).padStart(9)} ${per(a, (x) => x.uncached_tokens).padStart(9)} ` +
          `${per(a, (x) => x.tool_calls).padStart(6)} ${per(a, (x) => x.mcp_tool_calls).padStart(5)} ` +
          `${(a.wall_ms_mean / 1000).toFixed(1).padStart(7)} ${`${Math.round(a.success_rate * 100)} %`.padStart(8)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    fail('bench:live requires a POSIX platform — timeout handling kills whole process groups.');
  }
  const args = parseArgs(process.argv.slice(2));
  const providerMeta = PROVIDERS[args.provider];
  const taskIds = args.tasks
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let suite: LoadedSuite | undefined;
  if (args.suiteDir) {
    try {
      suite = loadSuite(args.suiteDir, { repoRoot });
    } catch (e) {
      fail((e as Error).message);
    }
    if (!args.dataDirGiven) args.dataDir = path.join(suite.dir, 'data');
    // A private suite's results never land in this repository (CCA-17).
    if (suite.private && isInside(args.dataDir, repoRoot)) {
      fail(
        `--data-dir ${args.dataDir} is inside this repository; a private suite keeps its results outside it (default: ${path.join(suite.dir, 'data')})`,
      );
    }
  }
  const tasks = suite
    ? suiteTasksByIds(suite, args.tasksGiven ? taskIds : [])
    : tasksByIds(taskIds);

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
      'dist/server/index.js is missing — run `pnpm run build` first (the cc arm serves the MCP server from dist).',
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

  // A Mac on battery idle-sleeps mid-run otherwise (2026-10-11: ~900 s
  // sessions, 0-call sessions, voided runs — #146).
  const awake = preventIdleSleep();
  const artefactDir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-live-${runId}-`));
  const coldWarm = args.cacheMode === 'cold-warm';
  console.log(
    `run:      ${runId} (${providerMeta.model}, tasks ${tasks.map((t) => t.id).join(',')}, repeats ${args.repeats}` +
      `${coldWarm ? ', cache mode cold-warm' : ''}, arms ${args.arms.join(',')}, ` +
      `${tasks.length * args.arms.length * args.repeats} sessions)`,
  );
  console.log(`artefacts: ${artefactDir}`);
  if (process.platform === 'darwin' && !awake) {
    console.warn('bench:live: caffeinate not started — the Mac may idle-sleep during sessions.');
  }

  const vanilla: SessionResult[] = [];
  const cc: SessionResult[] = [];
  const ccGuided: SessionResult[] = [];
  // Typed per arm: adding an arm to ARMS without a bucket is a compile error.
  const bucket: Record<Arm, SessionResult[]> = { vanilla, cc, 'cc-guided': ccGuided };
  const indexMsSamples: number[] = [];
  const dbBytesSamples: number[] = [];
  const firstCallCacheReads: number[] = [];
  let reportedModel: string | null = null;

  // Session order. cold: task → repeat → arm (unchanged). cold-warm:
  // task → arm → repeat, so the warm repeats follow their cold session
  // directly and the provider caches (Anthropic: 5 min TTL) are still alive.
  const schedule: Array<{ task: LiveTask; r: number; arm: Arm }> = [];
  for (const task of tasks) {
    if (coldWarm) {
      for (const arm of args.arms) {
        for (let r = 1; r <= args.repeats; r++) schedule.push({ task, r, arm });
      }
    } else {
      for (let r = 1; r <= args.repeats; r++) {
        for (const arm of args.arms) schedule.push({ task, r, arm });
      }
    }
  }
  // Warm seeds per (task, arm): the cold session's nonce, paths and index snapshot.
  const seeds = new Map<string, WarmSeed>();
  process.on('exit', () => {
    for (const s of seeds.values()) s.dispose();
  });

  const graceEnv = process.env.BENCH_LIVE_KILL_GRACE_MS;
  const graceMs = graceEnv && /^\d+$/.test(graceEnv) ? Number(graceEnv) : undefined;
  // Every retry (#146): listed in the run notes.
  const retries: string[] = [];

  for (const { task, r, arm } of schedule) {
    const phase = cachePhaseFor(args.cacheMode, r);
    const seedKey = `${task.id}|${arm}`;
    const warmFrom = phase === 'warm' ? seeds.get(seedKey) : undefined;
    if (phase === 'warm' && !warmFrom) fail(`${arm} ${task.id} r${r}: no cold seed to warm from`);
    const suffix = args.repeats > 1 ? `-r${r}` : '';
    const label = `${arm} ${task.id}${suffix ? ` r${r}` : ''}`;

    // One attempt, and ONE retry when the attempt is a harness or provider
    // fault (provider error, 0 model calls, machine slept — attemptFault).
    // The retry gets a fresh workspace and HOME through the same prepare
    // path: a cold session stays cold with a new nonce (and a new seed for
    // its warm repeats); a warm session rebuilds from the same warm seed.
    // The retry replaces the failed attempt; the run is voided only when it
    // fails too (#112).
    let outcome: SessionOutcome | undefined;
    let prep: PreparedArm | undefined;
    let firstFault: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The ONE preparation path — every arm gets its sandbox opencode.json
      // here (prepare.mts), before the ONE spawn site below consumes it.
      prep = prepareArmSession({
        provider: args.provider,
        arm,
        model: providerMeta.model,
        fixture: task.fixture ?? 'sample',
        ...(suite ? { suite } : {}),
        distServer: DIST_SERVER,
        keyExportName: providerMeta.exportAs,
        key,
        allowedRoots: process.env.CODE_CONTEXT_ALLOWED_ROOTS,
        ...(coldWarm && phase === 'cold' && args.repeats > 1 ? { seed: true } : {}),
        ...(warmFrom ? { warmFrom } : {}),
      });
      if (prep.seed) {
        seeds.get(seedKey)?.dispose(); // a retried cold session replaces its seed
        seeds.set(seedKey, prep.seed);
      }
      const tag = attempt > 1 ? `-retry${attempt - 1}` : '';
      try {
        outcome = await runSession({
          task,
          prep,
          timeoutSec: args.timeoutSec,
          costKnown: args.provider !== 'glm',
          eventsFile: path.join(artefactDir, `${arm}-${task.id}${suffix}${tag}.jsonl`),
          stderrFile: path.join(artefactDir, `${arm}-${task.id}${suffix}${tag}.stderr.log`),
          ...(graceMs !== undefined ? { graceMs } : {}),
        });
      } finally {
        prep.cleanup();
      }
      const fault = attemptFault({
        providerError: outcome.providerError,
        modelCalls: outcome.modelCalls,
        slept: outcome.slept,
        timeout: outcome.result.timeout,
      });
      if (!fault) break;
      if (attempt === 1) {
        firstFault = fault;
        retries.push(`retry: ${arm} ${task.id} r${r} — ${fault}`);
        console.log(`  ${label}  RETRY  — ${fault}`);
        continue;
      }
      // A provider error or a session in which the model never answered is
      // not a model FAIL: it voids the run, so a rate limit can never be
      // published as "the model failed" (Opus ladder 2026-10-11: a plan
      // session limit turned 29 of 45 sessions into 0-call FAILs).
      // outcome.providerError || outcome.modelCalls === 0 → attemptFault.
      fail(
        `${arm} ${task.id}: ${fault}. Retried once (first attempt: ${firstFault}). ` +
          `No run file written. Artefacts: ${artefactDir}`,
      );
    }
    if (!outcome || !prep) fail(`${label}: no session outcome`);

    if (r === args.repeats) {
      seeds.get(seedKey)?.dispose(); // last repeat of this (task, arm)
      seeds.delete(seedKey);
    }
    // Index stats: fresh builds only (a warm session copies the cold one's db).
    if (prep.indexInfo && phase === 'cold') {
      indexMsSamples.push(prep.indexInfo.indexMs);
      dbBytesSamples.push(prep.indexInfo.dbBytes);
    }
    if (coldWarm) {
      // First-time cost belongs to the cold session: its index build
      // counts in its wall time. Warm sessions reuse the index (0).
      const indexMs = phase === 'cold' && prep.indexInfo ? prep.indexInfo.indexMs : 0;
      outcome.result.wall_ms += indexMs;
      outcome.result.cache_phase = phase;
      outcome.result.index_ms = indexMs;
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
    if (phase === 'cold') firstCallCacheReads.push(firstRead);
    // Fresh-session rule: a session whose FIRST model call reads cache did
    // not start cold. For strict providers that voids the whole run — no
    // run file is written, nothing can be published by accident. Warm
    // sessions (cold-warm mode) are meant to read cache: not checked.
    if (phase === 'cold' && providerMeta.strictCache && firstRead > 0) {
      fail(
        `${arm} ${task.id}: first model call read ${firstRead} cached tokens — the session did not start fresh. ` +
          `No run file written. Artefacts: ${artefactDir}`,
      );
    }
    console.log(
      `  ${arm.padEnd(9)} ${task.id}${suffix ? ` r${r}` : ''}${coldWarm ? ` ${phase}` : ''}  ` +
        `${res.success ? 'PASS' : res.timeout ? 'TIMEOUT' : 'FAIL'}  ` +
        `tok ${res.tokens.input}+${res.tokens.cache_read}c+${res.tokens.cache_write}w→${res.tokens.output} (1st call cache ${firstRead})  ` +
        `tools ${res.tool_calls} (mcp ${res.mcp_tool_calls})  ` +
        (typeof res.cost_usd === 'number' ? `$${res.cost_usd.toFixed(4)}  ` : '') +
        `${(res.wall_ms / 1000).toFixed(1)}s` +
        (coldWarm && res.index_ms ? ` (index ${res.index_ms} ms)` : '') +
        `  — ${outcome.checkDetail}`,
    );
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
  const coldFreshNote =
    agentBin === 'claude'
      ? 'fresh sessions: new fixture copy, HOME, TMPDIR and empty CLAUDE_CONFIG_DIR per session; per-session nonce first in --append-system-prompt; only the MCP servers on the command line; ' +
        "prompt caching ON as in real Claude Code use (no DISABLE_PROMPT_CACHING). First-call cache reads are not enforced to 0: Claude Code's built-in system prompt and tool definitions are identical in every session, so that static prefix can be read from cache; the nonce and fresh paths stop any match beyond it. " +
        `${firstCallCacheTotal} cached tokens read on first calls (all arms, cold sessions); cache writes (cache_write) are the honest cold cost and count as uncached tokens`
      : providerMeta.strictCache
        ? 'fresh sessions: new fixture copy, HOME and TMPDIR per session; per-session nonce first in the system prompt; first-call cache read 0 in every session (enforced)'
        : `fresh sessions: new fixture copy, HOME and TMPDIR per session; per-session nonce first in the system prompt. The provider caches tool definitions across sessions and offers no off switch: ${firstCallCacheTotal} cached tokens read on first calls (both arms)`;
  const cacheNotes = coldWarm
    ? [
        `cache mode: cold-warm — per task and arm, repeat 1 is cold and repeats 2..${args.repeats} are warm (sessions carry cache_phase; aggregate.by_phase compares them)`,
        `cold sessions (repeat 1): ${coldFreshNote.replace(/^fresh sessions: /, '').replace(/ in every session \(enforced\)/, ' in every cold session (enforced)')}`,
        agentBin === 'claude'
          ? 'warm sessions (repeats 2..N): fresh fixture copy and HOME at the cold session’s paths, the cold session’s nonce and index reused (copied, not rebuilt), same args and env as cold; first-call cache reads expected and not checked'
          : 'warm sessions (repeats 2..N): fresh fixture copy and HOME at the cold session’s paths, the cold session’s nonce and index reused (copied, not rebuilt); first-call cache reads expected and not checked',
        'wall_ms of a cold cc session includes its index build (index_ms); warm sessions index_ms 0; aggregate wall means cover both phases',
        'session order: task → arm → repeat (warm repeats run right after their cold session)',
      ]
    : [coldFreshNote];
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
    ...(suite ? { suite } : {}),
    notes: [
      ...(suite
        ? [
            `suite ${suite.id}: ${suite.sources.length} pinned git source(s), workspace built with git archive per session` +
              (suite.redact
                ? '; redacted: tasks stored by id + sha256, no prompt or answer text'
                : ''),
          ]
        : []),
      ...cacheNotes,
      `session timeout ${args.timeoutSec} s on the wall clock: SIGTERM, then SIGKILL to the agent's whole process tree; a timed-out session keeps its partial usage (timeout: true). A provider error, 0 model calls or a machine sleep during the session is retried once with a fresh workspace and HOME; the retry replaces the attempt, and a second failure voids the run`,
      ...(retries.length > 0 ? retries : ['retries: none']),
      `arms run: ${args.arms.join(', ')} — vanilla (no server) · cc (server attached, no hint) · cc-guided (server + "use code-context first" in the system prompt); every cc arm runs CODE_CONTEXT_TOOLSETS=code (6 tools)`,
      'task prompts are neutral: they name no tools, only that bash is disabled',
      agentBin === 'claude'
        ? 'cost: Claude Code total_cost_usd (result event) at list price with prompt caching ON in every session: cache writes at the cache-write rate (1.25x input, 5-min TTL), cache reads at the cache-read rate (0.1x input), so the per-call overhead of the static prefix and tool definitions is priced at cache-read rates after the call that wrote it. Runs before CCA-10 (#125) had caching off and overstate that overhead about 10x'
        : args.provider === 'glm'
          ? 'cost: not known (GLM coding plan is a subscription)'
          : 'cost: opencode step cost',
      agentBin === 'claude'
        ? 'agent prompt: Claude Code default system prompt'
        : 'agent prompt: bench prompt (opencode-config.mts benchAgentPrompt), not the opencode default',
      'tokens total = input + cache_read + output (every token the model processed)',
      agentBin === 'claude'
        ? 'tokens from Claude Code stream-json: totals from the final result event usage (input_tokens, output_tokens, cache_read_input_tokens → cache_read, cache_creation_input_tokens → cache_write); per-message usage (once per API message id) only when a stream has no result event'
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
  const phases = (run.aggregate as AgentAggregate).by_phase;
  if (phases) printPhaseSummary(phases);
  console.log(`run:    ${path.relative(process.cwd(), runPath)}`);
  console.log(
    `index:  ${path.relative(process.cwd(), path.join(args.dataDir, 'index.json'))} (${index.runs.length} run${index.runs.length === 1 ? '' : 's'})`,
  );
  console.log(
    `latest: ${path.relative(process.cwd(), path.join(args.dataDir, 'latest.json'))} (${run.run_id})`,
  );
  console.log('publish with: pnpm run bench:publish');
}

main().catch((e: Error) => fail(e.message));
