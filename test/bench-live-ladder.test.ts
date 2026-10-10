/**
 * Ladder tasks L4–L6 (2026-10-11): the checkers compute their expected answers
 * from the workspace (a copy of this repo's src/). These tests run each
 * checker on a real copy: a correct solution passes, wrong ones fail.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFixture } from '../scripts/bench/live/prepare.mts';
import { deadExportsOf, importersOf, runChecker } from '../scripts/bench/live/checkers.mts';
import { LADDER_TASKS, tasksByIds } from '../scripts/bench/live/tasks.mts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ladder-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fresh = (): string => {
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
  copyFixture('src', ws);
  return ws;
};
const [L4, L5, L6] = tasksByIds(['L4', 'L5', 'L6']);

describe('ladder', () => {
  it('runs S → XL in order via "ladder"', () => {
    const t = tasksByIds(['ladder']);
    expect(t.map((x) => x.id).join(',')).toBe(LADDER_TASKS);
    expect(t.map((x) => x.size)).toEqual(['S', 'M', 'ML', 'L', 'XL']);
  });

  it('the src fixture copies src/ without node_modules or dist', () => {
    const ws = fresh();
    expect(fs.existsSync(path.join(ws, 'src', 'server', 'schema.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'package.json'))).toBe(true);
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? [e.name, ...walk(path.join(d, e.name))] : []));
    expect(walk(ws)).not.toContain('node_modules');
  });
});

describe('L4 importers', () => {
  const ws = fresh();
  const expected = importersOf(ws, 'src/server/schema.ts');
  it('finds the importers of schema.ts', () => {
    expect(expected.length).toBeGreaterThanOrEqual(3);
    expect(expected).toContain('src/server/index.ts');
  });
  it('passes with every importer, fails with one missing or two wrong extras', async () => {
    expect((await runChecker(L4, ws, expected.join('\n'))).pass).toBe(true);
    expect(
      (await runChecker(L4, ws, expected.map((f) => f.replace(/^src\//, '')).join('\n'))).pass,
    ).toBe(true);
    expect((await runChecker(L4, ws, expected.slice(1).join('\n'))).pass).toBe(false);
    const extra = [...expected, 'src/server/git.ts', 'src/server/sql-guard.ts'];
    expect((await runChecker(L4, ws, extra.join('\n'))).pass).toBe(false);
  });
});

describe('L5 rename', () => {
  const renameAll = (ws: string, only?: string): void => {
    for (const f of fs.readdirSync(path.join(ws, 'src'), { recursive: true }) as string[]) {
      const p = path.join(ws, 'src', f);
      if (!/\.(ts|tsx)$/.test(p) || (only && !p.endsWith(only))) continue;
      const s = fs.readFileSync(p, 'utf-8');
      if (s.includes('getPhaseStyle'))
        fs.writeFileSync(p, s.replaceAll('getPhaseStyle', 'phaseStyleFor'));
    }
  };
  it('fails untouched, passes when every reference is renamed', async () => {
    const ws = fresh();
    expect((await runChecker(L5, ws, '')).pass).toBe(false);
    renameAll(ws);
    const r = await runChecker(L5, ws, '');
    expect(r.detail).toContain('getPhaseStyle left: 0');
    expect(r.pass).toBe(true);
  });
  it('fails when only the definition is renamed', async () => {
    const ws = fresh();
    renameAll(ws, 'phases.ts');
    expect((await runChecker(L5, ws, '')).pass).toBe(false);
  });
});

describe('L6 dead exports', () => {
  const ws = fresh();
  const { universe, dead } = deadExportsOf(ws, 'src/server');
  it('finds a non-trivial set inside a larger universe', () => {
    expect(dead.size).toBeGreaterThanOrEqual(10);
    expect(universe.size).toBeGreaterThan(dead.size);
  });
  it('passes with the full list, fails below 80 % recall or precision', async () => {
    const all = [...dead];
    expect((await runChecker(L6, ws, all.join('\n'))).pass).toBe(true);
    const half = all.slice(0, Math.floor(all.length / 2));
    expect((await runChecker(L6, ws, half.join('\n'))).pass).toBe(false);
    const live = [...universe].filter((n) => !dead.has(n));
    expect((await runChecker(L6, ws, [...all, ...live].join('\n'))).pass).toBe(false);
  });
});
