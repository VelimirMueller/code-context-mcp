/**
 * One wrapper at tool registration for three cross-cutting concerns:
 *
 * 1. Toolsets — optional groups of tools stay out of the MCP tool list unless
 *    `CODE_CONTEXT_TOOLSETS` enables them. Every listed tool costs model context
 *    in every session; these never do work for the pipeline. Data is untouched:
 *    the tables, the dashboard and the HTTP API keep working.
 * 2. Flair (overdrive FLAIR.md) — a text response gets ONE header line
 *    `● code-context ▸ <tool> ░▒▓` and ONE footer line `<kaomoji> <ms> ms`.
 *    Responses callers parse as JSON get none. Errors: text stays plain and
 *    first, the footer uses a fail kaomoji. `OVERDRIVE_FLAIR=0` turns it off.
 * 3. Timing — one session-log line `done <tool> in <ms> ms` per finished call.
 *
 * Call once, before any tool is registered (after logToolExceptions is fine).
 */
import { log as slog } from "../sessionlog.js";

/** Optional toolsets and their tools. Everything not listed is always on. */
export const OPTIONAL_TOOLSETS: Readonly<Record<string, readonly string[]>> = {
  // Scrum gamification: agent mood tracking and the Remotion vision video.
  fun: ["record_mood", "get_mood_trends", "generate_vision_animation"],
  // Live-output streaming into the dashboard wizard panel. No command or skill
  // calls them; request_user_input / get_user_response stay on (kickoff uses them).
  stream: ["send_step_progress", "send_claude_output", "send_claude_step"],
};

/**
 * The `code` profile: the four tools that answer a reading agent's questions
 * (CCA-02, #117; query schema CCA-03, #118). About 2.4k chars of tool
 * definitions instead of about 49k for the default set — for sessions that
 * read code but never run the sprint process (benchmarks, OpenCode workers, one-off agents).
 */
export const CODE_TOOLS: readonly string[] = [
  "find_symbol",
  "get_file_context",
  "search_files",
  "query",
];

/**
 * Index maintenance tools. Always on in the default profile; under `code` only
 * with `code-admin` (`CODE_CONTEXT_TOOLSETS=code,code-admin`). A reading agent
 * never needs them: the index is pre-built and re-checked against the disk.
 */
export const CODE_ADMIN_TOOLS: readonly string[] = [
  "index_directory",
  "set_description",
  "set_directory_description",
  "set_change_reason",
  "get_changes",
  "execute",
  "health",
];

/** Anything with `has(toolName)`: a Set of hidden names, or a profile rule. */
export interface ToolFilter {
  has(name: string): boolean;
}

/**
 * The filter `instrumentTools` uses by default. `CODE_CONTEXT_TOOLSETS=code`
 * hides every tool outside CODE_TOOLS (opt-in profile, 2026-10-11); adding
 * `code-admin` keeps CODE_ADMIN_TOOLS too. `all` still wins and hides nothing.
 * Otherwise the optional-toolset rules of hiddenTools apply unchanged.
 */
export function toolFilter(env: string | undefined = process.env.CODE_CONTEXT_TOOLSETS): ToolFilter {
  const wanted = (env ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/^\+/, ""));
  if (wanted.includes("code") && !wanted.includes("all")) {
    const keep = new Set([...CODE_TOOLS, ...(wanted.includes("code-admin") ? CODE_ADMIN_TOOLS : [])]);
    return { has: (name: string) => !keep.has(name) };
  }
  return hiddenTools(env);
}

/**
 * Parse `CODE_CONTEXT_TOOLSETS`: a comma list of optional toolsets to enable
 * (`fun,stream`), or `all`. Unset/empty/`default` = none of them. Unknown
 * names are ignored. Returns the set of tool names to hide.
 */
export function hiddenTools(env: string | undefined = process.env.CODE_CONTEXT_TOOLSETS): Set<string> {
  const wanted = new Set(
    (env ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^\+/, ""))
      .filter(Boolean),
  );
  const hidden = new Set<string>();
  if (wanted.has("all")) return hidden;
  for (const [set, tools] of Object.entries(OPTIONAL_TOOLSETS)) {
    if (!wanted.has(set)) for (const t of tools) hidden.add(t);
  }
  return hidden;
}

const GLYPH = "●";
const TOOL = "code-context";
const OK = ["┬─┬ノ( º _ºノ)", "(⌐■_■)", "ᕙ(⇀‸↼‶)ᕗ", "(•̀ᴗ•́)و"];
const FAIL = ["(╯°□°)╯︵ ┻━┻", "ಠ_ಠ"];

function flairOn(): boolean {
  return process.env.OVERDRIVE_FLAIR !== "0";
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
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false;
  if (t.length > 2_000_000) return true; // too big to parse on the hot path; shape is enough
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

type TextItem = { type: "text"; text: string };
type ToolResult = { content?: unknown[]; isError?: boolean; [k: string]: unknown };

/** Add header/footer to a tool result. Pure; returns the input when nothing applies. */
export function decorate(result: unknown, tool: string, ms: number): unknown {
  try {
    if (!flairOn() || !result || typeof result !== "object") return result;
    const r = result as ToolResult;
    if (!Array.isArray(r.content) || r.content.length === 0) return result;
    const texts = r.content.filter((c): c is TextItem => !!c && (c as TextItem).type === "text" && typeof (c as TextItem).text === "string");
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
  if (typeof target.tool !== "function") return;
  patched.add(server);
  const original = target.tool as (...args: unknown[]) => unknown;

  target.tool = function instrumentedTool(this: unknown, ...args: unknown[]): unknown {
    const name = args[0];
    const last = args.length - 1;
    const handler = args[last];
    if (typeof name === "string" && hidden.has(name)) {
      // Not registered: invisible to tools/list, uncallable. Callers in this
      // codebase never use the returned handle.
      return { name, enabled: false, enable() {}, disable() {}, remove() {}, update() {} };
    }
    if (args.length >= 2 && typeof name === "string" && typeof handler === "function") {
      const fn = handler as (...a: unknown[]) => unknown;
      const finish = (result: unknown, start: number): unknown => {
        const ms = performance.now() - start;
        slog("INFO", `done ${name} in ${Math.round(ms)} ms`);
        return decorate(result, name, ms);
      };
      const wrapped = function (this: unknown, ...callArgs: unknown[]): unknown {
        const start = performance.now();
        const result = fn.apply(this, callArgs);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => finish(v, start),
            (err: unknown) => {
              slog("INFO", `done ${name} in ${Math.round(performance.now() - start)} ms (threw)`);
              throw err;
            },
          );
        }
        return finish(result, start);
      };
      Object.defineProperty(wrapped, "length", { value: fn.length });
      Object.defineProperty(wrapped, "name", { value: fn.name });
      args = args.slice();
      args[last] = wrapped;
    }
    return original.apply(this === undefined ? server : this, args);
  };
}
