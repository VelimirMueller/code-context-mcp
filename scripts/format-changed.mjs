#!/usr/bin/env node
// Prettier check for the files a change adds or modifies (#191).
//
// The repository is not formatted as a whole yet (about 280 legacy source
// files), so CI checks only what a PR touches; lint-staged formats staged
// files on commit, so touched files converge on the house style.
//
// Usage: node scripts/format-changed.mjs [base-ref]
//   base-ref defaults to $FORMAT_BASE, then origin/main. Exit 1 on any
//   unformatted file, 0 when every changed file passes or nothing changed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const base = process.argv[2] || process.env.FORMAT_BASE || 'origin/main';
if (!/^[\w./~^-]+$/.test(base)) {
  console.error(`format-changed: refusing base ref ${JSON.stringify(base)}`);
  process.exit(64);
}

let out;
try {
  out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
    encoding: 'utf8',
    cwd: root,
  });
} catch {
  console.error(`format-changed: cannot diff against ${base} (fetch it first, or pass a base ref)`);
  process.exit(2);
}
const files = out.split('\n').filter((f) => f && existsSync(path.join(root, f)));
if (files.length === 0) {
  console.log(`format-changed: no changed files against ${base}`);
  process.exit(0);
}
console.log(`format-changed: checking ${files.length} file(s) changed against ${base}`);
const r = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/prettier/bin/prettier.cjs'),
    '--check',
    '--ignore-unknown',
    '--no-error-on-unmatched-pattern',
    ...files,
  ],
  { stdio: 'inherit', cwd: root },
);
if (r.status !== 0) {
  console.error('format-changed: run `npx prettier --write <file>` on the files above.');
}
process.exit(r.status ?? 1);
