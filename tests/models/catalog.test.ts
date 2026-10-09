import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
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
  it('lets Pi select Extra High reasoning for Grok 4.6', () => {
    delete process.env.PI_GROK_CLI_MODELS;
    const config = resolveModels().find((model) => model.id === 'grok-4.6');
    if (!config) throw new Error('Grok 4.6 is missing');
    const model = {
      ...config,
      provider: 'grok-cli',
      api: 'openai-responses' as const,
      baseUrl: 'https://cli-chat-proxy.grok.com',
    };
    expect(getSupportedThinkingLevels(model)).toContain('xhigh');
    expect(clampThinkingLevel(model, 'xhigh')).toBe('xhigh');
  });

  it('reports reasoning-effort support by normalized model name', () => {
    expect(supportsReasoningEffort('grok-4.3')).toBe(true);
    expect(supportsReasoningEffort('grok-4.5')).toBe(true);
    expect(supportsReasoningEffort('grok-4.6')).toBe(true);
    expect(supportsReasoningEffort('grok-4.7')).toBe(true);
    expect(supportsReasoningEffort('grok-4.7-build-fast')).toBe(true);
    expect(supportsReasoningEffort('grok-cli/GROK-COMPOSER-2.5-fast')).toBe(false);
    expect(supportsReasoningEffort('grok-4.20-0309-non-reasoning')).toBe(false);
    expect(supportsReasoningEffort('grok-build')).toBe(false);
    expect(supportsReasoningEffort('grok-4.20-0309-reasoning')).toBe(false);
    expect(supportsReasoningEffort('grok-4.20-multi-agent-0309')).toBe(true);
  });

  it('infers reasoning-effort support for overridden models from their name', () => {
    process.env.PI_GROK_CLI_MODELS = 'grok-3-mini,grok-4.5-preview,custom-model,grok-4.3';

    expect(supportsReasoningEffort('grok-3-mini')).toBe(true);
    expect(supportsReasoningEffort('grok-cli/GROK-4.5-PREVIEW')).toBe(true);
    expect(supportsReasoningEffort('custom-model')).toBe(false);
    expect(supportsReasoningEffort('grok-4.3')).toBe(true);
    expect(supportsReasoningEffort('grok-4.6')).toBe(false);
  });

  it('bills documented models at double rates once the prompt reaches 200K tokens', () => {
    delete process.env.PI_GROK_CLI_MODELS;
    const models = resolveModels();

    for (const id of [
      'grok-build',
      'grok-4.3',
      'grok-4.5',
      'grok-4.6',
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-multi-agent-0309',
    ]) {
      const cost = models.find((model) => model.id === id)?.cost;
      expect(cost?.tiers).toEqual([
        {
          inputTokensAbove: 199_999,
          input: (cost?.input ?? 0) * 2,
          output: (cost?.output ?? 0) * 2,
          cacheRead: (cost?.cacheRead ?? 0) * 2,
          cacheWrite: (cost?.cacheWrite ?? 0) * 2,
        },
      ]);
    }
    expect(
      models.find((model) => model.id === 'grok-composer-2.5-fast')?.cost.tiers,
    ).toBeUndefined();
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
      'grok-4.7',
      'grok-4.7-build-fast',
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
    for (const [id, cacheRead] of [
      ['grok-4.5', 0.3],
      ['grok-4.6', 0.5],
    ] as const) {
      expect(models.find((model) => model.id === id)).toMatchObject({
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 500_000,
        cost: { input: 2, output: 6, cacheRead, cacheWrite: 0 },
      });
    }
    expect(models.filter((model) => model.id.startsWith('grok-4.7'))).toEqual([
      expect.objectContaining({
        id: 'grok-4.7',
        name: 'Grok 4.7',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 500_000,
        cost: {
          input: 2,
          output: 6,
          cacheRead: 0.5,
          cacheWrite: 0,
          tiers: [{ inputTokensAbove: 199_999, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
        },
        thinkingLevelMap: { xhigh: 'xhigh' },
      }),
      expect.objectContaining({
        id: 'grok-4.7-build-fast',
        name: 'Grok 4.7 Fast',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 500_000,
        cost: {
          input: 4,
          output: 12,
          cacheRead: 1,
          cacheWrite: 0,
          tiers: [{ inputTokensAbove: 199_999, input: 8, output: 24, cacheRead: 2, cacheWrite: 0 }],
        },
        thinkingLevelMap: { xhigh: 'xhigh' },
      }),
    ]);
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
