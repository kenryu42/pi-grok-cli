import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import type { BillingUsage } from '../../src/provider/billing.js';
import { saveQuotaUsage } from '../../src/provider/quotaCache.js';
import {
  EXHAUSTED_BALANCE_ERROR,
  ROTATION_CONTINUATION,
  registerExhaustionRotation,
} from '../../src/provider/rotation.js';
import { useTempHome } from '../vision/helpers.js';

const setupHome = useTempHome();
const THREE_ACCOUNTS = [
  { provider: 'grok-cli', label: 'Personal' },
  { provider: 'grok-cli-2', label: 'Work' },
  { provider: 'grok-cli-3', label: 'Client' },
];
const FOUR_ACCOUNTS = [...THREE_ACCOUNTS, { provider: 'grok-cli-4', label: 'Reserve' }];
const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

function usage(monthlyRemaining: number, weeklyRemaining?: number): BillingUsage {
  return {
    monthly: {
      monthlyLimit: 100,
      used: 100 - monthlyRemaining,
      billingPeriodEnd: '2026-08-01T00:00:00.000Z',
    },
    ...(weeklyRemaining === undefined
      ? {}
      : {
          weekly: {
            creditUsagePercent: 100 - weeklyRemaining,
            billingPeriodEnd: '2026-07-20T00:00:00.000Z',
          },
        }),
  };
}

function setup(
  options: {
    accounts?: { provider: string; label: string }[];
    auth?: string[];
    current?: { provider: string; id: string };
    missingModels?: string[];
    setModel?: boolean[];
  } = {},
) {
  setupHome();
  const accounts = options.accounts ?? [
    { provider: 'grok-cli', label: 'Personal' },
    { provider: 'grok-cli-2', label: 'Work' },
  ];
  saveConfig({
    ...DEFAULT_CONFIG,
    accounts: {
      nextAccountNumber: accounts.length + 1,
      selectedProvider: options.current?.provider ?? 'grok-cli',
      items: accounts,
    },
  });
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const authenticated = new Set(options.auth ?? accounts.map((account) => account.provider));
  const model = options.current ?? { provider: 'grok-cli', id: 'grok-build' };
  const context = {
    model: { ...model },
    modelRegistry: {
      getProviderAuthStatus: (provider: string) => ({ configured: authenticated.has(provider) }),
      find: (provider: string, id: string) =>
        options.missingModels?.includes(`${provider}/${id}`) ? undefined : { provider, id },
    },
    ui: { notify: vi.fn() },
  };
  const setModelResults = [...(options.setModel ?? [])];
  const setModel = vi.fn(async (nextModel: { provider: string; id: string }) => {
    const result = setModelResults.shift() ?? true;
    if (result) context.model = nextModel;
    return result;
  });
  const sendUserMessage = vi.fn();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage,
    setModel,
  } as unknown as ExtensionAPI;
  const rotation = registerExhaustionRotation(pi);

  return {
    context,
    handlers,
    notify: context.ui.notify,
    sendUserMessage,
    setModel,
    rotation,
    async emit(event: string, data: unknown = { type: event }) {
      for (const handler of handlers.get(event) ?? []) await handler(data, context);
    },
  };
}

function assistant(
  provider: string,
  errorMessage = EXHAUSTED_BALANCE_ERROR,
  model = 'grok-build',
  stopReason = 'error',
) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      provider,
      model,
      stopReason,
      errorMessage,
    },
  };
}

async function settleExhaustion(extension: ReturnType<typeof setup>, provider: string) {
  await extension.emit('message_end', assistant(provider));
  await extension.emit('agent_settled');
}

async function emitExtensionContinuation(extension: ReturnType<typeof setup>) {
  await extension.emit('input', {
    type: 'input',
    source: 'extension',
    text: ROTATION_CONTINUATION,
  });
}

function switchedProviders(extension: ReturnType<typeof setup>) {
  return extension.setModel.mock.calls.map(([model]) => model.provider);
}

async function setupAfterSuccessfulContinuation() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const extension = setup();
  await settleExhaustion(extension, 'grok-cli');
  await emitExtensionContinuation(extension);
  await extension.emit('message_end', assistant('grok-cli-2', '', 'grok-build', 'stop'));
  await extension.emit('agent_settled');
  return extension;
}

describe('Grok CLI exhaustion rotation', () => {
  it('switches only after agent_settled, preserves the model, and continues once', async () => {
    const extension = setup({ current: { provider: 'grok-cli', id: 'grok-composer-2.5-fast' } });

    await extension.emit(
      'message_end',
      assistant('grok-cli', EXHAUSTED_BALANCE_ERROR, 'grok-composer-2.5-fast'),
    );

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.sendUserMessage).not.toHaveBeenCalled();

    await extension.emit('agent_settled');

    expect(extension.setModel).toHaveBeenCalledOnce();
    expect(extension.setModel).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      id: 'grok-composer-2.5-fast',
    });
    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli-2');
    expect(extension.notify).toHaveBeenCalledWith(
      'Grok CLI: “Personal” exhausted; switched to “Work” and continuing.',
      'info',
    );
    expect(extension.sendUserMessage).toHaveBeenCalledOnce();
    expect(extension.sendUserMessage).toHaveBeenCalledWith(ROTATION_CONTINUATION);
  });

  it.each([
    ['near match', 'OpenAI API error (402): 402 "Grok Build usage balance exhausted".'],
    ['other 402', 'OpenAI API error (402): payment required'],
    ['401', 'OpenAI API error (401): unauthorized'],
    ['429', 'OpenAI API error (429): rate limited'],
  ])('ignores %s errors', async (_name, errorMessage) => {
    const extension = setup();

    await extension.emit('message_end', assistant('grok-cli', errorMessage));
    await extension.emit('agent_settled');

    expect(extension.setModel).not.toHaveBeenCalled();
  });

  it('ignores non-Grok providers and non-error assistant messages', async () => {
    const extension = setup();

    await extension.emit('message_end', assistant('openai', EXHAUSTED_BALANCE_ERROR));
    await extension.emit(
      'message_end',
      assistant('grok-cli', EXHAUSTED_BALANCE_ERROR, 'grok-build', 'stop'),
    );
    await extension.emit('agent_settled');

    expect(extension.setModel).not.toHaveBeenCalled();
  });

  it('uses circular account order and skips login-required accounts', async () => {
    const extension = setup({
      accounts: THREE_ACCOUNTS,
      auth: ['grok-cli-2', 'grok-cli-3'],
      current: { provider: 'grok-cli-3', id: 'grok-composer-2.5-fast' },
    });

    await extension.emit(
      'message_end',
      assistant('grok-cli-3', EXHAUSTED_BALANCE_ERROR, 'grok-composer-2.5-fast'),
    );
    await extension.emit('agent_settled');

    expect(extension.setModel).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      id: 'grok-composer-2.5-fast',
    });
  });

  it('skips failed setModel candidates and falls back to grok-build when needed', async () => {
    const extension = setup({
      accounts: THREE_ACCOUNTS,
      current: { provider: 'grok-cli', id: 'grok-composer-2.5-fast' },
      missingModels: ['grok-cli-3/grok-composer-2.5-fast'],
      setModel: [false, true],
    });

    await extension.emit(
      'message_end',
      assistant('grok-cli', EXHAUSTED_BALANCE_ERROR, 'grok-composer-2.5-fast'),
    );
    await extension.emit('agent_settled');

    expect(extension.setModel.mock.calls).toEqual([
      [{ provider: 'grok-cli-2', id: 'grok-composer-2.5-fast' }],
      [{ provider: 'grok-cli-3', id: 'grok-build' }],
    ]);
    expect(extension.sendUserMessage).toHaveBeenCalledOnce();
  });

  it('preserves attempted accounts across extension continuations and stops without wrapping', async () => {
    const extension = setup({
      accounts: THREE_ACCOUNTS,
    });

    await settleExhaustion(extension, 'grok-cli');
    await emitExtensionContinuation(extension);
    await settleExhaustion(extension, 'grok-cli-2');
    await emitExtensionContinuation(extension);
    await settleExhaustion(extension, 'grok-cli-3');
    await extension.emit('agent_settled');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli-3']);
    expect(extension.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(extension.notify).toHaveBeenCalledWith(
      'Grok CLI: all logged-in accounts are exhausted.',
      'warning',
    );
  });

  it('keeps recently exhausted accounts unavailable across new real user input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const extension = setup();

    await settleExhaustion(extension, 'grok-cli');
    await extension.emit('input', { type: 'input', source: 'interactive', text: 'try again' });
    await settleExhaustion(extension, 'grok-cli-2');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2']);
    expect(extension.notify).toHaveBeenCalledWith(
      'Grok CLI: all logged-in accounts are exhausted.',
      'warning',
    );
  });

  it('keeps recently exhausted accounts unavailable after a successful continuation', async () => {
    const extension = await setupAfterSuccessfulContinuation();
    await extension.emit('message_end', assistant('grok-cli-2'));
    await extension.emit('agent_settled');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2']);
  });

  it('makes an account eligible again exactly five minutes after exhaustion', async () => {
    const extension = await setupAfterSuccessfulContinuation();
    vi.setSystemTime(NOW + 5 * 60_000);
    await settleExhaustion(extension, 'grok-cli-2');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli']);
  });

  it('clears recent exhaustion when a new session starts', async () => {
    const extension = await setupAfterSuccessfulContinuation();
    await extension.emit('session_start');
    await settleExhaustion(extension, 'grok-cli-2');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli']);
  });

  it('allows successful login to clear one account’s recent exhaustion', async () => {
    const extension = await setupAfterSuccessfulContinuation();
    extension.rotation.clearRecentExhaustion('grok-cli');
    await settleExhaustion(extension, 'grok-cli-2');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli']);
  });

  it('orders fresh cached quota by the tightest remaining window without fetching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const extension = setup({ accounts: THREE_ACCOUNTS });
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    await saveQuotaUsage('grok-cli-2', usage(90, 10), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-3', usage(50), new Date(NOW).toISOString());

    await settleExhaustion(extension, 'grok-cli');

    expect(switchedProviders(extension)).toEqual(['grok-cli-3']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues through missing models and failed switches in quota-ranked order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const extension = setup({
      accounts: FOUR_ACCOUNTS,
      current: { provider: 'grok-cli', id: 'grok-composer-2.5-fast' },
      missingModels: ['grok-cli-3/grok-composer-2.5-fast', 'grok-cli-3/grok-build'],
      setModel: [false, true],
    });
    await saveQuotaUsage('grok-cli-2', usage(50), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-3', usage(90), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-4', usage(70), new Date(NOW).toISOString());

    await extension.emit(
      'message_end',
      assistant('grok-cli', EXHAUSTED_BALANCE_ERROR, 'grok-composer-2.5-fast'),
    );
    await extension.emit('agent_settled');

    expect(extension.setModel.mock.calls).toEqual([
      [{ provider: 'grok-cli-4', id: 'grok-composer-2.5-fast' }],
      [{ provider: 'grok-cli-2', id: 'grok-composer-2.5-fast' }],
    ]);
    expect(extension.sendUserMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined],
    ['stale', new Date(NOW - 30 * 60_000).toISOString()],
    ['invalid', new Date(NOW).toISOString()],
  ])('keeps a %s quota candidate in its circular slot', async (_name, updatedAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const extension = setup({ accounts: FOUR_ACCOUNTS, setModel: [false, true] });
    if (updatedAt) {
      await saveQuotaUsage(
        'grok-cli-2',
        updatedAt === new Date(NOW).toISOString()
          ? {
              monthly: {
                monthlyLimit: 0,
                used: 0,
                billingPeriodEnd: '2026-08-01T00:00:00.000Z',
              },
            }
          : usage(50),
        updatedAt,
      );
    }
    await saveQuotaUsage('grok-cli-3', usage(20), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-4', usage(80), new Date(NOW).toISOString());

    await settleExhaustion(extension, 'grok-cli');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli-4']);
  });

  it('preserves circular order when fresh quota scores tie', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const extension = setup({ accounts: THREE_ACCOUNTS });
    await saveQuotaUsage('grok-cli-2', usage(60, 40), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-3', usage(40), new Date(NOW).toISOString());

    await settleExhaustion(extension, 'grok-cli');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2']);
  });

  it('excludes a recently exhausted account even when it has the best cached quota', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const extension = setup({
      accounts: THREE_ACCOUNTS,
      current: { provider: 'grok-cli-2', id: 'grok-build' },
    });
    await saveQuotaUsage('grok-cli', usage(10), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-2', usage(95), new Date(NOW).toISOString());
    await saveQuotaUsage('grok-cli-3', usage(20), new Date(NOW).toISOString());

    await settleExhaustion(extension, 'grok-cli-2');
    await emitExtensionContinuation(extension);
    await extension.emit('message_end', assistant('grok-cli-3', '', 'grok-build', 'stop'));
    await extension.emit('agent_settled');
    extension.context.model = { provider: 'grok-cli', id: 'grok-build' };
    await settleExhaustion(extension, 'grok-cli');

    expect(switchedProviders(extension)).toEqual(['grok-cli-3', 'grok-cli-3']);
  });

  it('cancels a pending rotation after a manual model change', async () => {
    const extension = setup();

    await extension.emit('message_end', assistant('grok-cli'));
    await extension.emit('model_select', {
      type: 'model_select',
      model: { provider: 'openai', id: 'gpt-5' },
    });
    await extension.emit('model_select', {
      type: 'model_select',
      model: { provider: 'grok-cli', id: 'grok-build' },
    });
    await extension.emit('agent_settled');

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.sendUserMessage).not.toHaveBeenCalled();
  });
});
