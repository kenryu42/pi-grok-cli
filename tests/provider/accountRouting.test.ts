import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mutateAccountVault } from '../../src/provider/accountVault.js';
import { useTempHome, writeTestJson } from '../stateTestHelpers.js';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('../../src/auth/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/oauth.js')>()),
  refresh,
}));

const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;
const setupHome = useTempHome();

function deferredRefresh() {
  let resolve = (_value: { access: string; refresh: string; expires: number }) => {};
  const promise = new Promise<{ access: string; refresh: string; expires: number }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startRefresh(accountId?: string) {
  const deferred = deferredRefresh();
  refresh.mockReturnValue(deferred.promise);
  const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');
  const pending = resolveAccountRoute(accountId);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  return { ...deferred, pending };
}

async function saveAccount1(options: { active?: boolean; pending?: boolean } = {}) {
  await mutateAccountVault((vault) => {
    vault.accounts[0].credential = {
      access: 'account-token',
      refresh: 'account-refresh',
      expires: Date.now() + 300_000,
    };
    vault.accounts[0].revision = 1;
    if (options.active) vault.activeAccountId = 'account-1';
    vault.migration.markerInstallPending = options.pending ?? false;
  });
}

beforeEach(() => {
  setupHome();
  delete process.env.GROK_CLI_OAUTH_TOKEN;
  refresh.mockReset();
  writeTestJson(join(process.env.HOME as string, '.pi', 'agent', 'auth.json'), {
    'grok-cli': {
      type: 'oauth',
      access: 'pi-grok-cli-account-vault-v1',
      refresh: 'pi-grok-cli-account-vault-v1',
      expires: Number.MAX_SAFE_INTEGER,
    },
  });
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN;
  else process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
});

describe('account request routing', () => {
  it('routes the environment token without reading a vault account', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    await expect(resolveAccountRoute()).resolves.toMatchObject({
      source: 'environment',
      token: 'environment-token',
    });
  });

  it('selects the first logged-in account when the saved active account is absent', async () => {
    await saveAccount1();
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    await expect(resolveAccountRoute()).resolves.toMatchObject({
      accountId: 'account-1',
      revision: 1,
      source: 'vault',
      token: 'account-token',
    });
  });

  it('blocks vault requests until Pi installs the marker', async () => {
    writeTestJson(join(process.env.HOME as string, '.pi', 'agent', 'auth.json'), {});
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'account-token',
        refresh: 'account-refresh',
        expires: Date.now() + 60_000,
      };
      vault.activeAccountId = 'account-1';
      vault.migration.markerInstallPending = true;
    });
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    await expect(resolveAccountRoute()).rejects.toThrow('run /login');
  });

  it('blocks vault requests after native Pi logout removes the marker', async () => {
    await saveAccount1({ active: true });
    writeTestJson(join(process.env.HOME as string, '.pi', 'agent', 'auth.json'), {});
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    await expect(resolveAccountRoute()).rejects.toThrow('run /login');
  });

  it('unblocks the next request after Pi stores the marker', async () => {
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'account-token',
        refresh: 'account-refresh',
        expires: Date.now() + 300_000,
      };
      vault.activeAccountId = 'account-1';
      vault.migration.markerInstallPending = true;
    });
    writeTestJson(join(process.env.HOME as string, '.pi', 'agent', 'auth.json'), {
      'grok-cli': {
        type: 'oauth',
        access: 'pi-grok-cli-account-vault-v1',
        refresh: 'pi-grok-cli-account-vault-v1',
        expires: Number.MAX_SAFE_INTEGER,
      },
    });
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    await expect(resolveAccountRoute()).resolves.toMatchObject({
      accountId: 'account-1',
      token: 'account-token',
    });
  });

  it('uses the stored OAuth expiry without applying the refresh skew again', async () => {
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'still-valid-token',
        refresh: 'account-refresh',
        expires: Date.now() + 60_000,
      };
      vault.accounts[0].revision = 1;
      vault.activeAccountId = 'account-1';
    });
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    await expect(resolveAccountRoute()).resolves.toMatchObject({ token: 'still-valid-token' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shares one refresh and stores it only for the captured account revision', async () => {
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'expired-token',
        refresh: 'account-refresh',
        expires: 1,
      };
      vault.accounts[0].revision = 3;
      vault.activeAccountId = 'account-1';
    });
    refresh.mockResolvedValue({
      access: 'fresh-token',
      refresh: 'fresh-refresh',
      expires: Date.now() + 300_000,
    });
    const { resolveAccountRoute } = await import('../../src/provider/accountRouting.js');

    const routes = await Promise.all([resolveAccountRoute(), resolveAccountRoute()]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(routes.map((route) => route.token)).toEqual(['fresh-token', 'fresh-token']);
    expect(routes.map((route) => route.revision)).toEqual([4, 4]);
  });

  it('does not overwrite a newer login with a stale refresh result', async () => {
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'expired-token',
        refresh: 'old-refresh',
        expires: 1,
      };
      vault.accounts[0].revision = 3;
      vault.activeAccountId = 'account-1';
    });
    const request = await startRefresh();
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'new-login',
        refresh: 'new-login-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 4;
    });

    request.resolve({
      access: 'stale-refresh',
      refresh: 'stale-refresh-token',
      expires: Date.now() + 300_000,
    });

    await expect(request.pending).resolves.toMatchObject({ token: 'new-login', revision: 4 });
  });

  it('keeps an explicitly requested account after a stale refresh result', async () => {
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'active-token',
        refresh: 'active-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
      vault.accounts.push({
        id: 'work-id',
        slot: 2,
        label: 'Work',
        credential: { access: 'expired-work', refresh: 'old-work-refresh', expires: 1 },
        revision: 3,
      });
      vault.nextSlot = 3;
      vault.activeAccountId = 'account-1';
    });
    const request = await startRefresh('work-id');
    await mutateAccountVault((vault) => {
      const work = vault.accounts.find((account) => account.id === 'work-id');
      if (!work) throw new Error('missing test account');
      work.credential = {
        access: 'new-work-login',
        refresh: 'new-work-refresh',
        expires: Date.now() + 300_000,
      };
      work.revision = 4;
    });

    request.resolve({
      access: 'stale-work-refresh',
      refresh: 'stale-work-refresh-token',
      expires: Date.now() + 300_000,
    });

    await expect(request.pending).resolves.toMatchObject({
      accountId: 'work-id',
      token: 'new-work-login',
      revision: 4,
    });
  });

  it('falls back when the implicitly selected account logs out during refresh', async () => {
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'expired-active',
        refresh: 'expired-active-refresh',
        expires: 1,
      };
      vault.accounts[0].revision = 3;
      vault.accounts.push({
        id: 'work-id',
        slot: 2,
        label: 'Work',
        credential: {
          access: 'work-token',
          refresh: 'work-refresh',
          expires: Date.now() + 300_000,
        },
        revision: 1,
      });
      vault.nextSlot = 3;
      vault.activeAccountId = 'account-1';
    });
    const request = await startRefresh();
    await mutateAccountVault((vault) => {
      delete vault.accounts[0].credential;
      vault.accounts[0].revision = 4;
      vault.activeAccountId = 'work-id';
    });

    request.resolve({
      access: 'stale-active-refresh',
      refresh: 'stale-active-refresh-token',
      expires: Date.now() + 300_000,
    });

    await expect(request.pending).resolves.toMatchObject({
      accountId: 'work-id',
      token: 'work-token',
    });
  });
});
