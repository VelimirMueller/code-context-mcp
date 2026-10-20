/**
 * #179: one package, two entry points over the same server and context.db.
 *
 * - `code-context` (and its alias `vlm-code-context-mcp`): the index entry.
 *   No profile env = the six `code` tools, and only the code-index tables.
 * - `code-context-sprint`: the sprint entry. No profile env = `full`, 97 tools.
 *
 * Each bin in package.json is started from its TypeScript source over stdio
 * (CI runs the tests before the build), so a renamed or moved entry fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CODE_TOOLS } from '../src/server/tool-wrap.js';
import { LATEST_SCHEMA_VERSION } from '../src/server/schema-version.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  bin: Record<string, string>;
};

/** dist/server/x.js → src/server/x.ts */
function sourceOf(bin: string): string {
  const dist = PKG.bin[bin];
  expect(dist, `bin ${bin}`).toBeDefined();
  return path.join(REPO_ROOT, dist.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
}

interface Started {
  tools: string[];
  health?: { profile?: string; toolsets?: string[]; database?: { sprints?: number } };
}

async function start(bin: string, dbPath: string, profile?: string): Promise<Started> {
  const env = { ...(process.env as Record<string, string>), OVERDRIVE_FLAIR: '0' };
  delete env.CODE_CONTEXT_PROFILE;
  delete env.CODE_CONTEXT_TOOLSETS;
  if (profile !== undefined) env.CODE_CONTEXT_PROFILE = profile;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, sourceOf(bin), dbPath],
    cwd: path.dirname(dbPath),
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'entry-points-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    let health: Started['health'];
    if (tools.includes('health')) {
      const r = (await client.callTool({ name: 'health', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      health = JSON.parse(r.content[0].text);
    }
    return { tools, health };
  } finally {
    await client.close();
  }
}

function tables(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

let dir = '';
let dbPath = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca35-'));
  dbPath = path.join(dir, 'context.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('package bins (#179)', () => {
  it('maps the index, sprint and alias bins to the two entry files, each with a shebang', () => {
    expect(PKG.bin['code-context']).toBe('dist/server/index.js');
    expect(PKG.bin['vlm-code-context-mcp']).toBe('dist/server/index.js');
    expect(PKG.bin['code-context-sprint']).toBe('dist/server/sprint.js');
    expect(PKG.bin['code-context-mcp']).toBe('dist/server/setup.js');
    for (const bin of ['code-context', 'code-context-sprint']) {
      expect(fs.readFileSync(sourceOf(bin), 'utf-8').startsWith('#!/usr/bin/env node\n')).toBe(
        true,
      );
    }
  });
});

describe('two entry points over MCP stdio (#179)', () => {
  it('code-context lists the 6 code tools and creates only the code-index tables', async () => {
    const { tools } = await start('code-context', dbPath);
    expect(tools.sort()).toEqual([...CODE_TOOLS].sort());
    const t = tables(dbPath);
    expect(t).toContain('files');
    expect(t).not.toContain('sprints');
    expect(t).not.toContain('schema_versions');
  }, 30_000);

  it('code-context-sprint lists 97 tools (profile full) on the same database', async () => {
    // The index entry creates the file first: the sprint entry adds its tables.
    await start('code-context', dbPath);
    const { tools, health } = await start('code-context-sprint', dbPath);
    expect(tools).toHaveLength(97);
    for (const name of [...CODE_TOOLS, 'create_ticket', 'start_sprint', 'health'])
      expect(tools).toContain(name);
    expect(health?.profile).toBe('full');
    expect(health?.toolsets).toEqual(['code', 'code-admin', 'scrum']);
    const db = new Database(dbPath, { readonly: true });
    try {
      const v = db.prepare('SELECT MAX(version) v FROM schema_versions').get() as { v: number };
      expect(v.v).toBe(LATEST_SCHEMA_VERSION);
      expect((db.prepare('SELECT COUNT(*) c FROM agents').get() as { c: number }).c).toBe(9);
    } finally {
      db.close();
    }
  }, 30_000);

  it('code-context-sprint honours an explicit profile, and an unknown one becomes full', async () => {
    expect((await start('code-context-sprint', dbPath, 'code')).tools.sort()).toEqual(
      [...CODE_TOOLS].sort(),
    );
    expect(await start('code-context-sprint', dbPath, 'nope').then((r) => r.tools)).toHaveLength(
      97,
    );
  }, 30_000);

  it('the index entry leaves an existing sprint database untouched and still serves it', async () => {
    await start('code-context-sprint', dbPath);
    const { tools } = await start('code-context', dbPath);
    expect(tools).toHaveLength(CODE_TOOLS.length);
    expect(tables(dbPath)).toContain('sprints');
  }, 30_000);
});
