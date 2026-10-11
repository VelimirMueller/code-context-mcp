/**
 * `npm run bench:rescore` — re-run the deterministic checkers on the saved
 * final answers of a live run (CCA-07). Zero API calls: it reads the run JSON
 * and the runner's artefact dir (one `<arm>-<task>[-rN].jsonl` event stream
 * per session), parses each stream for the final answer, and checks it again
 * with the CURRENT task definitions and checkers.
 *
 * CLI: npm run bench:rescore -- --run <run.json> [--artefacts <dir>] [--out <dir>]
 *   --artefacts  the run's artefact dir; default: the newest
 *                `<os tmpdir>/bench-live-<run_id>-*` directory
 *   --out        write the corrected run JSON to <out>/<run_id>.json
 *                (never over the input file); without it, print only
 *
 * Scope: answer-type checkers only — `answer` (L1), `importers` (L4) and
 * `dead-exports` (L6). L4/L6 compute their expected answer from the PRISTINE
 * source tree, so the script rebuilds it from the run's git commit
 * (`git archive <commit> src package.json tsconfig.json`). Checkers that need
 * the agent's EDITED workspace (`symbol` L2, `tests` L3, `rename` L5) cannot
 * be re-run — the workspace is deleted after each session — so those
 * sessions keep their recorded result, and the script says so. A timed-out
 * session stays a failure.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionResult } from './lib/types.mts';
import { runChecker } from './live/checkers.mts';
import { parseClaudeStream } from './live/parse-claude.mts';
import { parseEventStream } from './live/parse-events.mts';
import { LIVE_TASKS, type LiveTask } from './live/tasks.mts';
import { renormalizeProblem, renormalizeRun } from './renormalize.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Checkers that judge only the final answer (plus the pristine source). */
const RESCORABLE = new Set(['answer', 'importers', 'dead-exports']);
/** Checkers that judge the pristine source and therefore need the run's src/. */
const NEEDS_SRC = new Set(['importers', 'dead-exports']);
/** Arm keys in the run JSON, in display order. */
const ARM_KEYS = ['vanilla', 'cc', 'cc_guided'] as const;
type ArmKey = (typeof ARM_KEYS)[number];

interface RunJson {
  run_id: string;
  git?: { commit?: string; dirty?: boolean };
  agent_cli?: { name?: string };
  notes?: string[];
  tasks: Array<{ id: string; checker: unknown }>;
  arms: Partial<Record<ArmKey, { results: SessionResult[] }>>;
  aggregate: {
    success_rate: Partial<Record<ArmKey, number>>;
    per_task: Array<{ task_id: string } & Partial<Record<ArmKey, { success_rate: number }>>>;
  };
  headline: Record<string, number>;
}

export interface SessionChange {
  arm: ArmKey;
  events: string;
  task: string;
  before: boolean;
  after: boolean;
  detail: string;
}

export interface RescoreReport {
  run: RunJson;
  changes: SessionChange[];
  /** Sessions whose recorded result was kept, with the reason. */
  kept: Array<{ arm: ArmKey; events: string; reason: string }>;
  /** Success rate per arm before and after. */
  rates: Array<{ arm: ArmKey; before: number; after: number; n: number }>;
}

export interface RescoreOpts {
  artefactDir: string;
  /** Pristine source root (contains src/) for L4/L6; null = none available. */
  srcRoot: string | null;
}

const rate = (rs: SessionResult[]): number =>
  rs.length > 0 ? rs.filter((r) => r.success).length / rs.length : 0;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Final assistant text of one saved session (opencode or Claude Code stream). */
export function finalAnswer(eventsFile: string, agent: string): string {
  const lines = fs.readFileSync(eventsFile, 'utf-8').split('\n');
  return agent === 'claude-code'
    ? parseClaudeStream(lines).assistantText
    : parseEventStream(lines).assistantText;
}

export async function rescoreRun(input: RunJson, opts: RescoreOpts): Promise<RescoreReport> {
  const run = structuredClone(input);
  const agent = run.agent_cli?.name ?? 'opencode';
  const changes: SessionChange[] = [];
  const kept: RescoreReport['kept'] = [];
  const rates: RescoreReport['rates'] = [];
  const tasks = new Map<string, LiveTask>(LIVE_TASKS.map((t) => [t.id, t]));

  for (const arm of ARM_KEYS) {
    const results = run.arms[arm]?.results;
    if (!results) continue;
    const before = rate(results);
    for (const r of results) {
      const task = tasks.get(r.task_id);
      const keep = (reason: string): void => {
        kept.push({ arm, events: r.events_path, reason });
      };
      if (!task) {
        keep(`task ${r.task_id} no longer exists`);
        continue;
      }
      if (!RESCORABLE.has(task.checker.type)) {
        keep(`${task.checker.type} checker needs the edited workspace`);
        continue;
      }
      if (r.timeout) {
        keep('timed out');
        continue;
      }
      if (NEEDS_SRC.has(task.checker.type) && !opts.srcRoot) {
        keep(`${task.checker.type} checker needs the run's source tree (git commit unavailable)`);
        continue;
      }
      const eventsFile = path.join(opts.artefactDir, r.events_path);
      if (!fs.existsSync(eventsFile)) {
        keep(`events file missing: ${r.events_path}`);
        continue;
      }
      const check = await runChecker(
        task,
        opts.srcRoot ?? opts.artefactDir,
        finalAnswer(eventsFile, agent),
      );
      if (check.pass !== r.success) {
        changes.push({
          arm,
          events: r.events_path,
          task: r.task_id,
          before: r.success,
          after: check.pass,
          detail: check.detail,
        });
        r.success = check.pass;
      }
    }
    rates.push({ arm, before, after: rate(results), n: results.length });
  }

  // Success-derived fields only; tokens, tool calls, cost and wall time are
  // facts of the session and stay exactly as recorded.
  for (const arm of ARM_KEYS) {
    const results = run.arms[arm]?.results;
    if (!results) continue;
    if (arm in run.aggregate.success_rate) run.aggregate.success_rate[arm] = rate(results);
    for (const row of run.aggregate.per_task) {
      const cell = row[arm];
      if (cell) cell.success_rate = rate(results.filter((r) => r.task_id === row.task_id));
    }
  }
  const pct = (arm: ArmKey): number => round1(rate(run.arms[arm]?.results ?? []) * 100);
  run.headline.success_vanilla_pct = pct('vanilla');
  run.headline.success_cc_pct = pct('cc');
  if (typeof run.headline.success_cc_guided_pct === 'number') {
    run.headline.success_cc_guided_pct = pct('cc_guided');
  }
  // Record the checker spec that produced the new verdicts.
  for (const t of run.tasks) {
    const cur = tasks.get(t.id);
    if (cur && RESCORABLE.has(cur.checker.type)) t.checker = cur.checker;
  }

  // A full run file: success feeds the per-PASS metrics (CCA-08), so
  // recompute aggregate + headline from the (rescored) sessions.
  const full = run as unknown as { aggregate: { tokens?: unknown } };
  if (full.aggregate.tokens && renormalizeProblem(run) === null) {
    return { run: renormalizeRun(run).run, changes, kept, rates };
  }
  return { run, changes, kept, rates };
}

/** Pristine `src/` (+ package.json, tsconfig.json) at `commit`, or null when git cannot give it. */
export function materialiseSource(commit: string, into: string): string | null {
  try {
    const tar = execFileSync(
      'git',
      ['archive', '--format=tar', commit, 'src', 'package.json', 'tsconfig.json'],
      { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 },
    );
    fs.mkdirSync(into, { recursive: true });
    execFileSync('tar', ['-x', '-C', into], { input: tar });
    return into;
  } catch {
    return null;
  }
}

function findArtefactDir(runId: string): string | null {
  const tmp = os.tmpdir();
  const hits = fs
    .readdirSync(tmp)
    .filter((d) => d.startsWith(`bench-live-${runId}-`))
    .map((d) => path.join(tmp, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0] ?? null;
}

function parseArgs(argv: string[]): { run: string; artefacts?: string; out?: string } {
  const out: { run?: string; artefacts?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`bench:rescore: ${a} needs a value`);
      return v;
    };
    if (a === '--run') out.run = next();
    else if (a === '--artefacts') out.artefacts = next();
    else if (a === '--out') out.out = next();
    else throw new Error(`bench:rescore: unknown argument ${a}`);
  }
  if (!out.run) throw new Error('bench:rescore: --run <run.json> is required');
  return out as { run: string; artefacts?: string; out?: string };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runPath = path.resolve(args.run);
  const input = JSON.parse(fs.readFileSync(runPath, 'utf-8')) as RunJson;
  const artefactDir = args.artefacts ?? findArtefactDir(input.run_id);
  if (!artefactDir || !fs.existsSync(artefactDir)) {
    throw new Error(`bench:rescore: no artefact dir for ${input.run_id} (pass --artefacts <dir>)`);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rescore-'));
  try {
    const commit = input.git?.commit;
    const srcRoot = commit ? materialiseSource(commit, path.join(scratch, 'ws')) : null;
    console.log(`run:       ${input.run_id}`);
    console.log(
      `source:    ${srcRoot ? `git ${commit?.slice(0, 12)}${input.git?.dirty ? ' (run was DIRTY — source may differ)' : ''}` : 'unavailable — L4/L6 keep their recorded result'}`,
    );

    const report = await rescoreRun(input, { artefactDir, srcRoot });

    console.log('\nsuccess per arm (old → new):');
    for (const r of report.rates) {
      const n = (x: number): string => `${Math.round(x * r.n)}/${r.n}`;
      console.log(
        `  ${r.arm.padEnd(10)} ${n(r.before).padStart(5)} → ${n(r.after).padStart(5)}  ` +
          `(${round1(r.before * 100)} % → ${round1(r.after * 100)} %)`,
      );
    }
    console.log(`\nchanged sessions: ${report.changes.length}`);
    for (const c of report.changes) {
      console.log(
        `  ${c.events.padEnd(24)} ${c.before ? 'PASS' : 'FAIL'} → ${c.after ? 'PASS' : 'FAIL'}  — ${c.detail}`,
      );
    }
    const reasons = new Map<string, number>();
    for (const k of report.kept) reasons.set(k.reason, (reasons.get(k.reason) ?? 0) + 1);
    console.log(`kept as recorded: ${report.kept.length}`);
    for (const [reason, n] of reasons) console.log(`  ${n} × ${reason}`);

    if (args.out) {
      const outDir = path.resolve(args.out);
      const outPath = path.join(outDir, `${input.run_id}.json`);
      if (outPath === runPath) {
        throw new Error('bench:rescore: --out would overwrite the input run file');
      }
      const rescored = report.run;
      rescored.notes = [
        ...(rescored.notes ?? []),
        `rescored ${new Date().toISOString().slice(0, 10)} (CCA-07) with the current answer checkers: ` +
          `${report.changes.length} session(s) changed; edit-task results kept as recorded`,
      ];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(rescored, null, 2)}\n`);
      console.log(`\nwrote:     ${outPath}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
