/**
 * Large fixture and index-shaped tasks (CCA-09, #124): the generated tree is
 * pinned (file count + sha256), the answer key is reproducible from it by an
 * independent method (TypeScript compiler API), and the I-task checkers pass
 * right answers and fail wrong ones. No network, no model, no server.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFixture } from '../scripts/bench/live/prepare.mts';
import { answerExportNames, runChecker } from '../scripts/bench/live/checkers.mts';
import {
  DEFAULT_LIVE_TASKS,
  INDEX_TASKS,
  LIVE_TASKS,
  SMOKE_TASKS,
  tasksByIds,
  type LiveTask,
} from '../scripts/bench/live/tasks.mts';
import {
  fixtureHash,
  generateLargeFixture,
  readPinnedFixture,
  specifier,
} from '../scripts/bench/live/large-fixture/generate.mts';
import {
  computeAnswerKey,
  readAnswerKey,
} from '../scripts/bench/live/large-fixture/answer-key.mts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-large-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const key = readAnswerKey();
const task = (id: string): LiveTask => tasksByIds([id])[0];
const check = async (id: string, answer: string) => runChecker(task(id), tmp, answer);

describe('large fixture integrity', () => {
  const files = generateLargeFixture();

  it('is 500–1,000 files and matches the pinned count and sha256', () => {
    const pinned = readPinnedFixture();
    expect(files.size).toBeGreaterThanOrEqual(500);
    expect(files.size).toBeLessThanOrEqual(1000);
    expect(files.size).toBe(pinned.files);
    expect(fixtureHash(files)).toBe(pinned.sha256);
  });

  it('is deterministic: a second generation is byte-identical', () => {
    expect(fixtureHash(generateLargeFixture())).toBe(fixtureHash(files));
  });

  it('is big enough that reading it all costs far more than 50k chars', () => {
    const chars = [...files.values()].reduce((n, c) => n + c.length, 0);
    expect(chars).toBeGreaterThan(400_000);
    expect(key.fixture.chars).toBe(chars);
  });

  it('copyFixture("large") writes the pinned tree into the workspace', () => {
    const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
    copyFixture('large', ws);
    const onDisk = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else
          onDisk.set(
            path.relative(ws, full).split(path.sep).join('/'),
            fs.readFileSync(full, 'utf-8'),
          );
      }
    };
    walk(ws);
    expect(fixtureHash(onDisk)).toBe(key.fixture.sha256);
    expect(onDisk.has('package.json')).toBe(true);
    expect(onDisk.has('tsconfig.json')).toBe(true);
  });

  it('builds relative specifiers like a person would write them', () => {
    expect(specifier('src/a/service/x.ts', 'src/core/index.ts')).toBe('../../core');
    expect(specifier('src/a/service/x.ts', 'src/a/model/y.ts', true)).toBe('../model/y.js');
    expect(specifier('src/a/x.ts', 'src/a/y.ts')).toBe('./y');
  });
});

describe('answer key', () => {
  it('is reproducible from the fixture (TypeScript compiler API) and type-checks clean', () => {
    const fresh = computeAnswerKey();
    expect(fresh.fixture.typeErrors).toBe(0);
    expect(fresh).toEqual(key);
  }, 60_000);

  it('has answers of a useful size', () => {
    const a = key.answers;
    expect(a.retryImporters.length).toBeGreaterThanOrEqual(8);
    expect(a.orderLineImporters.length).toBeGreaterThanOrEqual(8);
    expect(a.formatMoneyImporters.length).toBeGreaterThanOrEqual(8);
    expect(a.catalogUtilsUnused.length).toBeGreaterThanOrEqual(5);
    expect(a.catalogUtilsUnused.length).toBeLessThan(a.catalogUtilsExports.length);
    expect(a.resolveTaxRateDefinition).toEqual(['src/pricing/utils/tax-rates.ts']);
    expect(a.pointsMathTwoHop.length).toBeGreaterThanOrEqual(10);
    // every task has grep noise to get past
    expect(key.decoys.resolveTaxRate.length).toBeGreaterThanOrEqual(5);
    expect(key.decoys.formatMoney.length).toBeGreaterThanOrEqual(1);
  });
});

describe('index-shaped task set', () => {
  const I = tasksByIds(['index']);

  it('the default run is the smoke set plus the index-shaped set', () => {
    expect(INDEX_TASKS).toBe('I1,I2,I3,I4,I5,I6');
    expect(DEFAULT_LIVE_TASKS).toBe(`${SMOKE_TASKS},${INDEX_TASKS}`);
    expect(tasksByIds(['default']).map((t) => t.id)).toEqual(DEFAULT_LIVE_TASKS.split(','));
    expect(tasksByIds(['smoke', 'I4']).map((t) => t.id)).toEqual(['L1', 'L2', 'I4']);
  });

  it('every I-task runs on the large fixture against a pinned answer', () => {
    for (const t of I) {
      expect(t.fixture).toBe('large');
      expect(['pinned-paths', 'pinned-exports']).toContain(t.checker.type);
      const k = (t.checker as { key: keyof typeof key.answers }).key;
      expect(key.answers[k].length).toBeGreaterThan(0);
    }
  });

  it('prompts are neutral: no tool or index names', () => {
    for (const t of I) {
      expect(t.prompt).not.toMatch(
        /who_imports|exports_in|find_symbol|code-context|index_directory|\bgrep\b|\bMCP\b/i,
      );
      expect(t.prompt).toContain('The bash tool is disabled');
    }
  });

  it('ids are unique', () => {
    const ids = LIVE_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('pinned-paths checkers (I1, I2, I3, I6)', () => {
  const cases = [
    ['I1', key.answers.retryImporters],
    ['I2', key.answers.orderLineImporters],
    ['I3', key.answers.formatMoneyImporters],
    ['I6', key.answers.pointsMathTwoHop],
  ] as const;

  for (const [id, expected] of cases) {
    it(`${id}: the pinned list passes in common spellings`, async () => {
      expect((await check(id, expected.join('\n'))).pass).toBe(true);
      expect((await check(id, expected.map((f) => `- \`${f}\``).join('\n'))).pass).toBe(true);
      expect((await check(id, expected.map((f) => f.replace(/^src\//, '')).join('\n'))).pass).toBe(
        true,
      );
      expect((await check(id, expected.map((f) => `/tmp/bench-ws-x/${f}`).join('\n'))).pass).toBe(
        true,
      );
    });

    it(`${id}: one missing file fails, two wrong extras fail, one is tolerated`, async () => {
      expect((await check(id, expected.slice(1).join('\n'))).pass).toBe(false);
      const decoys = ['src/platform/http/retry-budget.ts', 'src/support/service/ticket-service.ts'];
      expect((await check(id, [...expected, decoys[0]].join('\n'))).pass).toBe(true);
      expect((await check(id, [...expected, ...decoys].join('\n'))).pass).toBe(false);
    });
  }

  it('I2: the barrel importers (orders/index.ts consumers) are wrong extras', async () => {
    const throughBarrel = ['src/app/container.ts', 'src/app/routes.ts'];
    const r = await check('I2', [...key.answers.orderLineImporters, ...throughBarrel].join('\n'));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('2 extra');
  });

  it('I3: the barrel itself and the module are not counted against the answer', async () => {
    const r = await check(
      'I3',
      [...key.answers.formatMoneyImporters, 'src/core/money.ts', 'src/core/index.ts'].join('\n'),
    );
    expect(r.pass).toBe(true); // money.ts is ignored, core/index.ts is the one tolerated extra
  });

  it('I6: commentary after the list does not count (CCA-07 answerPaths rules)', async () => {
    const answer = `${key.answers.pointsMathTwoHop.join('\n')}\n\nNote: src/app/container.ts imports the loyalty barrel, which is a third hop, so it is excluded.`;
    expect((await check('I6', answer)).pass).toBe(true);
  });
});

describe('I5 definition checker', () => {
  it('passes with the declaring file on the first line, with or without commentary', async () => {
    expect((await check('I5', 'src/pricing/utils/tax-rates.ts')).pass).toBe(true);
    expect(
      (
        await check(
          'I5',
          '**`src/pricing/utils/tax-rates.ts`**\n\nIt is re-exported by src/pricing/index.ts; src/billing/utils/tax.ts has an unrelated local function.',
        )
      ).pass,
    ).toBe(true);
  });

  it('fails on a decoy: the stale comment target, a re-export or a local', async () => {
    for (const wrong of [
      'src/billing/utils/tax.ts',
      'src/pricing/index.ts',
      'src/shipping/service/shipment-service.ts',
    ]) {
      expect((await check('I5', wrong)).pass).toBe(false);
    }
    expect((await check('I5', 'It is defined in the pricing domain.')).pass).toBe(false);
  });
});

describe('I4 unused-exports checker', () => {
  const unused = key.answers.catalogUtilsUnused;
  const universe = new Set(key.answers.catalogUtilsExports.map((e) => e.name));
  const used = key.answers.catalogUtilsExports.filter(
    (e) => !unused.some((u) => u.name === e.name),
  );

  it('passes with `file: name` lines, bare names, a table or prose', async () => {
    expect((await check('I4', unused.map((e) => `${e.file}: ${e.name}`).join('\n'))).pass).toBe(
      true,
    );
    expect(
      (await check('I4', unused.map((e) => `- \`${e.name}\` — not imported anywhere`).join('\n')))
        .pass,
    ).toBe(true);
    const table = [
      '| File | Export |',
      '|---|---|',
      ...unused.map((e) => `| ${e.file} | ${e.name} |`),
    ].join('\n');
    expect((await check('I4', table)).pass).toBe(true);
    expect(
      (await check('I4', `The unused exports are ${unused.map((e) => e.name).join(', ')}.`)).pass,
    ).toBe(true);
  });

  it('keeps names with underscores (PRICE_PLACEHOLDER) and bare file names', () => {
    const got = answerExportNames(
      'price-format.ts: PRICE_PLACEHOLDER\nsku.ts: skuChecksum, legacySkuPrefix',
      universe,
    );
    expect([...got].sort()).toEqual(['PRICE_PLACEHOLDER', 'legacySkuPrefix', 'skuChecksum']);
  });

  it('a "used exports" section and trailing commentary are not claims', async () => {
    const answer = [
      'Unused exports:',
      ...unused.map((e) => `- ${e.file}: ${e.name} (only normalizeSku-style local use, or none)`),
      '',
      'Used exports (for reference):',
      ...used.map((e) => `- ${e.file}: ${e.name}`),
    ].join('\n');
    expect((await check('I4', answer)).pass).toBe(true);
  });

  it('fails with one missing or two used exports named', async () => {
    expect(
      (
        await check(
          'I4',
          unused
            .slice(1)
            .map((e) => `${e.file}: ${e.name}`)
            .join('\n'),
        )
      ).pass,
    ).toBe(false);
    const wrong = [...unused, ...used.slice(0, 2)].map((e) => `${e.file}: ${e.name}`).join('\n');
    const r = await check('I4', wrong);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('2 wrong');
  });

  it('the grep traps are wrong answers: a comment mention or a same-named local is no use', () => {
    // legacySkuPrefix is only in a comment elsewhere, attributeGroupLabel only a
    // local name elsewhere, collectionSlug only re-exported by the barrel.
    const names = unused.map((e) => e.name);
    for (const n of [
      'legacySkuPrefix',
      'attributeGroupLabel',
      'collectionSlug',
      'PRICE_PLACEHOLDER',
    ]) {
      expect(names).toContain(n);
    }
    // whole-module import() and type-only import both count as use
    for (const n of ['variantKey', 'MAX_VARIANT_AXES', 'SlugOptions'])
      expect(names).not.toContain(n);
  });
});

describe('answer block scoring (CCA-07, #261)', () => {
  const expected = key.answers.formatMoneyImporters;
  // Files that mention formatMoney but are not importers (real grep noise).
  const decoys = key.decoys.formatMoney;
  const fenced = (block: string[], prose: string[] = []): string =>
    [
      'The import graph lists these files as importers of `formatMoney`:',
      '',
      '```',
      ...block,
      '```',
      ...prose,
    ].join('\n');

  it('excluded names in prose do not count when the right answer sits in a fenced block', async () => {
    const answer = fenced(expected, [
      '',
      'Not counted (re-export or a mere mention):',
      ...decoys.map((f) => `- \`${f}\``),
    ]);
    const r = await check('I3', answer);
    expect(r.detail).toBe(`${expected.length}/${expected.length} found, 0 extra`);
    expect(r.pass).toBe(true);
  });

  it('a wrong path inside the block still fails', async () => {
    const r = await check('I3', fenced(['src/not-an-importer.ts']));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/missing/);
  });

  it('--score-prose keeps the old behaviour: prose extras count', async () => {
    const answer = fenced(expected, ['', 'Not counted:', ...decoys.map((f) => `- \`${f}\``)]);
    const r = await runChecker(task('I3'), tmp, answer, { scoreProse: true });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain(`${decoys.length} extra`);
  });
});
