/**
 * Parse a Claude Code `--output-format stream-json --verbose` stream into the
 * same SessionUsage shape as the opencode parser (parse-events.mts), so the
 * opus arm feeds the same checker and normaliser.
 *
 * Stream shape (Claude Code 2.1.x):
 *   {"type":"system","subtype":"init","session_id":…,"model":…}
 *   {"type":"assistant","message":{"id":"msg_…","content":[{"type":"text"|"tool_use",…}],
 *     "usage":{"input_tokens":…,"output_tokens":…,"cache_read_input_tokens":…,
 *              "cache_creation_input_tokens":…}}}
 *   {"type":"user",…tool results…}
 *   {"type":"result","result":"<final text>","session_id":…}
 * One API message can arrive as several assistant events (one per content
 * block) that repeat the same id and usage, so usage is counted once per
 * message id and tool_use blocks once per block id.
 */
import {
  CODE_CONTEXT_SERVER_ALIAS,
  CODE_CONTEXT_TOOLS,
  type SessionUsage,
} from './parse-events.mts';

const MCP_PREFIX = `mcp__${CODE_CONTEXT_SERVER_ALIAS}__`;
const CODE_CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_CONTEXT_TOOLS.map((t) => `${MCP_PREFIX}${t}`),
);

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  result?: string;
  message?: { id?: string; model?: string; content?: Block[]; usage?: Usage };
}

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

export interface ClaudeSessionUsage extends SessionUsage {
  /** Model id the session reported (init event), e.g. claude-opus-5-5. */
  model: string | null;
}

export function parseClaudeStream(lines: string[]): ClaudeSessionUsage {
  const usageByMsg = new Map<string, Usage>(); // insertion order = call order
  const tools = new Map<string, string>(); // tool_use id -> name
  const texts = new Map<string, string>(); // `${msg}:${i}` -> text
  let skippedLines = 0;
  let sessionId: string | null = null;
  let model: string | null = null;
  let finalText: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: ClaudeEvent;
    try {
      ev = JSON.parse(line) as ClaudeEvent;
    } catch {
      skippedLines++;
      continue;
    }
    if (!ev || typeof ev !== 'object') {
      skippedLines++;
      continue;
    }
    if (typeof ev.session_id === 'string' && ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') {
      model = ev.model;
    } else if (ev.type === 'assistant' && ev.message && typeof ev.message.id === 'string') {
      const id = ev.message.id;
      if (ev.message.usage) usageByMsg.set(id, ev.message.usage);
      (ev.message.content ?? []).forEach((b, i) => {
        if (b?.type === 'tool_use' && typeof b.id === 'string')
          tools.set(b.id, String(b.name ?? ''));
        else if (b?.type === 'text' && typeof b.text === 'string') texts.set(`${id}:${i}`, b.text);
      });
    } else if (ev.type === 'result' && typeof ev.result === 'string') {
      finalText = ev.result;
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let firstCallCacheRead: number | null = null;
  for (const u of usageByMsg.values()) {
    inputTokens += num(u.input_tokens);
    outputTokens += num(u.output_tokens);
    cacheReadTokens += num(u.cache_read_input_tokens);
    cacheWriteTokens += num(u.cache_creation_input_tokens);
    if (firstCallCacheRead === null) firstCallCacheRead = num(u.cache_read_input_tokens);
  }
  let mcpToolCalls = 0;
  for (const name of tools.values()) if (CODE_CONTEXT_TOOL_NAMES.has(name)) mcpToolCalls++;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    firstCallCacheRead: firstCallCacheRead ?? 0,
    toolCalls: tools.size,
    mcpToolCalls,
    assistantText: finalText ?? [...texts.values()].join('\n\n'),
    skippedLines,
    sessionId,
    model,
  };
}
