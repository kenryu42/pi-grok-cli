import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AuthInteraction, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent';
import * as oauth from '../auth/oauth.js';
import { hasTerminalControlCharacters } from '../config.js';
import { confirmMarkerInstallation } from './accountMigration.js';
import { type AccountRoute, resolveAccountRoute } from './accountRouting.js';
import {
  ACCOUNT_1_ID,
  ACCOUNT_VAULT_MARKER,
  type AccountCredential,
  getAccountVaultSync,
  mutateAccountVault,
  type VaultAccount,
} from './accountVault.js';
import { fetchBillingUsage } from './billing.js';
import { createAccountDashboard } from './dashboard/server.js';
import {
  isCachedQuotaFresh,
  loadQuotaCache,
  removeQuotaUsage,
  saveQuotaUsageWhen,
} from './quotaCache.js';
import {
  createSessionAccountSelection,
  type SessionAccountSelection,
} from './sessionAccountSelection.js';

export const GROK_CLI_PROVIDER = 'grok-cli';
export const DEFAULT_GROK_MODEL = 'grok-build';
const noOp = () => {};

export interface AccountSnapshot {
  id: string;
  slot: number;
  label: string;
  permanent: boolean;
  status: string;
  authenticated: boolean;
  active: boolean;
  environment: boolean;
  tier?: string;
  quota?: {
    updatedAt: string;
    fresh: boolean;
    monthly: {
      monthlyLimit: number;
      used: number;
      billingPeriodEnd: string;
    };
    weekly?: {
      creditUsagePercent: number;
      billingPeriodEnd: string;
    };
  };
}

export interface AccountsSnapshot {
  connected: boolean;
  accounts: AccountSnapshot[];
}

export function isGrokCliProvider(provider: string | undefined): boolean {
  return provider === GROK_CLI_PROVIDER;
}

function defaultLabel(slot: number) {
  return `Account ${slot}`;
}

function normalizeLabel(accounts: VaultAccount[], id: string, slot: number, value: string) {
  const label = value.trim() || defaultLabel(slot);
  if ([...label].length > 40) throw new Error('Account labels must be 40 characters or fewer.');
  if (hasTerminalControlCharacters(label)) {
    throw new Error('Account labels cannot contain control characters.');
  }
  if (
    accounts.some(
      (account) =>
        account.id !== id && account.label.toLocaleLowerCase() === label.toLocaleLowerCase(),
    )
  ) {
    throw new Error(`An account named “${label}” already exists.`);
  }
  return label;
}

function callbacks(interaction: AuthInteraction): OAuthLoginCallbacks {
  return {
    onAuth(info) {
      interaction.notify({ type: 'auth_url', ...info });
    },
    onDeviceCode(info) {
      interaction.notify({ type: 'device_code', ...info });
    },
    onPrompt(prompt) {
      return interaction.prompt({ type: 'text', ...prompt });
    },
    onProgress(message) {
      interaction.notify({ type: 'progress', message });
    },
    onManualCodeInput() {
      return interaction.prompt({
        type: 'manual_code',
        message: 'Paste the authorization code',
      });
    },
    onSelect(prompt) {
      return interaction.prompt({ type: 'select', ...prompt });
    },
    signal: interaction.signal,
  };
}

function openAuthorizationUrl(url: string, onError: () => void) {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.once('error', onError);
  child.unref();
}

function terminalInteraction(ctx: ExtensionCommandContext): AuthInteraction {
  return {
    notify(event) {
      if (event.type === 'auth_url') {
        openAuthorizationUrl(event.url, () => {
          ctx.ui.notify(`Open this URL to continue login: ${event.url}`, 'warning');
        });
        ctx.ui.notify(event.instructions ?? 'Complete the Grok CLI login in your browser.', 'info');
        return;
      }
      if (event.type === 'device_code') {
        ctx.ui.notify(`Open ${event.verificationUri} and enter code ${event.userCode}.`, 'info');
        return;
      }
      ctx.ui.notify(event.message, 'info');
    },
    async prompt(prompt) {
      if (prompt.type === 'select') {
        const label = await ctx.ui.select(
          prompt.message,
          prompt.options.map((option) => option.label),
        );
        return prompt.options.find((option) => option.label === label)?.id ?? '';
      }
      return (await ctx.ui.input(prompt.message, prompt.placeholder)) ?? '';
    },
  };
}

function accountFrom(id: string) {
  const account = getAccountVaultSync().accounts.find((candidate) => candidate.id === id);
  if (!account) throw new Error(`Unknown Grok CLI account: ${id}`);
  return account;
}

export function accountRouteIsCurrent(route: AccountRoute) {
  if (route.source === 'environment') {
    return process.env.GROK_CLI_OAUTH_TOKEN === route.token;
  }
  const account = getAccountVaultSync().accounts.find(
    (candidate) => candidate.id === route.accountId,
  );
  return account?.revision === route.revision && account.credential !== undefined;
}

async function clearQuota(ctx: ExtensionContext, id: string) {
  await removeQuotaUsage(id).catch(() => {
    ctx.ui.notify('The account changed, but its cached quota could not be cleared.', 'warning');
  });
}

async function refreshQuota(route: AccountRoute, signal: AbortSignal) {
  const usage = await fetchBillingUsage(
    route.token,
    AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  );
  if (!(await saveQuotaUsageWhen(route.accountId, usage, () => accountRouteIsCurrent(route)))) {
    throw new Error('The account changed while its quota was refreshing.');
  }
}

async function refreshAccountBatches<T>(
  accounts: T[],
  refresh: (account: T) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const batch = accounts.slice(0, 3);
  if (!batch.length) return;
  await Promise.all(batch.map(refresh));
  await refreshAccountBatches(accounts.slice(3), refresh, signal);
}

function fallbackActive(accounts: VaultAccount[], removedId: string) {
  return accounts.find((account) => account.id !== removedId && account.credential !== undefined)
    ?.id;
}

function replaceVaultDefault(vault: ReturnType<typeof getAccountVaultSync>, removedId: string) {
  if (vault.activeAccountId !== removedId) return;
  const fallback = fallbackActive(vault.accounts, removedId);
  if (fallback) vault.activeAccountId = fallback;
  else delete vault.activeAccountId;
}

function logoutWarning(vault: ReturnType<typeof getAccountVaultSync>) {
  return {
    warning: vault.activeAccountId
      ? undefined
      : 'No logged-in account remains. Run /logout and select Grok CLI to disconnect Pi.',
  };
}

export async function resolveGrokToken(
  _ctx?: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
): Promise<string | undefined> {
  try {
    return (await resolveAccountRoute()).token;
  } catch {
    return undefined;
  }
}

function createAccountManager(
  clearRecentExhaustion: (accountId: string) => void,
  sessionSelection: SessionAccountSelection,
) {
  function persistSessionFallback(ctx: ExtensionContext, removedId: string, selectedId?: string) {
    if (selectedId !== removedId) return;
    const fallback = sessionSelection.accountId(ctx.sessionManager.getSessionId());
    if (fallback) sessionSelection.select(ctx, fallback);
  }

  return {
    nextSlot() {
      return getAccountVaultSync().nextSlot;
    },
    add(_ctx: ExtensionContext, value: string) {
      return mutateAccountVault((vault) => {
        const account = {
          id: randomUUID(),
          slot: vault.nextSlot,
          label: normalizeLabel(vault.accounts, '', vault.nextSlot, value),
          revision: 0,
        };
        vault.nextSlot += 1;
        vault.accounts.push(account);
        return account;
      });
    },
    rename(_ctx: ExtensionContext, id: string, value: string) {
      return mutateAccountVault((vault) => {
        const account = vault.accounts.find((candidate) => candidate.id === id);
        if (!account) throw new Error(`Unknown Grok CLI account: ${id}`);
        account.label = normalizeLabel(vault.accounts, id, account.slot, value);
        return { id: account.id, slot: account.slot, label: account.label };
      });
    },
    async activate(_ctx: ExtensionContext, id: string) {
      if (process.env.GROK_CLI_OAUTH_TOKEN) {
        throw new Error('Saved accounts cannot be selected while the environment token is active.');
      }
      const account = await mutateAccountVault((vault) => {
        const account = vault.accounts.find((candidate) => candidate.id === id);
        if (!account) throw new Error(`Unknown Grok CLI account: ${id}`);
        if (!account.credential) {
          throw new Error(`Log in to “${account.label}” before making it active.`);
        }
        return { id: account.id, slot: account.slot, label: account.label };
      });
      sessionSelection.select(_ctx, id);
      return account;
    },
    async login(ctx: ExtensionContext, id: string, interaction: AuthInteraction) {
      if (process.env.GROK_CLI_OAUTH_TOKEN) {
        throw new Error('Unset GROK_CLI_OAUTH_TOKEN before logging in from the dashboard.');
      }
      const revision = accountFrom(id).revision;
      const credential = (await oauth.login(callbacks(interaction))) as AccountCredential;
      const account = await mutateAccountVault((vault) => {
        const current = vault.accounts.find((candidate) => candidate.id === id);
        if (!current) throw new Error('The account was removed while login was in progress.');
        if (current.revision !== revision) {
          throw new Error('The account changed while login was in progress. Try again.');
        }
        current.credential = structuredClone(credential);
        current.revision += 1;
        vault.activeAccountId ??= current.id;
        return { id: current.id, slot: current.slot, label: current.label };
      });
      clearRecentExhaustion(id);
      await clearQuota(ctx, id);
      return account;
    },
    async logout(ctx: ExtensionContext, id: string) {
      if (process.env.GROK_CLI_OAUTH_TOKEN) {
        throw new Error(
          'Unset GROK_CLI_OAUTH_TOKEN and restart Pi to remove the environment token.',
        );
      }
      const selectedAccountId = sessionSelection.accountId(ctx.sessionManager.getSessionId());
      const result = await mutateAccountVault((vault) => {
        const account = vault.accounts.find((candidate) => candidate.id === id);
        if (!account) throw new Error(`Unknown Grok CLI account: ${id}`);
        delete account.credential;
        account.revision += 1;
        replaceVaultDefault(vault, id);
        return logoutWarning(vault);
      });
      persistSessionFallback(ctx, id, selectedAccountId);
      await clearQuota(ctx, id);
      return result;
    },
    async remove(ctx: ExtensionContext, id: string, expectedRevision?: number) {
      if (id === ACCOUNT_1_ID) throw new Error('The permanent Account 1 cannot be removed.');
      const selectedAccountId = sessionSelection.accountId(ctx.sessionManager.getSessionId());
      const result = await mutateAccountVault((vault) => {
        const account = vault.accounts.find((candidate) => candidate.id === id);
        if (!account) throw new Error(`Unknown Grok CLI account: ${id}`);
        if (
          expectedRevision !== undefined &&
          (account.revision !== expectedRevision || account.credential !== undefined)
        ) {
          return undefined;
        }
        replaceVaultDefault(vault, id);
        vault.accounts = vault.accounts.filter((account) => account.id !== id);
        return logoutWarning(vault);
      });
      if (!result) return;
      persistSessionFallback(ctx, id, selectedAccountId);
      await clearQuota(ctx, id);
      return result;
    },
    async refresh(
      _ctx: ExtensionContext,
      signal: AbortSignal,
      onProgress?: (progress: {
        id: string;
        completed: number;
        total: number;
        updated: boolean;
      }) => void,
    ) {
      const environment = Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
      const accounts = environment
        ? getAccountVaultSync().accounts.filter((account) => account.id === ACCOUNT_1_ID)
        : getAccountVaultSync().accounts.filter((account) => account.credential);
      let completed = 0;
      let updated = 0;
      const failed: string[] = [];
      await refreshAccountBatches(
        accounts,
        async (account) => {
          let succeeded = false;
          try {
            const route = await resolveAccountRoute(environment ? undefined : account.id);
            await refreshQuota(route, signal);
            updated += 1;
            succeeded = true;
          } catch {
            if (!signal.aborted) failed.push(account.id);
          } finally {
            completed += 1;
            onProgress?.({ id: account.id, completed, total: accounts.length, updated: succeeded });
          }
        },
        signal,
      );
      return { updated, failed };
    },
    async refreshOne(_ctx: ExtensionContext, id: string, signal: AbortSignal) {
      const account = accountFrom(id);
      if (!account.credential && !process.env.GROK_CLI_OAUTH_TOKEN) {
        throw new Error(`Log in to “${account.label}” before refreshing its quota.`);
      }
      try {
        await refreshQuota(await resolveAccountRoute(id), signal);
        return { updated: 1, failed: [] };
      } catch {
        return { updated: 0, failed: [id] };
      }
    },
    snapshot(_ctx: ExtensionContext): AccountsSnapshot {
      const vault = getAccountVaultSync();
      const cache = loadQuotaCache();
      const environment = Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
      const stored = readStoredCredential(GROK_CLI_PROVIDER);
      const connected =
        environment ||
        (stored?.type === 'oauth' &&
          stored.access === ACCOUNT_VAULT_MARKER &&
          stored.refresh === ACCOUNT_VAULT_MARKER);
      const selectedAccountId = sessionSelection.accountId(_ctx.sessionManager.getSessionId());
      return {
        connected,
        accounts: vault.accounts.map((account, index) => {
          const accountEnvironment = environment && account.id === ACCOUNT_1_ID;
          const authenticated = accountEnvironment || account.credential !== undefined;
          const active = accountEnvironment || (!environment && selectedAccountId === account.id);
          const quota = cache.accounts[account.id];
          const slot = index + 1;
          return {
            id: account.id,
            slot,
            label:
              account.label === defaultLabel(account.slot) ? defaultLabel(slot) : account.label,
            permanent: account.id === ACCOUNT_1_ID,
            status: active
              ? accountEnvironment
                ? 'Active (environment)'
                : 'Active'
              : authenticated
                ? 'Authenticated'
                : 'Login required',
            authenticated,
            active,
            environment: accountEnvironment,
            ...(quota
              ? {
                  ...(quota.tier ? { tier: quota.tier } : {}),
                  quota: {
                    updatedAt: quota.updatedAt,
                    fresh: isCachedQuotaFresh(quota),
                    monthly: { ...quota.monthly },
                    ...(quota.weekly ? { weekly: { ...quota.weekly } } : {}),
                  },
                }
              : {}),
          };
        }),
      };
    },
    handleModelSelect: noOp,
  };
}

export type AccountManager = ReturnType<typeof createAccountManager>;

async function addAccount(
  ctx: ExtensionCommandContext,
  manager: AccountManager,
  interaction: AuthInteraction,
) {
  const slot = manager.nextSlot();
  const value = await ctx.ui.input('Label this Grok CLI account:', defaultLabel(slot));
  if (value === undefined) return;
  const account = await manager.add(ctx, value);
  try {
    await manager.login(ctx, account.id, interaction);
  } catch (error) {
    await manager.remove(ctx, account.id);
    throw error;
  }
}

export function registerAccountManagement(
  pi: ExtensionAPI,
  clearRecentExhaustion: (accountId: string) => void = () => {},
  sessionSelection = createSessionAccountSelection(pi),
) {
  const manager = createAccountManager(clearRecentExhaustion, sessionSelection);
  const dashboard = createAccountDashboard(manager);

  pi.registerCommand('grok-cli-accounts', {
    description: 'Add, select, rename, log in, log out, or remove Grok CLI accounts',
    handler: async (args, ctx) => {
      await confirmMarkerInstallation();
      const command = args.trim();
      if (command === 'gui') {
        await dashboard.open(ctx);
        return;
      }
      if (command) {
        ctx.ui.notify('Usage: /grok-cli-accounts [gui]', 'warning');
        return;
      }
      const snapshot = manager.snapshot(ctx);
      const choice = await ctx.ui.select('Grok CLI accounts:', [
        ...snapshot.accounts.map(
          (account) => `${account.slot}. ${account.label} — ${account.status}`,
        ),
        'Add account',
        'Manage accounts',
      ]);
      if (!choice) return;
      const interaction = terminalInteraction(ctx);
      if (choice === 'Add account') {
        try {
          await addAccount(ctx, manager, interaction);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
        return;
      }
      if (choice === 'Manage accounts') {
        const selected = await ctx.ui.select(
          'Manage Grok CLI account:',
          snapshot.accounts.map((account) => `${account.slot}. ${account.label}`),
        );
        const account = snapshot.accounts.find(
          (candidate) => `${candidate.slot}. ${candidate.label}` === selected,
        );
        if (!account) return;
        const action = await ctx.ui.select(`Manage “${account.label}”:`, [
          'Rename',
          account.authenticated ? 'Log in again' : 'Log in',
          'Log out',
          ...(account.permanent ? [] : ['Remove']),
          'Back',
        ]);
        try {
          if (action === 'Rename') {
            const label = await ctx.ui.input(`Rename “${account.label}”:`, account.label);
            if (label !== undefined) await manager.rename(ctx, account.id, label);
          }
          if (action === 'Log in' || action === 'Log in again') {
            await manager.login(ctx, account.id, interaction);
          }
          if (action === 'Log out') await manager.logout(ctx, account.id);
          if (action === 'Remove') await manager.remove(ctx, account.id);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
        return;
      }
      const account = snapshot.accounts.find(
        (candidate) => `${candidate.slot}. ${candidate.label} — ${candidate.status}` === choice,
      );
      if (!account) return;
      try {
        if (!account.authenticated) await manager.login(ctx, account.id, interaction);
        else await manager.activate(ctx, account.id);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  return {
    manager,
    closeDashboard: dashboard.close,
    handleModelSelect: manager.handleModelSelect,
  };
}
