/**
 * Task 7 unit tests — OpenCode event-stream parser.
 *
 * The fixture is a sanitised capture of `opencode run --format json`
 * (opencode 1.18.30, one real run per provider), extended with hand-written
 * tool/unknown/malformed lines. Zero network, zero opencode invocation.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventStream, CODE_CONTEXT_TOOLS } from '../scripts/bench/live/parse-events.mts';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bench',
  'opencode-events.jsonl',
);
const lines = fs.readFileSync(fixturePath, 'utf-8').split('\n');

describe('parseEventStream', () => {
  it('sums tokens across step-finish parts, folding reasoning into output', () => {
    const u = parseEventStream(lines);
    expect(u.inputTokens).toBe(2500);
    expect(u.outputTokens).toBe(35); // (20 out + 5 reasoning) + (10 out + 0 reasoning)
    expect(u.cacheReadTokens).toBe(200);
    expect(u.cacheWriteTokens).toBe(50);
  });

  it('keeps the last state per part id — never double-counts updates', () => {
    const u = parseEventStream(lines);
    // prt_text1 is updated twice with growing text; only the final state counts.
    expect(u.assistantText).toBe(
      'The `formatDate` function lives in src/utils/helpers.ts.\n\nDone.',
    );
    // prt_tool1 arrives twice (pending → completed) but is one call.
    expect(u.toolCalls).toBe(3);
  });

  it('counts MCP tool calls by exact `<server alias>_<tool>` name, never by substring', () => {
    const u = parseEventStream(lines);
    expect(u.mcpToolCalls).toBe(1); // code-context_find_symbol
    expect(CODE_CONTEXT_TOOLS).toContain('find_symbol');
    expect(CODE_CONTEXT_TOOLS).toContain('search_files');
    expect(CODE_CONTEXT_TOOLS).toContain('index_directory');
  });

  it('does not count lookalike or bare tool names from other servers', () => {
    const lookalikes = [
      '{"type":"tool","part":{"id":"x1","type":"tool","tool":"xsearch_files"}}',
      '{"type":"tool","part":{"id":"x2","type":"tool","tool":"myserver_query"}}',
      '{"type":"tool","part":{"id":"x3","type":"tool","tool":"query"}}', // bare: a built-in, not MCP
      '{"type":"tool","part":{"id":"x4","type":"tool","tool":"code-context_query_extra"}}',
      '{"type":"tool","part":{"id":"x5","type":"tool","tool":"read"}}',
    ];
    const u = parseEventStream(lookalikes);
    expect(u.toolCalls).toBe(5);
    expect(u.mcpToolCalls).toBe(0);
    const exact = parseEventStream([
      '{"type":"tool","part":{"id":"y1","type":"tool","tool":"code-context_search_files"}}',
    ]);
    expect(exact.mcpToolCalls).toBe(1);
  });

  it('skips malformed lines and unknown event types, counting them', () => {
    const u = parseEventStream(lines);
    // subscription_idle, "not json{", error event — malformed/unknown only.
    // The stream's step_start part is expected-but-unhandled and not counted.
    expect(u.skippedLines).toBe(3);
  });

  it('captures the session id from the stream', () => {
    expect(parseEventStream(lines).sessionId).toBe('ses_bench_sample_001');
  });

  it('handles an empty stream', () => {
    const u = parseEventStream([]);
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
    expect(u.toolCalls).toBe(0);
    expect(u.assistantText).toBe('');
    expect(u.skippedLines).toBe(0);
    expect(u.sessionId).toBeNull();
  });

  it('accepts real captures: tokens without reasoning and without cache', () => {
    const real = [
      '{"type":"step_finish","part":{"id":"f1","type":"step-finish","tokens":{"total":7465,"input":5543,"output":2,"reasoning":0,"cache":{"write":0,"read":1920}}}}',
      '{"type":"text","part":{"id":"t1","type":"text","text":"ok"}}',
    ];
    const u = parseEventStream(real);
    expect(u.inputTokens).toBe(5543);
    expect(u.outputTokens).toBe(2);
    expect(u.cacheReadTokens).toBe(1920);
    expect(u.assistantText).toBe('ok');
  });
});

describe('parseEventStream — first-call cache read', () => {
  it('reports cache.read of the FIRST step only', () => {
    expect(parseEventStream(lines).firstCallCacheRead).toBe(200); // fixture steps: 200, then 0
  });
  it('is 0 for an empty stream', () => {
    expect(parseEventStream([]).firstCallCacheRead).toBe(0);
  });
});

describe('parseEventStream — cost', () => {
  const step = (id: string, cost?: number) =>
    JSON.stringify({
      type: 'step_finish',
      part: {
        id,
        type: 'step-finish',
        ...(cost === undefined ? {} : { cost }),
        tokens: { input: 1, output: 1 },
      },
    });
  it('sums the step costs opencode reports', () => {
    expect(parseEventStream([step('a', 0.0013), step('b', 0.0003)]).costUsd).toBeCloseTo(0.0016, 6);
  });
  it('is null when no step carries a cost', () => {
    expect(parseEventStream([step('a')]).costUsd).toBeNull();
  });
});

describe('parseEventStream — model calls', () => {
  it('counts step-finish parts as model calls; an empty stream has none', () => {
    expect(parseEventStream(lines).modelCalls).toBe(2);
    expect(parseEventStream([]).modelCalls).toBe(0);
  });
});
