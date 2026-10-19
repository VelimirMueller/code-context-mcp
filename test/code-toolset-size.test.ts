/**
 * CCA-02 (#117): the `code` profile lists its reading tools and tools/list stays
 * small. Every listed character is sent on every model call, so the size is
 * pinned with an upper bound: grow it on purpose, never by accident.
 *
 * Measured 2026-10-11 with OVERDRIVE_FLAIR=0: 11 tools / 5,888 chars before,
 * 4 tools / 1,881 chars after (chars/4 ≈ 1.5k → 0.5k tokens).
 *
 * CCA-03 (#118) raised the bound on purpose: the `query` description now
 * carries the files/exports/dependencies schema and the two common joins.
 * Measured 2026-10-11: 2,376 chars (+495, about 125 tokens per call). Bench
 * readers paid for the missing schema with sqlite_master dumps of 5–19.5k
 * chars and failed calls on guessed column names; one avoided dump pays for
 * the schema on 10–40 calls. The bound leaves ~70 chars of slack.
 *
 * CCA-04 (#119) kept the bound: get_file_context gained `snippet` and the
 * query schema gained exports.signature/line + files.import_lines; the shared
 * absolute_paths description got shorter to pay for it. Measured 2026-10-11:
 * 2,393 chars.
 *
 * CCA-05 (#120) raised the bound on purpose: who_imports and exports_in join
 * the profile. Measured 2026-10-11: 3,326 chars (+933, about 235 tokens per
 * call; ~210 of each tool's ~465 chars is fixed MCP schema overhead). Bench
 * L4 readers spent ~20k uncached tokens grepping to verify an importer list,
 * and L6 cost 58k vs 261k tokens per pass only when a reader found the
 * exports table on its own; one avoided grep pays for the two tools on many
 * calls. Their inputs stay minimal: one string, one flag, absolute_paths.
 * The bound leaves ~75 chars of slack.
 *
 * #178 (3.0.0): `code` is the default profile. A server started with no
 * profile env lists exactly CODE_TOOLS; `CODE_CONTEXT_PROFILE=full` lists the
 * 2.x default and `health` reports the active toolsets.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CODE_TOOLS,
  CODE_ADMIN_TOOLS,
  OPTIONAL_TOOLSETS,
  toolsetOf,
} from '../src/server/tool-wrap.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const SERVER_ENTRY = path.join(REPO_ROOT, 'src/server/index.ts');

/** Upper bound for JSON.stringify(tools) of `tools/list` under the code profile. */
const MAX_CODE_TOOLSET_CHARS = 3_400;

/**
 * Start the server with exactly these profile settings: the parent's
 * CODE_CONTEXT_PROFILE / CODE_CONTEXT_TOOLSETS never leak in. Returns the
 * listed tools and, when `health` is listed, its JSON.
 */
async function startServer(settings: { profile?: string; toolsets?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca02-'));
  const env = { ...(process.env as Record<string, string>), OVERDRIVE_FLAIR: '0' };
  delete env.CODE_CONTEXT_PROFILE;
  delete env.CODE_CONTEXT_TOOLSETS;
  if (settings.profile !== undefined) env.CODE_CONTEXT_PROFILE = settings.profile;
  if (settings.toolsets !== undefined) env.CODE_CONTEXT_TOOLSETS = settings.toolsets;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY, path.join(dir, 'context.db')],
    cwd: dir,
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'cca02-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    let health: { profile?: string; toolsets?: string[] } | undefined;
    if (tools.some((t) => t.name === 'health')) {
      const r = (await client.callTool({ name: 'health', arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
      };
      health = JSON.parse(r.content[0].text);
    }
    return { tools, health, instructions: client.getInstructions() };
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function listTools(toolsets: string) {
  return (await startServer({ toolsets })).tools;
}

describe('code toolset over MCP stdio', () => {
  it('lists exactly the reading tools (CODE_TOOLS), within the size budget', async () => {
    const tools = await listTools('code');
    expect(tools.map((t) => t.name).sort()).toEqual([...CODE_TOOLS].sort());
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(MAX_CODE_TOOLSET_CHARS);
    for (const t of tools) expect(t.description ?? '').not.toMatch(/checked against the disk/);
    // CCA-03: the query description is the schema a reader needs.
    const q = tools.find((t) => t.name === 'query')?.description ?? '';
    for (const col of [
      'files(id, path,',
      'line_count',
      'exports(id, file_id, name, kind',
      'dependencies(id, source_id, target_id, symbols)',
      'PRAGMA table_info',
    ]) {
      expect(q).toContain(col);
    }
    expect(q).not.toMatch(/\bcontent\b/);
    // CCA-05: the graph tools say the list is complete, so nobody greps to verify.
    for (const name of ['who_imports', 'exports_in']) {
      expect(tools.find((t) => t.name === name)?.description ?? '').toMatch(
        /complete .*import graph/i,
      );
    }
  }, 30_000);

  it('code,code-admin adds the maintenance tools back', async () => {
    const names = (await listTools('code,code-admin')).map((t) => t.name).sort();
    expect(names).toEqual([...CODE_TOOLS, ...CODE_ADMIN_TOOLS].sort());
  }, 30_000);

  it('code-admin alone (on the default profile) reports profile code in health', async () => {
    const { health } = await startServer({ toolsets: 'code-admin' });
    expect(health?.profile).toBe('code');
    expect(health?.toolsets).toEqual(['code', 'code-admin']);
  }, 30_000);
});

describe('profiles over MCP stdio (#178)', () => {
  it('no setting at all lists exactly the code tools (the 3.0.0 default)', async () => {
    const { tools, instructions } = await startServer();
    expect(tools.map((t) => t.name).sort()).toEqual([...CODE_TOOLS].sort());
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(MAX_CODE_TOOLSET_CHARS);
    expect(instructions).toMatch(/who_imports/);
  }, 30_000);

  it('CODE_CONTEXT_PROFILE=full lists the 2.x default and health reports it', async () => {
    const { tools, health } = await startServer({ profile: 'full' });
    const names = tools.map((t) => t.name);
    for (const t of [...CODE_TOOLS, ...CODE_ADMIN_TOOLS]) expect(names).toContain(t);
    for (const t of ['create_ticket', 'get_resume_state', 'start_sprint'])
      expect(names).toContain(t);
    for (const t of [...OPTIONAL_TOOLSETS.fun, ...OPTIONAL_TOOLSETS.stream])
      expect(names).not.toContain(t);
    expect(names).toHaveLength(97);
    expect(health?.profile).toBe('full');
    expect(health?.toolsets).toEqual(['code', 'code-admin', 'scrum']);
    expect([...new Set(names.map(toolsetOf))].sort()).toEqual([...health!.toolsets!].sort());
  }, 30_000);

  it('CODE_CONTEXT_PROFILE=all lists every tool', async () => {
    const { tools, health } = await startServer({ profile: 'all' });
    const names = tools.map((t) => t.name);
    for (const t of [...OPTIONAL_TOOLSETS.fun, ...OPTIONAL_TOOLSETS.stream])
      expect(names).toContain(t);
    expect(names).toHaveLength(103);
    expect(health?.toolsets).toEqual(['code', 'code-admin', 'scrum', 'fun', 'stream']);
    expect([...new Set(names.map(toolsetOf))].sort()).toEqual([...health!.toolsets!].sort());
  }, 30_000);
});
