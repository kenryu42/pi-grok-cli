import {
  AuthStorage,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import {
  isGrokCliProvider,
  registerAccountManagement,
  resolveGrokProvider,
  resolveGrokToken,
} from '../../src/provider/accounts.js';
import { oauthCredential, TEST_ACCOUNTS, useTempHome } from '../vision/helpers.js';

const setupHome = useTempHome();

function configureAccounts(
  selectedProvider = 'grok-cli',
  items = TEST_ACCOUNTS,
  nextAccountNumber = 3,
) {
  setupHome();
  saveConfig({
    ...DEFAULT_CONFIG,
    accounts: { nextAccountNumber, selectedProvider, items },
  });
}

async function runAccountsCommand(extension: ReturnType<typeof setup>) {
  await extension.commands.get('grok-cli-accounts')?.handler('', extension.context);
}

function setup(
  options: {
    auth?: Record<string, ReturnType<typeof oauthCredential>>;
    confirms?: boolean[];
    inputs?: (string | undefined)[];
    model?: { provider: string; id: string };
    preserveHome?: boolean;
    selections?: (string | undefined)[];
    setModel?: boolean[];
  } = {},
) {
  if (!options.preserveHome) setupHome();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const registerAccount = vi.fn();
  const unregisterProvider = vi.fn();
  const setModelResults = [...(options.setModel ?? [true])];
  const setModel = vi.fn(async () => setModelResults.shift() ?? true);
  const pi = {
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<void> });
    },
    setModel,
    unregisterProvider,
  } as unknown as ExtensionAPI;
  const accountManagement = registerAccountManagement(pi, registerAccount);

  const authStorage = AuthStorage.inMemory(options.auth);
  const selections = [...(options.selections ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const notify = vi.fn();
  const setEditorText = vi.fn();
  const models = new Map<string, { provider: string; id: string }>();
  for (const provider of ['grok-cli', 'grok-cli-2', 'grok-cli-3']) {
    for (const id of ['grok-build', 'grok-composer-2.5-fast']) {
      models.set(`${provider}/${id}`, { provider, id });
    }
  }
  const context = {
    model: options.model,
    modelRegistry: {
      authStorage,
      find: (provider: string, id: string) => models.get(`${provider}/${id}`),
      getApiKeyForProvider: (provider: string) => authStorage.getApiKey(provider),
    },
    ui: {
      confirm: vi.fn(async () => confirms.shift() ?? false),
      input: vi.fn(async () => inputs.shift()),
      notify,
      select: vi.fn(async () => selections.shift()),
      setEditorText,
    },
  };

  return {
    authStorage,
    accountManagement,
    commands,
    context,
    notify,
    registerAccount,
    setEditorText,
    setModel,
    unregisterProvider,
  };
}

describe('Grok CLI account helpers', () => {
  it('recognizes only the base provider and valid numbered aliases', () => {
    expect(isGrokCliProvider('grok-cli')).toBe(true);
    expect(isGrokCliProvider('grok-cli-2')).toBe(true);
    expect(isGrokCliProvider('grok-cli-10')).toBe(true);
    expect(isGrokCliProvider('grok-cli-1')).toBe(false);
    expect(isGrokCliProvider('grok-cli-work')).toBe(false);
  });

  it('resolves the current Grok alias or the persisted selection for other models', async () => {
    configureAccounts('grok-cli-2');
    const getApiKeyForProvider = vi.fn(async (provider: string) => `${provider}-token`);

    expect(
      resolveGrokProvider({
        model: { provider: 'grok-cli', id: 'grok-build' },
      } as unknown as Pick<ExtensionContext, 'model'>),
    ).toBe('grok-cli');
    expect(
      resolveGrokProvider({
        model: { provider: 'openai', id: 'gpt-5' },
      } as unknown as Pick<ExtensionContext, 'model'>),
    ).toBe('grok-cli-2');
    expect(
      await resolveGrokToken({
        model: { provider: 'openai', id: 'gpt-5' },
        modelRegistry: { getApiKeyForProvider },
      } as unknown as Pick<ExtensionContext, 'model' | 'modelRegistry'>),
    ).toBe('grok-cli-2-token');
    expect(getApiKeyForProvider).toHaveBeenCalledWith('grok-cli-2');
  });
});

describe('/grok-cli-accounts', () => {
  it('adds a labeled alias and pre-fills Pi native login', async () => {
    const extension = setup({ selections: ['＋ Add account'], inputs: ['Work'] });

    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts).toEqual({
      nextAccountNumber: 3,
      selectedProvider: 'grok-cli',
      items: [
        { provider: 'grok-cli', label: 'Account 1' },
        { provider: 'grok-cli-2', label: 'Work' },
      ],
    });
    expect(extension.registerAccount).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      label: 'Work',
    });
    expect(extension.setEditorText).toHaveBeenCalledWith('/login grok-cli-2');
  });

  it('uses a stable default label and never reuses removed numbers', async () => {
    configureAccounts('grok-cli', [{ provider: 'grok-cli', label: 'Account 1' }], 4);
    const extension = setup({ preserveHome: true, selections: ['＋ Add account'], inputs: [''] });

    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-4',
      label: 'Account 4',
    });
    expect(loadConfig().config.accounts.nextAccountNumber).toBe(5);
  });

  it('switches a logged-in account while preserving the current Grok model', async () => {
    configureAccounts();
    const extension = setup({
      auth: {
        'grok-cli': oauthCredential('personal'),
        'grok-cli-2': oauthCredential('work'),
      },
      model: { provider: 'grok-cli', id: 'grok-composer-2.5-fast' },
      preserveHome: true,
      selections: ['Work — Logged in'],
    });

    await runAccountsCommand(extension);

    expect(extension.setModel).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      id: 'grok-composer-2.5-fast',
    });
    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli-2');
  });

  it('uses grok-build when switching from a non-Grok model', async () => {
    configureAccounts();
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      model: { provider: 'openai', id: 'gpt-5' },
      preserveHome: true,
      selections: ['Work — Logged in'],
    });

    await runAccountsCommand(extension);

    expect(extension.setModel).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      id: 'grok-build',
    });
  });

  it('prefills login instead of switching an unauthenticated account', async () => {
    configureAccounts();
    const extension = setup({ preserveHome: true, selections: ['Work — Login required'] });

    await runAccountsCommand(extension);

    expect(extension.setEditorText).toHaveBeenCalledWith('/login grok-cli-2');
    expect(extension.setModel).not.toHaveBeenCalled();
  });

  it('does not persist a switch when Pi rejects the model change', async () => {
    configureAccounts();
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      preserveHome: true,
      selections: ['Work — Logged in'],
      setModel: [false],
    });

    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli');
    expect(extension.notify).toHaveBeenCalledWith(
      'Could not switch to “Work”; authentication is unavailable.',
      'error',
    );
  });

  it('rejects duplicate, controlled, and overlong labels before adding an account', async () => {
    configureAccounts();
    const extension = setup({
      preserveHome: true,
      selections: ['＋ Add account'],
      inputs: [' work ', 'bad\nlabel', 'bad\u009blabel', 'x'.repeat(41), 'Client'],
    });

    await runAccountsCommand(extension);

    expect(extension.notify.mock.calls.map(([message]) => message)).toEqual([
      'An account named “work” already exists.',
      'Account labels cannot contain control characters.',
      'Account labels cannot contain control characters.',
      'Account labels must be 40 characters or fewer.',
    ]);
    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-3',
      label: 'Client',
    });
  });

  it('renames an account and updates its provider display registration', async () => {
    configureAccounts();
    const extension = setup({
      selections: ['Manage accounts', 'Work — Login required', 'Rename'],
      inputs: ['Client'],
      preserveHome: true,
    });

    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.items[1]?.label).toBe('Client');
    expect(extension.registerAccount).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      label: 'Client',
    });
  });

  it('logs out and removes an inactive alias after confirmation', async () => {
    configureAccounts();
    const extension = setup({
      auth: {
        'grok-cli': oauthCredential('personal'),
        'grok-cli-2': oauthCredential('work'),
      },
      confirms: [true],
      model: { provider: 'grok-cli', id: 'grok-build' },
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Logged in', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.authStorage.has('grok-cli-2')).toBe(false);
    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Personal' },
    ]);
    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-2');
  });

  it('leaves an alias untouched when removal confirmation is cancelled', async () => {
    configureAccounts();
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      confirms: [false],
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Logged in', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.authStorage.has('grok-cli-2')).toBe(true);
    expect(loadConfig().config.accounts.items).toHaveLength(2);
    expect(extension.unregisterProvider).not.toHaveBeenCalled();
  });

  it('switches away before removing the active alias', async () => {
    configureAccounts('grok-cli-2');
    const extension = setup({
      auth: {
        'grok-cli': oauthCredential('personal'),
        'grok-cli-2': oauthCredential('work'),
      },
      confirms: [true],
      model: { provider: 'grok-cli-2', id: 'grok-composer-2.5-fast' },
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Active', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.setModel).toHaveBeenCalledWith({
      provider: 'grok-cli',
      id: 'grok-composer-2.5-fast',
    });
    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli');
    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-2');
  });

  it('defers unregistering an active alias when no authenticated fallback exists', async () => {
    configureAccounts('grok-cli-2');
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      confirms: [true],
      model: { provider: 'grok-cli-2', id: 'grok-build' },
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Active', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.unregisterProvider).not.toHaveBeenCalled();
    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Personal' },
    ]);

    extension.accountManagement.handleModelSelect({
      model: { provider: 'openai' },
      previousModel: { provider: 'grok-cli-2' },
    });

    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-2');
  });

  it('prefills native Pi relogin from account management', async () => {
    configureAccounts();
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Logged in', 'Log in again'],
    });

    await runAccountsCommand(extension);

    expect(extension.setEditorText).toHaveBeenCalledWith('/login grok-cli-2');
  });

  it('keeps the base slot and resets its label when logging out', async () => {
    configureAccounts('grok-cli', [{ provider: 'grok-cli', label: 'Personal' }], 2);
    const extension = setup({
      auth: { 'grok-cli': oauthCredential('personal') },
      confirms: [true],
      preserveHome: true,
      selections: ['Manage accounts', 'Personal — Active', 'Log out'],
    });

    await runAccountsCommand(extension);

    expect(extension.authStorage.has('grok-cli')).toBe(false);
    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Account 1' },
    ]);
    expect(extension.unregisterProvider).not.toHaveBeenCalled();
  });

  it('keeps the selected alias when logging out of the inactive base account', async () => {
    configureAccounts('grok-cli-2');
    const extension = setup({
      auth: {
        'grok-cli': oauthCredential('personal'),
        'grok-cli-2': oauthCredential('work'),
      },
      confirms: [true],
      preserveHome: true,
      selections: ['Manage accounts', 'Personal — Logged in', 'Log out'],
    });

    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli-2');
    expect(loadConfig().config.accounts.items[0]?.label).toBe('Account 1');
  });

  it('explains that a base environment token cannot be logged out from Pi', async () => {
    const original = process.env.GROK_CLI_OAUTH_TOKEN;
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';
    try {
      const extension = setup({
        selections: [
          'Manage accounts',
          'Account 1 — Active (environment)',
          'Environment token instructions',
        ],
      });

      await runAccountsCommand(extension);

      expect(extension.notify).toHaveBeenCalledWith(
        'Unset GROK_CLI_OAUTH_TOKEN and restart Pi to remove the environment token.',
        'info',
      );
      expect(extension.authStorage.has('grok-cli')).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN;
      else process.env.GROK_CLI_OAUTH_TOKEN = original;
    }
  });

  it('persists a Grok alias selected through Pi model controls', () => {
    configureAccounts();
    const extension = setup({ preserveHome: true });

    extension.accountManagement.handleModelSelect({
      model: { provider: 'grok-cli-2' },
      previousModel: { provider: 'grok-cli' },
    });

    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli-2');
  });
});
