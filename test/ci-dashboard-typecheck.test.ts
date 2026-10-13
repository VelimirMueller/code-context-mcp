/**
 * #213: CI type-checks the dashboard app. The root `tsc --noEmit` does not
 * include src/dashboard/app, so the test job runs `npm run typecheck:dashboard`
 * too, and a type error there fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('dashboard type check in CI (#213)', () => {
  it('has a script that type-checks the dashboard app project', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['typecheck:dashboard']).toBe('tsc --noEmit -p src/dashboard/app');
  });

  it('runs the script in the CI test job', () => {
    const ci = read('.github/workflows/ci.yml');
    const testJob = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  lint:'));
    expect(testJob).toMatch(/^\s+- run: npm run typecheck:dashboard$/m);
    // No `|| true` or continue-on-error: a type error must fail the job.
    expect(testJob).not.toMatch(/typecheck:dashboard.*\|\|/);
    expect(testJob).not.toMatch(/continue-on-error/);
  });

  it('includes the whole app source in the dashboard tsconfig', () => {
    const tsconfig = JSON.parse(read('src/dashboard/app/tsconfig.json')) as {
      include: string[];
      compilerOptions: { strict: boolean; noEmit: boolean };
    };
    expect(tsconfig.include).toContain('src');
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });
});
