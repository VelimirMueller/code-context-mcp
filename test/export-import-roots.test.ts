/**
 * #250 (TM-10): export_to_file and import_from_file resolve the target path
 * (realpath of the parent dir + basename) and refuse anything outside the
 * allowed roots — the same sandbox as index_directory. export_to_file refuses
 * an existing target unless overwrite: true is passed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from './helpers/db.js';
import { initScrumSchema, runMigrations } from '../src/scrum/schema.js';
import { registerScrumTools } from '../src/scrum/tools.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

class FakeServer {
  tools = new Map<string, Handler>();
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}

const text = (res: { content: Array<{ text: string }> }) =>
  res.content.map((c) => c.text).join('\n');

const sprintCount = (db: ReturnType<typeof createTestDb>) =>
  (db.prepare('SELECT COUNT(*) c FROM sprints').get() as { c: number }).c;

function makeTools() {
  const db = createTestDb();
  initScrumSchema(db);
  runMigrations(db);
  const server = new FakeServer();
  registerScrumTools(server as never, db);
  return { db, tools: server.tools };
}

let savedRoots: string | undefined;
let allowed: string;
let outside: string;

beforeEach(() => {
  savedRoots = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-roots-allow-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-roots-out-'));
  process.env.CODE_CONTEXT_ALLOWED_ROOTS = allowed;
});

afterEach(() => {
  if (savedRoots === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
  else process.env.CODE_CONTEXT_ALLOWED_ROOTS = savedRoots;
  fs.rmSync(allowed, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('export_to_file sandbox (#250)', () => {
  it('refuses a path outside the allowed roots and writes nothing', async () => {
    const { tools } = makeTools();
    const target = path.join(outside, 'dump.json');
    const res = await tools.get('export_to_file')!({ output_path: target });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed sandbox');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses a symlinked file that escapes the allowed roots', async () => {
    const { tools } = makeTools();
    const real = path.join(outside, 'escaped.json');
    fs.writeFileSync(real, 'keep-me');
    const link = path.join(allowed, 'escape.json');
    fs.symlinkSync(real, link);
    const res = await tools.get('export_to_file')!({ output_path: link });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed sandbox');
    expect(fs.readFileSync(real, 'utf-8')).toBe('keep-me');
  });

  it('refuses a symlinked parent directory that escapes the allowed roots', async () => {
    const { tools } = makeTools();
    const link = path.join(allowed, 'escape-dir');
    fs.symlinkSync(outside, link);
    const res = await tools.get('export_to_file')!({ output_path: path.join(link, 'dump.json') });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed sandbox');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a dangling symlink as the target', async () => {
    const { tools } = makeTools();
    const never = path.join(outside, 'never.json');
    const link = path.join(allowed, 'dangling.json');
    fs.symlinkSync(never, link);
    const res = await tools.get('export_to_file')!({ output_path: link });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('dangling symlink');
    expect(fs.existsSync(never)).toBe(false);
  });

  it('writes inside the allowed roots and refuses an existing target without overwrite', async () => {
    const { tools } = makeTools();
    const target = path.join(allowed, 'code-context-dump.json');

    const first = await tools.get('export_to_file')!({ output_path: target });
    expect(first.isError).toBeUndefined();
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8')) as { version: string };
    expect(parsed.version).toBe('2.0.0');

    const refused = await tools.get('export_to_file')!({ output_path: target });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('overwrite: true');

    const ok = await tools.get('export_to_file')!({ output_path: target, overwrite: true });
    expect(ok.isError).toBeUndefined();
    expect(text(ok)).toContain('Exported to');
  });
});

describe('import_from_file sandbox (#250)', () => {
  const dumpJson = () =>
    JSON.stringify({
      version: '2.0.0',
      tables: { sprints: [{ id: 1, name: 'S', goal: 'g', status: 'planning' }] },
    });

  it('refuses a path outside the allowed roots and imports nothing', async () => {
    const { tools, db } = makeTools();
    const file = path.join(outside, 'dump.json');
    fs.writeFileSync(file, dumpJson());
    const res = await tools.get('import_from_file')!({ input_path: file });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed sandbox');
    expect(sprintCount(db)).toBe(0);
  });

  it('refuses a symlinked path that escapes the allowed roots', async () => {
    const { tools, db } = makeTools();
    const real = path.join(outside, 'dump.json');
    fs.writeFileSync(real, dumpJson());
    const link = path.join(allowed, 'dump.json');
    fs.symlinkSync(real, link);
    const res = await tools.get('import_from_file')!({ input_path: link });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed sandbox');
    expect(sprintCount(db)).toBe(0);
  });

  it('imports a dump inside the allowed roots', async () => {
    const { tools, db } = makeTools();
    const file = path.join(allowed, 'dump.json');
    fs.writeFileSync(file, dumpJson());
    const res = await tools.get('import_from_file')!({ input_path: file });
    expect(res.isError).toBeUndefined();
    expect(sprintCount(db)).toBe(1);
  });
});
