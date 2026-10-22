/**
 * #284: `--version` and `--help` are flags of the two MCP entries, never a
 * database path, and an unknown flag is refused with exit 64. No case may
 * create a file in the working directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EX_USAGE, parseEntryArgs } from '../src/server/entry-args.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
};
const ENTRIES = {
  'code-context': path.join(REPO_ROOT, 'src/server/index.ts'),
  'code-context-sprint': path.join(REPO_ROOT, 'src/server/sprint.ts'),
};

let cwd = '';
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-args-'));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

function run(entry: string, arg: string) {
  return spawnSync(process.execPath, [TSX_CLI, entry, arg], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, OVERDRIVE_FLAIR: '0' },
    timeout: 30_000,
  });
}

describe('parseEntryArgs (#284)', () => {
  it('reads flags as flags and anything else as the db path', () => {
    expect(parseEntryArgs([])).toEqual({ kind: 'db', dbPath: './context.db' });
    expect(parseEntryArgs(['my.db'])).toEqual({ kind: 'db', dbPath: 'my.db' });
    expect(parseEntryArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseEntryArgs(['-v'])).toEqual({ kind: 'version' });
    expect(parseEntryArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseEntryArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseEntryArgs(['--nope'])).toEqual({ kind: 'bad', arg: '--nope' });
    expect(parseEntryArgs(['my.db', '--help'])).toEqual({ kind: 'help' });
    expect(parseEntryArgs(['my.db', '--nope'])).toEqual({ kind: 'bad', arg: '--nope' });
    expect(parseEntryArgs(['my.db', 'extra'])).toEqual({ kind: 'db', dbPath: 'my.db' });
  });
});

describe.each(Object.entries(ENTRIES))('%s flags (#284)', (bin, entry) => {
  it('--version prints the package version, exits 0 and creates no file', () => {
    const r = run(entry, '--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PKG.version);
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 30_000);

  it('--help prints the usage, exits 0 and creates no file', () => {
    const r = run(entry, '--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`usage: ${bin} [db-path]`);
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 30_000);

  it('an unknown flag exits 64 and creates no file', () => {
    const r = run(entry, '--nope');
    expect(r.status).toBe(EX_USAGE);
    expect(r.stderr).toContain(`${bin}: unknown option --nope`);
    expect(fs.readdirSync(cwd)).toEqual([]);
  }, 30_000);
});
