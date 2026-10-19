/**
 * #180: the public contract (docs/CONTRACT.md), pinned as JSON snapshots in
 * test/contract/snapshots/. A failing test here means the public surface moved.
 *
 * - On purpose: run `npm run contract:update`, commit the snapshots, and follow
 *   "How to change the contract" in docs/CONTRACT.md (CI needs a major version
 *   bump or the `contract-change-approved` label, scripts/check-contract-change.mjs).
 * - By accident: fix the code, not the snapshot.
 *
 * descriptions.json holds a hash per tool description. A changed description
 * fails here with a readable list, but it is NOT a contract change: the CI
 * gate ignores that file, so a typo fix needs only `npm run contract:update`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SNAPSHOT_DIR,
  PKG,
  profileContract,
  sampleOutputs,
  envSettingNames,
  dbLayout,
  type ProfileContract,
} from './harness.js';
import { CODE_TOOLS } from '../../src/server/tool-wrap.js';
import { LATEST_SCHEMA_VERSION } from '../../src/server/schema-version.js';

const UPDATE = process.env.CONTRACT_UPDATE === '1';
const HINT =
  'The public contract changed. On purpose: `npm run contract:update` and see docs/CONTRACT.md "How to change the contract". By accident: fix the code.';

function read(file: string): unknown {
  const p = path.join(SNAPSHOT_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`Missing snapshot ${file}: run npm run contract:update`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SNAPSHOT_DIR, file), JSON.stringify(value, null, 2) + '\n');
}

/** Compare `value` with the stored snapshot, or rewrite it under CONTRACT_UPDATE=1. */
function matchSnapshot(file: string, value: unknown): void {
  if (UPDATE) return write(file, value);
  expect(value, `${file}: ${HINT}`).toEqual(read(file));
}

/** A readable diff of two name → hash maps. */
function hashDiff(before: Record<string, string>, after: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const k of Object.keys(after).sort()) {
    if (!(k in before)) lines.push(`+ ${k} (new tool)`);
    else if (before[k] !== after[k]) lines.push(`~ ${k}: ${before[k]} → ${after[k]}`);
  }
  for (const k of Object.keys(before).sort()) if (!(k in after)) lines.push(`- ${k} (gone)`);
  return lines;
}

const profiles: Partial<Record<'code' | 'full' | 'all', ProfileContract>> = {};
async function profile(p: 'code' | 'full' | 'all'): Promise<ProfileContract> {
  return (profiles[p] ??= await profileContract(p));
}

describe('contract: tools/list per profile (#180)', () => {
  for (const p of ['code', 'full', 'all'] as const) {
    it(`${p}: tool names and input schemas`, async () => {
      matchSnapshot(`tools-${p}.json`, (await profile(p)).tools);
    }, 60_000);
  }

  it('code is exactly CODE_TOOLS, and every profile contains it', async () => {
    const code = (await profile('code')).tools.map((t) => t.name);
    expect(code).toEqual([...CODE_TOOLS].sort());
    for (const p of ['full', 'all'] as const) {
      const names = (await profile(p)).tools.map((t) => t.name);
      for (const t of CODE_TOOLS) expect(names).toContain(t);
    }
  }, 60_000);

  it('server instructions per profile', async () => {
    matchSnapshot('instructions.json', {
      code: (await profile('code')).instructions,
      full: (await profile('full')).instructions,
      all: (await profile('all')).instructions,
    });
  }, 60_000);

  it('tool descriptions (hashed; a change is reported, but is no contract break)', async () => {
    const current = { ...(await profile('all')).descriptions };
    for (const p of ['code', 'full'] as const) {
      // One description per tool in every profile.
      for (const [k, v] of Object.entries((await profile(p)).descriptions))
        expect(current[k], `${k} differs between profiles`).toBe(v);
    }
    const sorted = Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (UPDATE) return write('descriptions.json', sorted);
    const diff = hashDiff(read('descriptions.json') as Record<string, string>, sorted);
    expect(
      diff,
      `Tool descriptions changed (not a contract break; run npm run contract:update):\n${diff.join('\n')}`,
    ).toEqual([]);
  }, 60_000);
});

describe('contract: default output of the code tools (#180)', () => {
  it('sample outputs on test/fixtures/sample-project', async () => {
    const out = await sampleOutputs();
    // No timestamps and no absolute paths in the default output (2.12.0).
    for (const o of out) {
      if (o.args.absolute_paths) continue;
      expect(o.text, `${o.tool} ${JSON.stringify(o.args)}`).not.toMatch(/<ROOT>|<TMP>/);
      expect(o.text).not.toMatch(/\b(indexed|modified) \d{4}-\d{2}-\d{2}/);
    }
    expect(new Set(out.map((o) => o.tool))).toEqual(new Set(CODE_TOOLS));
    matchSnapshot('outputs-code.json', out);
  }, 60_000);
});

describe('contract: context.db layout per entry (#180)', () => {
  it('tables and columns each entry creates, and the schema version', async () => {
    const layout = await dbLayout();
    expect(layout.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(Object.keys(layout.index)).toContain('files');
    expect(Object.keys(layout.index)).not.toContain('schema_versions');
    expect(Object.keys(layout.sprint)).toContain('schema_versions');
    matchSnapshot('db-layout.json', layout);
  }, 60_000);
});

describe('contract: package surface (#180)', () => {
  it('bins in package.json', () => {
    matchSnapshot('bins.json', PKG.bin);
  });

  it('env setting names the code reads', () => {
    matchSnapshot('env.json', envSettingNames());
  });
});
