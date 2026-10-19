/**
 * #180: collect the public contract of the running server (docs/CONTRACT.md).
 *
 * Every value here is deterministic: tools sort by name, sample outputs run
 * against a fresh copy of test/fixtures/sample-project with the copy's
 * realpath replaced by `<ROOT>`. The settings that change what the server
 * lists or prints (CONTRACT_ENV) never come from the parent process; the rest
 * of the env (PATH, HOME, …) does, and the server output depends on none of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initSchema } from '../../src/server/schema.js';
import { indexDirectory } from '../../src/server/indexer.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SNAPSHOT_DIR = path.join(REPO_ROOT, 'test/contract/snapshots');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const FIXTURE = path.join(REPO_ROOT, 'test/fixtures/sample-project');

/** Env settings that change what the server lists or prints. Never inherited. */
const CONTRACT_ENV = [
  'CODE_CONTEXT_PROFILE',
  'CODE_CONTEXT_TOOLSETS',
  'CODE_CONTEXT_ABSOLUTE_PATHS',
  'CODE_CONTEXT_TIMESTAMPS',
  'CODE_CONTEXT_ALLOWED_ROOTS',
  'OVERDRIVE_FLAIR',
];

interface PackageJson {
  bin: Record<string, string>;
}
export const PKG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as PackageJson;

/** dist/server/x.js → src/server/x.ts: CI runs the tests before the build. */
function sourceOf(bin: string): string {
  const dist = PKG.bin[bin];
  if (!dist) throw new Error(`package.json has no bin ${bin}`);
  return path.join(REPO_ROOT, dist.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
}

export interface ListedTool {
  name: string;
  inputSchema: unknown;
}

export interface Session {
  tools: Array<ListedTool & { description: string }>;
  instructions: string | null;
  client: Client;
  close(): Promise<void>;
}

/** Start one entry over MCP stdio with exactly `env` on top of a clean environment. */
export async function startEntry(
  bin: string,
  dbPath: string,
  cwd: string,
  env: Record<string, string> = {},
): Promise<Session> {
  const childEnv = { ...(process.env as Record<string, string>) };
  for (const k of CONTRACT_ENV) delete childEnv[k];
  // The session log stays off in tests; it is not part of the output.
  childEnv.OVERDRIVE_SESSION_LOG = '0';
  Object.assign(childEnv, env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, sourceOf(bin), dbPath],
    cwd,
    env: childEnv,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  return {
    tools: listed
      .map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    instructions: client.getInstructions() ?? null,
    client,
    close: () => client.close(),
  };
}

/** The profiles of the contract and how each is started. */
export const PROFILE_STARTS: Record<
  'code' | 'full' | 'all',
  { bin: string; env: Record<string, string> }
> = {
  // The default of the index entry: no setting at all.
  code: { bin: 'code-context', env: {} },
  // The default of the sprint entry: no setting at all.
  full: { bin: 'code-context-sprint', env: {} },
  all: { bin: 'code-context', env: { CODE_CONTEXT_PROFILE: 'all' } },
};

export interface ProfileContract {
  tools: ListedTool[];
  descriptions: Record<string, string>;
  instructions: string | null;
}

/** sha256 of a text, 16 hex chars: a typo fix shows up, but is no contract break. */
export const hashText = (s: string): string =>
  crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/**
 * Split an input schema into its shape (the contract) and its prose. Every
 * string `description` (the tool's parameters, at any depth) moves out of the
 * shape into `prose`, keyed by its JSON path. A property NAMED `description`
 * is an object in `properties` and stays.
 */
export function splitSchema(schema: unknown): { shape: unknown; prose: Record<string, string> } {
  const prose: Record<string, string> = {};
  const walk = (v: unknown, at: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'description' && typeof x === 'string') prose[at || '.'] = x;
      else out[k] = walk(x, `${at}.${k}`);
    }
    return out;
  };
  return { shape: walk(schema, ''), prose };
}

export async function profileContract(
  profile: keyof typeof PROFILE_STARTS,
): Promise<ProfileContract> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cca180-')));
  try {
    const { bin, env } = PROFILE_STARTS[profile];
    const s = await startEntry(bin, path.join(dir, 'context.db'), dir, env);
    try {
      const split = s.tools.map((t) => ({ t, ...splitSchema(t.inputSchema) }));
      return {
        tools: split.map(({ t, shape }) => ({ name: t.name, inputSchema: shape })),
        // The tool description and its parameter descriptions, one hash per tool.
        descriptions: Object.fromEntries(
          split.map(({ t, prose }) => [t.name, hashText(JSON.stringify([t.description, prose]))]),
        ),
        instructions: s.instructions,
      };
    } finally {
      await s.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One sample call of a code tool. */
export interface SampleCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The sample calls: each of the six `code` tools, the default output and the
 * `absolute_paths` switch. Keep the list short; every entry is contract.
 */
export const SAMPLE_CALLS: SampleCall[] = [
  { tool: 'find_symbol', args: { name: 'ApiClient' } },
  { tool: 'find_symbol', args: { name: 'format%' } },
  { tool: 'find_symbol', args: { name: 'NoSuchSymbol' } },
  { tool: 'find_symbol', args: { name: 'ApiClient', absolute_paths: true } },
  { tool: 'get_file_context', args: { path: 'src/services/api.ts' } },
  { tool: 'get_file_context', args: { path: 'src/utils/helpers.ts', snippet: true } },
  { tool: 'get_file_context', args: { path: 'src/missing.ts' } },
  { tool: 'who_imports', args: { target: 'src/utils/helpers.ts' } },
  { tool: 'who_imports', args: { target: 'ApiClient' } },
  { tool: 'exports_in', args: { dir: 'src/utils' } },
  { tool: 'exports_in', args: { dir: 'src/utils', unused: true } },
  { tool: 'search_files', args: { query: 'api' } },
  { tool: 'search_files', args: { query: 'utils', absolute_paths: true } },
  {
    tool: 'query',
    args: {
      sql: "SELECT e.name, e.kind, e.line FROM exports e JOIN files f ON f.id = e.file_id WHERE f.path LIKE '%/src/utils/helpers.ts' ORDER BY e.name",
    },
  },
  { tool: 'query', args: { sql: 'DELETE FROM files' } },
];

export interface SampleOutput extends SampleCall {
  isError: boolean;
  text: string;
}

/**
 * Run SAMPLE_CALLS on the index entry with its defaults, over a fresh copy of
 * the sample project (indexed before the server starts, as `npx code-context-mcp
 * setup` or the reindex CLI does). The server's cwd is the project root.
 */
export async function sampleOutputs(): Promise<SampleOutput[]> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cca180-out-')));
  const proj = path.join(base, 'proj');
  fs.cpSync(FIXTURE, proj, { recursive: true });
  const dbPath = path.join(base, 'context.db');
  const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = base;
  try {
    const db = new Database(dbPath);
    initSchema(db);
    indexDirectory(db, proj);
    db.close();
  } finally {
    if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
  }
  const strip = (s: string) => s.split(proj).join('<ROOT>').split(base).join('<TMP>');
  try {
    const s = await startEntry('code-context', dbPath, proj, { CODE_CONTEXT_ALLOWED_ROOTS: base });
    try {
      const out: SampleOutput[] = [];
      for (const call of SAMPLE_CALLS) {
        const r = (await s.client.callTool({ name: call.tool, arguments: call.args })) as {
          content: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        out.push({
          ...call,
          isError: r.isError === true,
          text: strip(r.content.map((c) => c.text ?? `[${c.type}]`).join('\n')),
        });
      }
      return out;
    } finally {
      await s.close();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Env setting names the shipped code reads: every CODE_CONTEXT_* and
 * OVERDRIVE_* name in src/ (the dashboard browser app excluded: it reads none
 * of them at run time), plus DASHBOARD_PORT.
 */
export function envSettingNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === path.join(REPO_ROOT, 'src/dashboard/app')) continue;
        walk(p);
      } else if (/\.(ts|mts|js|mjs)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf-8');
        for (const m of src.matchAll(
          /\b(CODE_CONTEXT_[A-Z0-9_]+|OVERDRIVE_[A-Z0-9_]+|DASHBOARD_PORT)\b/g,
        ))
          names.add(m[1]);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return [...names].sort();
}

type Layout = Record<string, string[]>;

/** Tables (sqlite_sequence aside) and their `name TYPE` columns, sorted. */
function layoutOf(dbPath: string): Layout {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    return Object.fromEntries(
      tables.map((t) => [
        t,
        (
          db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(t) as {
            name: string;
            type: string;
          }[]
        )
          .map((c) => `${c.name} ${c.type}`.trim())
          .sort(),
      ]),
    );
  } finally {
    db.close();
  }
}

/**
 * The context.db layout per owner: the index entry starts on a new file
 * (code-index tables), then the sprint entry opens the same file (scrum
 * tables and the schema_versions stamp).
 */
export async function dbLayout(): Promise<{
  schemaVersion: number;
  index: Layout;
  sprint: Layout;
}> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cca180-db-')));
  const dbPath = path.join(dir, 'context.db');
  try {
    await (await startEntry('code-context', dbPath, dir)).close();
    const index = layoutOf(dbPath);
    await (await startEntry('code-context-sprint', dbPath, dir)).close();
    const all = layoutOf(dbPath);
    const sprint = Object.fromEntries(Object.entries(all).filter(([t]) => !(t in index)));
    const db = new Database(dbPath, { readonly: true });
    try {
      const v = db.prepare('SELECT MAX(version) v FROM schema_versions').get() as { v: number };
      return { schemaVersion: v.v, index, sprint };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
