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
import Database from 'better-sqlite3';
import { toISOLocal } from '../src/server/indexer.js';
import {
  ARMS,
  CLAUDE_TOOLS,
  cachePhaseFor,
  prepareArmSession,
  type PrepareArmOpts,
  type PreparedArm,
  type WarmSeed,
} from '../scripts/bench/live/prepare.mts';
import {
  CC_GUIDANCE,
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
const seeds: WarmSeed[] = [];
let tmpRoot = '';
let allowedRootsSnapshot: string | undefined;

afterEach(() => {
  for (const p of prepped.splice(0)) p.cleanup();
  for (const s of seeds.splice(0)) s.dispose();
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  }
  // restore the indexer sandbox roots the prepare() helper widened
  if (allowedRootsSnapshot === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  else process.env.CODE_CONTEXT_ALLOWED_ROOTS = allowedRootsSnapshot;
});

const prepare = (
  provider: LiveProvider,
  arm: (typeof ARMS)[number],
  extra: Pick<PrepareArmOpts, 'seed' | 'warmFrom'> = {},
): PreparedArm => {
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
    ...extra,
  });
  prepped.push(p);
  if (p.seed) seeds.push(p.seed);
  return p;
};

/** Run.mts order: a session's cleanup() runs before the next one is prepared. */
const finish = (p: PreparedArm): void => {
  p.cleanup();
  prepped = prepped.filter((x) => x !== p);
};

const promptOf = (p: PreparedArm): string =>
  (
    JSON.parse(fs.readFileSync(p.configPath, 'utf-8')) as {
      agent?: { build?: { prompt?: string } };
    }
  ).agent?.build?.prompt ?? '';

const fileRows = (db: string): unknown[] => {
  const h = new Database(db, { readonly: true });
  try {
    return h.prepare('SELECT path, size_bytes, modified_at FROM files ORDER BY path').all();
  } finally {
    h.close();
  }
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
      if (arm !== 'vanilla') {
        expect(Object.keys(servers)).toEqual(['code-context']);
        expect((servers['code-context'] as { env: Record<string, string> }).env).toEqual({
          CODE_CONTEXT_TOOLSETS: 'code',
        });
        expect(args).toContain('mcp__code-context');
      } else {
        expect(servers).toEqual({});
        expect(args).not.toContain('--allowedTools');
      }
    }
  });
});

describe('prepareArmSession — fair arms (2026-10-11)', () => {
  it('only cc-guided carries the guidance, in both CLIs', () => {
    for (const arm of ARMS) {
      const oc = prepare('deepseek', arm);
      const prompt =
        (
          JSON.parse(fs.readFileSync(oc.configPath, 'utf-8')) as {
            agent?: { build?: { prompt?: string } };
          }
        ).agent?.build?.prompt ?? '';
      const op = prepare('opus', arm);
      const i = op.command.args.indexOf('--append-system-prompt');
      if (arm === 'cc-guided') {
        expect(prompt).toContain(CC_GUIDANCE);
        expect(op.command.args[i + 1]).toBe(CC_GUIDANCE);
      } else {
        expect(prompt).not.toContain('code-context');
        expect(i).toBe(-1);
      }
    }
  });
  it('both cc arms index and attach the server with the code toolset; vanilla does not', () => {
    for (const arm of ARMS) {
      const p = prepare('glm', arm);
      const mcp = (
        JSON.parse(fs.readFileSync(p.configPath, 'utf-8')) as {
          mcp?: Record<string, { environment?: Record<string, string> }>;
        }
      ).mcp;
      if (arm === 'vanilla') {
        expect(mcp).toBeUndefined();
        expect(fs.existsSync(path.join(p.ws, 'context.db'))).toBe(false);
      } else {
        expect(mcp?.['code-context']?.environment).toEqual({ CODE_CONTEXT_TOOLSETS: 'code' });
        expect(fs.existsSync(path.join(p.ws, 'context.db'))).toBe(true);
      }
    }
  });
});

describe('CC_GUIDANCE names only tools the code toolset lists', () => {
  it('every tool it names exists in CODE_TOOLS', async () => {
    const { CODE_TOOLS } = await import('../src/server/tool-wrap.js');
    const named = CC_GUIDANCE.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(CODE_TOOLS).toContain(n);
  });
});

describe('cold-warm cache mode (2026-10-11)', () => {
  it('cachePhaseFor: cold mode is always cold; cold-warm is cold on repeat 1 only', () => {
    expect([1, 2, 3].map((r) => cachePhaseFor('cold', r))).toEqual(['cold', 'cold', 'cold']);
    expect([1, 2, 3].map((r) => cachePhaseFor('cold-warm', r))).toEqual(['cold', 'warm', 'warm']);
  });

  it('default (cold mode) preparation has no seed and a new nonce every time', () => {
    const a = prepare('deepseek', 'cc');
    const b = prepare('deepseek', 'cc');
    expect(a.seed).toBeUndefined();
    expect(a.cachePhase).toBe('cold');
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ws).not.toBe(b.ws);
  });

  it('warm reuses the cold nonce, paths and index — no re-index, index_ms 0', () => {
    for (const provider of PROVIDERS) {
      for (const arm of ['cc', 'cc-guided'] as const) {
        const cold = prepare(provider, arm, { seed: true });
        const seed = cold.seed!;
        expect(cold.cachePhase).toBe('cold');
        expect(cold.indexInfo!.indexMs).toBeGreaterThanOrEqual(0);
        expect(seed.indexDb && fs.existsSync(seed.indexDb)).toBe(true);
        const coldPrompt = promptOf(cold);
        const coldRows = fileRows(path.join(cold.ws, 'context.db'));
        const coldConfig = fs.readFileSync(cold.configPath, 'utf-8');
        finish(cold);

        const warm = prepare(provider, arm, { warmFrom: seed });
        expect(warm.cachePhase).toBe('warm');
        expect(warm.nonce).toBe(cold.nonce);
        expect(promptOf(warm)).toBe(coldPrompt); // identical prompt prefix
        expect(warm.ws).toBe(cold.ws);
        expect(warm.fakeHome).toBe(cold.fakeHome);
        expect(warm.indexInfo).toEqual({ indexMs: 0, dbBytes: seed.dbBytes });
        expect(fileRows(path.join(warm.ws, 'context.db'))).toEqual(coldRows);
        // byte-identical config: same nonce, same MCP command and db path
        expect(fs.readFileSync(warm.configPath, 'utf-8')).toBe(coldConfig);
        finish(warm);
      }
    }
  });

  it('warm sessions get a FRESH fixture copy and HOME: edits from repeat 1 cannot leak', () => {
    const cold = prepare('glm', 'cc', { seed: true });
    const helpers = path.join(cold.ws, 'src', 'utils', 'helpers.ts');
    const original = fs.readFileSync(helpers, 'utf-8');
    const mtime = fs.statSync(helpers).mtimeMs;
    // the agent edits a file, adds one, touches HOME and the db
    fs.writeFileSync(helpers, '// edited by repeat 1\n');
    fs.writeFileSync(path.join(cold.ws, 'leak.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(cold.fakeHome, 'leak'), 'x');
    const h = new Database(path.join(cold.ws, 'context.db'));
    h.exec('CREATE TABLE leaked (x INTEGER)');
    h.close();
    const seed = cold.seed!;
    finish(cold);

    const warm = prepare('glm', 'cc', { warmFrom: seed });
    expect(fs.readFileSync(helpers, 'utf-8')).toBe(original);
    // mtimes restored: the server's freshness check sees the indexed files unchanged
    // Filesystems store mtimes at different precision (Linux CI rounds sub-ms), so allow < 1 ms.
    expect(Math.abs(fs.statSync(helpers).mtimeMs - mtime)).toBeLessThan(1);
    const rows = fileRows(path.join(warm.ws, 'context.db')) as Array<{
      path: string;
      size_bytes: number;
      modified_at: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const st = fs.statSync(row.path); // the indexed absolute path exists again
      expect(st.size, row.path).toBe(row.size_bytes);
      expect(toISOLocal(st.mtime), row.path).toBe(row.modified_at);
    }
    expect(fs.existsSync(path.join(warm.ws, 'leak.ts'))).toBe(false);
    expect(fs.existsSync(path.join(warm.fakeHome, 'leak'))).toBe(false);
    expect(fs.readFileSync(path.join(warm.fakeHome, '.profile'), 'utf-8')).toContain('bench');
    const db = new Database(path.join(warm.ws, 'context.db'), { readonly: true });
    const leaked = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leaked'")
      .all();
    db.close();
    expect(leaked).toEqual([]); // snapshot was taken before the agent ran
  });

  it('vanilla warm: same nonce and paths, still no index', () => {
    const cold = prepare('deepseek', 'vanilla', { seed: true });
    expect(cold.seed!.indexDb).toBeUndefined();
    const seed = cold.seed!;
    finish(cold);
    const warm = prepare('deepseek', 'vanilla', { warmFrom: seed });
    expect(warm.nonce).toBe(seed.nonce);
    expect(warm.ws).toBe(seed.ws);
    expect(warm.indexInfo).toBeUndefined();
    expect(fs.existsSync(path.join(warm.ws, 'context.db'))).toBe(false);
  });

  it('opus: cold keeps DISABLE_PROMPT_CACHING=1, warm turns caching on with identical args', () => {
    for (const arm of ARMS) {
      const cold = prepare('opus', arm, { seed: true });
      expect(cold.env.DISABLE_PROMPT_CACHING).toBe('1');
      const coldArgs = [...cold.command.args];
      const seed = cold.seed!;
      finish(cold);
      const warm = prepare('opus', arm, { warmFrom: seed });
      expect(warm.env.DISABLE_PROMPT_CACHING).toBeUndefined();
      expect(warm.command.args).toEqual(coldArgs); // same cwd, mcp config path, system prompt
      expect(warm.env.CLAUDE_CONFIG_DIR).toBe(path.join(seed.fakeHome, '.claude'));
      expect(fs.readdirSync(warm.env.CLAUDE_CONFIG_DIR as string)).toEqual([]);
      finish(warm);
    }
  });

  it('refuses a warm session while the cold workspace still exists, or for another arm', () => {
    const cold = prepare('glm', 'cc', { seed: true });
    expect(() => prepare('glm', 'cc', { warmFrom: cold.seed! })).toThrow(/cannot recreate/);
    expect(() => prepare('glm', 'cc-guided', { warmFrom: cold.seed! })).toThrow(/warm seed is for/);
    expect(() => prepare('glm', 'cc', { seed: true, warmFrom: cold.seed! })).toThrow(/exclude/);
  });

  it('dispose() removes the index snapshot', () => {
    const cold = prepare('glm', 'cc', { seed: true });
    const db = cold.seed!.indexDb!;
    expect(fs.existsSync(db)).toBe(true);
    cold.seed!.dispose();
    expect(fs.existsSync(db)).toBe(false);
  });
});
