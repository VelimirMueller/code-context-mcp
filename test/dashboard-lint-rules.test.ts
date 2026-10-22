/**
 * #293: the ESLint guardrails of the Tailwind migration fire on a new dashboard file
 * and let runtime values through.
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A path that is on no ratchet list, like any new component.
const NEW_FILE = path.join(ROOT, 'src/dashboard/frontend/src/components/atoms/LintProbe.tsx');

async function lint(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath: NEW_FILE });
  return result.messages.filter((m) => m.severity === 2).map((m) => m.message);
}

describe('dashboard lint rules (#293)', () => {
  it('blocks static inline style values', async () => {
    const errors = await lint(
      "export const A = () => <div style={{ color: 'var(--text2)', padding: `4px` }} />;",
    );
    expect(errors.filter((m) => m.startsWith('Static style value'))).toHaveLength(2);
  });

  it('blocks hover styles set in a handler', async () => {
    const errors = await lint(
      "export const A = () => <div onMouseEnter={(e) => { e.currentTarget.style.color = 'red'; }} />;",
    );
    expect(errors).toContain('Hover style in a handler: use a `hover:` utility (#293).');
  });

  it('blocks unknown classes such as old variable names', async () => {
    const errors = await lint(
      'export const A = () => <div className="bg-surface-2 text-text2" />;',
    );
    expect(errors).toEqual(['Unknown class detected: text-text2']);
  });

  it('allows runtime values and CSS variables from data', async () => {
    const errors = await lint(
      'export const A = ({ w, c }: { w: number; c: string }) => <div className="bg-(--c) rounded-card" style={{ width: w, [\'--c\' as string]: c }} />;',
    );
    expect(errors).toEqual([]);
  });
});
