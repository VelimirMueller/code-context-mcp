import { describe, it, expect } from 'vitest';
import { modelToTier, formatModelRouting } from '../src/scrum/agent-model.js';
import { AGENT_DEFAULTS } from '../src/scrum/defaults.js';
import { KNOWN_AGENT_MODELS } from '../src/scrum/agent-model.js';

describe('modelToTier', () => {
  it('maps fable/opus/sonnet/haiku ids to Task-tool tiers', () => {
    expect(modelToTier('claude-fable-5-1')).toBe('fable');
    expect(modelToTier('claude-opus-5-5')).toBe('opus');
    expect(modelToTier('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelToTier('claude-haiku-5-5')).toBe('haiku');
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
    // Any non-Claude id falls back to sonnet (current behaviour, kept on purpose).
    expect(modelToTier('glm-5.3')).toBe('sonnet');
    expect(modelToTier('deepseek-v4-pro')).toBe('sonnet');
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

describe('KNOWN_AGENT_MODELS', () => {
  it('offers the current generation first and keeps superseded ids accepted', () => {
    expect(KNOWN_AGENT_MODELS.slice(0, 4)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    for (const old of [
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]) {
      expect(KNOWN_AGENT_MODELS).toContain(old);
    }
  });
});

describe('formatModelRouting', () => {
  it('includes the role, the tier, and the Task-tool instruction', () => {
    const md = formatModelRouting('fe-engineer', 'claude-fable-5-1');
    expect(md).toContain('## Model routing');
    expect(md).toContain('fe-engineer');
    expect(md).toContain('model: "fable"');
    expect(md).toContain('Task tool');
  });
  it('renders the tier even when the model id is null', () => {
    expect(formatModelRouting('qa', null)).toContain('model: "sonnet"');
  });
  it('routes each current-generation model to its tier directive', () => {
    expect(formatModelRouting('developer', 'claude-fable-5-1')).toContain('model: "fable"');
    expect(formatModelRouting('qa', 'claude-opus-5-5')).toContain('model: "opus"');
    expect(formatModelRouting('architect', 'claude-sonnet-5-5')).toContain('model: "sonnet"');
    expect(formatModelRouting('devops', 'claude-haiku-5-5')).toContain('model: "haiku"');
  });
});
