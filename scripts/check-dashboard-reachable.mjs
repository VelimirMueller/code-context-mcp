#!/usr/bin/env node
// Fail on dashboard modules that no page reaches (#223).
//
// Walks the import graph of the dashboard app from its entry (src/main.tsx,
// the script in index.html) with the TypeScript module resolver and the app
// tsconfig (so the `@/` alias resolves the same way as in Vite). Static
// imports, `export … from`, dynamic `import()` and `require()` count.
// Every .ts/.tsx file under src/dashboard/app/src must be reached, except
// test code (src/test/, *.test.*) and type declarations (*.d.ts).
//
// Usage: node scripts/check-dashboard-reachable.mjs [--json]
// Exit 0 when every module is reached, 1 when some are not, 2 on a setup error.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(root, 'src/dashboard/app');

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

/** Compiler options of the app tsconfig in `appDir` (paths, JSX, resolution). */
export function compilerOptions(appDir = APP_DIR) {
  const read = ts.readConfigFile(path.join(appDir, 'tsconfig.json'), ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, appDir).options;
}

/**
 * App modules under `appDir/src` that the entry `src/main.tsx` does not reach,
 * as paths relative to `appDir`. Test code (src/test/, *.test.*) and type
 * declarations (*.d.ts) are not app modules.
 */
export function unreachableModules(appDir = APP_DIR) {
  const srcDir = path.join(appDir, 'src');
  const options = compilerOptions(appDir);
  const host = ts.createCompilerHost(options);
  const isAppModule = (file) => {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    if (!/\.tsx?$/.test(rel) || rel.endsWith('.d.ts')) return false;
    return !rel.startsWith('test/') && !/\.test\.tsx?$/.test(rel);
  };

  const reached = new Set();
  const queue = [path.join(srcDir, 'main.tsx')];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      const resolved = ts.resolveModuleName(fileName, file, options, host).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      const target = path.resolve(resolved.resolvedFileName);
      // Only the app source is checked; shared modules outside it (e.g. @bench) are not followed.
      if (target.startsWith(srcDir + path.sep)) queue.push(target);
    }
  }
  return listFiles(srcDir)
    .filter((f) => isAppModule(f) && !reached.has(f))
    .map((f) => path.relative(appDir, f).split(path.sep).join('/'))
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let unreachable;
  try {
    unreachable = unreachableModules();
  } catch (e) {
    console.error(`check-dashboard-reachable: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(unreachable)}\n`);
  } else if (unreachable.length === 0) {
    process.stdout.write(
      'check-dashboard-reachable: every dashboard module is reached from src/main.tsx\n',
    );
  } else {
    console.error(
      `check-dashboard-reachable: ${unreachable.length} dashboard module(s) are not reached from src/main.tsx:`,
    );
    for (const f of unreachable) console.error(`  src/dashboard/app/${f}`);
    console.error('Delete them, or import them from a page.');
  }
  process.exit(unreachable.length === 0 ? 0 : 1);
}
