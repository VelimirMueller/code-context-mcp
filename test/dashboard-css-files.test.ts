/**
 * #293: the dashboard styles with Tailwind utilities and the tokens in src/index.css.
 * That file is the only stylesheet; a new .css (or Sass, Less …) file fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'src/dashboard/frontend');
const STYLE_FILE = /\.(css|scss|sass|less|styl|pcss)$/;

function styleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist') return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return styleFiles(full);
    return STYLE_FILE.test(e.name) ? [path.relative(FRONTEND, full)] : [];
  });
}

describe('dashboard stylesheets (#293)', () => {
  it('has src/index.css as its only stylesheet', () => {
    expect(styleFiles(FRONTEND)).toEqual(['src/index.css']);
  });
});
