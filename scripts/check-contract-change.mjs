#!/usr/bin/env node
// The contract gate (#180, docs/CONTRACT.md "How to change the contract").
//
// A PR that changes a contract snapshot (test/contract/snapshots/, except
// descriptions.json) passes only when it also bumps the major version in
// package.json against the base branch, or carries the label
// `contract-change-approved`. The contract tests themselves (pnpm run
// contract:test) make sure the snapshots match the code.
//
// Usage:
//   CI (pull_request): node scripts/check-contract-change.mjs
//     base commit and labels come from $GITHUB_EVENT_PATH.
//   Local: node scripts/check-contract-change.mjs [base-ref]
//     base-ref defaults to $CONTRACT_BASE, then origin/main; labels from
//     $CONTRACT_LABELS (comma list).
// Exit 0 = pass, 1 = contract change without approval, 64 = bad input.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_DIR = 'test/contract/snapshots/';
/** Snapshots that are reported but are no contract (tool description hashes). */
export const NON_CONTRACT = new Set([`${SNAPSHOT_DIR}descriptions.json`]);
export const APPROVAL_LABEL = 'contract-change-approved';

/** The major of a semver string, or NaN. */
export function major(version) {
  const m = /^v?(\d+)\./.exec(String(version ?? '').trim());
  return m ? Number(m[1]) : NaN;
}

/**
 * The decision, pure.
 * @param {{ baseHasSnapshots: boolean, changed: string[], baseVersion: string,
 *   headVersion: string, labels: string[] }} input
 * @returns {{ ok: boolean, contractFiles: string[], reason: string }}
 */
export function decide({ baseHasSnapshots, changed, baseVersion, headVersion, labels }) {
  const contractFiles = changed
    .filter((f) => f.startsWith(SNAPSHOT_DIR) && !NON_CONTRACT.has(f))
    .sort();
  if (!baseHasSnapshots)
    return {
      ok: true,
      contractFiles,
      reason: 'the base branch has no contract snapshots yet (first contract)',
    };
  if (contractFiles.length === 0)
    return { ok: true, contractFiles, reason: 'no contract snapshot changed' };
  const b = major(baseVersion);
  const h = major(headVersion);
  if (Number.isFinite(b) && Number.isFinite(h) && h > b)
    return {
      ok: true,
      contractFiles,
      reason: `major version bump ${baseVersion} → ${headVersion}`,
    };
  if (labels.includes(APPROVAL_LABEL))
    return { ok: true, contractFiles, reason: `label ${APPROVAL_LABEL} approves the change` };
  return {
    ok: false,
    contractFiles,
    reason:
      `the public contract changed without a major version bump (package.json ${baseVersion} → ${headVersion}) ` +
      `and without the label ${APPROVAL_LABEL}`,
  };
}

/** stdout line (eslint allows only console.warn/error). */
const say = (line) => process.stdout.write(`${line}\n`);

const git = (args, cwd) =>
  execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let base = process.argv[2] || process.env.CONTRACT_BASE || '';
  let labels = (process.env.CONTRACT_LABELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!base && eventPath && fs.existsSync(eventPath)) {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const pr = event.pull_request;
    if (!pr) {
      // A push to main lands a PR that passed this gate.
      say('contract gate: not a pull request, nothing to compare');
      return 0;
    }
    base = pr.base?.sha ?? '';
    labels = (pr.labels ?? []).map((l) => l.name);
  }
  base ||= 'origin/main';
  if (!/^[\w./~^-]+$/.test(base) || base.startsWith('-')) {
    console.error(`contract gate: refusing base ref ${JSON.stringify(base)}`);
    return 64;
  }

  let baseHasSnapshots = true;
  try {
    git(['cat-file', '-e', `${base}:${SNAPSHOT_DIR}`], root);
  } catch {
    baseHasSnapshots = false;
  }
  let changed;
  let baseVersion;
  let headVersion;
  try {
    changed = git(['diff', '--name-only', `${base}...HEAD`, '--', SNAPSHOT_DIR], root)
      .split('\n')
      .filter(Boolean);
    baseVersion = JSON.parse(git(['show', `${base}:package.json`], root)).version;
  } catch (e) {
    console.error(`contract gate: cannot diff against ${base} (fetch-depth 0?): ${e.message}`);
    return 64;
  }
  try {
    headVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch (e) {
    console.error(`contract gate: cannot read package.json: ${e.message}`);
    return 64;
  }

  const r = decide({ baseHasSnapshots, changed, baseVersion, headVersion, labels });
  for (const f of r.contractFiles) say(`  changed: ${f}`);
  if (r.ok) {
    say(`contract gate: pass — ${r.reason}`);
    return 0;
  }
  console.error(`contract gate: FAIL — ${r.reason}.`);
  console.error(
    '  Breaking on purpose: bump the major version in package.json and add a CHANGELOG "Breaking" entry.\n' +
      `  Additive or approved: a maintainer adds the label ${APPROVAL_LABEL} to the PR (see docs/CONTRACT.md).`,
  );
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
