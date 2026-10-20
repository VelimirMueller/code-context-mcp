import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanText, checkAssets, currentToken } from '../scripts/check-dist-token.mjs';

// #247: the build check fails when a dist/dashboard/assets file carries the
// dashboard token — the current one, or any 64-hex value near a token marker
// (the shape `vite build` left behind when it inlined VITE_DASHBOARD_TOKEN).

const dirs: string[] = [];
const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);

function assets(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'cc-dist-token-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scanText (#247)', () => {
  it('accepts a marker without a value — the prod code names window.__DASHBOARD_TOKEN__', () => {
    expect(scanText('window.__DASHBOARD_TOKEN__||"";')).toEqual([]);
  });

  it('fails on a 64-hex value next to a marker', () => {
    for (const marker of ['__DASHBOARD_TOKEN__', 'VITE_DASHBOARD_TOKEN']) {
      expect(scanText(`x ${marker}="${HEX}"`)).toHaveLength(1);
    }
  });

  it('fails on the known token anywhere in the file', () => {
    expect(scanText(`fetch("/x",{headers:{a:"${HEX}"}})`, [HEX])).toHaveLength(1);
  });

  it('accepts a 64-hex value more than 200 chars from the marker', () => {
    const far = 'x'.repeat(201);
    expect(scanText(`__DASHBOARD_TOKEN__=void 0;const p="${far}${OTHER_HEX}";`, [HEX])).toEqual([]);
  });

  it('checks every marker occurrence, not only the first', () => {
    const text = `__DASHBOARD_TOKEN__=0;${'y'.repeat(500)};VITE_DASHBOARD_TOKEN="${HEX}";`;
    expect(scanText(text)).toHaveLength(1);
  });
});

describe('checkAssets (#247)', () => {
  it('walks nested files and reports only the leaking ones', () => {
    const dir = assets();
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'clean.js'), 'console.log("no secrets");');
    writeFileSync(path.join(dir, 'sub', 'leaked.js'), `VITE_DASHBOARD_TOKEN="${HEX}";`);
    expect(checkAssets(dir)).toEqual({
      [path.join('sub', 'leaked.js')]: [
        `64-hex value ${HEX.slice(0, 8)}… within 200 chars of VITE_DASHBOARD_TOKEN`,
      ],
    });
  });

  it('passes a clean build', () => {
    const dir = assets();
    writeFileSync(
      path.join(dir, 'index.js'),
      'window.__DASHBOARD_TOKEN__=window.__DASHBOARD_TOKEN__;',
    );
    expect(checkAssets(dir)).toEqual({});
  });
});

describe('currentToken (#247)', () => {
  it('reads only — a missing token file stays missing', () => {
    const env = process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
    const db = process.env.VITE_DASHBOARD_DB;
    delete process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
    const dir = assets(); // no .code-context/dashboard.token beside it
    process.env.VITE_DASHBOARD_DB = path.join(dir, 'context.db');
    try {
      expect(currentToken()).toBeNull();
      expect(existsSync(path.join(dir, '.code-context'))).toBe(false);
    } finally {
      if (env !== undefined) process.env.CODE_CONTEXT_DASHBOARD_TOKEN = env;
      if (db === undefined) delete process.env.VITE_DASHBOARD_DB;
      else process.env.VITE_DASHBOARD_DB = db;
    }
  });

  it('prefers CODE_CONTEXT_DASHBOARD_TOKEN', () => {
    const env = process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
    process.env.CODE_CONTEXT_DASHBOARD_TOKEN = 'from-env';
    try {
      expect(currentToken()).toBe('from-env');
    } finally {
      if (env === undefined) delete process.env.CODE_CONTEXT_DASHBOARD_TOKEN;
      else process.env.CODE_CONTEXT_DASHBOARD_TOKEN = env;
    }
  });
});
