/**
 * Live bench task set (PLAN.md task 6).
 *
 * Three small tasks against test/fixtures/sample-project. Each task pairs a
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
 * L1 is the smallest task — `npm run bench:live -- --tasks L1` runs just it.
 * S1 is the opt-in sandbox probe (not part of DEFAULT_LIVE_TASKS, so it
 * never pollutes benchmark metrics).
 */

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
    };

/** Workspace source: the small sample project or a copy of this repo's src/. */
export type FixtureKind = 'sample' | 'src';

/** Ladder size, shown in results (S, M, ML, L, XL). */
export type TaskSize = 'S' | 'M' | 'ML' | 'L' | 'XL';

export interface LiveTask {
  id: string;
  prompt: string;
  checker: CheckerSpec;
  /** Defaults to 'sample'. */
  fixture?: FixtureKind;
  size?: TaskSize;
}

const TOOLS_NOTE =
  'Use the built-in file tools (read, grep, glob, edit) — the bash tool is disabled in this environment.';

export const LIVE_TASKS: LiveTask[] = [
  {
    id: 'L1',
    size: 'S',
    prompt:
      'Which file exports `formatDate`, and what does it depend on? Answer with file paths. ' +
      'Use the built-in file tools (read, grep, glob) — the bash tool is disabled in this environment.',
    checker: {
      type: 'answer',
      answerMustMatch: [
        'utils/helpers\\.(ts|js)\\b',
        'no (external |third[- ]party |npm |node )?(imports|dependencies|deps)( at all)?|self[- ]contained|standalone|zero (imports|dependencies)|nothing (to import|outside|imported)|does.?t (import|depend|rely|use) (on |anything |any |external)|only (uses?|imports?)( the )?(built[- ]?in|standard|native|js|javascript|date)|depend(s)? only on (the )?(built[- ]?in|standard|native|js|javascript|date)',
      ],
    },
  },
  {
    id: 'L2',
    prompt:
      'Add `slugify(text: string): string` to the utils module of this project ' +
      '(src/utils/helpers.ts) and export it from the utils barrel (src/utils/index.ts). ' +
      'Keep the existing code style. Use the built-in file tools (read, edit) — ' +
      'the bash tool is disabled in this environment.',
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
      'Use the built-in file tools (read, edit) — the bash tool is disabled in this environment.',
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
      'Rename the function `getPhaseStyle` (defined in src/dashboard/app/src/lib/phases.ts) to ' +
      '`phaseStyleFor`. Update the definition and every usage and import anywhere under src/, so ' +
      'the old name no longer appears anywhere under src/ (code, imports and comments). ' +
      'Change nothing else. ' +
      TOOLS_NOTE,
    checker: {
      type: 'rename',
      from: 'getPhaseStyle',
      to: 'phaseStyleFor',
      definedIn: 'src/dashboard/app/src/lib/phases.ts',
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
      'a comment counts as an appearance). Answer with one name per line, formatted `file: name`. ' +
      TOOLS_NOTE,
    checker: { type: 'dead-exports', dir: 'src/server', minRecall: 0.8, minPrecision: 0.8 },
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

export const DEFAULT_LIVE_TASKS = 'L1,L2';

/** The size ladder S → XL: `npm run bench:live -- --provider <p> --tasks ladder`. */
export const LADDER_TASKS = 'L1,L3,L4,L5,L6';

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
  if (ids.length === 1 && ids[0] === 'ladder') ids = LADDER_TASKS.split(',');
  const found: LiveTask[] = [];
  for (const id of ids) {
    const t = LIVE_TASKS.find((x) => x.id === id);
    if (!t)
      throw new Error(
        `bench:live: unknown task id ${id} (known: ${LIVE_TASKS.map((x) => x.id).join(', ')})`,
      );
    found.push(t);
  }
  return found;
}
