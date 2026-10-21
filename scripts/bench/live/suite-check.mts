/**
 * `pnpm run bench:suite-check <dir> [--no-index] [--keep]` — free check of
 * a suite (CCA-17): no provider key, no agent CLI, no model call.
 *
 * 1. loads and validates <dir>/suite.json + answers.json (loadSuite),
 * 2. builds ONE workspace from the pinned sources (git archive),
 * 3. checks every `paths` answer item exists in that workspace,
 * 4. indexes the workspace with the in-process indexer (as the cc arm does)
 *    and reports files, MB, index time and db size.
 *
 * Prints counts only — no prompts, no answers, no file names. Exit 1 on any
 * problem. --keep leaves the workspace in place and prints its path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../../src/server/schema.js';
import { indexDirectory } from '../../../src/server/indexer.js';
import { loadSuite, writeSuiteWorkspace } from './suite.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface SuiteCheckReport {
  suite: string;
  sources: number;
  tasks: number;
  files: number;
  bytes: number;
  buildMs: number;
  /** answers.json path items missing in the workspace (count only in console output). */
  missingPaths: string[];
  index?: { ms: number; files: number; dbBytes: number };
  ws?: string;
}

function walk(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  }
  return { files, bytes };
}

export function checkSuite(
  dir: string,
  opts: { index?: boolean; keep?: boolean; tmpdir?: string } = {},
): SuiteCheckReport {
  const suite = loadSuite(dir, { repoRoot });
  const ws = fs.realpathSync(
    fs.mkdtempSync(path.join(opts.tmpdir ?? os.tmpdir(), 'bench-suite-ws-')),
  );
  try {
    const t0 = Date.now();
    writeSuiteWorkspace(suite, ws);
    const buildMs = Date.now() - t0;
    const { files, bytes } = walk(ws);
    const missingPaths = Object.values(suite.answers)
      .filter((a) => a.kind === 'paths')
      .flatMap((a) => a.items)
      .filter((p) => !fs.existsSync(path.join(ws, p)));
    const report: SuiteCheckReport = {
      suite: suite.id,
      sources: suite.sources.length,
      tasks: suite.tasks.length,
      files,
      bytes,
      buildMs,
      missingPaths,
    };
    if (opts.index !== false) {
      const prev = process.env.CODE_CONTEXT_ALLOWED_ROOTS;
      process.env.CODE_CONTEXT_ALLOWED_ROOTS = [ws, ...(prev ? [prev] : [])].join(',');
      const dbPath = path.join(ws, 'context.db');
      const db = new Database(dbPath);
      try {
        db.pragma('journal_mode = WAL');
        initSchema(db);
        const t1 = Date.now();
        const r = indexDirectory(db, ws);
        report.index = { ms: Date.now() - t1, files: r.files, dbBytes: 0 };
      } finally {
        db.close();
        if (prev === undefined) delete process.env.CODE_CONTEXT_ALLOWED_ROOTS;
        else process.env.CODE_CONTEXT_ALLOWED_ROOTS = prev;
      }
      report.index.dbBytes = fs.statSync(dbPath).size;
    }
    if (opts.keep) report.ws = ws;
    return report;
  } finally {
    if (!opts.keep) fs.rmSync(ws, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: pnpm run bench:suite-check <suite dir> [--no-index] [--keep]');
    process.exit(1);
  }
  try {
    const r = checkSuite(dir, {
      index: !args.includes('--no-index'),
      keep: args.includes('--keep'),
    });
    const mb = (b: number): string => (b / 1024 / 1024).toFixed(1);
    console.log(`suite ${r.suite}: valid (${r.sources} sources, ${r.tasks} tasks)`);
    console.log(`workspace: ${r.files} files, ${mb(r.bytes)} MB, built in ${r.buildMs} ms`);
    if (r.index) {
      console.log(
        `index: ${r.index.files} files indexed in ${r.index.ms} ms, db ${mb(r.index.dbBytes)} MB`,
      );
    }
    if (r.ws) console.log(`kept: ${r.ws}`);
    if (r.missingPaths.length) {
      console.error(
        `${r.missingPaths.length} answer path(s) missing in the workspace — answers.json drifted`,
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(`bench:suite-check: ${(e as Error).message}`);
    process.exit(1);
  }
}
