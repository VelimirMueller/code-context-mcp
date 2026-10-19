// Dist freshness (S1, Sprint 23). Lives on the index side since #179: the
// index entry's `health` reports it, and the sprint entry re-exports it from
// src/scrum/tools.ts for get_resume_state.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Newest mtime of files with the given extensions under dir (shallow recursion, skips dot-dirs/node_modules). */
function newestMtime(dir: string, exts: string[], depth = 0): number {
  if (depth > 4) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p, exts, depth + 1));
    else if (exts.some((e) => entry.name.endsWith(e)))
      newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/**
 * S1 (Sprint 1 try_next, adopted Sprint 23): warn when src is newer than the compiled
 * dist the running server was loaded from — new/changed tools are silently missing
 * until `npm run build` + MCP reconnect. Returns null when fresh or not a dev checkout.
 */
export function checkDistFreshness(rootDir: string = process.cwd()): string | null {
  try {
    const srcDir = join(rootDir, 'src');
    const distDir = join(rootDir, 'dist');
    if (!existsSync(srcDir) || !existsSync(distDir)) return null; // packaged install — nothing to compare
    const srcNewest = newestMtime(srcDir, ['.ts', '.tsx']);
    const distNewest = newestMtime(distDir, ['.js']);
    if (srcNewest > distNewest + 5000) {
      return '⚠ STALE DIST: src/ is newer than the compiled server — run `npm run build` and reconnect MCP, or new/changed tools stay silently missing.';
    }
    return null;
  } catch {
    return null; // freshness is advisory — never break a tool over it
  }
}
