import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mutateAccountVault } from '../../src/provider/accountVault.js';
import {
  createSessionAccountSelection,
  SESSION_ACCOUNT_ENTRY,
} from '../../src/provider/sessionAccountSelection.js';
import { useTempHome } from '../stateTestHelpers.js';

const setupHome = useTempHome();

function context(sessionId: string, accountIds: string[] = []) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () =>
        accountIds.map((accountId, index) => ({
          type: 'custom',
          id: `entry-${index}`,
          parentId: index ? `entry-${index - 1}` : null,
          timestamp: new Date(index).toISOString(),
          customType: SESSION_ACCOUNT_ENTRY,
          data: { accountId },
        })),
    },
  } as unknown as ExtensionContext;
}

beforeEach(async () => {
  setupHome();
  await mutateAccountVault((vault) => {
    vault.accounts[0].credential = {
      access: 'one',
      refresh: 'one-refresh',
      expires: Date.now() + 300_000,
    };
    vault.accounts.push({
      id: 'work-id',
      slot: 2,
      label: 'Work',
      credential: {
        access: 'two',
        refresh: 'two-refresh',
        expires: Date.now() + 300_000,
      },
      revision: 1,
    });
    vault.nextSlot = 3;
    vault.activeAccountId = 'account-1';
  });
});

describe('Pi session account selection', () => {
  it('keeps account selections independent for two sessions', () => {
    const appendEntry = vi.fn();
    const selection = createSessionAccountSelection({ appendEntry } as unknown as ExtensionAPI);
    const first = context('session-a');
    const second = context('session-b');

    selection.restore(first);
    selection.restore(second);
    selection.select(first, 'work-id');

    expect(selection.accountId('session-a')).toBe('work-id');
    expect(selection.accountId('session-b')).toBe('account-1');
    expect(appendEntry).toHaveBeenCalledWith(SESSION_ACCOUNT_ENTRY, { accountId: 'work-id' });
  });

  it('restores the last account selection on the active session branch', () => {
    const selection = createSessionAccountSelection({
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI);

    expect(selection.restore(context('session-a', ['account-1', 'work-id']))).toBe('work-id');
    expect(selection.accountId('session-a')).toBe('work-id');
  });

  it('returns another logged-in account when a stored selection is no longer valid', () => {
    const selection = createSessionAccountSelection({
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI);

    expect(selection.restore(context('session-a', ['removed-id']))).toBe('account-1');
    expect(selection.accountId('session-a')).toBe('account-1');
  });
});
