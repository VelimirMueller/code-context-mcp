/**
 * Security-review unit tests — the ONE preparation path (prepare.mts).
 *
 * Security audit 2026-10-10, finding 2: the glm vanilla arm used to run
 * with NO opencode.json, i.e. an empty permission ruleset. prepare.mts is
 * now the only way a session workspace exists and the only place the
 * opencode child's env is built; run.mts has exactly one spawn site and it
 * consumes a PreparedArm. These tests enumerate EVERY arm (provider ×
 * vanilla/cc) and fail if any of them prepares without the sandbox config.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARMS,
  CLAUDE_TOOLS,
  prepareArmSession,
  type PreparedArm,
} from '../scripts/bench/live/prepare.mts';
import {
  SANDBOX_PERMISSIONS,
  DEEPSEEK_PROVIDER_CONFIG,
} from '../scripts/bench/live/opencode-config.mts';
import { PROVIDER_KEY_ENV_NAMES } from '../scripts/bench/live/sandbox.mts';
import type { LiveProvider } from '../scripts/bench/normalize-live.mts';

const PROVIDERS: LiveProvider[] = ['glm', 'deepseek'];

const KEY_BY_PROVIDER: Record<LiveProvider, { keyExportName: string; key: string }> = {
  glm: { keyExportName: 'ZHIPU_API_KEY', key: 'glm-key-value' },
  deepseek: { keyExportName: 'DEEPSEEK_API_KEY', key: 'dsk-key-value' },
  opus: { keyExportName: 'CLAUDE_CODE_OAUTH_TOKEN', key: 'opus-token-value' },
};

let prepped: PreparedArm[] = [];
let tmpRoot = '';
let allowedRootsSnapshot: string | undefined;

afterEach(() => {
  for (const p of prepped.splice(0)) p.cleanup();
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
  // restore the indexer sandbox roots the prepare() helper widened
  if (allowedRootsSnapshot === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  else process.env.CODE_CONTEXT_ALLOWED_ROOTS = allowedRootsSnapshot;
});

const prepare = (provider: LiveProvider, arm: (typeof ARMS)[number]): PreparedArm => {
  if (!tmpRoot) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-prepare-'));
    // run.mts widens the indexer sandbox to the temp dir before preparing;
    // do the same here (buildIndexDb runs in-process).
    allowedRootsSnapshot = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = [
      tmpRoot,
      ...(process.env.CODE_CONTEXT_ALLOWED_ROOTS?.split(',') ?? []),
    ].join(',');
  }
  const p = prepareArmSession({
    provider,
    arm,
    model: `${provider}-model`,
    distServer: path.join(tmpRoot, 'dist-server.js'),
    ...KEY_BY_PROVIDER[provider],
    allowedRoots: tmpRoot,
    tmpdir: tmpRoot,
  });
  prepped.push(p);
  return p;
};

describe('prepareArmSession — every arm carries the sandbox config', () => {
  it('writes <ws>/opencode.json with SANDBOX_PERMISSIONS for EVERY provider × arm', () => {
    for (const provider of PROVIDERS) {
      for (const arm of ARMS) {
        const p = prepare(provider, arm);
        expect(p.configPath, `${provider}/${arm} config path`).toBe(
          path.join(p.ws, 'opencode.json'),
        );
        const written = JSON.parse(fs.readFileSync(p.configPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        expect(written.permission, `${provider}/${arm} permission block`).toEqual(
          SANDBOX_PERMISSIONS,
        );
        expect((written.permission as Record<string, unknown>).bash).toBe('deny');
      }
    }
  });

  it('the workspace is a fresh copy of the fixture (the agent’s whole world)', () => {
    const p = prepare('glm', 'vanilla');
    expect(fs.existsSync(path.join(p.ws, 'src', 'utils', 'helpers.ts'))).toBe(true);
    expect(fs.existsSync(path.join(p.ws, 'package.json'))).toBe(true);
  });

  it('cc arm: builds context.db and registers ONLY code-context as MCP', () => {
    const p = prepare('glm', 'cc');
    expect(p.indexInfo).toBeTruthy();
    expect(fs.statSync(path.join(p.ws, 'context.db')).size).toBeGreaterThan(0);
    const written = JSON.parse(fs.readFileSync(p.configPath, 'utf-8')) as Record<string, unknown>;
    const mcp = written.mcp as Record<string, { type: string; command: string[] }>;
    expect(Object.keys(mcp)).toEqual(['code-context']);
    expect(mcp['code-context'].command).toEqual([
      process.execPath,
      path.join(tmpRoot, 'dist-server.js'),
      path.join(p.ws, 'context.db'),
    ]);
  });

  it('vanilla arm: no MCP, no provider block — but still the permission block', () => {
    for (const provider of PROVIDERS) {
      const p = prepare(provider, 'vanilla');
      expect(p.indexInfo).toBeUndefined();
      const written = JSON.parse(fs.readFileSync(p.configPath, 'utf-8')) as Record<string, unknown>;
      expect(written.mcp).toBeUndefined();
      if (provider === 'glm') expect(written.provider).toBeUndefined();
    }
  });

  it('deepseek arms pin the provider block; glm arms do not', () => {
    for (const arm of ARMS) {
      const dsk = prepare('deepseek', arm);
      const dskWritten = JSON.parse(fs.readFileSync(dsk.configPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(dskWritten.provider, `deepseek/${arm}`).toEqual({
        deepseek: DEEPSEEK_PROVIDER_CONFIG,
      });

      const glm = prepare('glm', arm);
      const glmWritten = JSON.parse(fs.readFileSync(glm.configPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(glmWritten.provider, `glm/${arm}`).toBeUndefined();
    }
  });

  it('builds the minimal agent env: isolated HOME with a .profile marker, one key only', () => {
    process.env.GITHUB_TOKEN = 'ghp_dummy';
    const p = prepare('deepseek', 'cc');
    expect(p.fakeHome).not.toBe(os.homedir());
    expect(fs.readFileSync(path.join(p.fakeHome, '.profile'), 'utf-8')).toContain('bench');
    expect(p.env.HOME).toBe(p.fakeHome);
    expect(p.env.DEEPSEEK_API_KEY).toBe('dsk-key-value');
    expect(p.env.GITHUB_TOKEN).toBeUndefined();
    for (const name of PROVIDER_KEY_ENV_NAMES) {
      if (name === 'DEEPSEEK_API_KEY') continue;
      expect(p.env[name], `${name} must not leak`).toBeUndefined();
    }
    delete process.env.GITHUB_TOKEN;
  });

  it('cleanup removes the workspace and the fake HOME', () => {
    const p = prepare('glm', 'vanilla');
    const ws = p.ws;
    const home = p.fakeHome;
    expect(fs.existsSync(ws)).toBe(true);
    p.cleanup();
    prepped = prepped.filter((x) => x !== p);
    expect(fs.existsSync(ws)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });
});

describe('prepareArmSession — every session starts fresh (2026-10-11)', () => {
  it('opencode arms: a new nonce per session, first line of the build agent prompt', () => {
    const nonces = new Set<string>();
    for (const provider of PROVIDERS) {
      for (const arm of ARMS) {
        const p = prepare(provider, arm);
        const cfg = JSON.parse(fs.readFileSync(p.configPath, 'utf-8')) as {
          agent?: { build?: { prompt?: string } };
        };
        const prompt = cfg.agent?.build?.prompt ?? '';
        expect(prompt.split('\n')[0]).toBe(`bench-session ${p.nonce}`);
        nonces.add(p.nonce);
      }
    }
    expect(nonces.size).toBe(PROVIDERS.length * ARMS.length);
  });

  it('each session gets its own TMPDIR inside its own HOME', () => {
    const a = prepare('deepseek', 'vanilla');
    const b = prepare('deepseek', 'cc');
    expect(a.env.TMPDIR).toBe(path.join(a.fakeHome, 'tmp'));
    expect(fs.statSync(a.env.TMPDIR as string).isDirectory()).toBe(true);
    expect(a.env.TMPDIR).not.toBe(b.env.TMPDIR);
  });

  it('the vanilla workspace holds no index; the cc workspace has its own', () => {
    const v = prepare('glm', 'vanilla');
    const c = prepare('glm', 'cc');
    expect(fs.existsSync(path.join(v.ws, 'context.db'))).toBe(false);
    expect(fs.existsSync(path.join(v.ws, '.code-context'))).toBe(false);
    expect(fs.existsSync(path.join(c.ws, 'context.db'))).toBe(true);
  });

  it('opus: claude with an empty config dir, no prompt caching, only the MCP servers it names', () => {
    for (const arm of ARMS) {
      const p = prepare('opus', arm);
      expect(p.command.bin).toBe('claude');
      const args = p.command.args;
      expect(args[0]).toBe('-p');
      expect(args).toContain('--strict-mcp-config');
      expect(
        args.slice(args.indexOf('--tools') + 1, args.indexOf('--tools') + 1 + CLAUDE_TOOLS.length),
      ).toEqual([...CLAUDE_TOOLS]);
      expect(CLAUDE_TOOLS).not.toContain('Bash');
      // the prompt is appended after a single-value option, never after a variadic one
      expect(args.at(-2)).toBe('--output-format');

      expect(p.env.DISABLE_PROMPT_CACHING).toBe('1');
      expect(p.env.CLAUDE_CONFIG_DIR).toBe(path.join(p.fakeHome, '.claude'));
      expect(fs.readdirSync(p.env.CLAUDE_CONFIG_DIR as string)).toEqual([]);
      expect(p.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('opus-token-value');

      const mcpPath = args[args.indexOf('--mcp-config') + 1];
      expect(mcpPath.startsWith(p.fakeHome)).toBe(true); // outside the workspace
      const servers = (
        JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
          mcpServers: Record<string, unknown>;
        }
      ).mcpServers;
      if (arm === 'cc') {
        expect(Object.keys(servers)).toEqual(['code-context']);
        expect(args).toContain('mcp__code-context');
      } else {
        expect(servers).toEqual({});
        expect(args).not.toContain('--allowedTools');
      }
    }
  });
});
