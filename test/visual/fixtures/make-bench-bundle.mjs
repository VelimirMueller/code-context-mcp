// Pack a bench data dir into bench.json.gz: { "<relative path>": "<file text>" }.
// test/e2e/serve.mjs unpacks it next to the db in visual mode (#293).
// Refresh (changes the benchmark baselines, so the PR needs the label visual-change):
//   git archive origin/bench-results data | tar -x -C /tmp/bench &&
//   node test/visual/fixtures/make-bench-bundle.mjs /tmp/bench/data
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, 'index.json'))) {
  console.error('usage: node make-bench-bundle.mjs <bench data dir with index.json>');
  process.exit(64);
}
const files = {};
for (const rel of fs.readdirSync(src, { recursive: true }).sort()) {
  const abs = path.join(src, rel);
  if (fs.statSync(abs).isFile()) files[rel.split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'bench.json.gz');
fs.writeFileSync(out, gzipSync(JSON.stringify(files), { level: 9 }));
process.stdout.write(`${Object.keys(files).length} files -> ${out}\n`);
