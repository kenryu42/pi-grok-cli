import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccountVault, mutateAccountVault } from '../../src/provider/accountVault.js';
import { saveQuotaUsage } from '../../src/provider/quotaCache.js';
import { rememberRequestAccount } from '../../src/provider/requestOwnership.js';
import {
  EXHAUSTED_BALANCE_ERROR,
  ROTATION_CONTINUATION,
  registerExhaustionRotation,
} from '../../src/provider/rotation.js';
import { createSessionAccountSelection } from '../../src/provider/sessionAccountSelection.js';
import {
  acquireFileLock,
  getAccountVaultPath,
  getGrokCliDirectory,
  writeFileAtomic,
} from '../../src/storage.js';
import { deferred, useEnvironmentToken, useTempHome } from '../stateTestHelpers.js';

const setupHome = useTempHome();
const setEnvironmentToken = useEnvironmentToken();

function exhaustedMessage(): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-responses',
    provider: 'grok-cli',
    model: 'grok-build',
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: EXHAUSTED_BALANCE_ERROR,
    timestamp: Date.now(),
  };
}

function extension() {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const sendUserMessage = vi.fn();
  const setModel = vi.fn();
  const appendEntry = vi.fn();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry,
    sendUserMessage,
    setModel,
  } as unknown as ExtensionAPI;
  const selection = createSessionAccountSelection(pi);
  const rotation = registerExhaustionRotation(pi, selection);
  const notify = vi.fn();
  const ctx = {
    model: { provider: 'grok-cli', id: 'grok-build' },
    sessionManager: {
      getSessionId: () => 'session-a',
      getBranch: () => [],
    },
    ui: { notify },
  } as unknown as ExtensionContext;
  return {
    rotation,
    notify,
    appendEntry,
    selection,
    sendUserMessage,
    setModel,
    async emit(event: string, value: unknown = {}) {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
  };
}

async function addLoggedInAccounts() {
  await mutateAccountVault((vault) => {
    vault.accounts[0].credential = {
      access: 'one',
      refresh: 'one-refresh',
      expires: Date.now() + 300_000,
    };
    vault.accounts.push(
      {
        id: 'account-2',
        slot: 2,
        label: 'Work',
        credential: {
          access: 'two',
          refresh: 'two-refresh',
          expires: Date.now() + 300_000,
        },
        revision: 1,
      },
      {
        id: 'account-3',
        slot: 3,
        label: 'Client',
        credential: {
          access: 'three',
          refresh: 'three-refresh',
          expires: Date.now() + 300_000,
        },
        revision: 1,
      },
    );
    vault.nextSlot = 4;
    vault.activeAccountId = 'account-1';
  });
}

async function settleExhaustion(test: ReturnType<typeof extension>, accountId: string) {
  const message = exhaustedMessage();
  rememberRequestAccount(message, accountId);
  await test.emit('message_end', { message });
  await test.emit('agent_settled');
}

beforeEach(() => {
  setupHome();
  setEnvironmentToken();
  vi.useRealTimers();
});

describe('Grok CLI exhaustion rotation', () => {
  it.each([
    'idle',
    'streaming',
  ] as const)('delivers the continuation through Pi when %s after the vault read', async (state) => {
    await addLoggedInAccounts();
    const directory = getGrokCliDirectory();
    const settled = deferred<void>();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.on('agent_settled', () => settled.resolve());
          registerExhaustionRotation(pi);
        },
      ],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, 'test-auth.json'),
      modelsPath: null,
      modelsStorePath: join(directory, 'test-models.json'),
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider('grok-cli', {
      api: 'openai-responses',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-only',
      models: [
        {
          id: 'grok-build',
          name: 'Test Grok',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10000,
          maxTokens: 1000,
        },
      ],
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      model: modelRuntime.getModel('grok-cli', 'grok-build'),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      tools: [],
    });
    const errors = vi.fn();
    await session.bindExtensions({ onError: errors });
    const responses: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    session.agent.streamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        'abort',
        () => stream.end({ ...exhaustedMessage(), stopReason: 'aborted' }),
        { once: true },
      );
      responses.push(stream);
      return stream;
    };
    const finish = (index: number, stopReason: 'stop' | 'error') => {
      const message = {
        ...exhaustedMessage(),
        stopReason,
        errorMessage: stopReason === 'error' ? EXHAUSTED_BALANCE_ERROR : undefined,
      };
      responses[index].push(
        stopReason === 'error'
          ? { type: 'error', reason: 'error', error: message }
          : { type: 'done', reason: 'stop', message },
      );
      responses[index].end(message);
    };
    const release =
      state === 'streaming' ? await acquireFileLock(getAccountVaultPath()) : undefined;
    const prompts = [session.prompt('Original request')];
    try {
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      finish(0, 'error');
      if (state === 'streaming') {
        await settled.promise;
        // Let rotation reach the held vault lock before another turn starts.
        await new Promise<void>((resolve) => setImmediate(resolve));
        prompts.push(session.prompt('Another request during account rotation'));
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        await release?.();
        await prompts[0];
        expect(errors).not.toHaveBeenCalled();
        expect(session.getFollowUpMessages()).toEqual([ROTATION_CONTINUATION]);
        expect(responses).toHaveLength(2);
        finish(1, 'stop');
      }
      const continuationIndex = state === 'streaming' ? 2 : 1;
      await vi.waitFor(() => expect(responses).toHaveLength(continuationIndex + 1));
      finish(continuationIndex, 'stop');
      await Promise.all(prompts);
      await session.waitForIdle();
      expect(errors).not.toHaveBeenCalled();
      expect(session.getFollowUpMessages()).toEqual([]);
      expect(
        session.messages.filter(
          (message) =>
            message.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'text' && part.text === ROTATION_CONTINUATION,
            ),
        ),
      ).toHaveLength(1);
      expect(session.sessionManager.getBranch()).toContainEqual(
        expect.objectContaining({
          type: 'custom',
          customType: 'grok-cli-active-account-v1',
          data: { accountId: 'account-2' },
        }),
      );
    } finally {
      await release?.();
      await session.abort();
      await Promise.allSettled(prompts);
      await session.abort();
      session.dispose();
    }
  });

  it('selects another logged-in account without changing the model provider', async () => {
    await addLoggedInAccounts();
    const test = extension();
    await settleExhaustion(test, 'account-1');

    expect(test.selection.accountId('session-a')).toBe('account-2');
    expect(test.appendEntry).toHaveBeenCalledWith('grok-cli-active-account-v1', {
      accountId: 'account-2',
    });
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
    expect(test.setModel).not.toHaveBeenCalled();
    expect(test.sendUserMessage).toHaveBeenCalledWith(ROTATION_CONTINUATION, {
      deliverAs: 'followUp',
    });
    expect(test.notify).toHaveBeenCalledWith(
      'Grok CLI: “Account 1” exhausted; switched to “Work” and continuing.',
      'info',
    );
  });

  it('attributes an in-flight failure to its captured account after selection changes', async () => {
    await addLoggedInAccounts();
    await mutateAccountVault((vault) => {
      vault.activeAccountId = 'account-3';
    });
    const test = extension();
    await settleExhaustion(test, 'account-1');

    expect(test.selection.accountId('session-a')).toBe('account-2');
    expect((await getAccountVault()).activeAccountId).toBe('account-3');
  });

  it('keeps attempted accounts across extension continuations', async () => {
    await addLoggedInAccounts();
    const test = extension();
    await settleExhaustion(test, 'account-1');
    await settleExhaustion(test, 'account-2');

    expect(test.selection.accountId('session-a')).toBe('account-3');
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
    expect(test.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('reports when all logged-in accounts are exhausted', async () => {
    await addLoggedInAccounts();
    const test = extension();
    for (const id of ['account-1', 'account-2', 'account-3']) {
      await settleExhaustion(test, id);
    }

    expect(test.notify).toHaveBeenLastCalledWith(
      'Grok CLI: all logged-in accounts are exhausted.',
      'warning',
    );
  });

  it('lets a successful login clear one recent exhaustion record', async () => {
    await addLoggedInAccounts();
    const test = extension();
    await settleExhaustion(test, 'account-1');
    test.rotation.clearRecentExhaustion('account-1');
    await settleExhaustion(test, 'account-2');

    expect(test.selection.accountId('session-a')).toBe('account-3');
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
  });

  it('does not rotate saved accounts when an environment token is active', async () => {
    setEnvironmentToken('environment-token');
    await addLoggedInAccounts();
    const test = extension();

    await settleExhaustion(test, 'account-1');

    expect((await getAccountVault()).activeAccountId).toBe('account-1');
    expect(test.sendUserMessage).not.toHaveBeenCalled();
    expect(test.notify).not.toHaveBeenCalled();
  });

  it('prefers the eligible account with the most weekly quota remaining', async () => {
    await addLoggedInAccounts();
    const updatedAt = new Date(Date.now() - 60_000).toISOString();
    await saveQuotaUsage(
      'account-2',
      {
        monthly: {
          monthlyLimit: 0,
          used: 0,
          billingPeriodEnd: '2026-08-25T00:00:00.000Z',
        },
        weekly: {
          creditUsagePercent: 90,
          billingPeriodEnd: '2026-08-18T00:00:00.000Z',
        },
      },
      updatedAt,
    );
    await saveQuotaUsage(
      'account-3',
      {
        monthly: {
          monthlyLimit: 0,
          used: 0,
          billingPeriodEnd: '2026-08-25T00:00:00.000Z',
        },
        weekly: {
          creditUsagePercent: 10,
          billingPeriodEnd: '2026-08-18T00:00:00.000Z',
        },
      },
      updatedAt,
    );
    const test = extension();
    await settleExhaustion(test, 'account-1');

    expect(test.selection.accountId('session-a')).toBe('account-3');
  });

  it('selects another candidate when the first candidate is removed before commit', async () => {
    await addLoggedInAccounts();
    const test = extension();
    const message = exhaustedMessage();
    rememberRequestAccount(message, 'account-1');
    await test.emit('message_end', { message });
    const release = await acquireFileLock(getAccountVaultPath());
    const pending = test.emit('agent_settled');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const vault = JSON.parse(readFileSync(getAccountVaultPath(), 'utf8')) as Awaited<
      ReturnType<typeof getAccountVault>
    >;
    vault.accounts = vault.accounts.filter((account) => account.id !== 'account-2');
    writeFileAtomic(getAccountVaultPath(), `${JSON.stringify(vault, null, 2)}\n`, 0o600);
    await release();

    await expect(pending).resolves.toBeUndefined();
    expect(test.selection.accountId('session-a')).toBe('account-3');
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
    expect(test.sendUserMessage).toHaveBeenCalledWith(ROTATION_CONTINUATION, {
      deliverAs: 'followUp',
    });
  });
});
