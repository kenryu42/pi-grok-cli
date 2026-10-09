import type { ModelCost, ModelCostRates } from '@earendil-works/pi-ai';

const LONG_CONTEXT_PROMPT_TOKENS = 200_000;

const withLongContextTier = (rates: ModelCostRates): ModelCost => ({
  ...rates,
  tiers: [
    {
      inputTokensAbove: LONG_CONTEXT_PROMPT_TOKENS - 1,
      input: rates.input * 2,
      output: rates.output * 2,
      cacheRead: rates.cacheRead * 2,
      cacheWrite: rates.cacheWrite * 2,
    },
  ],
});

const COST_BUILD = withLongContextTier({ input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 });
const COST_COMPOSER_FAST = { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 };
const COST_43 = withLongContextTier({ input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 });
const COST_45 = withLongContextTier({ input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 });
const COST_46 = withLongContextTier({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
const COST_47 = withLongContextTier({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
const COST_47_FAST_AT_TWICE_GROK_47 = withLongContextTier({
  input: 4,
  output: 12,
  cacheRead: 1,
  cacheWrite: 0,
});
const COST_420 = withLongContextTier({ input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 });

export interface GrokCliModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  acceptsReasoningEffort: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

const FALLBACK_MODELS: GrokCliModelConfig[] = [
  {
    id: 'grok-composer-2.5-fast',
    name: 'Composer 2.5 Fast (Grok CLI)',
    reasoning: false,
    acceptsReasoningEffort: false,
    input: ['text', 'image'],
    cost: COST_COMPOSER_FAST,
    contextWindow: 200_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    reasoning: true,
    acceptsReasoningEffort: false,
    input: ['text', 'image'],
    cost: COST_BUILD,
    contextWindow: 500_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    reasoning: true,
    acceptsReasoningEffort: true,
    input: ['text', 'image'],
    cost: COST_43,
    contextWindow: 1_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    reasoning: true,
    acceptsReasoningEffort: true,
    input: ['text', 'image'],
    cost: COST_45,
    contextWindow: 500_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    reasoning: true,
    acceptsReasoningEffort: true,
    input: ['text', 'image'],
    cost: COST_46,
    contextWindow: 500_000,
    maxTokens: 30_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  {
    id: 'grok-4.7',
    name: 'Grok 4.7',
    reasoning: true,
    acceptsReasoningEffort: true,
    input: ['text', 'image'],
    cost: COST_47,
    contextWindow: 500_000,
    maxTokens: 30_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  {
    id: 'grok-4.7-build-fast',
    name: 'Grok 4.7 Fast',
    reasoning: true,
    acceptsReasoningEffort: true,
    input: ['text', 'image'],
    cost: COST_47_FAST_AT_TWICE_GROK_47,
    contextWindow: 500_000,
    maxTokens: 30_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 Reasoning',
    reasoning: true,
    acceptsReasoningEffort: false,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20 Non-Reasoning',
    reasoning: false,
    acceptsReasoningEffort: false,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    name: 'Grok 4.20 Multi-Agent',
    reasoning: true,
    acceptsReasoningEffort: true,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
  },
];

const EFFORT_CAPABLE_PREFIXES = [
  'grok-3-mini',
  'grok-4.20-multi-agent',
  'grok-4.3',
  'grok-4.5',
  'grok-4.6',
  'grok-4.7',
];

const normalizedModelName = (modelId: string) =>
  (modelId.split('/').at(-1) ?? modelId).toLowerCase();

const modelConfig = (modelId: string) => {
  const name = normalizedModelName(modelId);
  return resolveModels().find((entry) => entry.id.toLowerCase() === name);
};

export function supportsReasoning(modelId: string): boolean {
  return modelConfig(modelId)?.reasoning ?? true;
}

export function supportsReasoningEffort(modelId: string): boolean {
  return modelConfig(modelId)?.acceptsReasoningEffort ?? false;
}

export function resolveModels(): GrokCliModelConfig[] {
  const env = (process.env.PI_GROK_CLI_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length === 0) return FALLBACK_MODELS;

  const byId = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
  return env.map(
    (id) =>
      byId.get(id) ?? {
        id,
        name: id,
        reasoning: true,
        acceptsReasoningEffort: EFFORT_CAPABLE_PREFIXES.some((prefix) =>
          id.toLowerCase().startsWith(prefix),
        ),
        input: ['text'] as ('text' | 'image')[],
        cost: COST_BUILD,
        contextWindow: 1_000_000,
        maxTokens: 30_000,
      },
  );
}
