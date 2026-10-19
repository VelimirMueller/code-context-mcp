import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs script without types
import { lastRun, snapshot } from '../scripts/bench/snapshot.mjs';

const run = (run_id: string, kind: string, ts: string) => ({
  schema: 'ccc-bench/1',
  run_id,
  kind,
  date: ts.slice(0, 10),
  ts,
  model: kind === 'simulated' ? null : 'm',
});

describe('bench snapshot (benchmarks/latest)', () => {
  it('picks the newest run of each kind on the newest publish date', () => {
    const picks = lastRun([
      run('glm-a', 'agent-glm', '2026-10-11T12:00:00Z'),
      run('glm-b', 'agent-glm', '2026-10-11T18:00:00Z'),
      run('sim-a', 'simulated', '2026-10-11T14:00:00Z'),
      run('dsk-old', 'agent-deepseek', '2026-10-10T23:00:00Z'),
      { run_id: '../evil', kind: 'simulated', date: '2026-10-11' },
    ]);
    expect(picks.map((r: any) => r.run_id)).toEqual(['glm-b', 'sim-a']);
    expect(lastRun([])).toEqual([]);
  });

  it('replaces old copies and writes a manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-'));
    const data = join(root, 'data');
    mkdirSync(join(data, 'runs'), { recursive: true });
    const runs = [
      run('glm-b', 'agent-glm', '2026-10-11T18:00:00Z'),
      run('sim-a', 'simulated', '2026-10-11T14:00:00Z'),
    ];
    writeFileSync(join(data, 'index.json'), JSON.stringify({ runs }));
    for (const r of runs) writeFileSync(join(data, 'runs', `${r.run_id}.json`), JSON.stringify(r));
    const out = join(root, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'stale-run.json'), '{}');
    writeFileSync(join(out, 'README.md'), 'kept');
    const m = snapshot(data, out);
    expect(m.date).toBe('2026-10-11');
    expect(readdirSync(out).sort()).toEqual([
      'README.md',
      'glm-b.json',
      'manifest.json',
      'sim-a.json',
    ]);
    expect(JSON.parse(readFileSync(join(out, 'glm-b.json'), 'utf8')).run_id).toBe('glm-b');
  });

  it('fails when a picked run file is missing, and writes no partial manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-'));
    mkdirSync(join(root, 'data', 'runs'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'index.json'),
      JSON.stringify({ runs: [run('glm-x', 'agent-glm', '2026-10-11T18:00:00Z')] }),
    );
    expect(() => snapshot(join(root, 'data'), join(root, 'out'))).toThrow(/run file missing/);
    expect(existsSync(join(root, 'out', 'manifest.json'))).toBe(false);
  });

  it('the committed copy matches its manifest', () => {
    const dir = join(__dirname, '..', 'benchmarks', 'latest');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(m.runs.length).toBeGreaterThan(0);
    for (const r of m.runs) {
      const f = JSON.parse(readFileSync(join(dir, r.file), 'utf8'));
      expect(f.run_id).toBe(r.run_id);
      expect(f.kind).toBe(r.kind);
      expect(f.date).toBe(m.date);
    }
  });
});
