#!/usr/bin/env node
// The visual baseline gate (#293). A PR that adds, changes or deletes a
// baseline under test/visual/__snapshots__/ passes only with the label
// `visual-change`. A refactor PR must match the baselines; it never edits them.
//
// Usage:
//   CI (pull_request): node scripts/check-visual-change.mjs
//     base commit and labels come from $GITHUB_EVENT_PATH.
//   Local: node scripts/check-visual-change.mjs [base-ref]
//     base-ref defaults to $VISUAL_BASE, then origin/develop; labels from
//     $VISUAL_LABELS (comma list).
// Exit 0 = pass, 1 = baseline change without the label, 64 = bad input.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_DIR = 'test/visual/__snapshots__/';
export const APPROVAL_LABEL = 'visual-change';

/**
 * The decision, pure.
 * @param {{ changed: string[], labels: string[] }} input
 * @returns {{ ok: boolean, files: string[], reason: string }}
 */
export function decide({ changed, labels }) {
  const files = changed.filter((f) => f.startsWith(BASELINE_DIR)).sort();
  if (files.length === 0) return { ok: true, files, reason: 'no baseline changed' };
  if (labels.includes(APPROVAL_LABEL))
    return { ok: true, files, reason: `label ${APPROVAL_LABEL} approves the change` };
  return { ok: false, files, reason: `baselines changed without the label ${APPROVAL_LABEL}` };
}

/** stdout line (eslint allows only console.warn/error). */
const say = (line) => process.stdout.write(`${line}\n`);

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let base = process.argv[2] || process.env.VISUAL_BASE || '';
  let labels = (process.env.VISUAL_LABELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!base && eventPath && fs.existsSync(eventPath)) {
    const pr = JSON.parse(fs.readFileSync(eventPath, 'utf8')).pull_request;
    if (!pr) {
      say('visual gate: not a pull request, nothing to compare');
      return 0;
    }
    base = pr.base?.sha ?? '';
    labels = (pr.labels ?? []).map((l) => l.name);
  }
  base ||= 'origin/develop';
  if (!/^[\w./~^-]+$/.test(base) || base.startsWith('-')) {
    console.error(`visual gate: refusing base ref ${JSON.stringify(base)}`);
    return 64;
  }
  let changed;
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', BASELINE_DIR], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    console.error(`visual gate: cannot diff against ${base} (fetch-depth 0?): ${e.message}`);
    return 64;
  }
  const r = decide({ changed, labels });
  for (const f of r.files) say(`  changed: ${f}`);
  if (r.ok) {
    say(`visual gate: pass — ${r.reason}`);
    return 0;
  }
  console.error(`visual gate: FAIL — ${r.reason}.`);
  console.error(
    '  A refactor must render like the baselines: fix the code, not the PNGs.\n' +
      `  An intended visual change: a maintainer adds the label ${APPROVAL_LABEL} to the PR.`,
  );
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
