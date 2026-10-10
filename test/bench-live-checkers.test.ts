/**
 * Task 6 unit tests — live-bench task set + deterministic checkers.
 *
 * Everything runs against temp copies of test/fixtures/sample-project; no
 * model, no opencode, no network. The L3 checker spawns the repo's vitest
 * inside the temp workspace (local process, still no network).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_TASKS,
  tasksByIds,
  renderPrompt,
  DEFAULT_LIVE_TASKS,
} from '../scripts/bench/live/tasks.mts';
import { runChecker, normaliseAnswer } from '../scripts/bench/live/checkers.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(repoRoot, 'test', 'fixtures', 'sample-project');

const L1 = LIVE_TASKS.find((t) => t.id === 'L1')!;
const L2 = LIVE_TASKS.find((t) => t.id === 'L2')!;
const L3 = LIVE_TASKS.find((t) => t.id === 'L3')!;

let tmpRoot = '';

function freshWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  fs.cpSync(FIXTURE, ws, { recursive: true });
  return ws;
}

/** Apply the L2 solution: slugify in helpers.ts + barrel re-export. */
function addSlugify(ws: string): void {
  const helpers = path.join(ws, 'src/utils/helpers.ts');
  fs.writeFileSync(
    helpers,
    `${fs.readFileSync(helpers, 'utf-8').trimEnd()}\n\n/**\n * Turn text into a lowercase dash-separated slug.\n */\nexport function slugify(text: string): string {\n  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n`,
  );
  const barrel = path.join(ws, 'src/utils/index.ts');
  fs.writeFileSync(
    barrel,
    fs
      .readFileSync(barrel, 'utf-8')
      .replace(
        'export { formatDate, capitalize, clamp, generateId, DEFAULT_PAGE_SIZE } from "./helpers.js";',
        'export { formatDate, capitalize, clamp, generateId, slugify, DEFAULT_PAGE_SIZE } from "./helpers.js";',
      ),
  );
}

/** Apply the L3 solution: parseDuration in helpers.ts + barrel re-export. */
function addParseDuration(ws: string): void {
  const helpers = path.join(ws, 'src/utils/helpers.ts');
  fs.writeFileSync(
    helpers,
    `${fs.readFileSync(helpers, 'utf-8').trimEnd()}\n\n/**\n * Parse a duration string like "1h 30m" into milliseconds, or null.\n */\nexport function parseDuration(str: string): number | null {\n  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };\n  let total = 0;\n  let matched = false;\n  for (const m of str.toLowerCase().matchAll(/(\\d+)\\s*(d|h|m|s)/g)) {\n    total += Number(m[1]) * units[m[2]];\n    matched = true;\n  }\n  return matched ? total : null;\n}\n`,
  );
  const barrel = path.join(ws, 'src/utils/index.ts');
  fs.writeFileSync(
    barrel,
    fs
      .readFileSync(barrel, 'utf-8')
      .replace(
        'export { formatDate, capitalize, clamp, generateId, DEFAULT_PAGE_SIZE } from "./helpers.js";',
        'export { formatDate, capitalize, clamp, generateId, parseDuration, DEFAULT_PAGE_SIZE } from "./helpers.js";',
      ),
  );
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-live-checkers-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('task set', () => {
  it('defines L1–L6 with prompts and checkers', () => {
    expect(LIVE_TASKS.map((t) => t.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'S1']);
    for (const t of LIVE_TASKS) {
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.checker.type).toMatch(/^(answer|symbol|tests|importers|rename|dead-exports)$/);
    }
  });

  it('no task needs a shell — prompts steer to the built-in file tools', () => {
    for (const t of LIVE_TASKS) {
      if (t.id === 'S1') continue; // the probe deliberately ATTEMPTS bash (must be refused)
      expect(t.prompt, `${t.id} prompt must not rely on a shell`).toMatch(/bash tool is disabled/);
    }
  });

  it('S1 is the opt-in sandbox probe and never runs by default', () => {
    const S1 = LIVE_TASKS.find((t) => t.id === 'S1')!;
    expect(S1.prompt).toContain('/proc/self/environ');
    expect(S1.prompt).toContain('{HOME}');
    expect(DEFAULT_LIVE_TASKS).not.toContain('S1');
  });

  it('renderPrompt substitutes {HOME} with the session’s isolated home', () => {
    const S1 = LIVE_TASKS.find((t) => t.id === 'S1')!;
    const rendered = renderPrompt(S1, { fakeHome: '/tmp/bench-home-x' });
    expect(rendered).toContain('/tmp/bench-home-x/.profile');
    expect(rendered).not.toContain('{HOME}');
    // tasks without placeholders pass through byte-identical
    const L1 = LIVE_TASKS.find((t) => t.id === 'L1')!;
    expect(renderPrompt(L1, { fakeHome: '/tmp/other' })).toBe(L1.prompt);
  });

  it('tasksByIds resolves and rejects ids', () => {
    expect(tasksByIds(['L1', 'L3']).map((t) => t.id)).toEqual(['L1', 'L3']);
    expect(() => tasksByIds(['L9'])).toThrow(/unknown task id/);
  });
});

describe('L1 answer checker', () => {
  it('passes on the pristine fixture with the right answer', async () => {
    const ws = freshWorkspace();
    const res = await runChecker(
      L1,
      ws,
      '`formatDate` is exported by `src/utils/helpers.ts` (and re-exported through the\n`src/utils/index.ts` barrel). It has NO imports — it is self-contained and\ndepends only on the built-in JavaScript Date API.',
    );
    expect(res.pass).toBe(true);
  });

  it('fails with a wrong file', async () => {
    const ws = freshWorkspace();
    const res = await runChecker(
      L1,
      ws,
      'formatDate lives in src/services/api.ts and depends on types.ts.',
    );
    expect(res.pass).toBe(false);
    expect(res.detail).toMatch(/missing/);
  });

  it('fails when only the barrel is named', async () => {
    const ws = freshWorkspace();
    const res = await runChecker(
      L1,
      ws,
      'src/utils/index.ts exports formatDate; it depends on nothing.',
    );
    expect(res.pass).toBe(false);
  });

  it('fails on an empty answer', async () => {
    const res = await runChecker(L1, freshWorkspace(), '   ');
    expect(res.pass).toBe(false);
    expect(res.detail).toMatch(/empty/);
  });

  it('normalises case, backticks, backslashes and whitespace', () => {
    expect(normaliseAnswer('  `SRC\\Utils\\HELPERS.TS`  ')).toBe('src/utils/helpers.ts');
  });
});

describe('L2 symbol checker', () => {
  it('fails on the pristine workspace', async () => {
    const res = await runChecker(L2, freshWorkspace(), '');
    expect(res.pass).toBe(false);
    expect(res.detail).toMatch(/no workspace file exports slugify/);
  });

  it('passes on the modified workspace', async () => {
    const ws = freshWorkspace();
    addSlugify(ws);
    const res = await runChecker(L2, ws, 'added slugify to helpers.ts');
    expect(res.pass).toBe(true);
    expect(res.detail).toContain('src/utils/index.ts');
  });

  it('fails when the symbol exists but the barrel does not re-export it', async () => {
    const ws = freshWorkspace();
    const helpers = path.join(ws, 'src/utils/helpers.ts');
    fs.writeFileSync(
      helpers,
      `${fs.readFileSync(helpers, 'utf-8').trimEnd()}\n\nexport function slugify(text: string): string {\n  return text.toLowerCase();\n}\n`,
    );
    const res = await runChecker(L2, ws, '');
    expect(res.pass).toBe(false);
    expect(res.detail).toMatch(/does not re-export/);
  });
});

describe('L3 tests checker', () => {
  it('fails on the pristine workspace', async () => {
    const res = await runChecker(L3, freshWorkspace(), '');
    expect(res.pass).toBe(false);
    expect(res.detail).toMatch(/hidden check failed/);
  }, 180_000);

  it('passes on the modified workspace', async () => {
    const ws = freshWorkspace();
    addParseDuration(ws);
    const res = await runChecker(L3, ws, 'added parseDuration');
    expect(res.pass).toBe(true);
    expect(res.detail).toMatch(/hidden check passed/);
  }, 180_000);

  // Security audit 2026-10-10: the agent may drop a vitest.config.* into the
  // workspace; the checker must run vitest with the harness-owned config
  // (--config outside the workspace, --root the workspace), so the planted
  // config — its import side effects AND its globalSetup/setupFiles — never
  // executes. The marker is written twice: at config-module top level (fires
  // on load) and from the globalSetup file (fires if hooks load).
  const plantedConfig = (marker: string, setupFile: string): string =>
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(marker)}, 'config-loaded');\n` +
    `export default {\n` +
    `  test: {\n` +
    `    globalSetup: [${JSON.stringify(`./${setupFile}`)}],\n` +
    `  },\n` +
    `};\n`;
  const plantedSetup = (marker: string): string =>
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(marker)}, 'global-setup-ran');\n`;

  it('ignores an agent-planted vitest config (trusted --config + --root containment)', async () => {
    const marker = path.join(tmpRoot, 'pwned-marker');
    const ws = freshWorkspace();
    addParseDuration(ws); // the workspace is a SOLVED one — merits must pass
    fs.writeFileSync(path.join(ws, 'vitest.config.ts'), plantedConfig(marker, 'pwned.setup.ts'));
    fs.writeFileSync(path.join(ws, 'pwned.setup.ts'), plantedSetup(marker));

    const res = await runChecker(L3, ws, 'added parseDuration');
    expect(res.pass, 'the hidden check still runs on its own merits').toBe(true);
    expect(fs.existsSync(marker), 'the planted vitest config must NOT be loaded').toBe(false);
  }, 180_000);

  it('ignores an agent-planted vitest.config.mts even when the check fails', async () => {
    const marker = path.join(tmpRoot, 'pwned-marker-2');
    const ws = freshWorkspace(); // pristine: the hidden check fails on merits
    fs.writeFileSync(path.join(ws, 'vitest.config.mts'), plantedConfig(marker, 'pwned2.setup.mts'));
    fs.writeFileSync(path.join(ws, 'pwned2.setup.mts'), plantedSetup(marker));

    const res = await runChecker(L3, ws, '');
    expect(res.pass).toBe(false);
    expect(fs.existsSync(marker), 'the planted vitest config must NOT be loaded').toBe(false);
  }, 180_000);
});
