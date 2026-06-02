import { afterEach, describe, expect, it } from 'vitest';
import { resolveModels, supportsReasoningEffort } from '../../src/models/catalog.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('model catalog', () => {
  it('reports reasoning-effort support by normalized model name', () => {
    expect(supportsReasoningEffort('grok-4.3')).toBe(true);
    expect(supportsReasoningEffort('grok-cli/GROK-COMPOSER-2.5-fast')).toBe(false);
    expect(supportsReasoningEffort('grok-4.20-0309-non-reasoning')).toBe(false);
  });

  it('uses fallback models when no override is configured', () => {
    delete process.env.PI_GROK_CLI_MODELS;

    const models = resolveModels();

    expect(models.map((model) => model.id)).toEqual([
      'grok-composer-2.5-fast',
      'grok-build',
      'grok-4.3',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-multi-agent-0309',
    ]);
    expect(models.find((model) => model.id === 'grok-composer-2.5-fast')).toMatchObject({
      contextWindow: 200_000,
    });
    expect(models.find((model) => model.id === 'grok-build')).toMatchObject({
      contextWindow: 512_000,
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
  });
});
