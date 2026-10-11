/**
 * ONE preparation path for every live-bench arm (security audit 2026-10-10,
 * finding 2: the glm vanilla arm used to spawn with NO opencode.json, i.e.
 * an empty permission ruleset).
 *
 * `prepareArmSession` is the only way a session workspace comes into
 * existence, and it ALWAYS writes `<ws>/opencode.json` carrying
 * `SANDBOX_PERMISSIONS` before anything is spawned — for vanilla and cc,
 * for glm and deepseek. It also owns the isolated fake HOME (with a real
 * `.profile` marker file, so probe reads hit `external_directory` deny
 * instead of a mere ENOENT) and the minimal agent env (sandbox.mts).
 *
 * run.mts has exactly ONE spawn site and it consumes a `PreparedArm`
 * (`prep.command`) — there is no code path that spawns an agent without going
 * through this module (guarded by test/bench-live-prepare.test.ts and the
 * source guards in test/bench-guard.test.ts).
 *
 * Fresh-session rule (2026-10-11): every session starts with nothing to
 * read from — a new fixture copy, a new HOME with its own TMPDIR (the agent
 * CLI's caches, model catalogue and session store all live under it), a
 * fresh index for the cc arm only, and a vanilla workspace proven to hold no
 * index. Provider prompt caches are handled per CLI: opencode sessions get a
 * per-session nonce as the first line of the system prompt
 * (opencode-config.mts benchAgentPrompt); Claude Code sessions run with an
 * empty CLAUDE_CONFIG_DIR, only the MCP servers named on the command line and
 * the same nonce as the first line of --append-system-prompt
 * (claudeAppendPrompt).
 *
 * Opus prompt caching (CCA-10, #125): ON in every session, cold and warm, as
 * in real Claude Code use. The 2.9.0 Opus runs set DISABLE_PROMPT_CACHING=1
 * and so paid full input price for the tool definitions on every call, about
 * 10x what a real session pays. "Cold" now means: fresh HOME, config dir,
 * workspace path and session, plus the per-session nonce, so no earlier cache
 * entry can match beyond Claude Code's static prefix (built-in system prompt
 * and tool definitions, identical in every session and every install). A
 * first-call read of that prefix is legitimate; run.mts records it, does not
 * enforce 0 (strictCache=false), and counts cache writes as the cold cost.
 *
 * Cold-then-warm mode (`--cache-mode cold-warm`, 2026-10-11): repeat 1 of a
 * (task, arm) is cold exactly as above and also leaves a `WarmSeed` — its
 * nonce, its workspace and HOME paths, the file mtimes of its fixture copy
 * and a snapshot of its freshly built index (taken before the agent runs).
 * Repeats 2..N are warm: `warmFrom` rebuilds a FRESH fixture copy and a
 * FRESH HOME at the SAME paths (cwd and HOME appear in the agent's system
 * prompt and task prompt, and the index stores absolute paths), restores the
 * mtimes (so the server's read-time freshness check sees nothing stale),
 * copies the index snapshot instead of re-indexing, and reuses the nonce, so
 * the provider prompt prefix of repeat 1 matches again. Claude Code args and
 * env are identical in both phases (prompt caching ON in both).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../../src/server/schema.js';
import { indexDirectory } from '../../../src/server/indexer.js';
import type { LiveProvider } from '../normalize-live.mts';
import {
  CC_GUIDANCE,
  writeOpencodeConfig,
  type WriteOpencodeConfigOpts,
} from './opencode-config.mts';
import { agentSpawnEnv } from './sandbox.mts';
import { writeLargeFixture } from './large-fixture/generate.mts';
import { CODE_CONTEXT_SERVER_ALIAS } from './parse-events.mts';
import type { FixtureKind } from './tasks.mts';

/**
 * Claude Code built-in tools for the opus arm — the same capabilities the
 * opencode sandbox allows (read, search, edit). No Bash, no Write, no web,
 * no sub-agents. acceptEdits confines edits to the working directory, and
 * reads outside it need a permission that -p mode never grants.
 */
export const CLAUDE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Edit'];

/**
 * The opus arm's --append-system-prompt: the per-session nonce first, then
 * the cc-guided rule. Claude Code has no slot in front of its own system
 * prompt (--system-prompt would replace the agent), so the nonce opens the
 * appended part — the first text after the static prefix. Every arm gets the
 * nonce line; only cc-guided gets the guidance.
 */
export function claudeAppendPrompt(nonce: string, guidance?: string): string {
  return [`bench-session ${nonce}`, ...(guidance ? [guidance] : [])].join('\n');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const FIXTURE = path.join(repoRoot, 'test', 'fixtures', 'sample-project');

/**
 * Copy the task's source into a fresh workspace. 'sample' = the 10-file
 * fixture; 'src' = this repo's src/ (≈160 files) plus package.json and
 * tsconfig.json — a real codebase for the larger ladder tasks; 'large' = the
 * generated ~680-file fixture of the index-shaped tasks (CCA-09), written
 * from the deterministic generator and refused when its sha256 differs from
 * the pinned one. node_modules and build output are never copied.
 */
export function copyFixture(kind: FixtureKind, ws: string): void {
  if (kind === 'sample') {
    fs.cpSync(FIXTURE, ws, { recursive: true });
    return;
  }
  if (kind === 'large') {
    writeLargeFixture(ws);
    return;
  }
  fs.cpSync(path.join(repoRoot, 'src'), path.join(ws, 'src'), {
    recursive: true,
    filter: (p) => !p.split(path.sep).some((part) => part === 'node_modules' || part === 'dist'),
  });
  for (const f of ['package.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(repoRoot, f), path.join(ws, f));
  }
}

/** Every bench arm — run.mts iterates this; tests enumerate it exhaustively. */
/**
 * vanilla = no server; cc = server attached, no hint; cc-guided = server
 * attached plus the rig's rule to use it first (CC_GUIDANCE). Both cc arms
 * load the code tools only (CODE_CONTEXT_TOOLSETS=code).
 */
export const ARMS = ['vanilla', 'cc', 'cc-guided'] as const;
export type Arm = (typeof ARMS)[number];

/**
 * Parse `--arms` (comma list). vanilla and cc are required (the headline
 * compares them); cc-guided is optional. Returned in ARMS order, deduplicated.
 */
export function parseArms(list: string): Arm[] {
  const names = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!(ARMS as readonly string[]).includes(n)) {
      throw new Error(`--arms: unknown arm "${n}" (known: ${ARMS.join(', ')})`);
    }
  }
  for (const req of ['vanilla', 'cc'] as const) {
    if (!names.includes(req)) throw new Error(`--arms must include ${req} (got "${list}")`);
  }
  return ARMS.filter((a) => names.includes(a));
}

/** `cold` = every session cold (default); `cold-warm` = repeat 1 cold, repeats 2..N warm. */
export const CACHE_MODES = ['cold', 'cold-warm'] as const;
export type CacheMode = (typeof CACHE_MODES)[number];
export type CachePhase = 'cold' | 'warm';

/** The phase of repeat `repeat` (1-based) of one (task, arm) under `mode`. */
export function cachePhaseFor(mode: CacheMode, repeat: number): CachePhase {
  return mode === 'cold-warm' && repeat > 1 ? 'warm' : 'cold';
}

/**
 * What a cold session leaves for the warm repeats of the same (task, arm):
 * the nonce, the paths to rebuild at, the fixture mtimes and the index
 * snapshot (cc arms). Owned by the runner; `dispose()` removes the snapshot.
 */
export interface WarmSeed {
  provider: LiveProvider;
  arm: Arm;
  fixture: FixtureKind;
  nonce: string;
  ws: string;
  fakeHome: string;
  /** Workspace-relative path → mtime (ms) of the cold session's fixture copy. */
  mtimes: Array<[string, number]>;
  /** Snapshot of the cold session's index db, taken before the agent ran (cc arms). */
  indexDb?: string;
  dbBytes?: number;
  dispose(): void;
}

export interface PrepareArmOpts {
  provider: LiveProvider;
  arm: Arm;
  /** Model id passed to the agent CLI. */
  model: string;
  /** Workspace source (task.fixture); defaults to 'sample'. */
  fixture?: FixtureKind;
  /** Repo dist server (cc arm MCP command); existence is checked by run.mts. */
  distServer: string;
  /** Name the opencode child reads the provider key under. */
  keyExportName: string;
  /** Provider key value — never logged, goes straight into the child env. */
  key: string;
  /** CODE_CONTEXT_ALLOWED_ROOTS for the child; omit to skip the variable. */
  allowedRoots?: string;
  /** Parent dir for the temp workspace/HOME (tests); defaults to os.tmpdir(). */
  tmpdir?: string;
  /** Cold session that seeds warm repeats: also return `seed` (cold-warm mode). */
  seed?: boolean;
  /** Warm session: rebuild from this cold session's seed (cold-warm mode). */
  warmFrom?: WarmSeed;
}

export interface IndexInfo {
  indexMs: number;
  dbBytes: number;
}

export interface PreparedArm {
  /** Fresh temp copy of the fixture — the agent's whole world. */
  ws: string;
  /** Always `<ws>/opencode.json`, ALWAYS written before spawn. */
  configPath: string;
  /** Present for the cc arm only (index timing stats). */
  indexInfo?: IndexInfo;
  /** Isolated HOME for the opencode child (contains only the .profile marker). */
  fakeHome: string;
  /** Minimal agent spawn env (sandbox.mts agentSpawnEnv). */
  env: NodeJS.ProcessEnv;
  /** The agent CLI and its arguments; run.mts appends the task prompt. */
  command: { bin: 'opencode' | 'claude'; args: string[] };
  /** Per-session nonce (first line of the opencode system prompt; first line of the opus --append-system-prompt). */
  nonce: string;
  /** 'warm' only when prepared from a WarmSeed. */
  cachePhase: CachePhase;
  /** Present when prepared with `seed: true` (cold-warm repeat 1). */
  seed?: WarmSeed;
  /** Remove the workspace and the fake HOME. */
  cleanup(): void;
}

function buildIndexDb(ws: string): IndexInfo {
  const dbPath = path.join(ws, 'context.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  const t0 = Date.now();
  indexDirectory(db, ws);
  const indexMs = Date.now() - t0;
  db.close();
  return { indexMs, dbBytes: fs.statSync(dbPath).size };
}

/** Every regular file under `dir`, workspace-relative, with its mtime (ms), sorted. */
function fileMtimes(dir: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push([r, fs.statSync(path.join(dir, r)).mtimeMs]);
    }
  };
  walk('');
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Recreate `dir` empty; it must not exist (the previous session cleaned it up). */
function recreateDir(dir: string, what: string): string {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    throw new Error(
      `prepareArmSession: cannot recreate the warm ${what} at ${dir}: ${(e as Error).message}`,
    );
  }
  return dir;
}

/**
 * Prepare ONE arm session: fresh workspace, index db (cc only), the sandbox
 * opencode.json (ALWAYS), and the minimal agent env. The single function
 * every arm — provider × vanilla/cc — goes through before spawning.
 */
export function prepareArmSession(opts: PrepareArmOpts): PreparedArm {
  const tmpdir = opts.tmpdir ?? os.tmpdir();
  const fixture = opts.fixture ?? 'sample';
  const warm = opts.warmFrom;
  if (warm && opts.seed) throw new Error('prepareArmSession: seed and warmFrom exclude each other');
  if (
    warm &&
    (warm.provider !== opts.provider || warm.arm !== opts.arm || warm.fixture !== fixture)
  ) {
    throw new Error(
      `prepareArmSession: warm seed is for ${warm.provider}/${warm.arm}/${warm.fixture}, not ${opts.provider}/${opts.arm}/${fixture}`,
    );
  }
  // Warm: the SAME nonce as the cold session, so the provider prompt prefix matches.
  const nonce = warm ? warm.nonce : randomUUID();

  // Warm: a FRESH fixture copy at the SAME path (cwd is part of the agent's
  // system prompt and the index stores absolute paths), with the cold copy's
  // mtimes restored so the server's freshness check finds nothing stale.
  const ws = warm
    ? recreateDir(warm.ws, 'workspace')
    : fs.mkdtempSync(path.join(tmpdir, 'bench-ws-'));
  copyFixture(fixture, ws);
  if (warm) {
    for (const [rel, mtimeMs] of warm.mtimes) {
      const abs = path.join(ws, rel);
      // Seconds as a float keep sub-millisecond precision; a Date rounds to whole ms.
      const t = mtimeMs / 1000;
      fs.utimesSync(abs, t, t);
    }
  }
  const mtimes = opts.seed ? fileMtimes(ws) : [];

  const mcpCommand = [process.execPath, opts.distServer, path.join(ws, 'context.db')];
  const configOpts: WriteOpencodeConfigOpts = { nonce };
  let indexInfo: IndexInfo | undefined;
  const withServer = opts.arm !== 'vanilla';
  const guidance = opts.arm === 'cc-guided' ? CC_GUIDANCE : undefined;
  if (guidance) configOpts.guidance = guidance;
  let seedDir: string | undefined;
  let seedDb: string | undefined;
  if (withServer && warm) {
    // Reuse the cold session's index: copy, never re-index (index_ms = 0).
    if (!warm.indexDb) throw new Error('prepareArmSession: warm seed has no index snapshot');
    fs.copyFileSync(warm.indexDb, path.join(ws, 'context.db'));
    indexInfo = { indexMs: 0, dbBytes: fs.statSync(path.join(ws, 'context.db')).size };
    configOpts.mcp = { command: mcpCommand };
  } else if (withServer) {
    indexInfo = buildIndexDb(ws);
    configOpts.mcp = { command: mcpCommand };
    if (opts.seed) {
      // Snapshot BEFORE the agent runs: the server may re-index files the
      // agent edits, and those edits must not leak into the warm repeats.
      seedDir = fs.mkdtempSync(path.join(tmpdir, 'bench-seed-'));
      seedDb = path.join(seedDir, 'context.db');
      fs.copyFileSync(path.join(ws, 'context.db'), seedDb);
    }
  }
  if (opts.provider === 'deepseek') {
    configOpts.includeDeepseekProvider = true; // model resolution only
  }
  // The sandbox contract: EVERY arm carries SANDBOX_PERMISSIONS. Even with
  // no mcp and no provider block, the config is still written.
  const configPath = writeOpencodeConfig(ws, configOpts);

  if (opts.arm === 'vanilla') {
    for (const f of ['context.db', '.code-context']) {
      if (fs.existsSync(path.join(ws, f))) {
        throw new Error(
          `prepareArmSession: vanilla workspace holds ${f} — it must start without an index`,
        );
      }
    }
  }

  // Warm: a FRESH HOME at the SAME path (the task prompt names it).
  const fakeHome = warm
    ? recreateDir(warm.fakeHome, 'HOME')
    : fs.mkdtempSync(path.join(tmpdir, 'bench-home-'));
  // A real file outside the workspace: probe reads of `$HOME/…` must be
  // refused by external_directory, not pass because the path is missing.
  fs.writeFileSync(path.join(fakeHome, '.profile'), '# bench sandbox home\n');
  // Own TMPDIR per session: nothing a CLI caches in its temp dir survives
  // into the next session.
  const sessionTmp = path.join(fakeHome, 'tmp');
  fs.mkdirSync(sessionTmp);

  let command: PreparedArm['command'];
  let extra: Record<string, string> = {};
  if (opts.provider === 'opus') {
    // Claude Code: empty config dir (no CLAUDE.md, memory, settings, hooks,
    // plugins), only the MCP servers in this file. Both cc arms ALWAYS load
    // the code toolset (CODE_CONTEXT_TOOLSETS=code): Claude Code starts the
    // server with its own env plus this `env`, and the minimal agent env
    // (sandbox.mts) carries no CODE_CONTEXT_TOOLSETS that could widen it.
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir);
    const mcpConfigPath = path.join(fakeHome, 'mcp.json');
    const servers = withServer
      ? {
          [CODE_CONTEXT_SERVER_ALIAS]: {
            command: mcpCommand[0],
            args: mcpCommand.slice(1),
            env: { CODE_CONTEXT_TOOLSETS: 'code' },
          },
        }
      : {};
    fs.writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
    // Variadic options (--mcp-config, --tools, --allowedTools) are always
    // followed by another option, so the prompt run.mts appends stays positional.
    command = {
      bin: 'claude',
      args: [
        '-p',
        '--mcp-config',
        mcpConfigPath,
        '--tools',
        ...CLAUDE_TOOLS,
        ...(withServer ? ['--allowedTools', `mcp__${CODE_CONTEXT_SERVER_ALIAS}`] : []),
        '--append-system-prompt',
        claudeAppendPrompt(nonce, guidance),
        '--strict-mcp-config',
        '--permission-mode',
        'acceptEdits',
        '--no-session-persistence',
        '--verbose',
        '--model',
        opts.model,
        '--output-format',
        'stream-json',
      ],
    };
    // Prompt caching ON in cold and warm sessions (CCA-10): never set
    // DISABLE_PROMPT_CACHING. Cold = fresh paths + new nonce, so only the
    // static prefix can be read from cache; warm = same paths + same nonce.
    extra = {
      CLAUDE_CONFIG_DIR: claudeDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    };
  } else {
    command = { bin: 'opencode', args: ['run', '--dir', ws, '-m', opts.model, '--format', 'json'] };
  }

  const env = agentSpawnEnv({
    fakeHome,
    tmpdir: sessionTmp,
    keyExportName: opts.keyExportName,
    key: opts.key,
    extra,
    ...(opts.allowedRoots ? { allowedRoots: opts.allowedRoots } : {}),
  });

  const seed: WarmSeed | undefined = opts.seed
    ? {
        provider: opts.provider,
        arm: opts.arm,
        fixture,
        nonce,
        ws,
        fakeHome,
        mtimes,
        ...(seedDb && indexInfo ? { indexDb: seedDb, dbBytes: indexInfo.dbBytes } : {}),
        dispose: () => {
          if (seedDir) fs.rmSync(seedDir, { recursive: true, force: true });
        },
      }
    : undefined;

  return {
    ws,
    configPath,
    indexInfo,
    fakeHome,
    env,
    command,
    nonce,
    cachePhase: warm ? 'warm' : 'cold',
    ...(seed ? { seed } : {}),
    cleanup: () => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}
