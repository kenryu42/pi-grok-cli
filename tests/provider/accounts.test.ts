import { EventEmitter } from 'node:events';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROK_CLI_PROVIDER,
  isGrokCliProvider,
  registerAccountManagement,
  resolveGrokToken,
} from '../../src/provider/accounts.js';
import { getAccountVault, mutateAccountVault } from '../../src/provider/accountVault.js';
import { loadQuotaCache, saveQuotaUsage } from '../../src/provider/quotaCache.js';
import {
  deferred,
  oauthCredential,
  setAccount1Credential,
  useEnvironmentToken,
  useTempHome,
  writePiCredential,
  writePiVaultMarker,
} from '../stateTestHelpers.js';

const { fetchBillingUsage, login, removeQuotaUsage, spawnProcess } = vi.hoisted(() => ({
  fetchBillingUsage: vi.fn(),
  login: vi.fn(),
  removeQuotaUsage: vi.fn(),
  spawnProcess: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnProcess }));

vi.mock('../../src/auth/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/oauth.js')>()),
  login,
}));

vi.mock('../../src/provider/billing.js', () => ({ fetchBillingUsage }));

vi.mock('../../src/provider/quotaCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/provider/quotaCache.js')>()),
  removeQuotaUsage,
}));

const setupHome = useTempHome();
const setEnvironmentToken = useEnvironmentToken();

const ctx = {
  sessionManager: {
    getSessionId: () => 'session-a',
    getBranch: () => [],
  },
  ui: {
    notify: vi.fn(),
  },
} as unknown as ExtensionContext;

const interaction = {
  notify: vi.fn(),
  prompt: vi.fn(),
} satisfies AuthInteraction;

function manager(clearRecentExhaustion = (_accountId: string) => {}, appendEntry = vi.fn()) {
  return registerAccountManagement(
    {
      appendEntry,
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI,
    clearRecentExhaustion,
  ).manager;
}

async function addLoggedInAccount(accounts: ReturnType<typeof manager>) {
  const account = await accounts.add(ctx, 'Work');
  await mutateAccountVault((vault) => {
    vault.accounts[1].credential = {
      access: 'two',
      refresh: 'two-refresh',
      expires: Date.now() + 300_000,
    };
    vault.accounts[1].revision = 1;
  });
  return account;
}

async function selectedLoggedInAccount() {
  await setAccount1Credential('one');
  const appendEntry = vi.fn();
  const accounts = manager(undefined, appendEntry);
  const account = await addLoggedInAccount(accounts);
  await accounts.activate(ctx, account.id);
  return { account, accounts, appendEntry };
}

beforeEach(() => {
  setupHome();
  setEnvironmentToken(undefined);
  login.mockReset();
  removeQuotaUsage.mockReset();
  removeQuotaUsage.mockResolvedValue(undefined);
  fetchBillingUsage.mockReset();
  fetchBillingUsage.mockResolvedValue({
    monthly: {
      monthlyLimit: 2000,
      used: 100,
      billingPeriodEnd: '2026-08-01T00:00:00.000Z',
    },
  });
  spawnProcess.mockReset();
  login.mockResolvedValue({
    access: 'new-access',
    refresh: 'new-refresh',
    expires: Date.now() + 300_000,
  });
});

describe('Grok provider identity', () => {
  it('accepts only the single Grok CLI provider', () => {
    expect(GROK_CLI_PROVIDER).toBe('grok-cli');
    expect(isGrokCliProvider('grok-cli')).toBe(true);
    expect(isGrokCliProvider('grok-cli-2')).toBe(false);
  });

  it('exposes the subscription tier from the cached quota', async () => {
    await saveQuotaUsage(
      'account-1',
      {
        tier: 'X Premium',
        monthly: {
          monthlyLimit: 0,
          used: 0,
          billingPeriodEnd: '2026-09-01T00:00:00.000Z',
        },
        weekly: {
          creditUsagePercent: 0,
          billingPeriodEnd: '2026-08-18T00:00:00.000Z',
        },
      },
      '2026-08-13T04:38:36.000Z',
    );

    expect(manager().snapshot(ctx).accounts[0]).toMatchObject({ tier: 'X Premium' });
  });
});

describe('vault account management', () => {
  it('adds an account with an opaque stable ID and increasing display slot', async () => {
    const accounts = manager();

    const account = await accounts.add(ctx, 'Work');

    expect(account).toMatchObject({ slot: 2, label: 'Work', revision: 0 });
    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(getAccountVault()).resolves.toMatchObject({
      nextSlot: 3,
      accounts: [{ id: 'account-1' }, { id: account.id, slot: 2, label: 'Work' }],
    });
  });

  it('logs in directly and preserves the account identity, slot, and label', async () => {
    const accounts = manager();
    const account = await accounts.add(ctx, 'Work');

    await accounts.login(ctx, account.id, interaction);

    expect(login).toHaveBeenCalledOnce();
    await expect(getAccountVault()).resolves.toMatchObject({
      activeAccountId: account.id,
      accounts: [
        { id: 'account-1', slot: 1, label: 'Account 1' },
        {
          id: account.id,
          slot: 2,
          label: 'Work',
          revision: 1,
          credential: { access: 'new-access', refresh: 'new-refresh' },
        },
      ],
    });
  });

  it('does not restore an account after logout completes during login', async () => {
    const accounts = manager();
    const account = await accounts.add(ctx, 'Work');
    const authorization = deferred<ReturnType<typeof oauthCredential>>();
    login.mockReturnValueOnce(authorization.promise);

    const pending = accounts.login(ctx, account.id, interaction);
    await accounts.logout(ctx, account.id);
    authorization.resolve(oauthCredential('late-login'));

    await expect(pending).rejects.toThrow('account changed while login was in progress');
    expect((await getAccountVault()).accounts[1]).toMatchObject({ revision: 1 });
    expect((await getAccountVault()).accounts[1].credential).toBeUndefined();
  });

  it('keeps a successful login when quota-cache cleanup fails', async () => {
    const accounts = manager();
    const account = await accounts.add(ctx, 'Work');
    removeQuotaUsage.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(accounts.login(ctx, account.id, interaction)).resolves.toMatchObject({
      id: account.id,
    });

    expect((await getAccountVault()).accounts[1].credential?.access).toBe('new-access');
  });

  it('clears recent exhaustion after direct account login succeeds', async () => {
    const clearRecentExhaustion = vi.fn();
    const accounts = manager(clearRecentExhaustion);
    const account = await accounts.add(ctx, 'Work');

    await accounts.login(ctx, account.id, interaction);

    expect(clearRecentExhaustion).toHaveBeenCalledWith(account.id);
  });

  it('rejects activation for a logged-out account', async () => {
    const accounts = manager();
    const account = await accounts.add(ctx, 'Work');

    await expect(accounts.activate(ctx, account.id)).rejects.toThrow('before making it active');
  });

  it('activates an account only for the current Pi session', async () => {
    const test = await selectedLoggedInAccount();

    expect(test.appendEntry).toHaveBeenCalledWith('grok-cli-active-account-v1', {
      accountId: test.account.id,
    });
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
    expect(test.accounts.snapshot(ctx).accounts[1]).toMatchObject({ active: true });
  });

  it('selects another logged-in account when the active account logs out', async () => {
    await setAccount1Credential('one');
    const accounts = manager();
    const account = await addLoggedInAccount(accounts);
    await mutateAccountVault((vault) => {
      vault.activeAccountId = account.id;
    });

    await accounts.logout(ctx, account.id);

    await expect(getAccountVault()).resolves.toMatchObject({
      activeAccountId: 'account-1',
      accounts: [
        { id: 'account-1', credential: { access: 'one' } },
        { id: account.id, revision: 2 },
      ],
    });
    expect((await getAccountVault()).accounts[1].credential).toBeUndefined();
  });

  it('persists another logged-in account when the selected session account logs out', async () => {
    const test = await selectedLoggedInAccount();
    test.appendEntry.mockClear();

    await test.accounts.logout(ctx, test.account.id);

    expect(test.appendEntry).toHaveBeenCalledWith('grok-cli-active-account-v1', {
      accountId: 'account-1',
    });
    expect(test.accounts.snapshot(ctx).accounts[0]).toMatchObject({ active: true });
  });

  it('removes the final active selection when the final login logs out', async () => {
    await setAccount1Credential('one');

    const result = await manager().logout(ctx, 'account-1');

    expect((await getAccountVault()).activeAccountId).toBeUndefined();
    expect(result.warning).toContain('/logout');
  });

  it('keeps Account 1 permanent and removes another account', async () => {
    const accounts = manager();
    const extra = await accounts.add(ctx, 'Work');

    await expect(accounts.remove(ctx, 'account-1')).rejects.toThrow('cannot be removed');
    await accounts.remove(ctx, extra.id);

    expect((await getAccountVault()).accounts.map((account) => account.id)).toEqual(['account-1']);
  });

  it('shows contiguous account numbers after an earlier account is removed', async () => {
    const accounts = manager();
    const removed = await accounts.add(ctx, '');
    const remaining = await accounts.add(ctx, '');

    await accounts.remove(ctx, removed.id);

    expect(accounts.snapshot(ctx).accounts).toMatchObject([
      { id: 'account-1', slot: 1, label: 'Account 1' },
      { id: remaining.id, slot: 2, label: 'Account 2' },
    ]);
    expect((await getAccountVault()).accounts[1]).toMatchObject({
      id: remaining.id,
      slot: 3,
      label: 'Account 3',
    });
  });

  it('hides logout state for a logged-out Account 1 snapshot', () => {
    const snapshot = manager().snapshot(ctx).accounts[0];

    expect(snapshot).toMatchObject({
      id: 'account-1',
      permanent: true,
      authenticated: false,
      active: false,
      status: 'Login required',
    });
  });

  it('uses the environment token without exposing a vault credential', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';

    expect(await resolveGrokToken()).toBe('environment-token');
    expect(manager().snapshot(ctx).accounts[0]).toMatchObject({
      environment: true,
      authenticated: true,
      active: true,
    });
    await expect(manager().login(ctx, 'account-1', interaction)).rejects.toThrow(
      'Unset GROK_CLI_OAUTH_TOKEN',
    );
  });

  it('reports Pi connected only after Pi stores the vault marker', () => {
    writePiCredential({
      access: 'released-access',
      refresh: 'released-refresh',
      expires: Date.now() + 300_000,
    });
    expect(manager().snapshot(ctx).connected).toBe(false);

    writePiVaultMarker();
    expect(manager().snapshot(ctx).connected).toBe(true);
  });

  it('rejects saved-account activation while the environment token is active', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';
    const accounts = manager();
    const account = await accounts.add(ctx, 'Work');
    await mutateAccountVault((vault) => {
      vault.accounts[1].credential = {
        access: 'work',
        refresh: 'work-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[1].revision = 1;
    });

    await expect(accounts.activate(ctx, account.id)).rejects.toThrow('environment token');
  });

  it('reports the authorization URL when the browser opener fails', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnProcess.mockReturnValue(child);
    login.mockImplementationOnce(async (callbacks) => {
      callbacks.onAuth({ url: 'https://accounts.x.ai/authorize?state=test' });
      child.emit('error', new Error('xdg-open missing'));
      throw new Error('stop test login');
    });
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionCommandContext) => unknown }
    >();
    registerAccountManagement({
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => unknown },
      ) {
        commands.set(name, command);
      },
    } as unknown as ExtensionAPI);
    const commandContext = {
      sessionManager: {
        getSessionId: () => 'session-a',
        getBranch: () => [],
      },
      ui: {
        input: vi.fn().mockResolvedValue('Work'),
        notify: vi.fn(),
        select: vi.fn().mockResolvedValue('Add account'),
      },
    } as unknown as ExtensionCommandContext;

    await commands.get('grok-cli-accounts')?.handler('', commandContext);

    expect(commandContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('https://accounts.x.ai/authorize?state=test'),
      'warning',
    );
  });

  it('does not save quota after the captured account logs out', async () => {
    writePiVaultMarker();
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'one',
        refresh: 'one-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
      vault.activeAccountId = 'account-1';
    });
    let finishBilling = (_usage: Awaited<ReturnType<typeof fetchBillingUsage>>) => {};
    fetchBillingUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBilling = resolve;
        }),
    );
    const accounts = manager();
    const pending = accounts.refreshOne(ctx, 'account-1', new AbortController().signal);
    await vi.waitFor(() => expect(fetchBillingUsage).toHaveBeenCalledOnce());
    await accounts.logout(ctx, 'account-1');

    finishBilling({
      monthly: {
        monthlyLimit: 2000,
        used: 100,
        billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      },
    });

    await expect(pending).resolves.toEqual({ updated: 0, failed: ['account-1'] });
    expect(loadQuotaCache().accounts['account-1']).toBeUndefined();
  });

  it('refreshes at most three account quotas at one time', async () => {
    writePiVaultMarker();
    await mutateAccountVault((vault) => {
      vault.accounts = Array.from({ length: 7 }, (_value, index) => ({
        id: index === 0 ? 'account-1' : `account-${index + 1}`,
        slot: index + 1,
        label: `Account ${index + 1}`,
        credential: {
          access: `access-${index + 1}`,
          refresh: `refresh-${index + 1}`,
          expires: Date.now() + 300_000,
        },
        revision: 1,
      }));
      vault.nextSlot = 8;
      vault.activeAccountId = 'account-1';
    });
    let active = 0;
    let maximum = 0;
    fetchBillingUsage.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      return {
        monthly: {
          monthlyLimit: 2000,
          used: 100,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      };
    });

    await expect(manager().refresh(ctx, new AbortController().signal)).resolves.toEqual({
      updated: 7,
      failed: [],
    });
    expect(maximum).toBeLessThanOrEqual(3);
  });
});
