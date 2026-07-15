import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type GrokCliAccount,
  type GrokCliConfig,
  hasTerminalControlCharacters,
  loadConfig,
  saveConfig,
} from '../config.js';

export const GROK_CLI_PROVIDER = 'grok-cli';
export const DEFAULT_GROK_MODEL = 'grok-build';

type RegisterAccount = (account: GrokCliAccount) => void;

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
  return ctx.modelRegistry.authStorage.has(provider);
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
  if (environment) return 'Environment token';
  return hasStoredAuth(ctx, provider) ? 'Logged in' : 'Login required';
}

function accountRows(ctx: ExtensionContext, config: GrokCliConfig) {
  return config.accounts.items.map((account) => ({
    account,
    row: `${account.label} — ${accountStatus(ctx, config, account.provider)}`,
  }));
}

function prefillLogin(ctx: ExtensionContext, provider: string) {
  ctx.ui.setEditorText(`/login ${provider}`);
}

async function switchAccount(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: GrokCliConfig,
  account: GrokCliAccount,
) {
  const modelId = isGrokCliProvider(ctx.model?.provider) ? ctx.model?.id : DEFAULT_GROK_MODEL;
  const model =
    ctx.modelRegistry.find(account.provider, modelId ?? DEFAULT_GROK_MODEL) ??
    ctx.modelRegistry.find(account.provider, DEFAULT_GROK_MODEL);
  if (!model) {
    ctx.ui.notify(`Grok CLI model unavailable for “${account.label}”.`, 'error');
    return false;
  }
  if (!(await pi.setModel(model))) {
    ctx.ui.notify(
      `Could not switch to “${account.label}”; authentication is unavailable.`,
      'error',
    );
    return false;
  }
  config.accounts.selectedProvider = account.provider;
  saveConfig(config);
  return true;
}

async function addAccount(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  registerAccount: RegisterAccount,
) {
  const provider = `${GROK_CLI_PROVIDER}-${config.accounts.nextAccountNumber}`;
  const label = await promptLabel(ctx, config, provider, 'Label this Grok CLI account:');
  if (!label) return;
  const account = { provider, label };
  config.accounts.items.push(account);
  config.accounts.nextAccountNumber += 1;
  try {
    saveConfig(config);
    registerAccount(account);
    prefillLogin(ctx, provider);
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
  registerAccount: RegisterAccount,
) {
  const label = await promptLabel(ctx, config, account.provider, `Rename “${account.label}”:`);
  if (!label) return;
  account.label = label;
  try {
    saveConfig(config);
    registerAccount(account);
  } catch (error) {
    ctx.ui.notify(
      `Could not rename Grok CLI account: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function removeBaseAccount(
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  account: GrokCliAccount,
  registerAccount: RegisterAccount,
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
    ctx.modelRegistry.authStorage.logout(account.provider);
    account.label = 'Account 1';
    saveConfig(config);
    registerAccount(account);
  } catch (error) {
    ctx.ui.notify(
      `Could not log out of Grok CLI: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function fallbackBeforeRemoval(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  removed: GrokCliAccount,
) {
  const needsFallback =
    config.accounts.selectedProvider === removed.provider ||
    ctx.model?.provider === removed.provider;
  if (!needsFallback) return undefined;
  const candidates = config.accounts.items.filter(
    (account) => account.provider !== removed.provider && hasAccountAuth(ctx, account.provider),
  );
  for (const account of candidates) {
    const target =
      ctx.modelRegistry.find(account.provider, ctx.model?.id ?? DEFAULT_GROK_MODEL) ??
      ctx.modelRegistry.find(account.provider, DEFAULT_GROK_MODEL);
    if (target && (await pi.setModel(target))) return account.provider;
  }
  return candidates.length ? null : undefined;
}

async function removeAlias(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  account: GrokCliAccount,
  deferredRemovals: Set<string>,
) {
  if (
    !(await ctx.ui.confirm(
      `Remove “${account.label}”?`,
      'This removes its saved OAuth login from Pi and deletes the account slot.',
    ))
  ) {
    return;
  }
  const fallback = await fallbackBeforeRemoval(pi, ctx, config, account);
  if (fallback === null) {
    ctx.ui.notify('Could not switch to another authenticated Grok CLI account.', 'error');
    return;
  }
  try {
    ctx.modelRegistry.authStorage.logout(account.provider);
    config.accounts.items = config.accounts.items.filter(
      (candidate) => candidate.provider !== account.provider,
    );
    config.accounts.selectedProvider = fallback ?? GROK_CLI_PROVIDER;
    saveConfig(config);
    if (ctx.model?.provider === account.provider && fallback === undefined) {
      deferredRemovals.add(account.provider);
      ctx.ui.notify(
        'Grok CLI account removed. The current model now requires login and will disappear after you switch models.',
        'warning',
      );
      return;
    }
    pi.unregisterProvider(account.provider);
  } catch (error) {
    ctx.ui.notify(
      `Could not remove Grok CLI account: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

async function manageAccount(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: GrokCliConfig,
  account: GrokCliAccount,
  registerAccount: RegisterAccount,
  deferredRemovals: Set<string>,
) {
  const environment =
    account.provider === GROK_CLI_PROVIDER && Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
  const loginLabel = hasStoredAuth(ctx, account.provider) ? 'Log in again' : 'Log in';
  const removeLabel = account.provider === GROK_CLI_PROVIDER ? 'Log out' : 'Log out and remove';
  const options = environment
    ? ['Rename', 'Environment token instructions', 'Back']
    : ['Rename', loginLabel, removeLabel, 'Back'];
  const action = await ctx.ui.select(`Manage “${account.label}”:`, options);
  if (action === 'Rename') {
    await renameAccount(ctx, config, account, registerAccount);
    return;
  }
  if (action === loginLabel) {
    prefillLogin(ctx, account.provider);
    return;
  }
  if (action === 'Environment token instructions') {
    ctx.ui.notify(
      'Unset GROK_CLI_OAUTH_TOKEN and restart Pi to remove the environment token.',
      'info',
    );
    return;
  }
  if (action === 'Log out') {
    await removeBaseAccount(ctx, config, account, registerAccount);
    return;
  }
  if (action === 'Log out and remove') {
    await removeAlias(pi, ctx, config, account, deferredRemovals);
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

export function registerAccountManagement(pi: ExtensionAPI, registerAccount: RegisterAccount) {
  const deferredRemovals = new Set<string>();

  pi.registerCommand('grok-cli-accounts', {
    description: 'Add, switch, rename, relogin, or remove Grok CLI accounts',
    handler: async (_args, ctx) => {
      const config = copyConfig();
      const rows = accountRows(ctx, config);
      const choice = await ctx.ui.select('Grok CLI accounts:', [
        ...rows.map(({ row }) => row),
        '＋ Add account',
        'Manage accounts',
      ]);
      if (choice === '＋ Add account') {
        await addAccount(ctx, config, registerAccount);
        return;
      }
      if (choice === 'Manage accounts') {
        const latest = copyConfig();
        const managementRows = accountRows(ctx, latest);
        const selected = await ctx.ui.select(
          'Manage Grok CLI account:',
          managementRows.map(({ row }) => row),
        );
        const account = managementRows.find(({ row }) => row === selected)?.account;
        if (account) {
          await manageAccount(pi, ctx, latest, account, registerAccount, deferredRemovals);
        }
        return;
      }
      const account = rows.find(({ row }) => row === choice)?.account;
      if (!account) return;
      if (!hasAccountAuth(ctx, account.provider)) {
        prefillLogin(ctx, account.provider);
        return;
      }
      await switchAccount(pi, ctx, config, account);
    },
  });

  return {
    handleModelSelect(event: {
      model: { provider: string };
      previousModel?: { provider: string };
    }) {
      if (event.previousModel && deferredRemovals.delete(event.previousModel.provider)) {
        pi.unregisterProvider(event.previousModel.provider);
      }
      if (!isGrokCliProvider(event.model.provider)) return;
      const config = copyConfig();
      if (!config.accounts.items.some((account) => account.provider === event.model.provider))
        return;
      if (config.accounts.selectedProvider === event.model.provider) return;
      config.accounts.selectedProvider = event.model.provider;
      saveConfig(config);
    },
  };
}
