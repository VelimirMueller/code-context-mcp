/**
 * OpenCode event-stream parser (PLAN.md task 7).
 *
 * Input: the newline-delimited JSON that `opencode run --format json` prints.
 * Verified against opencode 1.18.30 with one real capture per provider
 * (glm: zai-coding-plan/glm-5.3, deepseek: deepseek/deepseek-v4-pro):
 *
 *   {"type":"step_start","timestamp":…,"sessionID":"ses_…","part":{"id":"prt_…","type":"step-start",…}}
 *   {"type":"text",…,"part":{"id":"prt_…","type":"text","text":"ok"}}
 *   {"type":"step_finish",…,"part":{"id":"prt_…","type":"step-finish","tokens":{"input":…,"output":…,"reasoning":…,"cache":{"read":…,"write":…}}}}
 *   {"type":"tool",…,"part":{"id":"prt_…","type":"tool","tool":"read","state":{…}}}
 *   {"type":"error",…,"error":{…}}
 *
 * The outer `type` is the snake_case of `part.type`; parts are re-emitted as
 * they update, so the parser keeps the LAST state per part id (last-write-wins,
 * never double-counted). Token fields live on step-finish parts; reasoning
 * tokens are generated output and count into `outputTokens`. Malformed lines
 * and unknown event/part types are skipped and counted, never fatal; expected
 * but unhandled parts (step-start, reasoning) are skipped silently.
 */

/**
 * The alias code-context is registered under in the per-workspace opencode
 * config (opencode-config.mts uses this same constant). opencode prefixes MCP
 * tool names with the server alias (`code-context_find_symbol`), so a call
 * counts as a code-context call only when the name is EXACTLY
 * `<alias>_<tool>` — never by substring, which would miscount tools such as
 * `xsearch_files` from other servers.
 */
export const CODE_CONTEXT_SERVER_ALIAS = 'code-context';

/**
 * Tools served by the code-context MCP server (src/server/index.ts).
 */
export const CODE_CONTEXT_TOOLS: readonly string[] = [
  'index_directory',
  'find_symbol',
  'get_file_context',
  'search_files',
  'set_description',
  'set_directory_description',
  'set_change_reason',
  'get_changes',
  'query',
  'execute',
  'health',
];

/** Exact MCP tool names as opencode reports them: `<server alias>_<tool>`. */
const CODE_CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_CONTEXT_TOOLS.map((t) => `${CODE_CONTEXT_SERVER_ALIAS}_${t}`),
);

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cache.read of the FIRST model call — 0 means the session started cold. */
  firstCallCacheRead: number;
  toolCalls: number;
  mcpToolCalls: number;
  assistantText: string;
  skippedLines: number;
  sessionId: string | null;
}

interface StreamPart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

interface StreamEvent {
  type?: string;
  sessionID?: string;
  part?: StreamPart;
}

const HANDLED_PART_TYPES = new Set(['text', 'tool', 'step-finish']);
/** Healthy-stream part types we deliberately ignore — not worth counting. */
const EXPECTED_UNHANDLED_PART_TYPES = new Set(['step-start', 'reasoning']);

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

export function parseEventStream(lines: string[]): SessionUsage {
  const parts = new Map<string, StreamPart>();
  let skippedLines = 0;
  let sessionId: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue; // blank/trailing-newline artifacts are not malformed lines
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      skippedLines++;
      continue;
    }
    if (!event || typeof event !== 'object' || !event.part || typeof event.part !== 'object') {
      skippedLines++; // error events, unknown envelopes
      continue;
    }
    if (typeof event.sessionID === 'string' && event.sessionID) sessionId = event.sessionID;
    const part = event.part;
    if (EXPECTED_UNHANDLED_PART_TYPES.has(part.type ?? '')) continue; // healthy stream
    if (
      typeof part.id !== 'string' ||
      !part.id ||
      !part.type ||
      !HANDLED_PART_TYPES.has(part.type)
    ) {
      skippedLines++; // malformed parts and truly unknown types
      continue;
    }
    parts.set(part.id, part); // last write wins per part id
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let firstCallCacheRead: number | null = null;
  let toolCalls = 0;
  let mcpToolCalls = 0;
  const texts: string[] = [];

  for (const part of parts.values()) {
    if (part.type === 'text') {
      texts.push(typeof part.text === 'string' ? part.text : '');
    } else if (part.type === 'tool') {
      toolCalls++;
      const name = typeof part.tool === 'string' ? part.tool : '';
      if (CODE_CONTEXT_TOOL_NAMES.has(name)) mcpToolCalls++;
    } else if (part.type === 'step-finish') {
      const t = part.tokens;
      inputTokens += num(t?.input);
      outputTokens += num(t?.output) + num(t?.reasoning);
      cacheReadTokens += num(t?.cache?.read);
      if (firstCallCacheRead === null) firstCallCacheRead = num(t?.cache?.read); // parts keep stream order
      cacheWriteTokens += num(t?.cache?.write);
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    firstCallCacheRead: firstCallCacheRead ?? 0,
    toolCalls,
    mcpToolCalls,
    assistantText: texts.join('\n\n'),
    skippedLines,
    sessionId,
  };
}
