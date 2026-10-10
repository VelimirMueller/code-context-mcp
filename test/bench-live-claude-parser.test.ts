/**
 * Claude Code stream-json parser (opus arm). Hand-written lines in the shape
 * of `claude -p --output-format stream-json --verbose` (Claude Code 2.1.x).
 */
import { describe, it, expect } from 'vitest';
import { parseClaudeStream } from '../scripts/bench/live/parse-claude.mts';

const ev = (o: unknown): string => JSON.stringify(o);
const usage = (input: number, output: number, read: number, write: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});

const lines = [
  ev({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' }),
  // message 1 arrives as two events (one per content block) with the same id and usage
  ev({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'Looking.' }],
      usage: usage(1000, 20, 0, 0),
    },
  }),
  ev({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'tool_use', id: 't1', name: 'mcp__code-context__find_symbol' }],
      usage: usage(1000, 20, 0, 0),
    },
  }),
  ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
  ev({
    type: 'assistant',
    message: {
      id: 'm2',
      content: [
        { type: 'tool_use', id: 't2', name: 'Read' },
        { type: 'tool_use', id: 't3', name: 'mcp__code-context-evil__find_symbol' },
      ],
      usage: usage(300, 10, 0, 0),
    },
  }),
  'not json',
  ev({ type: 'result', subtype: 'success', result: 'src/utils/helpers.ts', session_id: 's-1' }),
];

describe('parseClaudeStream', () => {
  const u = parseClaudeStream(lines);
  it('counts usage once per API message id', () => {
    expect(u.inputTokens).toBe(1300);
    expect(u.outputTokens).toBe(30);
    expect(u.cacheReadTokens).toBe(0);
    expect(u.firstCallCacheRead).toBe(0);
  });
  it('counts tool calls once per tool_use id, MCP by exact server prefix', () => {
    expect(u.toolCalls).toBe(3);
    expect(u.mcpToolCalls).toBe(1);
  });
  it('takes the final answer, session id and model', () => {
    expect(u.assistantText).toBe('src/utils/helpers.ts');
    expect(u.sessionId).toBe('s-1');
    expect(u.model).toBe('claude-opus-5-5');
    expect(u.skippedLines).toBe(1);
  });
  it('reports a cache read on the first call', () => {
    const warm = parseClaudeStream([
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(10, 1, 4000, 0) } }),
    ]);
    expect(warm.firstCallCacheRead).toBe(4000);
  });
});

describe('parseClaudeStream — totals from the result event', () => {
  it('takes output from result.usage, not the partial per-message snapshot', () => {
    const u = parseClaudeStream([
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(5480, 16, 0, 0) } }),
      ev({ type: 'assistant', message: { id: 'm2', content: [], usage: usage(8210, 2, 0, 0) } }),
      ev({ type: 'result', result: 'done', usage: usage(13690, 2912, 0, 0) }),
    ]);
    expect(u.inputTokens).toBe(13690);
    expect(u.outputTokens).toBe(2912);
    expect(u.firstCallCacheRead).toBe(0);
  });
  it('falls back to per-message usage when the stream has no result (timeout)', () => {
    const u = parseClaudeStream([
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(100, 7, 0, 0) } }),
    ]);
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(7);
  });
});
