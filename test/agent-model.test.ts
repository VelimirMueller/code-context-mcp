import { describe, it, expect } from 'vitest';
import { modelToTier, formatModelRouting } from '../src/scrum/agent-model.js';
import { AGENT_DEFAULTS } from '../src/scrum/defaults.js';
import { KNOWN_AGENT_MODELS } from '../src/scrum/agent-model.js';

describe('modelToTier', () => {
  it('maps fable/opus/sonnet/haiku ids to Task-tool tiers', () => {
    expect(modelToTier('claude-fable-5')).toBe('fable');
    expect(modelToTier('claude-opus-4-8')).toBe('opus');
    expect(modelToTier('claude-opus-5')).toBe('opus');
    expect(modelToTier('claude-sonnet-5')).toBe('sonnet');
    expect(modelToTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelToTier('claude-haiku-4-5')).toBe('haiku');
  });
  it('defaults unknown/null/undefined to sonnet', () => {
    expect(modelToTier(null)).toBe('sonnet');
    expect(modelToTier(undefined)).toBe('sonnet');
    expect(modelToTier('gpt-9')).toBe('sonnet');
  });
  it('every known model id routes to a real tier and every seed model is a known id', () => {
    for (const id of KNOWN_AGENT_MODELS)
      expect(['fable', 'opus', 'sonnet', 'haiku']).toContain(modelToTier(id));
    for (const agent of AGENT_DEFAULTS)
      expect(KNOWN_AGENT_MODELS, `${agent.role}: ${agent.model}`).toContain(agent.model);
  });
  it('routes every factory-seed model to a spawnable tier (no seed falls through by accident)', () => {
    const spawnable = ['fable', 'opus', 'sonnet', 'haiku'];
    for (const agent of AGENT_DEFAULTS) {
      const tier = modelToTier(agent.model);
      expect(spawnable, `${agent.role} (${agent.model})`).toContain(tier);
      // A current-generation seed must never land on the unknown-model
      // fallback: its id prefix must match the tier it routes to.
      expect(
        agent.model.startsWith(`claude-${tier}`),
        `${agent.role}: ${agent.model} -> ${tier}`,
      ).toBe(true);
    }
  });
});

describe('formatModelRouting', () => {
  it('includes the role, the tier, and the Task-tool instruction', () => {
    const md = formatModelRouting('fe-engineer', 'claude-fable-5');
    expect(md).toContain('## Model routing');
    expect(md).toContain('fe-engineer');
    expect(md).toContain('model: "fable"');
    expect(md).toContain('Task tool');
  });
  it('renders the tier even when the model id is null', () => {
    expect(formatModelRouting('qa', null)).toContain('model: "sonnet"');
  });
  it('routes each current-generation model to its tier directive', () => {
    expect(formatModelRouting('developer', 'claude-fable-5')).toContain('model: "fable"');
    expect(formatModelRouting('qa', 'claude-opus-4-8')).toContain('model: "opus"');
    expect(formatModelRouting('architect', 'claude-sonnet-5')).toContain('model: "sonnet"');
    expect(formatModelRouting('devops', 'claude-haiku-4-5')).toContain('model: "haiku"');
  });
});
