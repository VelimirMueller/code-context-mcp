#!/usr/bin/env node
// Copies the last published benchmark run into the repository.
//
//   node scripts/bench/snapshot.mjs <data-dir> <out-dir>
//
// <data-dir> is the data/ folder of the bench-results branch (index.json + runs/).
// The last run is the one the benchmark site shows as the newest "Run N":
// the newest run of each kind on the newest publish date. The script replaces
// every *.json in <out-dir> with those run files plus a manifest.json.
// Run by .github/workflows/bench-snapshot.yml; no network, no dependencies.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

function ms(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** index entries -> the run entries of the last run (newest per kind on the newest date). */
export function lastRun(runs) {
  const ok = (Array.isArray(runs) ? runs : []).filter(
    (r) =>
      r &&
      typeof r.run_id === 'string' &&
      ID_RE.test(r.run_id) &&
      typeof r.kind === 'string' &&
      typeof r.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.date),
  );
  if (!ok.length) return [];
  const newestDate = ok
    .map((r) => r.date)
    .sort()
    .at(-1);
  const byKind = new Map();
  for (const r of ok.filter((x) => x.date === newestDate)) {
    const cur = byKind.get(r.kind);
    const t = ms(r.ts || r.date) ?? 0;
    if (
      !cur ||
      t > (ms(cur.ts || cur.date) ?? 0) ||
      (t === (ms(cur.ts || cur.date) ?? 0) && r.run_id > cur.run_id)
    )
      byKind.set(r.kind, r);
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export function snapshot(dataDir, outDir) {
  const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'));
  const picks = lastRun(index && index.runs);
  if (!picks.length) throw new Error('no runs in index.json');
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith('.json')) rmSync(join(outDir, f));
  for (const r of picks) {
    const src = join(dataDir, 'runs', `${r.run_id}.json`);
    if (!existsSync(src)) throw new Error(`run file missing: runs/${r.run_id}.json`);
    const run = JSON.parse(readFileSync(src, 'utf8'));
    if (run.run_id !== r.run_id) throw new Error(`run_id mismatch in runs/${r.run_id}.json`);
    writeFileSync(join(outDir, `${r.run_id}.json`), JSON.stringify(run, null, 2) + '\n');
  }
  const manifest = {
    schema: 'ccc-bench-snapshot/1',
    date: picks[0].date,
    site: 'https://velimirmueller.github.io/code-context-mcp/',
    source: 'bench-results branch, data/runs/',
    runs: picks.map((r) => ({
      run_id: r.run_id,
      kind: r.kind,
      model: r.model ?? null,
      ts: r.ts ?? null,
      file: `${r.run_id}.json`,
    })),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const [dataDir, outDir] = process.argv.slice(2);
  if (!dataDir || !outDir) {
    console.error('usage: node scripts/bench/snapshot.mjs <data-dir> <out-dir>');
    process.exit(2);
  }
  const m = snapshot(dataDir, outDir);
  console.log(`snapshot ${m.date}: ${m.runs.map((r) => r.run_id).join(', ')}`);
}
