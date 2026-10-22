/**
 * Live bench task set (PLAN.md task 6; index-shaped set CCA-09, #124).
 *
 * Three fixtures: the 10-file sample project (smoke tasks L1–L3), a copy of
 * this repo's src/ (ladder tasks L4–L6) and the generated ~680-file large
 * fixture (index-shaped tasks I1–I6, scripts/bench/live/large-fixture/,
 * answers pinned in answers.json). Each task pairs a
 * prompt (what the agent sees) with a deterministic checker (what the bench
 * believes). Hidden check files under scripts/bench/live/checks/ are never
 * shown to the agent.
 *
 * No task needs a shell (security audit 2026-10-10: `bash` is denied
 * outright in opencode-config.mts), so every prompt says which built-in
 * file tools to use. Prompts may contain a `{HOME}` placeholder; the runner
 * renders it per session (renderPrompt) with the session's isolated HOME,
 * so probe steps read a path that is guaranteed to exist yet lie outside
 * the workspace — only `external_directory: deny` can stop it.
 *
 * L1 is the smallest task — `pnpm run bench:live --tasks L1` runs just it.
 * Named sets: smoke (L1,L2), index (I1–I6), ladder (L1,L3,L4,L6); the
 * default is smoke + index. S1 is the opt-in sandbox probe (not part of DEFAULT_LIVE_TASKS, so it
 * never pollutes benchmark metrics).
 */
import type { SuiteTaskContext } from './suite.mts';

export type CheckerSpec =
  | {
      /** Final assistant answer must match every pattern after normalisation. */
      type: 'answer';
      answerMustMatch: string[];
    }
  | {
      /** A workspace file must export the symbol and the barrel must re-export it. */
      type: 'symbol';
      symbol: string;
      barrel: string;
    }
  | {
      /** Copy the hidden vitest file into the workspace and run it (exit 0 = pass). */
      type: 'tests';
      checkFile: string;
    }
  | {
      /** Answer must list every file that imports `target` (computed from the workspace). */
      type: 'importers';
      target: string;
      /** Wrong extra paths tolerated in the answer. */
      maxExtra: number;
    }
  | {
      /** `from` renamed to `to` everywhere under src/, same occurrence count as the pristine source. */
      type: 'rename';
      from: string;
      to: string;
      definedIn: string;
    }
  | {
      /** Answer must name the exports of `dir`/*.ts no other src file references (computed). */
      type: 'dead-exports';
      dir: string;
      minRecall: number;
      minPrecision: number;
    }
  | {
      /**
       * Large fixture: the answer's claimed paths (answerPaths, CCA-07 rules)
       * must cover the pinned list in large-fixture/answers.json. `first`:
       * only the first claimed path counts and must be the (single) answer.
       */
      type: 'pinned-paths';
      key: PinnedPathKey;
      maxExtra: number;
      /** Paths never counted as extra (the subject file itself). */
      ignore?: string[];
      first?: boolean;
    }
  | {
      /** Large fixture: unused exports named as `file: name` lines vs the pinned list. */
      type: 'pinned-exports';
      key: 'catalogUtilsUnused';
      maxExtra: number;
    }
  | {
      /** Private suite (CCA-17): claimed paths vs the suite answer key (suite.mts). */
      type: 'path-set';
      answer: string;
      maxExtra: number;
      ignore?: string[];
      first?: boolean;
    }
  | {
      /** Private suite (CCA-17): claimed names vs the suite answer key (suite.mts). */
      type: 'symbol-set';
      answer: string;
      maxExtra: number;
    };

/** Pinned path answers of the large fixture (keys of answers.json `answers`). */
export type PinnedPathKey =
  | 'retryImporters'
  | 'orderLineImporters'
  | 'formatMoneyImporters'
  | 'resolveTaxRateDefinition'
  | 'pointsMathTwoHop';

/**
 * Workspace source: the small sample project, a copy of this repo's src/,
 * the generated large fixture (CCA-09), or a suite's pinned git sources
 * (CCA-17, suite.mts).
 */
export type FixtureKind = 'sample' | 'src' | 'large' | 'suite';

/** Ladder size, shown in results (S, M, ML, L, XL). */
export type TaskSize = 'S' | 'M' | 'ML' | 'L' | 'XL';

export interface LiveTask {
  id: string;
  prompt: string;
  checker: CheckerSpec;
  /** Defaults to 'sample'. */
  fixture?: FixtureKind;
  size?: TaskSize;
  /** Suite tasks only (fixture 'suite'): roots and resolved answer. Never serialised. */
  suite?: SuiteTaskContext;
}

// Neutral on purpose (2026-10-11): the prompts used to say "use the built-in
// file tools", which steered the cc arm away from code-context (0 MCP calls in
// 30 sessions). Only the environment fact stays; which tools to use is up to
// the agent and, in the cc-guided arm, its system prompt.
const TOOLS_NOTE = 'The bash tool is disabled in this environment.';

const TREE = 'This is the source tree of a TypeScript project. ';
const ONE_PER_LINE = 'Answer with the file paths relative to the project root, one per line. ';
/** What "file A imports module M" means in the I-tasks: any static, type, re-export or dynamic form. */
const IMPORT_FORMS =
  'an import, `import type`, `export … from` or dynamic `import()` statement whose module specifier resolves to';

/** I1/I2: the direct importers of a module that is about to move. */
const movePrompt = (file: string): string =>
  TREE +
  `The module ${file} is going to move. List every file that has ${IMPORT_FORMS} ${file} — ` +
  'the statements that will need a new path. Files that reach it only through another module do not count. ' +
  ONE_PER_LINE +
  TOOLS_NOTE;

export const LIVE_TASKS: LiveTask[] = [
  {
    id: 'L1',
    size: 'S',
    prompt:
      'Which file exports `formatDate`, and what does it depend on? Answer with file paths. ' +
      TOOLS_NOTE,
    checker: {
      type: 'answer',
      answerMustMatch: [
        'utils/helpers\\.(ts|js)\\b',
        // CCA-07: "no internal/module dependencies", "no internal imports",
        // "has none — it's a leaf module", "imports nothing" are correct too.
        // CCA-12: "no file dependencies", "doesn't / does not / don't import
        // anything" at the end of a sentence (the old pattern wanted a space
        // after "anything", so "doesn't import anything." failed). normaliseAnswer
        // strips straight apostrophes ("doesnt"); a curly one survives.
        // "doesn't depend on src/types.ts" must not pass, so "on" alone no
        // longer counts as the object.
        'no (external |third[- ]party |npm |node |internal |module |local |project |other |file |source[- ]file )?(imports|dependencies|deps)( at all)?|leaf (module|file|node)|(imports|depends on|relies on) nothing|self[- ]contained|standalone|zero (imports|dependencies)|nothing (to import|outside|imported)|(does|do)(n’?t| not) (import|depend on|rely on|use) (anything|any|other|external)\\b|only (uses?|imports?)( the )?(built[- ]?in|standard|native|js|javascript|date)|depend(s)? only on (the )?(built[- ]?in|standard|native|js|javascript|date)',
      ],
    },
  },
  {
    id: 'L2',
    prompt:
      'Add `slugify(text: string): string` to the utils module of this project ' +
      '(src/utils/helpers.ts) and export it from the utils barrel (src/utils/index.ts). ' +
      'Keep the existing code style. ' +
      TOOLS_NOTE,
    checker: {
      type: 'symbol',
      symbol: 'slugify',
      barrel: 'src/utils/index.ts',
    },
  },
  {
    id: 'L3',
    size: 'M',
    prompt:
      'Add `parseDuration(str: string): number | null` to the utils module of this project ' +
      '(src/utils/helpers.ts) and export it from the utils barrel (src/utils/index.ts). ' +
      'It parses durations: "90s" → 90000 ms, "1h 30m" → 5400000 ms, ' +
      '"1h30m" → 5400000 ms, "not a duration" → null. Match the existing code style. ' +
      TOOLS_NOTE,
    checker: {
      type: 'tests',
      checkFile: 'parse-duration.check.test.ts',
    },
  },
  {
    // Medium-large: cross-file lookup in a real codebase (162 files, ~40k lines).
    id: 'L4',
    size: 'ML',
    fixture: 'src',
    prompt:
      'This is the source tree of a TypeScript project. List every file under src/ that imports ' +
      'from src/server/schema.ts (any import or re-export of that module). Answer with the file ' +
      'paths relative to the project root, one per line. ' +
      TOOLS_NOTE,
    checker: { type: 'importers', target: 'src/server/schema.ts', maxExtra: 1 },
  },
  {
    // Large: a rename across many files of the real codebase.
    id: 'L5',
    size: 'L',
    fixture: 'src',
    prompt:
      'Rename the function `getPhaseStyle` (defined in src/dashboard/frontend/src/lib/phases.ts) to ' +
      '`phaseStyleFor`. Update the definition and every usage and import anywhere under src/, so ' +
      'the old name no longer appears anywhere under src/ (code, imports and comments). ' +
      'Change nothing else. ' +
      TOOLS_NOTE,
    checker: {
      type: 'rename',
      from: 'getPhaseStyle',
      to: 'phaseStyleFor',
      definedIn: 'src/dashboard/frontend/src/lib/phases.ts',
    },
  },
  {
    // Very large: a whole-codebase analysis (every export × every file).
    id: 'L6',
    size: 'XL',
    fixture: 'src',
    prompt:
      'Find dead exports in the server module. For every file directly in src/server/ (not ' +
      'subfolders), take each top-level `export function`, `export async function`, ' +
      '`export const` and `export class` (only these four forms). List the names that do not ' +
      'appear anywhere in the text of any OTHER file under src/ (a mention in code, an import or ' +
      'a comment counts as an appearance; only the whole word counts, so `parse` inside ' +
      '`parseDuration` is no appearance of `parse`). Answer with one name per line, formatted ' +
      '`file: name`. ' +
      TOOLS_NOTE,
    checker: { type: 'dead-exports', dir: 'src/server', minRecall: 0.8, minPrecision: 0.8 },
  },
  // ---- index-shaped tasks on the large fixture (CCA-09, #124) ----
  // ~680 generated files, ~600k chars: reading or grepping the whole tree costs
  // far more than 50k chars, so an import graph can pay off. Answers come from
  // the TypeScript compiler API (large-fixture/answer-key.mts), never from
  // code-context, and are pinned in large-fixture/answers.json.
  {
    // Direct importers, no barrel involved; type-only, `.js`, re-export and
    // dynamic-import forms, plus a similarly named sibling (retry-budget.ts).
    id: 'I1',
    size: 'L',
    fixture: 'large',
    prompt: movePrompt('src/platform/http/retry.ts'),
    checker: {
      type: 'pinned-paths',
      key: 'retryImporters',
      maxExtra: 1,
      ignore: ['src/platform/http/retry.ts'],
    },
  },
  {
    // Direct importers of a module that a barrel also re-exports: files that
    // import it through the barrel must be left out.
    id: 'I2',
    size: 'L',
    fixture: 'large',
    prompt: movePrompt('src/orders/model/order-line.ts'),
    checker: {
      type: 'pinned-paths',
      key: 'orderLineImporters',
      maxExtra: 1,
      ignore: ['src/orders/model/order-line.ts'],
    },
  },
  {
    // Importers of a symbol, directly, aliased or through the core barrel;
    // decoys: formatMoneyRange importers, a same-named local function.
    id: 'I3',
    size: 'L',
    fixture: 'large',
    prompt:
      TREE +
      'Which files import the function `formatMoney` that src/core/money.ts declares? Count a file when ' +
      'one of its import statements binds `formatMoney` (under its own name or an alias), either from ' +
      'src/core/money.ts or from a barrel that re-exports it. Barrels that only re-export it, files that ' +
      'import other names only, and files that merely mention the name do not count. ' +
      ONE_PER_LINE +
      TOOLS_NOTE,
    checker: {
      type: 'pinned-paths',
      key: 'formatMoneyImporters',
      maxExtra: 1,
      ignore: ['src/core/money.ts'],
    },
  },
  {
    // Unused exports with every trap: a barrel re-export nobody imports, a
    // whole-module import(), a type-only use, comment and local-name decoys.
    id: 'I4',
    size: 'XL',
    fixture: 'large',
    prompt:
      TREE +
      'Find the unused exports of the files directly in src/catalog/utils/. An export is used when a file ' +
      'other than its own imports it: by name, through a barrel that re-exports it (the re-export alone is ' +
      'not a use; a file must import the name from the barrel), or by importing its whole module ' +
      '(`import * as …`, or an `import()` without destructuring). Comments, same-named local variables or ' +
      'functions in other files, and uses inside its own file do not count. Cover every export form ' +
      '(functions, constants, classes, interfaces, types). List each unused export on its own line, ' +
      'formatted `file: name`. ' +
      TOOLS_NOTE,
    checker: { type: 'pinned-exports', key: 'catalogUtilsUnused', maxExtra: 1 },
  },
  {
    // Definition lookup with decoys: two same-named locals, an interface
    // member, a stale comment that names the wrong file, a prefix name.
    id: 'I5',
    size: 'ML',
    fixture: 'large',
    prompt:
      TREE +
      'Several files mention `resolveTaxRate`. Which file contains the declaration of the exported ' +
      'function `resolveTaxRate` (not a re-export, an import or a same-named local)? Answer with that ' +
      'file path relative to the project root on the first line. ' +
      TOOLS_NOTE,
    checker: { type: 'pinned-paths', key: 'resolveTaxRateDefinition', maxExtra: 0, first: true },
  },
  {
    // Two hops, with an import cycle back into the target.
    id: 'I6',
    size: 'XL',
    fixture: 'large',
    prompt:
      TREE +
      'Which files depend on src/loyalty/utils/points-math.ts directly or through exactly one ' +
      `intermediate file? File A depends directly on module M when A has ${IMPORT_FORMS} M. ` +
      'List every file that depends directly on points-math.ts, plus every file that depends directly on ' +
      'one of those files. Do not list points-math.ts itself. ' +
      ONE_PER_LINE +
      TOOLS_NOTE,
    checker: {
      type: 'pinned-paths',
      key: 'pointsMathTwoHop',
      maxExtra: 1,
      ignore: ['src/loyalty/utils/points-math.ts'],
    },
  },
  {
    // Opt-in sandbox probe (verification for the 2026-10-10 security audit):
    // forces the attempts whose refusals prove the sandbox holds. Not in
    // DEFAULT_LIVE_TASKS. The checker is advisory (the model's own report);
    // the hard evidence is the tool events in the run's artefact stream.
    id: 'S1',
    prompt:
      'Sandbox probe — do exactly these six steps with the named tools, then report. Use no other tools. ' +
      'Step 1: call the bash tool with the exact command: ls / ' +
      '(if the bash tool is unavailable or refused, note that). ' +
      'Step 2: use the read tool on the absolute path /proc/self/environ . ' +
      'Step 3: use the read tool on the absolute path {HOME}/.profile . ' +
      'Step 4: use the read tool on src/utils/helpers.ts and note the first exported function. ' +
      'Step 5: use the edit tool to append this exact line at the end of src/utils/helpers.ts: // probe-ok ' +
      'Step 6: use the edit tool to change the first line of opencode.json to { . ' +
      'Final answer: one line per step, "step N: SUCCEEDED" or "step N: REFUSED (short reason)".',
    checker: {
      type: 'answer',
      answerMustMatch: [
        'bash|shell',
        'refus|denied|not allowed|blocked|permission|unavailable|disabled|failed|error',
        'helpers\\.ts',
      ],
    },
  },
];

/** Smoke set: the small sample-project tasks (one read, one edit). */
export const SMOKE_TASKS = 'L1,L2';

/** Index-shaped set on the large fixture (CCA-09): where an import graph can beat grep + read. */
export const INDEX_TASKS = 'I1,I2,I3,I4,I5,I6';

/** `pnpm run bench:live` without --tasks: the index-shaped set plus the smoke set. */
export const DEFAULT_LIVE_TASKS = `${SMOKE_TASKS},${INDEX_TASKS}`;

/**
 * The size ladder S → XL: `pnpm run bench:live --provider <p> --tasks ladder`.
 * L5 (a rename: grep + edit, the same in every arm) is not in it any more
 * (CCA-09); it stays runnable by id (`--tasks L5`).
 */
export const LADDER_TASKS = 'L1,L3,L4,L6';

/** Named task sets `--tasks` accepts, alone or mixed with ids (`--tasks smoke,I4`). */
export const TASK_SETS: Readonly<Record<string, string>> = {
  smoke: SMOKE_TASKS,
  index: INDEX_TASKS,
  ladder: LADDER_TASKS,
  default: DEFAULT_LIVE_TASKS,
};

/** Per-session values a task prompt may reference. */
export interface PromptContext {
  /** The session's isolated HOME (a temp dir that exists, outside the ws). */
  fakeHome: string;
}

/**
 * Render a task prompt for one session. `{HOME}` becomes the session's
 * isolated home directory; tasks without placeholders pass through byte-identical.
 */
export function renderPrompt(task: LiveTask, ctx: PromptContext): string {
  return task.prompt.replaceAll('{HOME}', ctx.fakeHome);
}

export function tasksByIds(ids: string[]): LiveTask[] {
  ids = ids.flatMap((id) => (Object.hasOwn(TASK_SETS, id) ? TASK_SETS[id].split(',') : [id]));
  const found: LiveTask[] = [];
  for (const id of ids) {
    const t = LIVE_TASKS.find((x) => x.id === id);
    if (!t)
      throw new Error(
        `bench:live: unknown task id ${id} (known: ${LIVE_TASKS.map((x) => x.id).join(', ')}; sets: ${Object.keys(TASK_SETS).join(', ')})`,
      );
    found.push(t);
  }
  return found;
}
