/**
 * `pnpm run bench:renormalize` — recompute `aggregate` and `headline` of saved
 * agent runs from their session results (CCA-08). Zero API calls, no
 * artefacts needed: every metric derives from `arms.*.results`.
 *
 * Use it to give old run files the honest metrics (uncached tokens, cost,
 * tokens per PASS, paired deltas with spread). Session facts (tokens, calls,
 * success, cost) stay exactly as recorded; only derived fields change. Run
 * `bench:rescore` first when the checkers changed, then this.
 *
 * Side effect on pre-2026-10-11 runs: `tokens.*.total` was input + output
 * then; recomputed, it is input + cache_read + output like every newer run.
 *
 * CLI: pnpm run bench:renormalize --out <dir> <run.json> [<run.json> ...]
 *   --out   write each recomputed run to <out>/<run_id>.json (never over an
 *           input file); without it, print the new headlines only
 * Simulated and legacy runs are skipped (they have no sessions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentHeadline, SessionResult } from './lib/types.mts';
import { aggregateLive } from './normalize-live.mts';

const AGENT_KINDS = new Set(['agent-glm', 'agent-deepseek', 'agent-opus']);

interface RunLike {
  run_id: string;
  kind?: string;
  notes?: string[];
  tasks?: Array<{ id: string }>;
  arms?: {
    vanilla?: { results: SessionResult[] };
    cc?: { results: SessionResult[] };
    cc_guided?: { results: SessionResult[] };
  };
  aggregate?: unknown;
  headline?: unknown;
}

export interface RenormalizeResult<T> {
  run: T;
  before: unknown;
  after: AgentHeadline;
}

/** Null reason when `run` can be renormalized; otherwise why not. */
export function renormalizeProblem(run: unknown): string | null {
  if (!run || typeof run !== 'object') return 'not a JSON object';
  const r = run as RunLike;
  if (!r.kind || !AGENT_KINDS.has(r.kind)) return `kind ${String(r.kind)} has no sessions`;
  if (!Array.isArray(r.arms?.vanilla?.results) || !Array.isArray(r.arms?.cc?.results)) {
    return 'missing arms.vanilla / arms.cc results';
  }
  return null;
}

/**
 * Recompute aggregate + headline from the sessions. Pure; never mutates the
 * input. Task order follows `run.tasks`; task ids that appear only in
 * sessions are appended.
 */
export function renormalizeRun<T extends object>(input: T): RenormalizeResult<T> {
  const problem = renormalizeProblem(input);
  if (problem) throw new Error(`renormalize: ${problem}`);
  const run = structuredClone(input) as T & RunLike;
  const vanilla = run.arms!.vanilla!.results;
  const cc = run.arms!.cc!.results;
  const guided = run.arms!.cc_guided?.results ?? [];
  const ids = (run.tasks ?? []).map((t) => t.id);
  for (const r of [...vanilla, ...cc, ...guided]) if (!ids.includes(r.task_id)) ids.push(r.task_id);
  const { aggregate, headline } = aggregateLive(ids, { vanilla, cc, ccGuided: guided });
  const before = run.headline;
  run.aggregate = aggregate;
  run.headline = headline;
  return { run, before, after: headline };
}

function fmtPass(x: number | null | undefined): string {
  return typeof x === 'number' ? x.toLocaleString('en-US') : 'n/a';
}
function fmtPct(x: number | null | undefined): string {
  return typeof x === 'number' ? `${x > 0 ? '+' : ''}${x} %` : 'n/a';
}

/** One-paragraph summary of a headline for the CLI. */
export function headlineSummary(h: AgentHeadline): string {
  const guided = typeof h.success_cc_guided_pct === 'number';
  const spread = (s: AgentHeadline['uncached_saved_spread']): string =>
    s ? ` [${fmtPct(s.min)} … ${fmtPct(s.max)}, ${s.repeats} repeats]` : '';
  const lines = [
    `  success          vanilla ${h.success_vanilla_pct} % · cc ${h.success_cc_pct} %` +
      (guided ? ` · guided ${h.success_cc_guided_pct} %` : ''),
    `  uncached saved   cc ${fmtPct(h.uncached_saved_pct)}${spread(h.uncached_saved_spread)}` +
      (guided
        ? ` · guided ${fmtPct(h.guided_uncached_saved_pct)}${spread(h.guided_uncached_saved_spread)}`
        : ''),
    `  cost saved       cc ${fmtPct(h.cost_saved_pct)}` +
      (guided ? ` · guided ${fmtPct(h.guided_cost_saved_pct)}` : ''),
    `  uncached / PASS  vanilla ${fmtPass(h.uncached_per_pass?.vanilla)} · cc ${fmtPass(h.uncached_per_pass?.cc)}` +
      (guided ? ` · guided ${fmtPass(h.uncached_per_pass?.cc_guided)}` : ''),
    `  (all tokens saved, demoted: cc ${fmtPct(h.tokens_saved_pct)}` +
      (guided ? ` · guided ${fmtPct(h.guided_tokens_saved_pct)}` : '') +
      ')',
  ];
  return lines.join('\n');
}

function parseArgs(argv: string[]): { out?: string; files: string[] } {
  const out: { out?: string; files: string[] } = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('bench:renormalize: --out needs a value');
      out.out = v;
    } else if (a.startsWith('--')) {
      throw new Error(`bench:renormalize: unknown argument ${a}`);
    } else out.files.push(a);
  }
  if (out.files.length === 0) throw new Error('bench:renormalize: pass at least one run file');
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ? path.resolve(args.out) : null;
  const inputs = new Set(args.files.map((f) => path.resolve(f)));
  for (const file of args.files) {
    const input = JSON.parse(fs.readFileSync(file, 'utf-8')) as RunLike;
    const problem = renormalizeProblem(input);
    if (problem) {
      console.log(`skip ${path.basename(file)}: ${problem}`);
      continue;
    }
    const { run, after } = renormalizeRun(input);
    console.log(`\n${run.run_id} (${run.kind})`);
    console.log(headlineSummary(after));
    if (outDir) {
      const outPath = path.join(outDir, `${run.run_id}.json`);
      if (inputs.has(outPath)) {
        throw new Error(`bench:renormalize: --out would overwrite the input ${outPath}`);
      }
      run.notes = [
        ...(run.notes ?? []),
        `renormalized ${new Date().toISOString().slice(0, 10)} (CCA-08): aggregate and headline ` +
          'recomputed from the recorded sessions (uncached tokens, cost, per-PASS, paired deltas)',
      ];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`);
      console.log(`  wrote ${outPath}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
