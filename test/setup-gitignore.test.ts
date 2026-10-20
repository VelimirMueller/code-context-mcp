import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDbGitignored, ensureDumpGitignored } from '../src/server/gitignore.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => (dir = mkdtempSync(path.join(tmpdir(), 'cc-gitignore-')));

describe('setup: keep context.db out of git', () => {
  it('creates .gitignore with the db pattern in a git checkout', () => {
    fresh();
    mkdirSync(path.join(dir, '.git'));
    expect(ensureDbGitignored(dir)).toBe('added');
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain('\ncontext.db*\n');
  });

  it('appends after existing rules without a trailing newline, once', () => {
    fresh();
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
    expect(ensureDbGitignored(dir)).toBe('added');
    expect(ensureDbGitignored(dir)).toBe('present');
    const content = readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(content.startsWith('node_modules\n')).toBe(true);
    expect(content.match(/context\.db\*/g)).toHaveLength(1);
  });

  it('respects an existing anchored rule', () => {
    fresh();
    writeFileSync(path.join(dir, '.gitignore'), '/context.db*\n');
    expect(ensureDbGitignored(dir)).toBe('present');
  });

  it('leaves a directory that is not a git checkout alone', () => {
    fresh();
    expect(ensureDbGitignored(dir)).toBe('not-a-repo');
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });
});

describe('setup: keep the export dump out of git (#250)', () => {
  it('creates .gitignore with the dump pattern in a git checkout, once', () => {
    fresh();
    mkdirSync(path.join(dir, '.git'));
    expect(ensureDumpGitignored(dir)).toBe('added');
    expect(ensureDumpGitignored(dir)).toBe('present');
    const content = readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('\ncode-context-dump*.json\n');
    expect(content.match(/code-context-dump\*\.json/g)).toHaveLength(1);
  });

  it('adds the dump pattern next to an existing db rule without touching it', () => {
    fresh();
    mkdirSync(path.join(dir, '.git'));
    ensureDbGitignored(dir);
    expect(ensureDumpGitignored(dir)).toBe('added');
    const content = readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(content.match(/context\.db\*/g)).toHaveLength(1);
    expect(content.match(/code-context-dump\*\.json/g)).toHaveLength(1);
  });

  it('respects an existing anchored rule', () => {
    fresh();
    writeFileSync(path.join(dir, '.gitignore'), '/code-context-dump*.json\n');
    expect(ensureDumpGitignored(dir)).toBe('present');
  });
});
