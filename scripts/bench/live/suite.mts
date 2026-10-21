/**
 * Private suites (CCA-17, #149): run the live bench on code that must not
 * live in this repository.
 *
 *   pnpm run bench:live --suite <dir> --provider <p> [--tasks T1,T2]
 *
 * A suite is a directory OUTSIDE this repository with:
 *   <dir>/suite.json    the suite (schema SUITE_SCHEMA, validated by loadSuite)
 *   <dir>/answers.json  the answer key (schema ANSWERS_SCHEMA)
 *   <dir>/data/         run results (runs/, index.json, latest.json) by default
 *
 * The workspace of every session is built from local git clones with
 * `git archive <commit>[:<subdir>]` into `<ws>/<source name>/`: the commit is
 * pinned, the clone's working tree (dirty or not) is never read, and no
 * network is used. The cc arms index the whole workspace, one root with one
 * folder per source.
 *
 * Privacy: a private suite writes its runs to its own data/ (never into this
 * repository), its run JSON carries `suite.private: true` (bench:publish
 * refuses it), and with `redact` (the default for private suites) the run
 * JSON stores no prompt text, no answers and no source names: tasks by id
 * plus a sha256, sources by commit plus a sha256 of the name.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LiveTask, TaskSize } from './tasks.mts';

export const SUITE_SCHEMA = 'ccc-bench-suite/1';
export const ANSWERS_SCHEMA = 'ccc-bench-suite-answers/1';

/** One pinned source of a suite workspace. */
export interface SuiteSource {
  /** Folder name in the workspace (`<ws>/<name>/`). */
  name: string;
  /** Absolute path to a local git clone. */
  repo: string;
  /** Full or abbreviated commit sha; resolved to the full sha at load time. */
  commit: string;
  /** Only this folder of the commit (its contents land directly in `<ws>/<name>/`). */
  subdir?: string;
}

/** Checkers a suite task can use: the generic answer-key checkers plus `answer`. */
export type SuiteCheckerSpec =
  | { type: 'answer'; answerMustMatch: string[] }
  | {
      /** The answer's claimed paths must cover answers[answer] with at most maxExtra wrong ones. */
      type: 'path-set';
      answer: string;
      maxExtra: number;
      /** Paths never counted as extra (the subject file itself). */
      ignore?: string[];
      /** Only the first claimed path counts; it must be answers[answer].items[0]. */
      first?: boolean;
    }
  | {
      /** The answer's claimed names (from answers[answer].universe) must cover answers[answer].items. */
      type: 'symbol-set';
      answer: string;
      maxExtra: number;
    };

export interface SuiteTaskSpec {
  id: string;
  size?: TaskSize;
  /**
   * Short group id for the redacted summary (CCA-19), e.g. "spa", "php",
   * "cross-repo". Shown as `groups[group]` when the suite maps it.
   */
  group?: string;
  prompt: string;
  checker: SuiteCheckerSpec;
}

export interface SuiteFile {
  schema: typeof SUITE_SCHEMA;
  id: string;
  description: string;
  private: boolean;
  /** Store tasks/sources by hash only in run JSON. Defaults to `private`. */
  redact?: boolean;
  /**
   * Public display name (CCA-19), e.g. "Real-world suite A": the only name a
   * redacted summary (`bench:publish --private-summary`) and the local
   * dashboard show. Required for a summary.
   */
  alias?: string;
  /** Group id → public label for the summary (CCA-19). */
  groups?: Record<string, string>;
  /**
   * Tasks without `group` fall into the group of their id's first letter
   * (S1 → "S", mapped through `groups`). Off: they fall into "all".
   */
  groupByPrefix?: boolean;
  /** Task ids are not secret (CCA-19). Off (default): never in a summary. */
  publicTaskIds?: boolean;
  sources: SuiteSource[];
  tasks: SuiteTaskSpec[];
}

/** One answer of the key: a set of workspace paths or of names. */
export interface SuiteAnswer {
  kind: 'paths' | 'symbols';
  items: string[];
  /** symbols only: every name the checker recognises as a claim (items ⊆ universe). */
  universe?: string[];
}

export interface AnswersFile {
  schema: typeof ANSWERS_SCHEMA;
  suite: string;
  answers: Record<string, SuiteAnswer>;
}

/** What a loaded suite task carries next to the LiveTask fields (never serialised). */
export interface SuiteTaskContext {
  suiteId: string;
  /** Source folder names: the first path segment of every workspace path. */
  roots: string[];
  answer?: SuiteAnswer;
}

export interface LoadedSuite {
  dir: string;
  id: string;
  description: string;
  private: boolean;
  redact: boolean;
  /** Commits resolved to full shas. */
  sources: SuiteSource[];
  tasks: LiveTask[];
  answers: Record<string, SuiteAnswer>;
}

/** Run JSON `suite` block. Redacted: no names, no prompts, no answers. */
export interface RunSuiteInfo {
  schema: typeof SUITE_SCHEMA;
  id: string;
  private: boolean;
  redact: boolean;
  sources: Array<{ name?: string; name_sha256?: string; commit: string; subdir?: string }>;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const SIZES: readonly TaskSize[] = ['S', 'M', 'ML', 'L', 'XL'];
/** Group ids: short labels like "spa", "php", "cross-repo". */
export const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** Public texts (alias, group labels): one line, no path or markup characters. */
export const PUBLIC_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+&,-]{0,59}$/;

class SuiteError extends Error {}

function readJson(file: string, what: string): unknown {
  if (!fs.existsSync(file)) throw new SuiteError(`${what} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new SuiteError(`${what} is not valid JSON (${file}): ${(e as Error).message}`);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const isStrArr = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((s) => typeof s === 'string');
const isWhole = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Local only: no prompt, no credential helper, no fetch can start.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const SUITE_KEYS = [
  'schema',
  'id',
  'description',
  'private',
  'redact',
  'alias',
  'groups',
  'groupByPrefix',
  'publicTaskIds',
  'sources',
  'tasks',
];

/** Every problem of a suite.json value, as `path: message` lines (empty = valid). */
export function suiteProblems(x: unknown): string[] {
  const p: string[] = [];
  if (!isObj(x)) return ['suite.json: must be a JSON object'];
  if (x.schema !== SUITE_SCHEMA)
    p.push(`schema: must be "${SUITE_SCHEMA}" (got ${JSON.stringify(x.schema)})`);
  if (typeof x.id !== 'string' || !ID_RE.test(x.id))
    p.push(`id: must match ${ID_RE} (got ${JSON.stringify(x.id)})`);
  if (typeof x.description !== 'string') p.push('description: must be a string');
  if (typeof x.private !== 'boolean') p.push('private: must be true or false');
  if (x.redact !== undefined && typeof x.redact !== 'boolean')
    p.push('redact: must be true or false');
  if (x.alias !== undefined && (typeof x.alias !== 'string' || !PUBLIC_LABEL_RE.test(x.alias)))
    p.push(`alias: must match ${PUBLIC_LABEL_RE} (a public display name)`);
  if (x.groupByPrefix !== undefined && typeof x.groupByPrefix !== 'boolean')
    p.push('groupByPrefix: must be true or false');
  if (x.publicTaskIds !== undefined && typeof x.publicTaskIds !== 'boolean')
    p.push('publicTaskIds: must be true or false');
  if (x.groups !== undefined) {
    if (!isObj(x.groups)) p.push('groups: must be an object {group id: public label}');
    else
      for (const [k, v] of Object.entries(x.groups)) {
        if (!GROUP_RE.test(k)) p.push(`groups.${k}: group id must match ${GROUP_RE}`);
        if (typeof v !== 'string' || !PUBLIC_LABEL_RE.test(v))
          p.push(`groups.${k}: label must match ${PUBLIC_LABEL_RE}`);
      }
  }
  if (!Array.isArray(x.sources) || x.sources.length === 0)
    p.push('sources: must be a non-empty array');
  else {
    const names = new Set<string>();
    x.sources.forEach((s, i) => {
      const at = `sources[${i}]`;
      if (!isObj(s)) return p.push(`${at}: must be an object`);
      if (typeof s.name !== 'string' || !NAME_RE.test(s.name))
        p.push(`${at}.name: must match ${NAME_RE}`);
      else if (names.has(s.name)) p.push(`${at}.name: duplicate "${s.name}"`);
      else names.add(s.name);
      if (typeof s.repo !== 'string' || !path.isAbsolute(s.repo))
        p.push(`${at}.repo: must be an absolute path to a local git clone`);
      if (typeof s.commit !== 'string' || !SHA_RE.test(s.commit))
        p.push(`${at}.commit: must be a hex commit sha (7–64 chars)`);
      if (s.subdir !== undefined) {
        const ok =
          typeof s.subdir === 'string' &&
          s.subdir.length > 0 &&
          !path.isAbsolute(s.subdir) &&
          !s.subdir.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');
        if (!ok)
          p.push(
            `${at}.subdir: must be a relative path inside the repo (no "..", no leading or trailing "/")`,
          );
      }
      for (const k of Object.keys(s)) {
        if (!['name', 'repo', 'commit', 'subdir'].includes(k)) p.push(`${at}.${k}: unknown field`);
      }
    });
  }
  if (!Array.isArray(x.tasks) || x.tasks.length === 0) p.push('tasks: must be a non-empty array');
  else {
    const ids = new Set<string>();
    x.tasks.forEach((t, i) => {
      const at = `tasks[${i}]`;
      if (!isObj(t)) return p.push(`${at}: must be an object`);
      if (typeof t.id !== 'string' || !ID_RE.test(t.id)) p.push(`${at}.id: must match ${ID_RE}`);
      else if (ids.has(t.id)) p.push(`${at}.id: duplicate "${t.id}"`);
      else ids.add(t.id);
      if (t.size !== undefined && !SIZES.includes(t.size as TaskSize))
        p.push(`${at}.size: must be one of ${SIZES.join(', ')}`);
      if (t.group !== undefined && (typeof t.group !== 'string' || !GROUP_RE.test(t.group)))
        p.push(`${at}.group: must match ${GROUP_RE}`);
      if (typeof t.prompt !== 'string' || !t.prompt.trim())
        p.push(`${at}.prompt: must be a non-empty string`);
      const c = t.checker;
      if (!isObj(c)) return p.push(`${at}.checker: must be an object`);
      if (c.type === 'answer') {
        if (!isStrArr(c.answerMustMatch) || c.answerMustMatch.length === 0)
          p.push(`${at}.checker.answerMustMatch: must be a non-empty string array`);
        else
          for (const src of c.answerMustMatch) {
            try {
              new RegExp(src);
            } catch {
              p.push(`${at}.checker.answerMustMatch: invalid pattern /${src}/`);
            }
          }
      } else if (c.type === 'path-set' || c.type === 'symbol-set') {
        if (typeof c.answer !== 'string' || !c.answer)
          p.push(`${at}.checker.answer: must name a key of answers.json`);
        if (!isWhole(c.maxExtra)) p.push(`${at}.checker.maxExtra: must be a whole number >= 0`);
        if (c.type === 'path-set') {
          if (c.ignore !== undefined && !isStrArr(c.ignore))
            p.push(`${at}.checker.ignore: must be a string array`);
          if (c.first !== undefined && typeof c.first !== 'boolean')
            p.push(`${at}.checker.first: must be true or false`);
        }
      } else {
        p.push(
          `${at}.checker.type: must be answer, path-set or symbol-set (got ${JSON.stringify(c.type)})`,
        );
      }
    });
  }
  for (const k of Object.keys(x)) {
    if (!SUITE_KEYS.includes(k)) p.push(`${k}: unknown field`);
  }
  return p;
}

/** Problems of answers.json against its suite (key refs, kinds, universes). */
export function answersProblems(x: unknown, suite: SuiteFile): string[] {
  const p: string[] = [];
  if (!isObj(x)) return ['answers.json: must be a JSON object'];
  if (x.schema !== ANSWERS_SCHEMA) p.push(`answers.schema: must be "${ANSWERS_SCHEMA}"`);
  if (x.suite !== suite.id)
    p.push(`answers.suite: must be the suite id "${suite.id}" (got ${JSON.stringify(x.suite)})`);
  if (!isObj(x.answers)) return [...p, 'answers.answers: must be an object'];
  const answers = x.answers;
  for (const [k, a] of Object.entries(answers)) {
    const at = `answers.${k}`;
    if (!isObj(a)) {
      p.push(`${at}: must be an object`);
      continue;
    }
    if (a.kind !== 'paths' && a.kind !== 'symbols') p.push(`${at}.kind: must be paths or symbols`);
    if (!isStrArr(a.items) || a.items.length === 0)
      p.push(`${at}.items: must be a non-empty string array`);
    if (a.kind === 'symbols') {
      if (!isStrArr(a.universe))
        p.push(`${at}.universe: symbols need the universe of recognised names`);
      else if (isStrArr(a.items)) {
        const u = new Set(a.universe);
        const out = a.items.filter((n) => !u.has(n));
        if (out.length) p.push(`${at}.universe: misses items ${out.join(', ')}`);
      }
    }
    if (a.kind === 'paths' && isStrArr(a.items)) {
      const roots = new Set(suite.sources.map((s) => s.name));
      const bad = a.items.filter((i) => !roots.has(i.split('/')[0]));
      if (bad.length)
        p.push(`${at}.items: paths must start with a source name (${bad.slice(0, 3).join(', ')})`);
    }
  }
  for (const t of suite.tasks) {
    const c = t.checker;
    if (c.type === 'answer') continue;
    const a = answers[c.answer];
    if (!isObj(a)) {
      p.push(`tasks ${t.id}: answer "${c.answer}" is missing in answers.json`);
      continue;
    }
    const want = c.type === 'path-set' ? 'paths' : 'symbols';
    if (a.kind !== want)
      p.push(
        `tasks ${t.id}: ${c.type} needs a "${want}" answer, "${c.answer}" is "${String(a.kind)}"`,
      );
  }
  return p;
}

/**
 * Is `p` inside `dir` (or equal)? Both resolved through realpath where they
 * exist, so a symlink cannot smuggle a path in or out.
 */
export function isInside(p: string, dir: string): boolean {
  const real = (x: string): string => {
    let cur = path.resolve(x);
    const tail: string[] = [];
    // realpath of the longest existing prefix (the leaf may not exist yet).
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    try {
      cur = fs.realpathSync(cur);
    } catch {
      /* keep lexical */
    }
    return path.join(cur, ...tail);
  };
  const rel = path.relative(real(dir), real(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The nearest private suite that contains `file` (a suite.json with
 * `private: true` in `file`'s directory or any parent), or null.
 */
export function privateSuiteContaining(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  try {
    dir = path.dirname(fs.realpathSync(file));
  } catch {
    /* not there: lexical */
  }
  for (;;) {
    const s = path.join(dir, 'suite.json');
    if (fs.existsSync(s)) {
      try {
        const v = JSON.parse(fs.readFileSync(s, 'utf-8')) as Record<string, unknown>;
        if (v?.schema === SUITE_SCHEMA && v.private !== false) return dir;
      } catch {
        // An unreadable suite.json next to run files: treat as private (fail closed).
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load and validate `<dir>/suite.json` + `<dir>/answers.json`, resolve every
 * source commit in its clone, and turn the tasks into LiveTasks (fixture
 * 'suite'). Throws one error that lists every problem.
 *
 * `repoRoot`: a private suite inside this repository is refused.
 */
export function loadSuite(dirArg: string, opts: { repoRoot?: string } = {}): LoadedSuite {
  const dir = path.resolve(dirArg);
  const fail = (lines: string[]): never => {
    throw new SuiteError(`suite ${dir} is invalid:\n  - ${lines.join('\n  - ')}`);
  };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail([`not a directory: ${dir}`]);
  const raw = readJson(path.join(dir, 'suite.json'), 'suite.json');
  const problems = suiteProblems(raw);
  if (problems.length) fail(problems);
  const suite = raw as SuiteFile;
  if (suite.private && opts.repoRoot && isInside(dir, opts.repoRoot)) {
    fail([`a private suite must live outside this repository (${opts.repoRoot})`]);
  }
  const answersRaw = readJson(path.join(dir, 'answers.json'), 'answers.json');
  const aProblems = answersProblems(answersRaw, suite);
  if (aProblems.length) fail(aProblems);
  const answers = (answersRaw as AnswersFile).answers;

  const srcProblems: string[] = [];
  const sources: SuiteSource[] = suite.sources.map((s) => {
    if (!fs.existsSync(s.repo)) {
      srcProblems.push(`source ${s.name}: repo not found: ${s.repo}`);
      return s;
    }
    let commit = s.commit;
    try {
      commit = git(s.repo, ['rev-parse', '--verify', '--quiet', `${s.commit}^{commit}`]);
    } catch {
      srcProblems.push(`source ${s.name}: commit ${s.commit} does not exist in ${s.repo}`);
      return s;
    }
    if (s.subdir) {
      try {
        const type = git(s.repo, ['cat-file', '-t', `${commit}:${s.subdir}`]);
        if (type !== 'tree')
          srcProblems.push(`source ${s.name}: ${s.subdir} is not a folder at ${commit}`);
      } catch {
        srcProblems.push(`source ${s.name}: ${s.subdir} does not exist at ${commit}`);
      }
    }
    return { ...s, commit };
  });
  if (srcProblems.length) fail(srcProblems);

  const roots = sources.map((s) => s.name);
  const tasks: LiveTask[] = suite.tasks.map((t) => ({
    id: t.id,
    ...(t.size ? { size: t.size } : {}),
    prompt: t.prompt,
    checker: t.checker,
    fixture: 'suite',
    suite: {
      suiteId: suite.id,
      roots,
      ...(t.checker.type !== 'answer' ? { answer: answers[t.checker.answer] } : {}),
    },
  }));

  return {
    dir,
    id: suite.id,
    description: suite.description,
    private: suite.private,
    redact: suite.redact ?? suite.private,
    sources,
    tasks,
    answers,
  };
}

/**
 * Write the suite workspace: for each source, `git archive <commit>[:<subdir>]`
 * extracted into `<ws>/<name>/`. Reads the object store only — the clone's
 * working tree, index and remotes are never touched.
 */
export function writeSuiteWorkspace(suite: Pick<LoadedSuite, 'sources'>, ws: string): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-suite-tar-'));
  try {
    for (const s of suite.sources) {
      const dest = path.join(ws, s.name);
      fs.mkdirSync(dest, { recursive: true });
      const tar = path.join(tmp, `${s.name}.tar`);
      const treeish = s.subdir ? `${s.commit}:${s.subdir}` : s.commit;
      git(s.repo, ['archive', '--format=tar', '-o', tar, treeish]);
      execFileSync('tar', ['-xf', tar, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
      fs.rmSync(tar, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The run JSON `suite` block (redacted: commits only, names hashed). */
export function runSuiteInfo(suite: LoadedSuite): RunSuiteInfo {
  return {
    schema: SUITE_SCHEMA,
    id: suite.id,
    private: suite.private,
    redact: suite.redact,
    sources: suite.sources.map((s) =>
      suite.redact
        ? { name_sha256: sha256(s.name), commit: s.commit }
        : { name: s.name, commit: s.commit, ...(s.subdir ? { subdir: s.subdir } : {}) },
    ),
  };
}

/** A task as the run JSON stores it: full, or by id + hashes when redacted. */
export function runTaskEntry(task: LiveTask, redact: boolean): Record<string, unknown> {
  const c = task.checker as SuiteCheckerSpec;
  if (!redact) {
    return {
      id: task.id,
      ...(task.size ? { size: task.size } : {}),
      fixture: `suite ${task.suite?.suiteId ?? ''}`.trim(),
      prompt: task.prompt,
      checker: c,
    };
  }
  const answerHash =
    c.type === 'answer'
      ? sha256(JSON.stringify(c.answerMustMatch))
      : sha256(JSON.stringify(task.suite?.answer ?? null));
  return {
    id: task.id,
    ...(task.size ? { size: task.size } : {}),
    fixture: `suite ${task.suite?.suiteId ?? ''}`.trim(),
    prompt_sha256: sha256(task.prompt),
    checker: {
      type: c.type,
      ...(c.type !== 'answer' ? { maxExtra: c.maxExtra } : {}),
      answer_sha256: answerHash,
    },
  };
}

/** For callers that want the message without a stack (run.mts `fail`). */
export const isSuiteError = (e: unknown): e is Error => e instanceof SuiteError;
