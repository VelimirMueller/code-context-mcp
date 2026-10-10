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
 * (opencode-config.mts benchAgentPrompt); Claude Code sessions run with
 * DISABLE_PROMPT_CACHING=1, an empty CLAUDE_CONFIG_DIR and only the MCP
 * servers named on the command line.
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
import { writeOpencodeConfig, type WriteOpencodeConfigOpts } from './opencode-config.mts';
import { agentSpawnEnv } from './sandbox.mts';
import { CODE_CONTEXT_SERVER_ALIAS } from './parse-events.mts';
import type { FixtureKind } from './tasks.mts';

/**
 * Claude Code built-in tools for the opus arm — the same capabilities the
 * opencode sandbox allows (read, search, edit). No Bash, no Write, no web,
 * no sub-agents. acceptEdits confines edits to the working directory, and
 * reads outside it need a permission that -p mode never grants.
 */
export const CLAUDE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Edit'];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const FIXTURE = path.join(repoRoot, 'test', 'fixtures', 'sample-project');

/**
 * Copy the task's source into a fresh workspace. 'sample' = the 10-file
 * fixture; 'src' = this repo's src/ (≈160 files) plus package.json and
 * tsconfig.json — a real codebase for the larger ladder tasks. node_modules
 * and build output are never copied.
 */
export function copyFixture(kind: FixtureKind, ws: string): void {
  if (kind === 'sample') {
    fs.cpSync(FIXTURE, ws, { recursive: true });
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
export const ARMS = ['vanilla', 'cc'] as const;
export type Arm = (typeof ARMS)[number];

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
  /** Per-session nonce (first line of the opencode system prompt). */
  nonce: string;
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

/**
 * Prepare ONE arm session: fresh workspace, index db (cc only), the sandbox
 * opencode.json (ALWAYS), and the minimal agent env. The single function
 * every arm — provider × vanilla/cc — goes through before spawning.
 */
export function prepareArmSession(opts: PrepareArmOpts): PreparedArm {
  const tmpdir = opts.tmpdir ?? os.tmpdir();
  const nonce = randomUUID();

  const ws = fs.mkdtempSync(path.join(tmpdir, 'bench-ws-'));
  copyFixture(opts.fixture ?? 'sample', ws);

  const mcpCommand = [process.execPath, opts.distServer, path.join(ws, 'context.db')];
  const configOpts: WriteOpencodeConfigOpts = { nonce };
  let indexInfo: IndexInfo | undefined;
  if (opts.arm === 'cc') {
    indexInfo = buildIndexDb(ws);
    configOpts.mcp = { command: mcpCommand };
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

  const fakeHome = fs.mkdtempSync(path.join(tmpdir, 'bench-home-'));
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
    // plugins), no prompt caching, only the MCP servers in this file.
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir);
    const mcpConfigPath = path.join(fakeHome, 'mcp.json');
    const servers =
      opts.arm === 'cc'
        ? { [CODE_CONTEXT_SERVER_ALIAS]: { command: mcpCommand[0], args: mcpCommand.slice(1) } }
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
        ...(opts.arm === 'cc' ? ['--allowedTools', `mcp__${CODE_CONTEXT_SERVER_ALIAS}`] : []),
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
    extra = {
      CLAUDE_CONFIG_DIR: claudeDir,
      DISABLE_PROMPT_CACHING: '1',
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

  return {
    ws,
    configPath,
    indexInfo,
    fakeHome,
    env,
    command,
    nonce,
    cleanup: () => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}
