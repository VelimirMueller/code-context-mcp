/**
 * Deterministic checkers for the live bench task set (PLAN.md task 6).
 *
 * Checkers take `(workspaceDir, finalAnswer)` and return `{ pass, detail }` —
 * no model, no opencode, no network. Symbol detection reuses `parseExports`
 * from src/server/indexer.ts instead of reimplementing it. Hidden check
 * files are copied into the workspace only at check time, never before.
 * The tests checker runs vitest with a harness-owned config outside the
 * workspace (`--config` + `--root`, see vitest.trusted.config.mts), so
 * agent-authored workspace config is never loaded.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExports } from '../../../src/server/indexer.js';
import { checkerSpawnEnv } from './sandbox.mts';
import type { LiveTask, PinnedPathKey } from './tasks.mts';
import { ANSWERS_PATH } from './large-fixture/generate.mts';
import type { AnswerKey } from './large-fixture/answer-key.mts';

export interface CheckResult {
  pass: boolean;
  detail: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const CHECKS_DIR = path.join(scriptDir, 'checks');
const CHECK_TIMEOUT_MS = 120_000;

/** Lowercase, strip quotes/backticks/markdown bold, forward slashes, collapse whitespace. */
export function normaliseAnswer(answer: string): string {
  return answer
    .toLowerCase()
    .replace(/[`"'*]/g, '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A marker line the model may put before its answer list. */
const ANSWER_MARKER_RE = /^(?:Answer|Result|Final answer):\s*/i;

/**
 * The answer block the answer checkers score (CCA-07, #261): the LAST fenced
 * code block in the model's final message, or the text after the last line
 * matching `^(Answer|Result|Final answer):`. Falls back to the whole message
 * when neither is present (the answer is then prose or plain lines). Names a
 * session mentions in explanation prose around the block never count.
 */
export function answerBlock(finalAnswer: string): string {
  const lines = finalAnswer.split('\n');
  let fence = false;
  let body: string[] = [];
  let lastBlock: string | null = null;
  let markerAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence && ANSWER_MARKER_RE.test(line)) markerAt = i;
    if (/^\s*```/.test(line)) {
      if (fence) {
        lastBlock = body.join('\n');
        body = [];
      }
      fence = !fence;
    } else if (fence) {
      body.push(line);
    }
  }
  if (fence && body.length > 0) lastBlock = body.join('\n'); // unterminated fence
  if (lastBlock !== null) return lastBlock;
  if (markerAt >= 0) {
    const trailing = lines[markerAt].replace(ANSWER_MARKER_RE, '');
    const rest = lines.slice(markerAt + 1);
    return (trailing ? [trailing, ...rest] : rest).join('\n');
  }
  return finalAnswer;
}

function checkAnswer(task: LiveTask, finalAnswer: string): CheckResult {
  const norm = normaliseAnswer(finalAnswer);
  if (!norm) return { pass: false, detail: 'empty final answer' };
  const missing: string[] = [];
  for (const source of (task.checker as { answerMustMatch: string[] }).answerMustMatch) {
    let re: RegExp;
    try {
      re = new RegExp(source);
    } catch {
      // A bad pattern is a checker bug, not a crash of the whole live run:
      // fail this task with a clear reason instead.
      return { pass: false, detail: `invalid checker pattern /${source}/` };
    }
    if (!re.test(norm)) missing.push(`/${source}/`);
  }
  return missing.length === 0
    ? { pass: true, detail: 'answer matches all patterns' }
    : { pass: false, detail: `answer missing: ${missing.join(' ')}` };
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function checkSymbol(task: LiveTask, workspaceDir: string): CheckResult {
  const { symbol, barrel } = task.checker as { symbol: string; barrel: string };
  const srcDir = path.join(workspaceDir, 'src');
  if (!fs.existsSync(srcDir)) return { pass: false, detail: 'no src/ directory in workspace' };

  const definers: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const exports = parseExports(fs.readFileSync(file, 'utf-8'));
    if (exports.some((e) => e.name === symbol)) {
      definers.push(path.relative(workspaceDir, file));
    }
  }
  if (definers.length === 0) {
    return { pass: false, detail: `no workspace file exports ${symbol}` };
  }

  const barrelPath = path.join(workspaceDir, barrel);
  if (!fs.existsSync(barrelPath)) {
    return {
      pass: false,
      detail: `barrel ${barrel} not found (defined in ${definers.join(', ')})`,
    };
  }
  const barrelExports = parseExports(fs.readFileSync(barrelPath, 'utf-8'));
  if (!barrelExports.some((e) => e.name === symbol)) {
    return {
      pass: false,
      detail: `${barrel} does not re-export ${symbol} (defined in ${definers.join(', ')})`,
    };
  }
  return {
    pass: true,
    detail: `${symbol} defined in ${definers.join(', ')} and re-exported from ${barrel}`,
  };
}

async function checkTests(task: LiveTask, workspaceDir: string): Promise<CheckResult> {
  const { checkFile } = task.checker as { checkFile: string };
  const source = path.join(CHECKS_DIR, checkFile);
  if (!fs.existsSync(source))
    return { pass: false, detail: `hidden check file missing: ${checkFile}` };

  const targetDir = path.join(workspaceDir, 'test');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, checkFile);
  fs.copyFileSync(source, target);

  const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitestBin)) {
    return { pass: false, detail: 'vitest not installed in the repo (npm ci first)' };
  }

  // Config containment (security audit 2026-10-10): vitest runs with a
  // harness-owned config passed EXPLICITLY (--config, this file lives in the
  // repo, outside every workspace) and --root pinned to the workspace, so an
  // agent-authored vitest.config.*/vitest.workspace.* in the workspace is
  // never loaded — its globalSetup/setupFiles cannot run.
  const trustedConfig = path.join(CHECKS_DIR, 'vitest.trusted.config.mts');

  // The code under test was written by the model and is untrusted: run it in a
  // fresh fake HOME with a scrubbed env (no provider keys, no GITHUB_TOKEN),
  // cwd inside the temp workspace, and a hard timeout that kills the process
  // group (SIGTERM then SIGKILL) so a hung test cannot outlive the checker.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-check-home-'));
  const { code, tail } = await new Promise<{ code: number | null; tail: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        vitestBin,
        'run',
        '--config',
        trustedConfig,
        '--root',
        workspaceDir,
        path.join('test', checkFile),
      ],
      {
        cwd: workspaceDir,
        env: checkerSpawnEnv({ fakeHome }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let timedOut = false;
    let closed = false; // guards the SIGKILL timer against a recycled pid
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));

    let settled = false; // 'error' and 'close' can both fire; resolve once
    let killTimer: NodeJS.Timeout | undefined;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        if (closed) return;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000);
    }, CHECK_TIMEOUT_MS);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      closed = true;
      clearTimeout(killer);
      clearTimeout(killTimer);
      const out = Buffer.concat([...stdout, ...stderr]).toString('utf-8');
      resolve({ code: timedOut ? null : code, tail: out.slice(-600) });
    };
    child.on('close', finish);
    child.on('error', () => finish(null));
  });

  fs.rmSync(fakeHome, { recursive: true, force: true });

  return code === 0
    ? { pass: true, detail: `hidden check passed (${checkFile})` }
    : {
        pass: false,
        detail: `hidden check failed (exit ${code ?? 'timeout'}): …${tail.replace(/\s+/g, ' ').slice(-300)}`,
      };
}

// ---- ladder checkers (L4–L6): expected answers are COMPUTED from source ----

/** Every .ts/.tsx/.mts file under `<root>/src`, skipping node_modules. */
function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

const rel = (root: string, f: string): string => path.relative(root, f).split(path.sep).join('/');
const stripExt = (p: string): string => p.replace(/\.(ts|tsx|mts|js|mjs)$/, '');
const wordRe = (name: string, flags = ''): RegExp =>
  new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, flags);

const IMPORT_SPEC_RES = [
  /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s+['"]([^'"]+)['"]/g,
];

/** Workspace files that import or re-export `target` (relative specifiers only). */
export function importersOf(root: string, target: string): string[] {
  const want = stripExt(target);
  const hits: string[] = [];
  for (const f of srcFiles(root)) {
    const src = fs.readFileSync(f, 'utf-8');
    const specs = IMPORT_SPEC_RES.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));
    const hit = specs.some(
      (sp) => sp.startsWith('.') && stripExt(rel(root, path.resolve(path.dirname(f), sp))) === want,
    );
    if (hit && rel(root, f) !== target) hits.push(rel(root, f));
  }
  return hits.sort();
}

/** A relative or absolute .ts/.tsx/.mts path; group 1 drops a leading `./`. */
const PATH_SRC = String.raw`(?:\.\/)?(\/?[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|mts))`;
const PATH_RE = new RegExp(PATH_SRC, 'g');
const LEAD_PATH_RE = new RegExp(`^${PATH_SRC}\\b`);

/** `src/a.ts`, `a.ts`-style `server/a.ts` and `/tmp/ws-x/src/a.ts` all become `src/…`. */
function toSrc(p: string): string {
  const inSrc = /(?:^|\/)(src\/.+)$/.exec(p);
  if (inSrc) return inSrc[1];
  return `src/${p.replace(/^\/+/, '')}`;
}

/**
 * Cues that a line or sentence names a path WITHOUT claiming it as an answer:
 * "excluded", "false positive", "only mentions it", "a different module",
 * "no longer", "not an import", "isn't an importer", "doesn't import it".
 * Narrow on purpose: a plain "not" ("- src/a.ts (not a re-export)") must not
 * drop a real answer, so "not" only counts right before import/importer.
 */
const NEGATION_RE =
  /\b(?:exclu(?:ded|des|de|ding|sions?)|false[- ]positives?|ignored|unrelated|different module|no longer|only (?:mentions?|references?)|(?:not|never|isn['’]t|aren['’]t|doesn['’]t|don['’]t)\s+(?:\w+\s+){0,2}?(?:imports?|importers?|importing)\b)/i;

/** List markers, quotes and emphasis that may precede a path at line start. */
const LINE_LEAD_RE = /^(?:\s*(?:[-*+•>]|\d+[.)])\s+)*[\s`*_"']*/;

/**
 * The paths a line OFFERS as answers: the run of paths at the very start of
 * the line (after list markers, backticks or bold), separated only by commas,
 * "and" or whitespace. Paths later in the line are commentary.
 */
function leadingPaths(line: string, leadRe: RegExp = LEAD_PATH_RE): string[] {
  let rest = line.replace(LINE_LEAD_RE, '');
  const out: string[] = [];
  for (;;) {
    const m = leadRe.exec(rest);
    if (!m) break;
    out.push(m[1]);
    rest = rest.slice(m[0].length);
    const sep = /^[`*_"']*(?:\s*(?:,|;|&|\band\b)\s*|\s+)[`*_"']*/.exec(rest);
    if (!sep || sep[0].length === 0) break;
    rest = rest.slice(sep[0].length);
  }
  return out;
}

/**
 * File paths an answer CLAIMS, normalised to `src/…` (CCA-07, 2026-10-11).
 *
 * Rule: the answer list is every line that STARTS with a path (plain lines,
 * list items, lines in a code block). Paths inside prose — "the fifth grep
 * hit (`src/x.ts`) was a false positive" — are commentary, not answers.
 * A path line is dropped when it carries a negation cue (NEGATION_RE:
 * "`src/a.ts` only mentions it in a comment, not an import") or sits under a
 * short negating heading ("Notes on exclusions:", "False positives:") until
 * the next prose line. If no line starts with a path, the answer is prose
 * ("the importers are src/a.ts and src/b.ts"): every path counts, except in
 * sentences with a negation cue.
 *
 * A model that lists a wrong file AS an answer still pays for it: list lines
 * without a negation cue always count.
 */
export function answerPaths(answer: string): Set<string> {
  return claimedPaths(answer, { lead: LEAD_PATH_RE, any: PATH_RE, normalise: toSrc });
}

/** How claimedPaths finds and normalises paths (TS fixtures vs suite workspaces). */
interface PathClaimRules {
  /** A path at the start of the rest of a line; group 1 = the path. */
  lead: RegExp;
  /** Any path in prose (global); group 1 = the path. */
  any: RegExp;
  /** Map a matched path to the key form (`src/…`, `<source>/…`). */
  normalise: (p: string) => string;
}

/**
 * Any relative or absolute file path with an extension and at least one
 * folder; group 1 drops a leading `./`. Suite workspaces hold any language.
 */
const ANY_PATH_SRC = String.raw`(?:\.\/)?(\/?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z][A-Za-z0-9]{0,7})`;

/**
 * Claimed paths of an answer about a suite workspace (CCA-17), normalised to
 * `<source>/…`: an absolute path or one with a leading folder is cut at the
 * first segment that names a source. Same claim rules as answerPaths.
 */
export function suiteAnswerPaths(answer: string, roots: readonly string[]): Set<string> {
  const rootSet = new Set(roots);
  const normalise = (p: string): string => {
    const segs = p.replace(/^\/+/, '').split('/');
    const i = segs.findIndex((x) => rootSet.has(x));
    return i >= 0 ? segs.slice(i).join('/') : segs.join('/');
  };
  return claimedPaths(answer, {
    lead: new RegExp(`^${ANY_PATH_SRC}(?![\\w/])`),
    any: new RegExp(ANY_PATH_SRC, 'g'),
    normalise,
  });
}

/** The claim rules documented on answerPaths, with pluggable path syntax. */
function claimedPaths(answer: string, rules: PathClaimRules): Set<string> {
  const lines = answer.replace(/\\/g, '/').split('\n');
  const listed = new Set<string>();
  let anyPathLine = false;
  let negatedSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const lead = leadingPaths(line, rules.lead);
    if (lead.length === 0) {
      // Prose line: a short negating heading opens an excluded section;
      // any other prose line closes it.
      const words = line.split(/\s+/).length;
      const heading = /^#{1,6}\s/.test(line) || (line.endsWith(':') && words <= 8);
      negatedSection = heading && NEGATION_RE.test(line);
      continue;
    }
    anyPathLine = true;
    if (negatedSection || NEGATION_RE.test(line)) continue;
    for (const p of lead) listed.add(rules.normalise(p));
  }
  if (anyPathLine) return listed;

  const out = new Set<string>();
  for (const sentence of answer.replace(/\\/g, '/').split(/(?<=[.;!?])\s+|\n/)) {
    if (NEGATION_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(rules.any)) out.add(rules.normalise(m[1]));
  }
  return out;
}

function checkImporters(task: LiveTask, ws: string, finalAnswer: string): CheckResult {
  const { target, maxExtra } = task.checker as { target: string; maxExtra: number };
  const expected = importersOf(ws, target);
  if (expected.length === 0) {
    return { pass: false, detail: `fixture drifted: nothing imports ${target} any more` };
  }
  const named = answerPaths(finalAnswer);
  named.delete(target);
  const missing = expected.filter((f) => !named.has(f));
  const extra = [...named].filter((f) => !expected.includes(f));
  const pass = expected.length > 0 && missing.length === 0 && extra.length <= maxExtra;
  return {
    pass,
    detail:
      `${expected.length - missing.length}/${expected.length} importers found, ${extra.length} extra` +
      (missing.length ? `; missing ${missing.join(', ')}` : '') +
      (extra.length ? `; extra ${extra.join(', ')}` : ''),
  };
}

function countWord(files: string[], name: string): number {
  return files.reduce(
    (n, f) => n + (fs.readFileSync(f, 'utf-8').match(wordRe(name, 'g'))?.length ?? 0),
    0,
  );
}

function checkRename(task: LiveTask, ws: string): CheckResult {
  const { from, to, definedIn } = task.checker as { from: string; to: string; definedIn: string };
  // The workspace is a copy of this repo's src/, so the pristine counts come from the repo.
  const pristine = srcFiles(repoRoot);
  const wantTo = countWord(pristine, from) + countWord(pristine, to);
  const files = srcFiles(ws);
  const leftFrom = countWord(files, from);
  const gotTo = countWord(files, to);
  const defPath = path.join(ws, definedIn);
  const defines =
    fs.existsSync(defPath) &&
    parseExports(fs.readFileSync(defPath, 'utf-8')).some((e) => e.name === to);
  const pass = leftFrom === 0 && gotTo === wantTo && defines;
  return {
    pass,
    detail: `${from} left: ${leftFrom}; ${to}: ${gotTo}/${wantTo}; ${definedIn} exports ${to}: ${defines ? 'yes' : 'no'}`,
  };
}

// Exactly the four forms the L6 prompt names; "appears" = any whole-word
// mention in another file's text, as the prompt defines it.
const EXPORT_DECL_RE = /^export (?:async )?(?:function|const|class) ([\w$]+)/gm;

/** Exports of `<dir>/*.ts` (top level only) that no other src file references by name. */
export function deadExportsOf(
  root: string,
  dir: string,
): { universe: Set<string>; dead: Set<string> } {
  const files = srcFiles(root);
  const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf-8')]));
  const universe = new Set<string>();
  const dead = new Set<string>();
  for (const f of files) {
    if (path.dirname(rel(root, f)) !== dir) continue;
    for (const m of (texts.get(f) ?? '').matchAll(EXPORT_DECL_RE)) {
      const name = m[1];
      universe.add(name);
      const re = wordRe(name);
      if (![...texts].some(([g, t]) => g !== f && re.test(t))) dead.add(name);
    }
  }
  return { universe, dead };
}

function checkDeadExports(task: LiveTask, ws: string, finalAnswer: string): CheckResult {
  const { dir, minRecall, minPrecision } = task.checker as {
    dir: string;
    minRecall: number;
    minPrecision: number;
  };
  const { universe, dead } = deadExportsOf(ws, dir);
  // Case-sensitive: identifiers are compared as written.
  const named = new Set(
    [...finalAnswer.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((t) => universe.has(t)),
  );
  const hit = [...named].filter((n) => dead.has(n)).length;
  const recall = dead.size ? hit / dead.size : 0;
  const precision = named.size ? hit / named.size : 0;
  const pct = (x: number): string => `${Math.round(x * 100)} %`;
  return {
    pass: recall >= minRecall && precision >= minPrecision,
    detail: `${hit}/${dead.size} dead exports named, ${named.size - hit} wrong; recall ${pct(recall)}, precision ${pct(precision)}`,
  };
}

// ---- large-fixture checkers (I1–I6): expected answers are PINNED -------------

/** The pinned answer key (large-fixture/answers.json), read at check time. */
function answerKey(): AnswerKey {
  return JSON.parse(fs.readFileSync(ANSWERS_PATH, 'utf-8')) as AnswerKey;
}

function checkPinnedPaths(task: LiveTask, finalAnswer: string): CheckResult {
  const { key, maxExtra, ignore, first } = task.checker as {
    key: PinnedPathKey;
    maxExtra: number;
    ignore?: string[];
    first?: boolean;
  };
  const expected = answerKey().answers[key];
  const named = answerPaths(finalAnswer);
  for (const p of ignore ?? []) named.delete(p);
  if (first) {
    const got = [...named][0];
    return {
      pass: got !== undefined && got === expected[0],
      detail:
        got === undefined ? 'no path in the answer' : `first path ${got}, expected ${expected[0]}`,
    };
  }
  const missing = expected.filter((f) => !named.has(f));
  const extra = [...named].filter((f) => !expected.includes(f));
  return {
    pass: missing.length === 0 && extra.length <= maxExtra,
    detail:
      `${expected.length - missing.length}/${expected.length} found, ${extra.length} extra` +
      (missing.length ? `; missing ${missing.join(', ')}` : '') +
      (extra.length ? `; extra ${extra.join(', ')}` : ''),
  };
}

/**
 * Section headings that introduce exports the answer does NOT claim as
 * unused ("Used exports:", "In use (for reference):", "Excluded:").
 * "Unused" itself is no cue (lookbehind).
 */
const USED_SECTION_RE =
  /\b(?:(?<!un)used|in use|alive|exclu(?:ded|sions?)|false[- ]positives?|not (?:dead|unused))\b/i;
const IDENT_LIST_SRC = String.raw`([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)`;
/** A file path or bare file name (`sku.ts`), non-capturing. */
const FILE_SRC = String.raw`(?:\.\/)?\/?[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx|mts)`;
const CLAIM_LINE_RE = new RegExp(
  String.raw`^(?:${FILE_SRC}\s*(?:::|→|->|[:#—–-])?\s*)?${IDENT_LIST_SRC}`,
);

/**
 * Export names an answer CLAIMS (CCA-09), limited to `universe`. Like
 * answerPaths: the claim lines are lines that start with `file: name`, a
 * bare name, or a table row of both; names later in a line are commentary
 * ("skuChecksum — only normalizeSku uses it"). Lines under a short heading
 * that names used exports are not claims. Without claim lines (prose), every
 * universe name in the answer counts.
 */
export function answerExportNames(answer: string, universe: ReadonlySet<string>): Set<string> {
  const claimed = new Set<string>();
  let anyClaim = false;
  let negatedSection = false;
  for (const raw of answer.replace(/\\/g, '/').split('\n')) {
    let line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    if (line.startsWith('|')) line = line.replace(/^\|/, '').replace(/\|/g, ' : ');
    const lead = line.replace(LINE_LEAD_RE, '').replace(/[`*]/g, '');
    const m = CLAIM_LINE_RE.exec(lead);
    const names = m ? m[1].split(/\s*,\s*/).filter((n) => universe.has(n)) : [];
    if (names.length === 0) {
      const words = line.split(/\s+/).length;
      const heading = /^#{1,6}\s/.test(line) || (line.endsWith(':') && words <= 8);
      if (heading) negatedSection = USED_SECTION_RE.test(line);
      continue;
    }
    anyClaim = true;
    if (!negatedSection) for (const n of names) claimed.add(n);
  }
  if (anyClaim) return claimed;
  return new Set(
    [...answer.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]).filter((t) => universe.has(t)),
  );
}

function checkPinnedExports(task: LiveTask, finalAnswer: string): CheckResult {
  const { maxExtra } = task.checker as { maxExtra: number };
  const { catalogUtilsUnused, catalogUtilsExports } = answerKey().answers;
  const expected = catalogUtilsUnused.map((e) => e.name);
  const named = answerExportNames(finalAnswer, new Set(catalogUtilsExports.map((e) => e.name)));
  const missing = expected.filter((n) => !named.has(n));
  const extra = [...named].filter((n) => !expected.includes(n));
  return {
    pass: missing.length === 0 && extra.length <= maxExtra,
    detail:
      `${expected.length - missing.length}/${expected.length} unused exports named, ${extra.length} wrong` +
      (missing.length ? `; missing ${missing.join(', ')}` : '') +
      (extra.length ? `; wrong ${extra.join(', ')}` : ''),
  };
}

// ---- private-suite checkers (CCA-17): expected answers from <suite>/answers.json ----

function suiteContext(task: LiveTask): NonNullable<LiveTask['suite']> {
  if (!task.suite?.answer) {
    throw new Error(
      `${task.id}: suite checker without a loaded suite answer (load it with loadSuite)`,
    );
  }
  return task.suite;
}

/** Set comparison shared by the suite checkers. */
function compareSets(
  expected: readonly string[],
  named: ReadonlySet<string>,
  maxExtra: number,
  noun: string,
): CheckResult {
  const missing = expected.filter((f) => !named.has(f));
  const extra = [...named].filter((f) => !expected.includes(f));
  return {
    pass: missing.length === 0 && extra.length <= maxExtra,
    detail:
      `${expected.length - missing.length}/${expected.length} ${noun} found, ${extra.length} extra` +
      (missing.length ? `; missing ${missing.join(', ')}` : '') +
      (extra.length ? `; extra ${extra.join(', ')}` : ''),
  };
}

function checkSuitePaths(task: LiveTask, finalAnswer: string): CheckResult {
  const { maxExtra, ignore, first } = task.checker as {
    maxExtra: number;
    ignore?: string[];
    first?: boolean;
  };
  const ctx = suiteContext(task);
  const expected = ctx.answer?.items ?? [];
  const named = suiteAnswerPaths(finalAnswer, ctx.roots);
  for (const p of ignore ?? []) named.delete(p);
  if (first) {
    const got = [...named][0];
    return {
      pass: got !== undefined && got === expected[0],
      detail:
        got === undefined ? 'no path in the answer' : `first path ${got}, expected ${expected[0]}`,
    };
  }
  return compareSets(expected, named, maxExtra, 'paths');
}

/** `App\Jobs\SyncThing` (or `\App\…`) → `SyncThing`: names are compared unqualified. */
const QUALIFIED_RE = /\\?(?:[A-Za-z_][\w]*\\)+([A-Za-z_][\w]*)/g;

function checkSuiteSymbols(task: LiveTask, finalAnswer: string): CheckResult {
  const { maxExtra } = task.checker as { maxExtra: number };
  const ctx = suiteContext(task);
  const expected = ctx.answer?.items ?? [];
  const universe = new Set(ctx.answer?.universe ?? expected);
  const named = answerExportNames(finalAnswer.replace(QUALIFIED_RE, '$1'), universe);
  return compareSets(expected, named, maxExtra, 'names');
}

export interface CheckerOptions {
  /** Score the full prose (the pre-#261 behaviour) instead of only the answer block. */
  scoreProse?: boolean;
}

export async function runChecker(
  task: LiveTask,
  workspaceDir: string,
  finalAnswer: string,
  opts: CheckerOptions = {},
): Promise<CheckResult> {
  const answer = opts.scoreProse ? finalAnswer : answerBlock(finalAnswer);
  switch (task.checker.type) {
    case 'answer':
      return checkAnswer(task, answer);
    case 'symbol':
      return checkSymbol(task, workspaceDir);
    case 'tests':
      return checkTests(task, workspaceDir);
    case 'importers':
      return checkImporters(task, workspaceDir, answer);
    case 'rename':
      return checkRename(task, workspaceDir);
    case 'dead-exports':
      return checkDeadExports(task, workspaceDir, answer);
    case 'pinned-paths':
      return checkPinnedPaths(task, answer);
    case 'pinned-exports':
      return checkPinnedExports(task, answer);
    case 'path-set':
      return checkSuitePaths(task, answer);
    case 'symbol-set':
      return checkSuiteSymbols(task, answer);
  }
}
