/**
 * #179: the module boundary between the code index and the sprint process.
 *
 * The index (src/server: the index entry, index/search/graph tools, indexer,
 * policy, gitignore) never imports src/scrum, src/dashboard or src/bridge.
 * The sprint side reaches them through a short allowlist of src/server files:
 * the sprint entry, the toolset registration file, and the two CLIs that
 * belong to the sprint process. The index entry loads the registration file
 * with a dynamic import, only when a sprint toolset is on.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO_ROOT, 'src');
const SERVER = path.join(SRC, 'server');
const SPRINT_DIRS = ['scrum', 'dashboard', 'bridge'].map((d) => path.join(SRC, d) + path.sep);

/** src/server files allowed to import the sprint side, with the reason. */
const ALLOWED: Record<string, string> = {
  'sprint.ts': 'the sprint entry (bin code-context-sprint)',
  'sprint-toolsets.ts': 'the toolset registration file: scrum schema, seed, scrum tools',
  'setup.ts': 'installs the sprint process (scrum seed, /kickoff, bridge hook)',
  'sync-github-cli.ts': 'the sprint process GitHub sync CLI',
};

/** The index entry loads the registration file lazily; nothing else is dynamic. */
const INDEX_DYNAMIC_IMPORTS = ['./sprint-toolsets.js'];

interface Imports {
  static: string[];
  dynamic: string[];
}

function importsOf(file: string): Imports {
  const src = fs.readFileSync(file, 'utf-8');
  const stat = new Set<string>();
  const dyn = new Set<string>();
  // `import … from 'x'`, `export … from 'x'`, `import 'x'` (multi-line import lists included).
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gms))
    stat.add(m[1]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) stat.add(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) dyn.add(m[1]);
  return { static: [...stat], dynamic: [...dyn] };
}

/** Resolve a relative specifier to a .ts file under src, or null for packages. */
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base + '.ts', path.join(base, 'index.ts')]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const isSprintSide = (file: string) => SPRINT_DIRS.some((d) => file.startsWith(d));
const rel = (file: string) => path.relative(REPO_ROOT, file);

const serverFiles = fs
  .readdirSync(SERVER)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(SERVER, f));

describe('module boundary: code index vs sprint process (#179)', () => {
  it('only the allowlisted src/server files import src/scrum, src/dashboard or src/bridge', () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      if (ALLOWED[path.basename(file)]) continue;
      const { static: s, dynamic: d } = importsOf(file);
      for (const spec of [...s, ...d]) {
        const target = resolveSpec(file, spec);
        if (target && isSprintSide(target)) offenders.push(`${rel(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file exists (no stale exemptions)', () => {
    for (const name of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(SERVER, name)), name).toBe(true);
    }
  });

  it('the index code never reaches the sprint side through static imports', () => {
    const seen = new Set<string>();
    const reached: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      if (isSprintSide(file)) reached.push(rel(file));
      for (const spec of importsOf(file).static) {
        const target = resolveSpec(file, spec);
        if (target) walk(target);
      }
    };
    // The index entry, the reindex CLI and the gitignore helper are the roots.
    for (const root of ['index.ts', 'reindex-cli.ts', 'gitignore.ts'])
      walk(path.join(SERVER, root));
    expect(reached).toEqual([]);
    // Sanity: the walk covers the index code named in the issue.
    for (const f of ['indexer.ts', 'graph.ts', 'index-policy.ts', 'schema.ts', 'tool-wrap.ts'])
      expect(seen.has(path.join(SERVER, f)), f).toBe(true);
    expect(seen.has(path.join(SERVER, 'sprint-toolsets.ts'))).toBe(false);
  });

  it('the index entry loads the sprint process only through the registration file', () => {
    expect(importsOf(path.join(SERVER, 'index.ts')).dynamic).toEqual(INDEX_DYNAMIC_IMPORTS);
  });

  it('the sprint entry loads the index entry, not a copy of the server', () => {
    const { static: s, dynamic: d } = importsOf(path.join(SERVER, 'sprint.ts'));
    expect(d).toEqual(['./index.js']);
    for (const spec of s) {
      const target = resolveSpec(path.join(SERVER, 'sprint.ts'), spec);
      if (target) expect(isSprintSide(target), spec).toBe(false);
    }
  });
});
