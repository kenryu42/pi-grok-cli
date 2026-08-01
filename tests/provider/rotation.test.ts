import { readFileSync } from 'node:fs';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccountVault, mutateAccountVault } from '../../src/provider/accountVault.js';
import { rememberRequestAccount } from '../../src/provider/requestOwnership.js';
import {
  EXHAUSTED_BALANCE_ERROR,
  ROTATION_CONTINUATION,
  registerExhaustionRotation,
} from '../../src/provider/rotation.js';
import { createSessionAccountSelection } from '../../src/provider/sessionAccountSelection.js';
import { acquireFileLock, getAccountVaultPath, writeFileAtomic } from '../../src/storage.js';
import { useEnvironmentToken, useTempHome } from '../stateTestHelpers.js';

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
    expect(test.sendUserMessage).toHaveBeenCalledWith(ROTATION_CONTINUATION);
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
    expect(test.sendUserMessage).toHaveBeenCalledWith(ROTATION_CONTINUATION);
  });
});
