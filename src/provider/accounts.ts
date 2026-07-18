import type { AuthInteraction } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { matchesKey, SelectList } from '@earendil-works/pi-tui';
import {
  findAvailableAccountNumber,
  type GrokCliAccount,
  type GrokCliConfig,
  hasTerminalControlCharacters,
  loadConfig,
  saveConfig,
} from '../config.js';
import { fetchBillingUsage } from './billing.js';
import { createAccountDashboard } from './dashboard/server.js';
import {
  formatCachedQuota,
  isCachedQuotaFresh,
  loadQuotaCache,
  removeQuotaUsage,
  saveQuotaUsage,
} from './quotaCache.js';

export const GROK_CLI_PROVIDER = 'grok-cli';
export const DEFAULT_GROK_MODEL = 'grok-build';

type RegisterAccount = (account: GrokCliAccount) => void;

export type PlanTier = 'free' | 'supergrok-lite' | 'supergrok' | 'supergrok-heavy';

export interface AccountSnapshot {
  provider: string;
  label: string;
  status: string;
  authenticated: boolean;
  active: boolean;
  environment: boolean;
  plan?: PlanTier;
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
  accounts: AccountSnapshot[];
}

export function isGrokCliProvider(provider: string | undefined): boolean {
  return provider === GROK_CLI_PROVIDER || /^grok-cli-(?:[2-9]|[1-9]\d+)$/.test(provider ?? '');
}

function copyConfig(): GrokCliConfig {
  const config = loadConfig().config;
  return {
    ...config,
    accounts: {
      ...config.accounts,
      items: config.accounts.items.map((account) => ({ ...account })),
    },
    imagine: { ...config.imagine },
    vision: { ...config.vision },
  };
}

function accountNumber(provider: string) {
  if (provider === GROK_CLI_PROVIDER) return 1;
  return Number(provider.slice('grok-cli-'.length));
}

function defaultLabel(provider: string) {
  return `Account ${accountNumber(provider)}`;
}

function labelError(config: GrokCliConfig, provider: string, label: string) {
  if ([...label].length > 40) return 'Account labels must be 40 characters or fewer.';
  if (hasTerminalControlCharacters(label))
    return 'Account labels cannot contain control characters.';
  if (
    config.accounts.items.some(
      (account) =>
        account.provider !== provider &&
        account.label.toLocaleLowerCase() === label.toLocaleLowerCase(),
    )
  ) {
    return `An account named “${label}” already exists.`;
  }
  return undefined;
}

function normalizeLabel(config: GrokCliConfig, provider: string, value: string) {
  const label = value.trim() || defaultLabel(provider);
  const error = labelError(config, provider, label);
  if (error) throw new Error(error);
  return label;
}

async function promptLabel(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  provider: string,
  title: string,
) {
  while (true) {
    const input = await ctx.ui.input(title, defaultLabel(provider));
    if (input === undefined) return undefined;
    const label = input.trim() || defaultLabel(provider);
    const error = labelError(config, provider, label);
    if (!error) return label;
    ctx.ui.notify(error, 'error');
  }
}

function hasStoredAuth(ctx: ExtensionContext, provider: string) {
  return ctx.modelRegistry.getProviderAuthStatus(provider).configured;
}

function accountRuntime(ctx: ExtensionContext) {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime) throw new Error('Pi account authentication runtime is unavailable.');
  return runtime;
}

function hasAccountAuth(ctx: ExtensionContext, provider: string) {
  return (
    hasStoredAuth(ctx, provider) ||
    (provider === GROK_CLI_PROVIDER && Boolean(process.env.GROK_CLI_OAUTH_TOKEN))
  );
}

function accountStatus(ctx: ExtensionContext, config: GrokCliConfig, provider: string) {
  const environment = provider === GROK_CLI_PROVIDER && Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
  if (config.accounts.selectedProvider === provider && hasAccountAuth(ctx, provider)) {
    return environment ? 'Active (environment)' : 'Active';
  }
  if (environment) return 'Authenticated (environment)';
  return hasStoredAuth(ctx, provider) ? 'Authenticated' : 'Login required';
}

// Tier from the monthly credit cap: 0 free, up to 4,000 Lite, up to 20,000 SuperGrok, above Heavy.
export function planTier(monthlyLimit: number): PlanTier {
  if (monthlyLimit <= 0) return 'free';
  if (monthlyLimit <= 4000) return 'supergrok-lite';
  if (monthlyLimit <= 20000) return 'supergrok';
  return 'supergrok-heavy';
}

async function resolveAccountToken(ctx: ExtensionContext, provider: string) {
  if (provider === GROK_CLI_PROVIDER && process.env.GROK_CLI_OAUTH_TOKEN) {
    return process.env.GROK_CLI_OAUTH_TOKEN;
  }
  try {
    return await ctx.modelRegistry.getApiKeyForProvider(provider);
  } catch {
    return undefined;
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

function showAccountSelector(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  mode: 'main' | 'manage',
  manager: AccountManager,
) {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const accountItems = new Map(
      config.accounts.items.map((account) => [
        account.provider,
        {
          value: account.provider,
          label: `${account.label} — ${accountStatus(ctx, config, account.provider)}`,
          description: '',
        },
      ]),
    );
    const items = [
      ...accountItems.values(),
      ...(mode === 'main'
        ? [
            { value: 'action:add', label: '＋ Add account', description: '' },
            { value: 'action:manage', label: 'Manage accounts', description: '' },
          ]
        : []),
    ];
    const selectList = new SelectList(
      items,
      Math.min(items.length, 10),
      {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('dim', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      },
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 40 },
    );
    const refreshingProviders = new Set<string>();
    const failedProviders = new Set<string>();
    const controller = new AbortController();
    let cache = loadQuotaCache();
    let status: string | undefined;
    let refreshing = false;
    let disposed = false;

    const updateDescriptions = () => {
      for (const account of config.accounts.items) {
        const item = accountItems.get(account.provider);
        if (!item) continue;
        const cached = cache.accounts[account.provider];
        item.description = !hasAccountAuth(ctx, account.provider)
          ? 'Quota unavailable · login required'
          : refreshingProviders.has(account.provider)
            ? 'Refreshing…'
            : failedProviders.has(account.provider)
              ? cached
                ? `${formatCachedQuota(cached)} · refresh failed`
                : 'Refresh failed · press r to retry'
              : cached
                ? formatCachedQuota(cached)
                : 'Quota not fetched · press r';
      }
      selectList.invalidate();
    };

    const close = (value: string | undefined) => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      done(value);
    };

    const startRefresh = async () => {
      if (refreshing || disposed) return;
      const accounts = config.accounts.items.filter((account) =>
        hasAccountAuth(ctx, account.provider),
      );
      if (!accounts.length) {
        status = 'No logged-in accounts to refresh';
        tui.requestRender();
        return;
      }
      refreshing = true;
      failedProviders.clear();
      for (const account of accounts) refreshingProviders.add(account.provider);
      status = `Refreshing quotas… 0/${accounts.length}`;
      updateDescriptions();
      tui.requestRender();
      const result = await manager.refresh(ctx, controller.signal, (progress) => {
        refreshingProviders.delete(progress.provider);
        if (!progress.updated) failedProviders.add(progress.provider);
        cache = loadQuotaCache();
        status = `Refreshing quotas… ${progress.completed}/${progress.total}`;
        updateDescriptions();
        if (!disposed) tui.requestRender();
      });

      refreshing = false;
      if (disposed) return;
      status = `Updated ${result.updated} accounts; ${result.failed.length} failed`;
      tui.requestRender();
    };

    selectList.onSelect = (item) => close(item.value);
    selectList.onCancel = () => close(undefined);
    updateDescriptions();

    return {
      render(width: number) {
        return [
          theme.fg(
            'accent',
            theme.bold(mode === 'main' ? 'Grok CLI accounts:' : 'Manage Grok CLI account:'),
          ),
          '',
          ...selectList.render(width),
          '',
          ...(status ? [theme.fg('dim', status)] : []),
          theme.fg(
            'dim',
            `r refresh quotas · enter select · esc ${mode === 'main' ? 'close' : 'back'}`,
          ),
        ];
      },
      invalidate() {
        selectList.invalidate();
      },
      handleInput(data: string) {
        if (data === 'r' || data === 'R' || matchesKey(data, 'r')) {
          void startRefresh();
          return;
        }
        selectList.handleInput(data);
        if (!disposed) tui.requestRender();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        controller.abort();
      },
    };
  });
}

function prefillLogin(ctx: ExtensionContext, provider: string) {
  ctx.ui.setEditorText(`/login ${provider}`);
}

async function addAccount(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  manager: AccountManager,
) {
  const provider = manager.nextProvider();
  const label = await promptLabel(ctx, config, provider, 'Label this Grok CLI account:');
  if (!label) return;
  try {
    prefillLogin(ctx, (await manager.add(ctx, label)).provider);
  } catch (error) {
    ctx.ui.notify(
      `Could not add Grok CLI account: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function renameAccount(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  account: GrokCliAccount,
  manager: AccountManager,
) {
  const label = await promptLabel(ctx, config, account.provider, `Rename “${account.label}”:`);
  if (!label) return;
  try {
    await manager.rename(ctx, account.provider, label);
  } catch (error) {
    ctx.ui.notify(
      `Could not rename Grok CLI account: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function removeBaseAccount(
  ctx: ExtensionCommandContext,
  account: GrokCliAccount,
  manager: AccountManager,
) {
  if (
    !(await ctx.ui.confirm(
      `Log out of “${account.label}”?`,
      'This removes its saved OAuth login from Pi.',
    ))
  ) {
    return;
  }
  try {
    const result = await manager.logout(ctx, account.provider);
    if (result.warning) ctx.ui.notify(result.warning, 'warning');
  } catch (error) {
    ctx.ui.notify(
      `Could not log out of Grok CLI: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function fallbackBeforeRemoval(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: GrokCliConfig,
  removed: GrokCliAccount,
) {
  const candidates = config.accounts.items.filter(
    (account) => account.provider !== removed.provider && hasAccountAuth(ctx, account.provider),
  );
  if (ctx.model?.provider !== removed.provider) {
    return config.accounts.selectedProvider === removed.provider
      ? (candidates[0]?.provider ?? GROK_CLI_PROVIDER)
      : config.accounts.selectedProvider;
  }
  for (const account of candidates) {
    const target =
      ctx.modelRegistry.find(account.provider, ctx.model?.id ?? DEFAULT_GROK_MODEL) ??
      ctx.modelRegistry.find(account.provider, DEFAULT_GROK_MODEL);
    if (target && (await pi.setModel(target))) return account.provider;
  }
  return candidates.length ? null : undefined;
}

async function removeAlias(
  ctx: ExtensionCommandContext,
  account: GrokCliAccount,
  manager: AccountManager,
) {
  if (
    !(await ctx.ui.confirm(
      `Remove “${account.label}”?`,
      'This removes its saved OAuth login from Pi and deletes the account slot.',
    ))
  ) {
    return;
  }
  try {
    const result = await manager.remove(ctx, account.provider);
    if (result.warning) ctx.ui.notify(result.warning, 'warning');
  } catch (error) {
    ctx.ui.notify(
      `Could not remove Grok CLI account: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function manageAccount(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  account: GrokCliAccount,
  manager: AccountManager,
) {
  const environment =
    account.provider === GROK_CLI_PROVIDER && Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
  const loginLabel = hasStoredAuth(ctx, account.provider) ? 'Log in again' : 'Log in';
  const removeLabel = account.provider === GROK_CLI_PROVIDER ? 'Log out' : 'Log out and remove';
  const options = environment
    ? ['Rename', 'Environment token instructions', 'Back']
    : ['Rename', loginLabel, removeLabel, 'Back'];
  const action = await ctx.ui.select(`Manage “${account.label}”:`, options);
  switch (action) {
    case 'Rename':
      await renameAccount(ctx, config, account, manager);
      return;
    case loginLabel:
      prefillLogin(ctx, account.provider);
      return;
    case 'Environment token instructions':
      ctx.ui.notify(
        'Unset GROK_CLI_OAUTH_TOKEN and restart Pi to remove the environment token.',
        'info',
      );
      return;
    case 'Log out':
      await removeBaseAccount(ctx, account, manager);
      return;
    case 'Log out and remove':
      await removeAlias(ctx, account, manager);
  }
}

export function resolveGrokProvider(ctx: Pick<ExtensionContext, 'model'>) {
  const config = loadConfig().config;
  if (
    isGrokCliProvider(ctx.model?.provider) &&
    config.accounts.items.some((account) => account.provider === ctx.model?.provider)
  ) {
    return ctx.model?.provider ?? GROK_CLI_PROVIDER;
  }
  return config.accounts.selectedProvider;
}

export async function resolveGrokToken(
  ctx: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
): Promise<string | undefined> {
  const provider = resolveGrokProvider(ctx);
  if (provider === GROK_CLI_PROVIDER && process.env.GROK_CLI_OAUTH_TOKEN) {
    return process.env.GROK_CLI_OAUTH_TOKEN;
  }
  try {
    return await ctx.modelRegistry.getApiKeyForProvider(provider);
  } catch {
    return undefined;
  }
}

function createAccountManager(
  pi: ExtensionAPI,
  registerAccount: RegisterAccount,
  deferredRemovals: Set<string>,
) {
  let mutations = Promise.resolve();
  const accountGenerations = new Map<string, number>();
  const mutate = <T>(operation: () => Promise<T> | T) => {
    const result = mutations.then(operation, operation);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const accountGeneration = (provider: string) => accountGenerations.get(provider) ?? 0;
  const invalidateAccount = (provider: string) =>
    accountGenerations.set(provider, accountGeneration(provider) + 1);
  const accountFrom = (config: GrokCliConfig, provider: string) => {
    const account = config.accounts.items.find((candidate) => candidate.provider === provider);
    if (!account) throw new Error(`Unknown Grok CLI account: ${provider}`);
    return account;
  };
  const clearQuota = async (provider: string) => {
    try {
      await removeQuotaUsage(provider);
      return undefined;
    } catch (error) {
      return `Grok CLI quota cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const refreshAccounts = async (
    ctx: ExtensionContext,
    accounts: { account: GrokCliAccount; generation: number }[],
    signal: AbortSignal,
    onProgress?: (progress: {
      provider: string;
      completed: number;
      total: number;
      updated: boolean;
    }) => void,
  ) => {
    let completed = 0;
    let updated = 0;
    const failed: string[] = [];
    await refreshAccountBatches(
      accounts,
      async ({ account, generation }) => {
        let succeeded = false;
        try {
          const token = await resolveAccountToken(ctx, account.provider);
          if (!token) throw new Error('authentication unavailable');
          const usage = await fetchBillingUsage(
            token,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
          succeeded = await mutate(async () => {
            if (
              accountGeneration(account.provider) !== generation ||
              !copyConfig().accounts.items.some(
                (candidate) => candidate.provider === account.provider,
              ) ||
              !hasAccountAuth(ctx, account.provider)
            ) {
              return false;
            }
            await saveQuotaUsage(account.provider, usage);
            return true;
          });
          if (succeeded) updated += 1;
        } catch {
          if (!signal.aborted) failed.push(account.provider);
        } finally {
          completed += 1;
          onProgress?.({
            provider: account.provider,
            completed,
            total: accounts.length,
            updated: succeeded,
          });
        }
      },
      signal,
    );
    return { updated, failed };
  };

  return {
    nextProvider() {
      return `${GROK_CLI_PROVIDER}-${findAvailableAccountNumber(
        copyConfig().accounts.items.map((account) => account.provider),
        deferredRemovals,
      )}`;
    },
    add(_ctx: ExtensionContext, value: string) {
      return mutate(() => {
        const config = copyConfig();
        const provider = `${GROK_CLI_PROVIDER}-${findAvailableAccountNumber(
          config.accounts.items.map((account) => account.provider),
          deferredRemovals,
        )}`;
        const account = { provider, label: normalizeLabel(config, provider, value) };
        config.accounts.items.push(account);
        config.accounts.nextAccountNumber = findAvailableAccountNumber(
          config.accounts.items.map((candidate) => candidate.provider),
        );
        saveConfig(config);
        invalidateAccount(provider);
        registerAccount(account);
        return account;
      });
    },
    rename(_ctx: ExtensionContext, provider: string, value: string) {
      return mutate(() => {
        const config = copyConfig();
        const account = accountFrom(config, provider);
        account.label = normalizeLabel(config, provider, value);
        saveConfig(config);
        registerAccount(account);
        return account;
      });
    },
    activate(ctx: ExtensionContext, provider: string) {
      return mutate(async () => {
        const config = copyConfig();
        const account = accountFrom(config, provider);
        if (!hasAccountAuth(ctx, provider)) {
          throw new Error(`Log in to “${account.label}” before making it active.`);
        }
        const modelId = isGrokCliProvider(ctx.model?.provider) ? ctx.model?.id : DEFAULT_GROK_MODEL;
        const model =
          ctx.modelRegistry.find(provider, modelId ?? DEFAULT_GROK_MODEL) ??
          ctx.modelRegistry.find(provider, DEFAULT_GROK_MODEL);
        if (!model) throw new Error(`Grok CLI model unavailable for “${account.label}”.`);
        if (!(await pi.setModel(model))) {
          throw new Error(`Could not switch to “${account.label}”; authentication is unavailable.`);
        }
        config.accounts.selectedProvider = provider;
        saveConfig(config);
        return account;
      });
    },
    async login(ctx: ExtensionContext, provider: string, interaction: AuthInteraction) {
      const config = copyConfig();
      const account = accountFrom(config, provider);
      if (provider === GROK_CLI_PROVIDER && process.env.GROK_CLI_OAUTH_TOKEN) {
        throw new Error('Unset GROK_CLI_OAUTH_TOKEN before logging in from the dashboard.');
      }
      const result = await accountRuntime(ctx).login(account.provider, 'oauth', interaction);
      invalidateAccount(provider);
      return result;
    },
    logout(ctx: ExtensionContext, provider: string) {
      return mutate(async () => {
        if (provider !== GROK_CLI_PROVIDER) {
          throw new Error('Only the permanent base account can be logged out without removal.');
        }
        if (process.env.GROK_CLI_OAUTH_TOKEN) {
          throw new Error(
            'Unset GROK_CLI_OAUTH_TOKEN and restart Pi to remove the environment token.',
          );
        }
        const config = copyConfig();
        const account = accountFrom(config, provider);
        await accountRuntime(ctx).logout(provider);
        invalidateAccount(provider);
        account.label = 'Account 1';
        saveConfig(config);
        registerAccount(account);
        return { warning: await clearQuota(provider) };
      });
    },
    remove(ctx: ExtensionContext, provider: string) {
      return mutate(async () => {
        if (provider === GROK_CLI_PROVIDER) {
          throw new Error('The permanent base account cannot be removed.');
        }
        const config = copyConfig();
        const account = accountFrom(config, provider);
        const fallback = await fallbackBeforeRemoval(pi, ctx, config, account);
        if (fallback === null) {
          throw new Error('Could not switch to another authenticated Grok CLI account.');
        }
        await accountRuntime(ctx).logout(provider);
        invalidateAccount(provider);
        config.accounts.items = config.accounts.items.filter(
          (candidate) => candidate.provider !== provider,
        );
        config.accounts.selectedProvider = fallback ?? GROK_CLI_PROVIDER;
        saveConfig(config);
        const cacheWarning = await clearQuota(provider);
        if (ctx.model?.provider === provider && fallback === undefined) {
          deferredRemovals.add(provider);
          return {
            warning:
              cacheWarning ??
              'Grok CLI account removed. The current model now requires login and will disappear after you switch models.',
          };
        }
        pi.unregisterProvider(provider);
        return { warning: cacheWarning };
      });
    },
    async refresh(
      ctx: ExtensionContext,
      signal: AbortSignal,
      onProgress?: (progress: {
        provider: string;
        completed: number;
        total: number;
        updated: boolean;
      }) => void,
    ) {
      return refreshAccounts(
        ctx,
        copyConfig().accounts.items.flatMap((account) =>
          hasAccountAuth(ctx, account.provider)
            ? [{ account, generation: accountGeneration(account.provider) }]
            : [],
        ),
        signal,
        onProgress,
      );
    },
    async refreshOne(ctx: ExtensionContext, provider: string, signal: AbortSignal) {
      const account = accountFrom(copyConfig(), provider);
      if (!hasAccountAuth(ctx, provider)) {
        throw new Error(`Log in to “${account.label}” before refreshing its quota.`);
      }
      return refreshAccounts(ctx, [{ account, generation: accountGeneration(provider) }], signal);
    },
    snapshot(ctx: ExtensionContext): AccountsSnapshot {
      const config = copyConfig();
      const cache = loadQuotaCache();
      return {
        accounts: config.accounts.items.map((account) => {
          const environment =
            account.provider === GROK_CLI_PROVIDER && Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
          const authenticated = hasAccountAuth(ctx, account.provider);
          const quota = cache.accounts[account.provider];
          return {
            provider: account.provider,
            label: account.label,
            status: accountStatus(ctx, config, account.provider),
            authenticated,
            active: config.accounts.selectedProvider === account.provider && authenticated,
            environment,
            ...(quota
              ? {
                  plan: planTier(quota.monthly.monthlyLimit),
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
    handleModelSelect(event: {
      model: { provider: string };
      previousModel?: { provider: string };
    }) {
      if (event.previousModel && deferredRemovals.delete(event.previousModel.provider)) {
        pi.unregisterProvider(event.previousModel.provider);
      }
      if (!isGrokCliProvider(event.model.provider)) return;
      return mutate(() => {
        const config = copyConfig();
        if (!config.accounts.items.some((account) => account.provider === event.model.provider))
          return;
        if (config.accounts.selectedProvider === event.model.provider) return;
        config.accounts.selectedProvider = event.model.provider;
        saveConfig(config);
      });
    },
  };
}

export type AccountManager = ReturnType<typeof createAccountManager>;

export function registerAccountManagement(pi: ExtensionAPI, registerAccount: RegisterAccount) {
  const deferredRemovals = new Set<string>();
  const manager = createAccountManager(pi, registerAccount, deferredRemovals);
  const dashboard = createAccountDashboard(manager);

  pi.registerCommand('grok-cli-accounts', {
    description:
      'Add, switch, rename, relogin, or remove Grok CLI accounts; pass gui to open the browser UI',
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === 'gui') {
        await dashboard.open(ctx);
        return;
      }
      if (command) {
        ctx.ui.notify('Usage: /grok-cli-accounts [gui]', 'warning');
        return;
      }
      const config = copyConfig();
      const choice = await showAccountSelector(ctx, config, 'main', manager);
      if (choice === 'action:add') {
        await addAccount(ctx, config, manager);
        return;
      }
      if (choice === 'action:manage') {
        const latest = copyConfig();
        const selected = await showAccountSelector(ctx, latest, 'manage', manager);
        const account = latest.accounts.items.find(({ provider }) => provider === selected);
        if (account) {
          await manageAccount(ctx, latest, account, manager);
        }
        return;
      }
      const account = config.accounts.items.find(({ provider }) => provider === choice);
      if (!account) return;
      if (!hasAccountAuth(ctx, account.provider)) {
        prefillLogin(ctx, account.provider);
        return;
      }
      try {
        await manager.activate(ctx, account.provider);
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
