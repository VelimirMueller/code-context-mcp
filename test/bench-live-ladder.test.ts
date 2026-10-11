/**
 * Ladder tasks L4–L6 (2026-10-11): the checkers compute their expected answers
 * from the workspace (a copy of this repo's src/). These tests run each
 * checker on a real copy: a correct solution passes, wrong ones fail.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixture } from '../scripts/bench/live/prepare.mts';
import {
  answerPaths,
  deadExportsOf,
  importersOf,
  runChecker,
} from '../scripts/bench/live/checkers.mts';
import { LADDER_TASKS, tasksByIds } from '../scripts/bench/live/tasks.mts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ladder-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fresh = (): string => {
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
  copyFixture('src', ws);
  return ws;
};
const [L4, L5, L6] = tasksByIds(['L4', 'L5', 'L6']);

/** Real answers the old checkers failed by mistake (CCA-07), machine paths replaced. */
const FALSE_NEGATIVES = (
  JSON.parse(
    fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'fixtures',
        'bench',
        'cca-07-false-negatives.json',
      ),
      'utf-8',
    ),
  ) as { answers: Array<{ session: string; task: string; answer: string }> }
).answers;

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
  let ws = '';
  let expected: string[] = [];
  beforeAll(() => {
    ws = fresh();
    expected = importersOf(ws, 'src/server/schema.ts');
  });
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
    const nonImporters = [
      'src/server/git.ts',
      'src/server/sql-guard.ts',
      'src/server/statusline.ts',
    ]
      .filter((f) => !expected.includes(f))
      .slice(0, 2);
    expect(nonImporters).toHaveLength(2);
    const extra = [...expected, ...nonImporters];
    expect((await runChecker(L4, ws, extra.join('\n'))).pass).toBe(false);
  });
});

describe('L4 answer list (CCA-07)', () => {
  let ws = '';
  let expected: string[] = [];
  beforeAll(() => {
    ws = fresh();
    expected = importersOf(ws, 'src/server/schema.ts');
  });
  const l4 = FALSE_NEGATIVES.filter((a) => a.task === 'L4');

  it('has the three real glm-20261011-090620 vanilla answers', () => {
    expect(l4.map((a) => a.session)).toEqual(['vanilla-L4-r1', 'vanilla-L4-r2', 'vanilla-L4-r3']);
  });

  it.each(l4.map((a) => [a.session, a.answer]))(
    '%s: paths in notes ("false positive", "not imports", "different module") are not answers',
    async (_session, answer) => {
      const r = await runChecker(L4, ws, answer);
      expect(r.detail).toBe(`${expected.length}/${expected.length} importers found, 0 extra`);
      expect(r.pass).toBe(true);
    },
  );

  it('still fails when real non-importers are LISTED as importers', async () => {
    const wrong = ['src/server/git.ts', 'src/server/sql-guard.ts'];
    // Same notes as a real answer, but two wrong files in the list itself.
    const answer = `${l4[0].answer.replace(
      '```\nsrc/dashboard/dashboard.ts',
      `\`\`\`\n${wrong.join('\n')}\nsrc/dashboard/dashboard.ts`,
    )}`;
    const r = await runChecker(L4, ws, answer);
    expect(r.detail).toContain('2 extra');
    expect(r.pass).toBe(false);
  });

  it('still fails when an importer is missing from the list but named in a note', async () => {
    const [first, ...rest] = expected;
    const answer = `${rest.join('\n')}\n\n(${first} only mentions the path in a comment, not an import.)`;
    expect((await runChecker(L4, ws, answer)).pass).toBe(false);
  });

  it('reads list items, bold, inline lists and absolute workspace paths', () => {
    expect([
      ...answerPaths(
        '- **`src/a.ts`** — imports it\n2. server/b.ts\n`src/c.ts`, `src/d.ts` and src/e.ts\n<TMP>/bench-ws-x/src/f.ts',
      ),
    ]).toEqual(['src/a.ts', 'src/server/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    expect([...answerPaths('/tmp/bench-ws-x/src/f.ts')]).toEqual(['src/f.ts']);
  });

  it('drops list items under a short negating heading until the next prose line', () => {
    const answer =
      'Importers:\n- src/a.ts\n\nExcluded (comments only):\n- src/x.ts\n- src/y.ts\n\nAlso:\n- src/b.ts';
    expect([...answerPaths(answer)]).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps a list item whose note says "not" about something else', () => {
    expect([...answerPaths('- src/a.ts (not a re-export, a plain import)')]).toEqual(['src/a.ts']);
  });

  it('falls back to prose sentences when no line starts with a path', () => {
    expect([
      ...answerPaths('The importers are src/a.ts and src/b.ts. src/c.ts was a false positive.'),
    ]).toEqual(['src/a.ts', 'src/b.ts']);
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
  let ws = '';
  let universe = new Set<string>();
  let dead = new Set<string>();
  beforeAll(() => {
    ws = fresh();
    ({ universe, dead } = deadExportsOf(ws, 'src/server'));
  });
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
