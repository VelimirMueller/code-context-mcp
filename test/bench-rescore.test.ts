/**
 * CCA-07: `pnpm run bench:rescore` re-runs the answer checkers on saved event
 * streams. These tests build a tiny run JSON + artefact dir (opencode JSON
 * events) and check what flips, what is kept and how the aggregate follows.
 * No model, no network.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rescoreRun } from '../scripts/bench/rescore.mts';
import type { SessionResult } from '../scripts/bench/lib/types.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rescore-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const realL1 = (
  JSON.parse(
    fs.readFileSync(path.join(here, 'fixtures', 'bench', 'cca-07-false-negatives.json'), 'utf-8'),
  ) as { answers: Array<{ task: string; answer: string }> }
).answers.find((a) => a.task === 'L1')!.answer;

/** One opencode `text` event per line, as `opencode run --format json` prints it. */
function events(text: string): string {
  return `${JSON.stringify({ type: 'text', part: { id: 'prt_1', type: 'text', text } })}\n`;
}

function session(
  task: string,
  events_path: string,
  success: boolean,
  timeout = false,
): SessionResult {
  return {
    task_id: task,
    success,
    timeout,
    tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
    tool_calls: 1,
    mcp_tool_calls: 0,
    wall_ms: 100,
    session_id: 'ses_x',
    events_path,
  };
}

describe('rescoreRun', () => {
  it('flips a false-negative L1, keeps edit tasks and timeouts, updates the aggregate', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'art-'));
    fs.writeFileSync(path.join(dir, 'vanilla-L1-r1.jsonl'), events(realL1));
    fs.writeFileSync(path.join(dir, 'vanilla-L1-r2.jsonl'), events('formatDate is in src/a.ts.'));
    fs.writeFileSync(path.join(dir, 'vanilla-L1-r3.jsonl'), events(realL1));
    fs.writeFileSync(path.join(dir, 'vanilla-L3-r1.jsonl'), events('done'));
    const results = [
      session('L1', 'vanilla-L1-r1.jsonl', false),
      session('L1', 'vanilla-L1-r2.jsonl', false),
      session('L1', 'vanilla-L1-r3.jsonl', false, true),
      session('L3', 'vanilla-L3-r1.jsonl', true),
    ];
    const run = {
      run_id: 'glm-test',
      agent_cli: { name: 'opencode' },
      tasks: [
        { id: 'L1', checker: { type: 'answer', answerMustMatch: ['old'] } },
        { id: 'L3', checker: { type: 'tests', checkFile: 'x' } },
      ],
      arms: { vanilla: { results } },
      aggregate: {
        success_rate: { vanilla: 0.25 },
        per_task: [
          { task_id: 'L1', vanilla: { success_rate: 0 } },
          { task_id: 'L3', vanilla: { success_rate: 1 } },
        ],
      },
      headline: { success_vanilla_pct: 25, success_cc_pct: 0 },
    };
    const before = structuredClone(run);

    const report = await rescoreRun(run, { artefactDir: dir, srcRoot: null });

    expect(report.changes.map((c) => [c.events, c.before, c.after])).toEqual([
      ['vanilla-L1-r1.jsonl', false, true],
    ]);
    expect(report.kept.map((k) => k.reason)).toEqual([
      'timed out',
      'tests checker needs the edited workspace',
    ]);
    expect(report.rates).toEqual([{ arm: 'vanilla', before: 0.25, after: 0.5, n: 4 }]);
    expect(report.run.aggregate.success_rate.vanilla).toBe(0.5);
    expect(report.run.aggregate.per_task[0].vanilla?.success_rate).toBeCloseTo(1 / 3);
    expect(report.run.aggregate.per_task[1].vanilla?.success_rate).toBe(1);
    expect(report.run.headline.success_vanilla_pct).toBe(50);
    expect(
      (report.run.tasks[0].checker as { answerMustMatch: string[] }).answerMustMatch[0],
    ).not.toBe('old');
    // Token and tool facts are untouched; the input object is not mutated.
    expect(report.run.arms.vanilla?.results[0].tokens).toEqual(results[0].tokens);
    expect(run).toEqual(before);
  });

  it('keeps L4/L6 as recorded when the source tree is unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'art-'));
    fs.writeFileSync(path.join(dir, 'cc-L4-r1.jsonl'), events('src/server/index.ts'));
    const run = {
      run_id: 'dsk-test',
      tasks: [
        { id: 'L4', checker: { type: 'importers', target: 'src/server/schema.ts', maxExtra: 1 } },
      ],
      arms: { cc: { results: [session('L4', 'cc-L4-r1.jsonl', false)] } },
      aggregate: {
        success_rate: { cc: 0 },
        per_task: [{ task_id: 'L4', cc: { success_rate: 0 } }],
      },
      headline: { success_vanilla_pct: 0, success_cc_pct: 0 },
    };
    const report = await rescoreRun(run, { artefactDir: dir, srcRoot: null });
    expect(report.changes).toEqual([]);
    expect(report.kept[0].reason).toMatch(/source tree/);
  });
  it('recomputes the per-PASS headline of a full run file (CCA-08)', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'art-'));
    fs.writeFileSync(path.join(dir, 'vanilla-L1-r1.jsonl'), events(realL1));
    const run = {
      run_id: 'glm-full',
      kind: 'agent-glm',
      agent_cli: { name: 'opencode' },
      tasks: [{ id: 'L1', checker: { type: 'answer', answerMustMatch: ['old'] } }],
      arms: {
        vanilla: { results: [session('L1', 'vanilla-L1-r1.jsonl', false)] },
        cc: { results: [session('L1', 'cc-L1-r1.jsonl', true)] },
      },
      aggregate: {
        success_rate: { vanilla: 0, cc: 1 },
        tokens: {},
        per_task: [{ task_id: 'L1', vanilla: { success_rate: 0 }, cc: { success_rate: 1 } }],
      },
      headline: { success_vanilla_pct: 0, success_cc_pct: 100 },
    };
    const report = await rescoreRun(run, { artefactDir: dir, srcRoot: null });
    expect(report.changes).toHaveLength(1);
    const h = report.run.headline as unknown as {
      success_vanilla_pct: number;
      uncached_per_pass: { vanilla: number | null; cc: number | null };
    };
    expect(h.success_vanilla_pct).toBe(100);
    // vanilla had no PASS before; after the flip its 15 uncached tokens count once.
    expect(h.uncached_per_pass).toEqual({ vanilla: 15, cc: 15 });
  });
});
