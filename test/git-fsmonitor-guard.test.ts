import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listIndexableFiles } from '../src/server/indexer.js';
import { makeRepo, write, commitAll, git } from './helpers/git-repo.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const repo = () => {
  const r = makeRepo();
  roots.push(r);
  return r;
};

describe("git fsmonitor and hooks are disabled on the indexer's git calls", () => {
  it.skipIf(process.platform === 'win32')(
    'does not run a repo-local core.fsmonitor command while listing files',
    () => {
      const r = repo();
      write(r, 'src/a.ts', 'export const a = 1;\n');
      commitAll(r);
      // A repo that arrived as an archive could carry this; git would run the
      // command during `ls-files`. The safe args must stop it before it writes.
      const marker = path.join(r, 'fsmonitor-ran.marker');
      git(r, 'config', 'core.fsmonitor', `sh -c 'touch "${marker}"'`);
      expect(existsSync(marker)).toBe(false);
      listIndexableFiles(r);
      expect(existsSync(marker)).toBe(false);
    },
  );
});
