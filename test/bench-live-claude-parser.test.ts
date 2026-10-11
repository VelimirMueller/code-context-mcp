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

describe('parseClaudeStream — cache fields (CCA-10, caching on in cold sessions)', () => {
  it('takes cache_read and cache_write (cache_creation) totals from result.usage', () => {
    const u = parseClaudeStream([
      // cold first call: static prefix read from cache, the rest written
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(3, 9, 4200, 6100) } }),
      ev({ type: 'assistant', message: { id: 'm2', content: [], usage: usage(5, 3, 10300, 800) } }),
      ev({
        type: 'result',
        result: 'done',
        usage: usage(8, 640, 14500, 6900),
        total_cost_usd: 0.0731,
      }),
    ]);
    expect(u.inputTokens).toBe(8);
    expect(u.outputTokens).toBe(640);
    expect(u.cacheReadTokens).toBe(14500);
    expect(u.cacheWriteTokens).toBe(6900);
    expect(u.firstCallCacheRead).toBe(4200); // from the first API message, not the result
    expect(u.costUsd).toBe(0.0731);
    expect(u.modelCalls).toBe(2);
  });
  it('sums per-message cache fields once per message id without a result event', () => {
    const u = parseClaudeStream([
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(3, 1, 4200, 6100) } }),
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(3, 1, 4200, 6100) } }),
      ev({ type: 'assistant', message: { id: 'm2', content: [], usage: usage(5, 1, 10300, 800) } }),
    ]);
    expect(u.cacheReadTokens).toBe(14500);
    expect(u.cacheWriteTokens).toBe(6900);
    expect(u.costUsd).toBeNull();
  });
});

describe('parseClaudeStream — cost', () => {
  it('reads total_cost_usd from the result event', () => {
    const u = parseClaudeStream([
      ev({ type: 'result', result: 'x', usage: usage(1, 1, 0, 0), total_cost_usd: 0.2273 }),
    ]);
    expect(u.costUsd).toBe(0.2273);
  });
  it('the result event cost wins; per-message usage never produces a cost', () => {
    const u = parseClaudeStream([
      ev({ type: 'assistant', message: { id: 'm1', content: [], usage: usage(10, 1, 0, 9000) } }),
      ev({ type: 'result', result: 'x', usage: usage(10, 50, 0, 9000), total_cost_usd: 0.0577 }),
    ]);
    expect(u.costUsd).toBe(0.0577);
  });
  it('is null without a result event', () => {
    expect(parseClaudeStream([]).costUsd).toBeNull();
  });
});

describe('parseClaudeStream — provider errors', () => {
  it('reports a usage-limit result as a provider error with 0 model calls', () => {
    const u = parseClaudeStream([
      ev({
        type: 'assistant',
        message: {
          id: 'x',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'limit' }],
          usage: usage(0, 0, 0, 0),
        },
      }),
      ev({
        type: 'result',
        is_error: true,
        api_error: 'usage_limit_reached',
        api_error_status: 429,
        result: "You've hit your session limit",
      }),
    ]);
    expect(u.providerError).toBe('usage_limit_reached (HTTP 429)');
    expect(u.modelCalls).toBe(0);
  });
  it('a normal session has model calls and no provider error', () => {
    const u = parseClaudeStream(lines);
    expect(u.providerError).toBeNull();
    expect(u.modelCalls).toBe(2);
  });
});
