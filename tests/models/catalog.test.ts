import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveModels,
  supportsReasoning,
  supportsReasoningEffort,
} from '../../src/models/catalog.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('model catalog', () => {
  it('reports reasoning-effort support by normalized model name', () => {
    expect(supportsReasoningEffort('grok-4.3')).toBe(true);
    expect(supportsReasoningEffort('grok-4.5')).toBe(true);
    expect(supportsReasoningEffort('grok-4.6')).toBe(true);
    expect(supportsReasoningEffort('grok-cli/GROK-COMPOSER-2.5-fast')).toBe(false);
    expect(supportsReasoningEffort('grok-4.20-0309-non-reasoning')).toBe(false);
  });

  it('reports reasoning support by normalized model name', () => {
    expect(supportsReasoning('grok-cli/GROK-BUILD')).toBe(true);
    expect(supportsReasoning('grok-cli/GROK-4.6')).toBe(true);
    expect(supportsReasoning('grok-cli/GROK-COMPOSER-2.5-fast')).toBe(false);
    expect(supportsReasoning('grok-4.20-0309-non-reasoning')).toBe(false);
  });

  it('uses fallback models when no override is configured', () => {
    delete process.env.PI_GROK_CLI_MODELS;

    const models = resolveModels();

    expect(models.map((model) => model.id)).toEqual([
      'grok-composer-2.5-fast',
      'grok-build',
      'grok-4.3',
      'grok-4.5',
      'grok-4.6',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-multi-agent-0309',
    ]);
    expect(models.find((model) => model.id === 'grok-composer-2.5-fast')).toMatchObject({
      contextWindow: 200_000,
      input: ['text', 'image'],
    });
    expect(models.find((model) => model.id === 'grok-build')).toMatchObject({
      contextWindow: 500_000,
    });
    expect(models.find((model) => model.id === 'grok-4.20-0309-reasoning')).toMatchObject({
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    });
    expect(models.find((model) => model.id === 'grok-4.5')).toMatchObject({
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 500_000,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    });
    expect(models.find((model) => model.id === 'grok-4.6')).toMatchObject({
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 500_000,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it('filters, reorders, and fills unknown model overrides', () => {
    process.env.PI_GROK_CLI_MODELS = ' custom-model , grok-build ,, grok-4.3 ';

    const models = resolveModels();

    expect(models.map((model) => model.id)).toEqual(['custom-model', 'grok-build', 'grok-4.3']);
    expect(models[0]).toMatchObject({
      name: 'custom-model',
      reasoning: true,
      input: ['text'],
      contextWindow: 1_000_000,
      maxTokens: 30_000,
    });
    expect(models[1].name).toBe('Grok Build');
    expect(supportsReasoning('grok-cli/CUSTOM-MODEL')).toBe(true);
  });
});
