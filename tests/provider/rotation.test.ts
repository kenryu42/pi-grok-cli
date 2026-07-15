import { AuthStorage, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import {
  EXHAUSTED_BALANCE_ERROR,
  ROTATION_CONTINUATION,
  registerExhaustionRotation,
} from '../../src/provider/rotation.js';
import { oauthCredential, useTempHome } from '../vision/helpers.js';

const setupHome = useTempHome();
const THREE_ACCOUNTS = [
  { provider: 'grok-cli', label: 'Personal' },
  { provider: 'grok-cli-2', label: 'Work' },
  { provider: 'grok-cli-3', label: 'Client' },
];

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
  const authStorage = AuthStorage.inMemory(
    Object.fromEntries(
      (options.auth ?? accounts.map((account) => account.provider)).map((provider) => [
        provider,
        oauthCredential(`${provider}-token`),
      ]),
    ),
  );
  const model = options.current ?? { provider: 'grok-cli', id: 'grok-build' };
  const context = {
    model: { ...model },
    modelRegistry: {
      authStorage,
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
  registerExhaustionRotation(pi);

  return {
    context,
    handlers,
    notify: context.ui.notify,
    sendUserMessage,
    setModel,
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

  it('starts a fresh chain for new real user input', async () => {
    const extension = setup();

    await settleExhaustion(extension, 'grok-cli');
    await extension.emit('input', { type: 'input', source: 'interactive', text: 'try again' });
    await settleExhaustion(extension, 'grok-cli-2');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli']);
  });

  it('clears the chain after the continuation settles successfully', async () => {
    const extension = setup();

    await settleExhaustion(extension, 'grok-cli');
    await emitExtensionContinuation(extension);
    await extension.emit('message_end', assistant('grok-cli-2', '', 'grok-build', 'stop'));
    await extension.emit('agent_settled');
    await extension.emit('message_end', assistant('grok-cli-2'));
    await extension.emit('agent_settled');

    expect(switchedProviders(extension)).toEqual(['grok-cli-2', 'grok-cli']);
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
