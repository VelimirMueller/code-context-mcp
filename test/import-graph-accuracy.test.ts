/**
 * CCA-38 (#182): the import-graph accuracy script scores the indexer against
 * the TypeScript compiler. On a 5-file fixture with an alias, an index file, a
 * star re-export, a type-only and a dynamic import, the compiler truth must be
 * exact and the one regex false positive (a commented-out import) must be
 * found and named.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigIndex,
  measureRepo,
  sampleOf,
  truthRefs,
  codeOnly,
} from '../scripts/research/import-graph-accuracy.mts';

const FIXTURE = fs.realpathSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/import-accuracy'),
);
const src = (p: string): string => path.join(FIXTURE, 'src', p);

describe('import-graph accuracy script (CCA-38)', () => {
  it('reads every module reference the compiler sees, with its kind and target', () => {
    const configs = new ConfigIndex(FIXTURE);
    const refs = truthRefs(src('app.ts'), fs.readFileSync(src('app.ts'), 'utf-8'), configs);
    expect(refs.map((r) => [r.spec, r.kind, r.target && path.relative(FIXTURE, r.target)])).toEqual(
      [
        ['@/lib/math', 'static', 'src/lib/math.ts'],
        ['./lib/math', 'type-only', 'src/lib/math.ts'],
        ['./lib', 'static', 'src/lib/index.ts'],
        ['./lazy', 'dynamic', 'src/lazy.ts'],
      ],
    );
    const barrel = truthRefs(
      src('lib/index.ts'),
      fs.readFileSync(src('lib/index.ts'), 'utf-8'),
      configs,
    );
    expect(barrel).toEqual([
      { spec: './math', kind: 're-export', target: src('lib/math.ts'), viaNodeModules: false },
    ]);
  });

  it('scores edges, who_imports and exports and names the false positive', () => {
    const r = measureRepo(FIXTURE, { sample: 50 });
    // Truth: app → math, app → lib/index, app → lazy, lib/index → math.
    expect(r.edges).toMatchObject({ tp: 4, fp: 1, fn: 0 });
    expect(r.edges.precision).toBeCloseTo(0.8);
    expect(r.edges.recall).toBe(1);
    expect(r.edgesByCategory.fp).toEqual({ 'not an import per compiler (comment/string)': 1 });
    expect(r.falsePositives.map((e) => [path.relative(FIXTURE, e.target), e.spec])).toEqual([
      ['src/legacy.ts', './legacy'],
    ]);
    expect(r.aliasEdges).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    // legacy.ts gets a phantom importer from the commented-out line.
    expect(r.whoImports.fp).toBe(1);
    expect(r.whoImports.recall).toBe(1);
    // lib/index.ts re-exports add and Num with `export *`: the index lists them under math.ts.
    expect(r.exportsIn.fnByCategory).toEqual({ 'export * re-export': 2 });
    expect(r.exportsIn.fp).toBe(0);
  });

  it('samples deterministically', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    expect(sampleOf(xs, 5, 182)).toEqual(sampleOf(xs, 5, 182));
    expect(sampleOf(xs, 5, 182)).not.toEqual(sampleOf(xs, 5, 183));
    expect(new Set(sampleOf(xs, 100, 1)).size).toBe(100);
  });

  it('blanks comments, strings and template text but keeps code and offsets', () => {
    const text = "export const a = `x ${b} export const c` + '// no'; // export const d\n";
    const code = codeOnly(text);
    expect(code).toHaveLength(text.length);
    expect(code).toContain('export const a');
    expect(code[text.indexOf('${b}') + 2]).toBe('b'); // the substitution stays code
    expect(code).not.toContain('export const c');
    expect(code).not.toContain('export const d');
  });
});
