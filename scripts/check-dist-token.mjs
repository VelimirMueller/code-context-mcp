#!/usr/bin/env node
// Fail when the built dashboard ships the auth token (#247, TM-07).
//
// `vite build` used to inline VITE_DASHBOARD_TOKEN into the assets because the
// dashboard wrote it to app/.env.local; npm 2.13.0 published a test token that
// way. token.ts reads the env var only behind import.meta.env.DEV now, so a
// production build drops it — this script holds that line. It scans every file
// under dist/dashboard/assets for:
//   - the current dashboard token: CODE_CONTEXT_DASHBOARD_TOKEN, or
//     .code-context/dashboard.token beside the db (VITE_DASHBOARD_DB or
//     context.db at the repo root — the same rule as dashboardTokenRoot in
//     src/dashboard/auth.ts, but an existing file only; nothing is generated);
//   - a 64-hex string within 200 chars of __DASHBOARD_TOKEN__ or
//     VITE_DASHBOARD_TOKEN — the shape an inlined token leaves behind. The
//     markers alone are fine: the production code reads
//     window.__DASHBOARD_TOKEN__, so the name appears without a value.
//
// Usage: node scripts/check-dist-token.mjs [assetsDir]
// Exit 0 when the assets are clean, 1 when a token leaked, 2 on a setup error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEX64 = /[0-9a-fA-F]{64}/g;
const MARKERS = ['__DASHBOARD_TOKEN__', 'VITE_DASHBOARD_TOKEN'];
const WINDOW = 200;

/** Violations for one file's text: the known tokens anywhere, or 64-hex near a marker. */
export function scanText(text, knownTokens = []) {
  const violations = [];
  for (const token of knownTokens) {
    if (token && text.includes(token)) {
      violations.push(`contains the current dashboard token (${'.'.repeat(6)}${token.slice(-4)})`);
    }
  }
  for (const marker of MARKERS) {
    for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) {
      const around = text.slice(Math.max(0, i - WINDOW), i + marker.length + WINDOW);
      HEX64.lastIndex = 0;
      const hit = HEX64.exec(around);
      if (hit) {
        violations.push(`64-hex value ${hit[0].slice(0, 8)}… within ${WINDOW} chars of ${marker}`);
      }
    }
  }
  return violations;
}

/** Violations per file (relative paths) for every file under assetsDir, recursively. */
export function checkAssets(assetsDir, knownTokens = []) {
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const violations = {};
  for (const file of walk(assetsDir)) {
    const found = scanText(readFileSync(file, 'utf-8'), knownTokens);
    if (found.length) violations[path.relative(assetsDir, file)] = found;
  }
  return violations;
}

/** The token the dashboard would use now, or null. Reads only — never generates. */
export function currentToken() {
  const env = process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
  if (env && env.trim()) return env.trim();
  const db = process.env.VITE_DASHBOARD_DB
    ? path.resolve(process.env.VITE_DASHBOARD_DB)
    : path.join(root, 'context.db');
  try {
    return (
      readFileSync(
        path.join(path.dirname(db), '.code-context', 'dashboard.token'),
        'utf-8',
      ).trim() || null
    );
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assetsDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(root, 'dist/dashboard/assets');
  if (!existsSync(assetsDir)) {
    console.error(`No dist assets at ${assetsDir} — run npm run build first.`);
    process.exit(2);
  }
  const token = currentToken();
  const violations = checkAssets(assetsDir, token ? [token] : []);
  for (const [file, found] of Object.entries(violations)) {
    for (const v of found) console.error(`${file}: ${v}`);
  }
  if (Object.keys(violations).length) {
    console.error(
      `Token leak: ${Object.keys(violations).length} dist asset file(s) carry the dashboard token (#247).`,
    );
    process.exit(1);
  }
  console.log(
    token
      ? `dist assets clean (checked against the current token).`
      : 'dist assets clean (no token file — markers and 64-hex checked only).',
  );
}
