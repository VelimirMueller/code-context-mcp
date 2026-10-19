/**
 * One wrapper at tool registration for three cross-cutting concerns:
 *
 * 1. Toolsets and profiles — a tool is listed only when its toolset is on.
 *    The profile (`CODE_CONTEXT_PROFILE`, default `code` since 3.0.0, #178)
 *    picks the base toolsets; `CODE_CONTEXT_TOOLSETS` adds more. Every listed
 *    tool costs model context in every session. Data is untouched: the
 *    tables, the dashboard and the HTTP API keep working.
 * 2. Flair (overdrive FLAIR.md) — a text response gets ONE header line
 *    `● code-context ▸ <tool> ░▒▓` and ONE footer line `<kaomoji> <ms> ms`.
 *    Responses callers parse as JSON get none. Errors: text stays plain and
 *    first, the footer uses a fail kaomoji. On when the `scrum` toolset is on
 *    (`full`, `all`), and `OVERDRIVE_FLAIR=0` turns it off. Off otherwise (it
 *    is model context, ~15–25 tokens per result), and `OVERDRIVE_FLAIR=1`
 *    turns it on.
 * 3. Timing — one session-log line `done <tool> in <ms> ms` per finished call.
 *
 * Also here: the MCP server `instructions` (serverInstructions) and the
 * timestamp switch for model-facing results (showTimestamps), because both
 * depend on the same env as the toolsets.
 *
 * Call once, before any tool is registered (after logToolExceptions is fine).
 */
import { log as slog } from '../sessionlog.js';

/**
 * The `code` toolset: the six tools that answer a reading agent's questions
 * (CCA-02, #117; query schema CCA-03, #118; who_imports/exports_in CCA-05,
 * #120). About 3.3k chars of tool definitions instead of about 49k for the
 * `full` profile. Always on, in every profile.
 */
export const CODE_TOOLS: readonly string[] = [
  'find_symbol',
  'get_file_context',
  'who_imports',
  'exports_in',
  'search_files',
  'query',
];

/**
 * The `code-admin` toolset: index maintenance. On in `full` and `all`; under
 * `code` only with `CODE_CONTEXT_TOOLSETS=code-admin`. A reading agent never
 * needs them: the index is pre-built and re-checked against the disk.
 */
export const CODE_ADMIN_TOOLS: readonly string[] = [
  'index_directory',
  'set_description',
  'set_directory_description',
  'set_change_reason',
  'get_changes',
  'execute',
  'health',
];

/** Optional toolsets that no profile but `all` turns on. */
export const OPTIONAL_TOOLSETS: Readonly<Record<'fun' | 'stream', readonly string[]>> = {
  // Scrum gamification: agent mood tracking and the Remotion vision video.
  fun: ['record_mood', 'get_mood_trends', 'generate_vision_animation'],
  // Live-output streaming into the dashboard wizard panel. No command or skill
  // calls them; request_user_input / get_user_response stay in `scrum` (kickoff uses them).
  stream: ['send_step_progress', 'send_claude_output', 'send_claude_step'],
};

/**
 * Every toolset, in report order. `scrum` is every tool no other toolset
 * names: the sprint process, agents, skills, the dashboard bridge, dump and
 * restore (src/scrum/tools.ts and src/scrum/tools/).
 */
export const TOOLSETS = ['code', 'code-admin', 'scrum', 'fun', 'stream'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/**
 * Profiles: the base toolsets. `full` is the 2.x default (97 tools); `all`
 * adds `fun` and `stream` (103 tools).
 */
export const PROFILES = {
  code: ['code'],
  full: ['code', 'code-admin', 'scrum'],
  all: TOOLSETS,
} as const satisfies Record<string, readonly Toolset[]>;
export type Profile = keyof typeof PROFILES;

/**
 * The profile when `CODE_CONTEXT_PROFILE` is unset. A second entry point
 * (the sprint process bin, #179) sets its own default with
 * `process.env.CODE_CONTEXT_PROFILE ??= "full"` before it loads the server,
 * or passes `defaultProfile` to resolveToolsets.
 */
export const DEFAULT_PROFILE: Profile = 'code';

/** The active profile and toolsets. `health` reports it. */
export interface ToolSelection {
  profile: Profile;
  /** Active toolsets, in TOOLSETS order. */
  toolsets: readonly Toolset[];
  /** Env values this server did not understand and ignored. */
  ignored: readonly string[];
}

function isProfile(v: string): v is Profile {
  return Object.prototype.hasOwnProperty.call(PROFILES, v);
}

function isToolset(v: string): v is Toolset {
  return (TOOLSETS as readonly string[]).includes(v);
}

/**
 * Read the profile and the toolsets from the env.
 *
 * - `CODE_CONTEXT_PROFILE`: `code` | `full` | `all`. Unset, empty or unknown
 *   = `defaultProfile` (an unknown value is listed in `ignored`).
 * - `CODE_CONTEXT_TOOLSETS`: comma list of toolsets to add to the profile
 *   (`code-admin`, `scrum`, `fun`, `stream`), or `all`. A leading `+` is
 *   allowed. It only adds: it never takes a toolset away from the profile.
 *   `code` and `default` (2.x spellings) are accepted and change nothing.
 */
export function resolveToolsets(
  profileEnv: string | undefined = process.env.CODE_CONTEXT_PROFILE,
  toolsetsEnv: string | undefined = process.env.CODE_CONTEXT_TOOLSETS,
  defaultProfile: Profile = DEFAULT_PROFILE,
): ToolSelection {
  const ignored: string[] = [];
  const p = (profileEnv ?? '').trim().toLowerCase();
  let profile = defaultProfile;
  if (isProfile(p)) profile = p;
  else if (p) ignored.push(`CODE_CONTEXT_PROFILE=${p}`);

  const on = new Set<Toolset>(PROFILES[profile]);
  for (const raw of (toolsetsEnv ?? '').split(',')) {
    const t = raw.trim().toLowerCase().replace(/^\+/, '');
    if (!t || t === 'default') continue;
    if (t === 'all') for (const s of TOOLSETS) on.add(s);
    else if (isToolset(t)) on.add(t);
    else ignored.push(`CODE_CONTEXT_TOOLSETS:${t}`);
  }
  return { profile, toolsets: TOOLSETS.filter((s) => on.has(s)), ignored };
}

/** The toolset a tool belongs to. Every tool no list names is `scrum`. */
export function toolsetOf(name: string): Toolset {
  if (CODE_TOOLS.includes(name)) return 'code';
  if (CODE_ADMIN_TOOLS.includes(name)) return 'code-admin';
  for (const [set, tools] of Object.entries(OPTIONAL_TOOLSETS)) {
    if (tools.includes(name)) return set as Toolset;
  }
  return 'scrum';
}

/** Anything with `has(toolName)`: true = the tool is hidden. */
export interface ToolFilter {
  has(name: string): boolean;
}

/** The filter `instrumentTools` uses by default: hides every tool outside the active toolsets. */
export function toolFilter(selection: ToolSelection = resolveToolsets()): ToolFilter {
  const on = new Set<Toolset>(selection.toolsets);
  return { has: (name: string) => !on.has(toolsetOf(name)) };
}

const GLYPH = '●';
const TOOL = 'code-context';
const OK = ['┬─┬ノ( º _ºノ)', '(⌐■_■)', 'ᕙ(⇀‸↼‶)ᕗ', '(•̀ᴗ•́)و'];
const FAIL = ['(╯°□°)╯︵ ┻━┻', 'ಠ_ಠ'];

const TRUTHY = /^(1|true|yes)$/i;

/**
 * Flair on or off. `OVERDRIVE_FLAIR=0` always turns it off, `OVERDRIVE_FLAIR=1`
 * (true/yes) always on. Unset: on when the `scrum` toolset is on (the
 * overdrive terminal look of the sprint process), off otherwise, where every
 * result is model context for a reading agent.
 */
export function flairEnabled(
  flair: string | undefined = process.env.OVERDRIVE_FLAIR,
  selection: ToolSelection = resolveToolsets(),
): boolean {
  const v = (flair ?? '').trim();
  if (v === '0' || /^(false|no|off)$/i.test(v)) return false;
  if (TRUTHY.test(v)) return true;
  return selection.toolsets.includes('scrum');
}

/**
 * `modified …` / `indexed …` timestamps in model-facing results
 * (find_symbol, get_file_context, search_files). Off unless
 * `CODE_CONTEXT_TIMESTAMPS=1`: the read-time freshness check already
 * re-indexes changed files and prints a notice when it did, so the
 * timestamps cost tokens without changing an answer.
 */
export function showTimestamps(
  env: string | undefined = process.env.CODE_CONTEXT_TIMESTAMPS,
): boolean {
  return TRUTHY.test((env ?? '').trim());
}

/** Upper bound for serverInstructions(), pinned by test/tool-wrap.test.ts (~95 tokens). */
export const MAX_INSTRUCTIONS_CHARS = 400;

/**
 * The MCP server `instructions`: when to use the graph tools instead of grep,
 * that results hold no full code, and how paths print. Only tools the active
 * profile lists are named; undefined when none of them is listed.
 */
export function serverInstructions(
  hidden: ToolFilter = toolFilter(),
  absolutePaths: boolean = TRUTHY.test(process.env.CODE_CONTEXT_ABSOLUTE_PATHS ?? ''),
): string | undefined {
  const on = (t: string) => !hidden.has(t);
  const routes = [
    ['who_imports', 'Who imports X: who_imports.'],
    ['find_symbol', 'Where is S defined: find_symbol.'],
    ['get_file_context', 'What a file exports or imports: get_file_context.'],
    ['exports_in', 'What dir D exports or leaves unused: exports_in.'],
  ]
    .filter(([t]) => on(t))
    .map(([, r]) => r);
  if (routes.length === 0) return undefined;
  const parts = ['Code index of this project; prefer it to grep.', ...routes];
  parts.push(
    on('get_file_context')
      ? 'Results never hold full code: read the file for that. get_file_context gives signatures and import lines, snippet:true short bodies.'
      : 'Results never hold full code: read the file for that.',
  );
  if (!absolutePaths) parts.push('Paths are project-relative.');
  return parts.join(' ');
}

/** Header line, ≤ 72 chars. */
export function flairHeader(tool: string): string {
  return `${GLYPH} ${TOOL} ▸ ${tool} ░▒▓`.slice(0, 72);
}

/** Footer line: kaomoji picked by the duration, never randomly. */
export function flairFooter(ms: number, failed: boolean): string {
  const set = failed ? FAIL : OK;
  const whole = Math.max(0, Math.round(ms));
  return `${set[whole % set.length]} ${whole} ms`;
}

/** True when the text is a JSON document a caller will parse. */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  const first = t[0];
  const last = t[t.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false;
  if (t.length > 2_000_000) return true; // too big to parse on the hot path; shape is enough
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

type TextItem = { type: 'text'; text: string };
type ToolResult = { content?: unknown[]; isError?: boolean; [k: string]: unknown };

/** Add header/footer to a tool result. Pure; returns the input when nothing applies. */
export function decorate(result: unknown, tool: string, ms: number): unknown {
  try {
    if (!flairEnabled() || !result || typeof result !== 'object') return result;
    const r = result as ToolResult;
    if (!Array.isArray(r.content) || r.content.length === 0) return result;
    const texts = r.content.filter(
      (c): c is TextItem =>
        !!c && (c as TextItem).type === 'text' && typeof (c as TextItem).text === 'string',
    );
    if (texts.length === 0) return result;
    if (texts.some((c) => looksLikeJson(c.text))) return result;
    const failed = r.isError === true;
    const content = r.content.slice();
    const firstIdx = content.indexOf(texts[0]);
    const lastIdx = content.lastIndexOf(texts[texts.length - 1]);
    if (!failed) {
      content[firstIdx] = { ...texts[0], text: `${flairHeader(tool)}\n${texts[0].text}` };
    }
    const lastItem = content[lastIdx] as TextItem;
    content[lastIdx] = { ...lastItem, text: `${lastItem.text}\n${flairFooter(ms, failed)}` };
    return { ...r, content };
  } catch {
    return result; // flair never breaks the tool
  }
}

const patched = new WeakSet<object>();

/**
 * Patch `server.tool(...)` so hidden tools are never registered and every
 * other handler is timed, logged and decorated. Idempotent per server.
 */
export function instrumentTools(server: object, hidden: ToolFilter = toolFilter()): void {
  if (patched.has(server)) return;
  const target = server as { tool?: unknown };
  if (typeof target.tool !== 'function') return;
  patched.add(server);
  const original = target.tool as (...args: unknown[]) => unknown;

  target.tool = function instrumentedTool(this: unknown, ...args: unknown[]): unknown {
    const name = args[0];
    const last = args.length - 1;
    const handler = args[last];
    if (typeof name === 'string' && hidden.has(name)) {
      // Not registered: invisible to tools/list, uncallable. Callers in this
      // codebase never use the returned handle.
      return { name, enabled: false, enable() {}, disable() {}, remove() {}, update() {} };
    }
    if (args.length >= 2 && typeof name === 'string' && typeof handler === 'function') {
      const fn = handler as (...a: unknown[]) => unknown;
      const finish = (result: unknown, start: number): unknown => {
        const ms = performance.now() - start;
        slog('INFO', `done ${name} in ${Math.round(ms)} ms`);
        return decorate(result, name, ms);
      };
      const wrapped = function (this: unknown, ...callArgs: unknown[]): unknown {
        const start = performance.now();
        const result = fn.apply(this, callArgs);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          return (result as Promise<unknown>).then(
            (v) => finish(v, start),
            (err: unknown) => {
              slog('INFO', `done ${name} in ${Math.round(performance.now() - start)} ms (threw)`);
              throw err;
            },
          );
        }
        return finish(result, start);
      };
      Object.defineProperty(wrapped, 'length', { value: fn.length });
      Object.defineProperty(wrapped, 'name', { value: fn.name });
      args = args.slice();
      args[last] = wrapped;
    }
    return original.apply(this === undefined ? server : this, args);
  };
}
