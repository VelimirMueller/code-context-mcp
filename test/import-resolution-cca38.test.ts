/**
 * CCA-38 (#182): import-graph gaps the accuracy measurement found, closed in
 * the resolver and parsers:
 * - Vite `resolve.alias` (static object / array forms) is read.
 * - A bare specifier whose node_modules entry links back into the repo (npm,
 *   yarn, pnpm workspaces) resolves to the package source (NestJS: 818 of
 *   5,549 edges were missing).
 * - `.mts` / `.cts` files are parsed and resolved (this repo: 75 edges).
 * - `export default async function`, generators, `abstract` and `declare`
 *   exports are listed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyViteAlias, parseViteAliases, tokenize } from '../src/server/vite-alias.js';
import { AliasResolver } from '../src/server/tsconfig-paths.js';
import { initSchema } from '../src/server/schema.js';
import { indexDirectory, parseExports } from '../src/server/indexer.js';

const CFG = '/repo/app/vite.config.ts';

describe('parseViteAliases', () => {
  it('reads the object form with path.resolve, fileURLToPath and templates', () => {
    const text = `
      import { defineConfig } from 'vite';
      import path from 'node:path';
      import { fileURLToPath, URL } from 'node:url';
      export default defineConfig({
        resolve: {
          alias: {
            '@': path.resolve(__dirname, 'src'), // comment: '#': '/nope'
            '~lib': fileURLToPath(new URL('./lib', import.meta.url)),
            "#shared": \`\${__dirname}/../shared\`,
            assets: path.join(import.meta.dirname, 'public', 'img'),
            '/root': '/src',
            skipped: './relative',
            unknown: someCall('x'),
          },
        },
      });`;
    expect(parseViteAliases(text, CFG)).toEqual([
      { find: '@', replacement: '/repo/app/src', rootRelative: false },
      { find: '~lib', replacement: '/repo/app/lib', rootRelative: false },
      { find: '#shared', replacement: '/repo/shared', rootRelative: false },
      { find: 'assets', replacement: '/repo/app/public/img', rootRelative: false },
      { find: '/root', replacement: '/src', rootRelative: true },
    ]);
  });

  it('reads the array form, skips RegExp finds, and follows a local __dirname const', () => {
    const text = `
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const srcDir = resolve(__dirname, 'src');
      export default {
        resolve: {
          alias: [
            { find: /^~(.*)$/, replacement: '$1' },
            { find: '@', replacement: srcDir },
            { replacement: resolve(__dirname, 'x/y'), find: 'xy' },
          ],
        },
      };`;
    expect(parseViteAliases(text, CFG)).toEqual([
      { find: '@', replacement: '/repo/app/src', rootRelative: false },
      { find: 'xy', replacement: '/repo/app/x/y', rootRelative: false },
    ]);
  });

  it('returns nothing for a config without static aliases', () => {
    expect(parseViteAliases('export default { plugins: [react()] }', CFG)).toEqual([]);
    expect(
      parseViteAliases('const alias = makeAliases(); export default { resolve: { alias } }', CFG),
    ).toEqual([]);
  });

  it('does not mistake division for a regex literal', () => {
    const toks = tokenize("const a = b / 2; const c = 'x/y';");
    expect(toks.filter((t) => t.t === 'str')).toEqual([{ t: 'str', v: 'x/y' }]);
  });
});

describe('applyViteAlias', () => {
  const aliases = [
    { find: '@', replacement: '/repo/app/src' },
    { find: '/root', replacement: '/src', rootRelative: true },
  ];
  it('matches the key itself or the key followed by a slash, like @rollup/plugin-alias', () => {
    expect(applyViteAlias(aliases, '@/lib/x', '/repo/app')).toBe('/repo/app/src/lib/x');
    expect(applyViteAlias(aliases, '@', '/repo/app')).toBe('/repo/app/src');
    expect(applyViteAlias(aliases, '@nestjs/core', '/repo/app')).toBeNull();
    expect(applyViteAlias(aliases, '/root/a', '/repo/app')).toBe('/repo/app/src/a');
  });
});

describe('AliasResolver: Vite aliases and workspace packages', () => {
  let root: string;
  const w = (rel: string, text = 'export const x = 1;\n'): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cca38-')));
    // Vite app: alias "~" only in vite.config, "@" in both (tsconfig wins).
    w(
      'web/vite.config.ts',
      "import path from 'node:path';\nexport default { resolve: { alias: { '~': path.resolve(__dirname, 'src/lib'), '@': path.resolve(__dirname, 'nowhere') } } };\n",
    );
    w('web/tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
    w('web/src/lib/util.ts');
    w('web/src/main.ts');
    // Workspace: node_modules/@acme/core → packages/core (a link into the repo).
    w(
      'packages/core/package.json',
      '{ "name": "@acme/core", "types": "index.d.ts", "main": "index.js" }',
    );
    w('packages/core/index.ts');
    w('packages/core/sub/thing.ts');
    w('packages/app/main.ts');
    w('node_modules/real-ext/index.js', 'module.exports = 1;\n');
    fs.mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'packages/core'),
      path.join(root, 'node_modules/@acme/core'),
      'dir',
    );
    // A link that points outside the root is never followed.
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cca38-out-')));
    fs.writeFileSync(path.join(outside, 'index.ts'), 'export {};\n');
    fs.symlinkSync(outside, path.join(root, 'node_modules/escape'), 'dir');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves a Vite-only alias and lets tsconfig paths win where both exist', () => {
    const r = new AliasResolver(root);
    const from = path.join(root, 'web/src/main.ts');
    expect(r.resolve('~/util', from)).toBe(path.join(root, 'web/src/lib/util.ts'));
    expect(r.resolve('@/lib/util', from)).toBe(path.join(root, 'web/src/lib/util.ts'));
    // Outside the Vite app the alias does not apply.
    expect(r.resolve('~/util', path.join(root, 'packages/app/main.ts'))).toBeNull();
  });

  it('resolves workspace packages through node_modules links, never external ones', () => {
    const r = new AliasResolver(root);
    const from = path.join(root, 'packages/app/main.ts');
    // types index.d.ts is missing; main index.js maps to the index.ts source.
    expect(r.resolve('@acme/core', from)).toBe(path.join(root, 'packages/core/index.ts'));
    expect(r.resolve('@acme/core/sub/thing', from)).toBe(
      path.join(root, 'packages/core/sub/thing.ts'),
    );
    expect(r.resolve('@acme/core/../../app/main', from)).toBeNull();
    expect(r.resolve('real-ext', from)).toBeNull();
    expect(r.resolve('escape', from)).toBeNull();
    expect(r.resolve('missing-pkg', from)).toBeNull();
  });

  it('stores workspace edges and .mts edges in the index', () => {
    w('packages/app/main.ts', "import { x } from '@acme/core';\nexport const y = x;\n");
    w(
      'tools/a.mts',
      "import { b } from './b.mts';\nimport { c } from './c.mjs';\nexport const a = b + c;\n",
    );
    w('tools/b.mts', 'export const b = 1;\n');
    w('tools/c.mts', 'export const c = 1;\n');
    const db = new Database(':memory:');
    initSchema(db);
    const saved = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
    process.env.CODE_CONTEXT_ALLOWED_ROOTS = root;
    try {
      indexDirectory(db, root);
    } finally {
      if (saved === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
      else process.env.CODE_CONTEXT_ALLOWED_ROOTS = saved;
    }
    const edges = (
      db
        .prepare(
          `SELECT s.path AS s, t.path AS t FROM dependencies d JOIN files s ON s.id = d.source_id JOIN files t ON t.id = d.target_id`,
        )
        .all() as { s: string; t: string }[]
    ).map((e) => `${path.relative(root, e.s)} -> ${path.relative(root, e.t)}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        'packages/app/main.ts -> packages/core/index.ts',
        'tools/a.mts -> tools/b.mts',
        'tools/a.mts -> tools/c.mts',
      ]),
    );
    const mtsExports = db
      .prepare(`SELECT e.name FROM exports e JOIN files f ON f.id = e.file_id WHERE f.path = ?`)
      .all(path.join(root, 'tools/b.mts'));
    expect(mtsExports).toEqual([{ name: 'b' }]);
    const ext = db
      .prepare(`SELECT external_imports FROM files WHERE path = ?`)
      .get(path.join(root, 'packages/app/main.ts'));
    expect(ext).toEqual({ external_imports: null });
    db.close();
  });
});

describe('parseExports: declaration forms the regex parser used to miss', () => {
  it('lists async default functions, generators, abstract classes and declare exports', () => {
    const names = parseExports(
      [
        'export default async function Page() {}',
        'export function* walk() {}',
        'export async function *stream() {}',
        'export abstract class Base {}',
        'export declare const VERSION: string;',
        'export default abstract class Shape {}',
        'export const functional = 1;',
      ].join('\n'),
    ).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(['Page', 'walk', 'stream', 'Base', 'VERSION', 'Shape', 'functional']),
    );
    expect(names).not.toContain('al');
  });
});
