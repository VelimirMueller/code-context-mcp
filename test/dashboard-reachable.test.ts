/**
 * #223: every dashboard module is reached from src/main.tsx, and CI fails on
 * a module that no page reaches (scripts/check-dashboard-reachable.mjs).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs script without type declarations
import { unreachableModules } from '../scripts/check-dashboard-reachable.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** A small app with the dashboard tsconfig shape: `@/` alias, JSX, bundler resolution. */
function fixtureApp(files: Record<string, string>): string {
  tmp = mkdtempSync(path.join(tmpdir(), 'reachable-'));
  writeFileSync(
    path.join(tmp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        allowImportingTsExtensions: true,
        noEmit: true,
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src'],
    }),
  );
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    writeFileSync(path.join(tmp, rel), text);
  }
  return tmp;
}

describe('unreachable dashboard modules (#223)', () => {
  it('finds none in the dashboard app', () => {
    expect(unreachableModules()).toEqual([]);
  });

  it('follows aliases, re-exports and dynamic imports, and reports the rest', () => {
    const app = fixtureApp({
      'src/main.tsx':
        "import { a } from '@/a';\nconst lazy = () => import('./pages/Lazy');\nexport { a, lazy };\n",
      'src/a.ts': "export * from './b';\nexport const a = 1;\n",
      'src/b.ts': 'export const b = 2;\n',
      'src/pages/Lazy.tsx': 'export default function Lazy() { return null; }\n',
      'src/orphan.tsx': "import { b } from './b';\nexport const orphan = b;\n",
      'src/components/index.ts': "export * from '../orphan';\n",
      'src/test/orphan.test.ts': "import '../orphan';\n",
      'src/vite-env.d.ts': '/// <reference types="vite/client" />\n',
    });
    expect(unreachableModules(app)).toEqual(['src/components/index.ts', 'src/orphan.tsx']);
  });

  it('runs in the CI lint job and fails it', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:dashboard-reachable']).toBe(
      'node scripts/check-dashboard-reachable.mjs',
    );
    const ci = read('.github/workflows/ci.yml');
    const lintJob = ci.slice(ci.indexOf('\n  lint:'), ci.indexOf('\n  e2e:'));
    expect(lintJob).toMatch(/^\s+run: npm run check:dashboard-reachable$/m);
    expect(lintJob).not.toMatch(/check:dashboard-reachable.*\|\|/);
    expect(lintJob).not.toMatch(/continue-on-error/);
  });
});
