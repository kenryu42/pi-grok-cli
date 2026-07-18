import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import {
  isGrokCliProvider,
  planTier,
  registerAccountManagement,
  resolveGrokProvider,
  resolveGrokToken,
} from '../../src/provider/accounts.js';
import { loadQuotaCache, saveQuotaUsage } from '../../src/provider/quotaCache.js';
import { oauthCredential, TEST_ACCOUNTS, useTempHome } from '../vision/helpers.js';

const setupHome = useTempHome();
const originalFetch = globalThis.fetch;
const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  if (originalToken === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN;
  else process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
});

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

const authenticatedAccounts = () => ({
  'grok-cli': oauthCredential('personal'),
  'grok-cli-2': oauthCredential('work'),
});

const numberedAccounts = (count: number) =>
  Array.from({ length: count }, (_value, index) => ({
    provider: index === 0 ? 'grok-cli' : `grok-cli-${index + 1}`,
    label: `Account ${index + 1}`,
  }));

function setupRefresh(
  accounts: { provider: string }[],
  action: (component: Component) => Promise<void>,
) {
  return setup({
    auth: Object.fromEntries(
      accounts.map((account) => [account.provider, oauthCredential(account.provider)]),
    ),
    preserveHome: true,
    customActions: [action],
  });
}

async function runAccountsCommand(extension: ReturnType<typeof setup>) {
  await extension.commands.get('grok-cli-accounts')?.handler('', extension.context);
}

async function runAccountsCommandWith(extension: ReturnType<typeof setup>, args: string) {
  await extension.commands.get('grok-cli-accounts')?.handler(args, extension.context);
}

function setup(
  options: {
    auth?: Record<string, ReturnType<typeof oauthCredential>>;
    confirms?: boolean[];
    customActions?: ((component: Component) => Promise<void>)[];
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

  const credentials = new Map(Object.entries(options.auth ?? {}));
  const authStorage = {
    get: (provider: string) => credentials.get(provider),
    has: (provider: string) => credentials.has(provider),
    set: (provider: string, credential: ReturnType<typeof oauthCredential>) =>
      credentials.set(provider, credential),
  };
  const selections = [...(options.selections ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const customActions = [...(options.customActions ?? [])];
  const notify = vi.fn();
  const setEditorText = vi.fn();
  const customRenders: string[][] = [];
  const models = new Map<string, { provider: string; id: string }>();
  for (const provider of ['grok-cli', 'grok-cli-2', 'grok-cli-3']) {
    for (const id of ['grok-build', 'grok-composer-2.5-fast']) {
      models.set(`${provider}/${id}`, { provider, id });
    }
  }
  const context = {
    model: options.model,
    modelRegistry: {
      runtime: {
        login: vi.fn(),
        logout: async (provider: string) => {
          credentials.delete(provider);
        },
      },
      find: (provider: string, id: string) => models.get(`${provider}/${id}`),
      getProviderAuthStatus: (provider: string) => ({ configured: credentials.has(provider) }),
      getApiKeyForProvider: async (provider: string) => {
        const credential = authStorage.get(provider);
        return credential?.type === 'oauth' ? credential.access : undefined;
      },
    },
    ui: {
      confirm: vi.fn(async () => confirms.shift() ?? false),
      custom: vi.fn(
        async (
          factory: (
            tui: { requestRender: () => void },
            theme: { bold: (text: string) => string; fg: (_color: string, text: string) => string },
            keybindings: unknown,
            done: (value: string | undefined) => void,
          ) => Component | Promise<Component>,
        ) => {
          let resolveResult = (_value: string | undefined) => {};
          const result = new Promise<string | undefined>((resolve) => {
            resolveResult = resolve;
          });
          let component: Component;
          const tui = {
            requestRender() {
              customRenders.push(component.render(160));
            },
          };
          component = await factory(
            tui,
            { bold: (text) => text, fg: (_color, text) => text },
            {},
            resolveResult,
          );
          customRenders.push(component.render(160));
          const action = customActions.shift();
          if (action) {
            await action(component);
            return result;
          }
          const choice = selections.shift();
          if (choice === undefined) {
            component.handleInput?.('\u001b');
            return result;
          }
          for (let index = 0; index < 20; index += 1) {
            const selected = component.render(160).find((line) => line.startsWith('→ '));
            if (selected?.includes(choice)) {
              component.handleInput?.('\r');
              return result;
            }
            component.handleInput?.('\u001b[B');
          }
          throw new Error(`Could not select custom UI row: ${choice}`);
        },
      ),
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
    customRenders,
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

  it('maps monthly credit caps to plan tiers', () => {
    expect(planTier(0)).toBe('free');
    expect(planTier(4000)).toBe('supergrok-lite');
    expect(planTier(20000)).toBe('supergrok');
    expect(planTier(20001)).toBe('supergrok-heavy');
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
  it('rejects unknown arguments without opening the TUI', async () => {
    const extension = setup();

    await runAccountsCommandWith(extension, 'wat');

    expect(extension.notify).toHaveBeenCalledWith('Usage: /grok-cli-accounts [gui]', 'warning');
    expect(extension.context.ui.custom).not.toHaveBeenCalled();
  });

  it('produces a credential-free account snapshot for alternate interfaces', async () => {
    configureAccounts();
    await saveQuotaUsage('grok-cli-2', {
      monthly: {
        monthlyLimit: 2000,
        used: 700,
        billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      },
      weekly: {
        creditUsagePercent: 35,
        billingPeriodEnd: '2026-07-20T00:00:00.000Z',
      },
    });
    const extension = setup({ auth: authenticatedAccounts(), preserveHome: true });

    const snapshot = extension.accountManagement.manager.snapshot(
      extension.context as unknown as ExtensionContext,
    );

    expect(snapshot.accounts[1]).toMatchObject({
      provider: 'grok-cli-2',
      label: 'Work',
      authenticated: true,
      active: false,
      environment: false,
      plan: 'supergrok-lite',
      quota: {
        monthly: { monthlyLimit: 2000, used: 700 },
        weekly: { creditUsagePercent: 35 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('work-token');
  });

  it('reads authentication through the Pi 0.80.9 model-registry facade', () => {
    configureAccounts();
    const extension = setup({ auth: authenticatedAccounts(), preserveHome: true });
    const modelRegistry = extension.context.modelRegistry as unknown as {
      authStorage?: unknown;
      getProviderAuthStatus?: (provider: string) => { configured: boolean };
    };
    delete modelRegistry.authStorage;
    modelRegistry.getProviderAuthStatus = (provider) => ({
      configured: provider === 'grok-cli' || provider === 'grok-cli-2',
    });

    expect(
      extension.accountManagement.manager.snapshot(extension.context as unknown as ExtensionContext)
        .accounts,
    ).toEqual([
      expect.objectContaining({ provider: 'grok-cli', authenticated: true }),
      expect.objectContaining({ provider: 'grok-cli-2', authenticated: true }),
    ]);
  });

  it('shares add and rename mutations with alternate interfaces', async () => {
    const extension = setup();

    const account = await extension.accountManagement.manager.add(
      extension.context as unknown as ExtensionContext,
      ' Work ',
    );
    await extension.accountManagement.manager.rename(
      extension.context as unknown as ExtensionContext,
      account.provider,
      'Client',
    );

    expect(account.provider).toBe('grok-cli-2');
    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Account 1' },
      { provider: 'grok-cli-2', label: 'Client' },
    ]);
    expect(extension.registerAccount).toHaveBeenNthCalledWith(1, {
      provider: 'grok-cli-2',
      label: 'Work',
    });
    expect(extension.registerAccount).toHaveBeenNthCalledWith(2, {
      provider: 'grok-cli-2',
      label: 'Client',
    });
  });

  it('shows cached quota usage in both account selectors', async () => {
    configureAccounts();
    await saveQuotaUsage(
      'grok-cli',
      {
        monthly: {
          monthlyLimit: 2000,
          used: 300,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
        weekly: {
          creditUsagePercent: 60,
          billingPeriodEnd: '2026-07-20T00:00:00.000Z',
        },
      },
      new Date().toISOString(),
    );
    const extension = setup({
      auth: authenticatedAccounts(),
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Authenticated', 'Back'],
    });

    await runAccountsCommand(extension);

    expect(extension.context.ui.custom).toHaveBeenCalledTimes(2);
    expect(extension.customRenders[0]?.join('\n')).toContain(
      'Monthly 300 / 2,000 used · Weekly 60% used',
    );
    expect(extension.customRenders.at(-1)?.join('\n')).toContain('Quota not fetched · press r');
  });

  it('refreshes every logged-in account with r without changing models and preserves selection', async () => {
    configureAccounts();
    process.env.GROK_CLI_OAUTH_TOKEN = 'personal';
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const authorization = (init?.headers as Record<string, string>).authorization;
      const used = authorization === 'Bearer personal' ? 300 : 900;
      if (String(input).includes('format=credits')) {
        return Response.json({
          config: {
            currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
            creditUsagePercent: used === 300 ? 60 : 25,
            billingPeriodEnd: '2026-07-20T00:00:00.000Z',
          },
        });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: used },
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      });
    });
    globalThis.fetch = fetchMock;
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      preserveHome: true,
      customActions: [
        async (component) => {
          component.handleInput?.('\u001b[B');
          component.handleInput?.('r');
          component.handleInput?.('r');
          await vi.waitFor(() => {
            expect(Object.keys(loadQuotaCache().accounts)).toHaveLength(2);
          });
          expect(component.render(160).find((line) => line.startsWith('→ '))).toContain('Work');
          component.handleInput?.('\u001b');
        },
      ],
    });

    await runAccountsCommand(extension);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(loadQuotaCache().accounts['grok-cli']?.monthly.used).toBe(300);
    expect(loadQuotaCache().accounts['grok-cli-2']?.monthly.used).toBe(900);
    expect(extension.setModel).not.toHaveBeenCalled();
    expect(extension.customRenders.flat().join('\n')).toContain('Updated 2 accounts; 0 failed');
  });

  it('keeps cached quota on a partial refresh failure and marks only that row failed', async () => {
    configureAccounts();
    await saveQuotaUsage(
      'grok-cli-2',
      {
        monthly: {
          monthlyLimit: 2000,
          used: 700,
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      },
      new Date().toISOString(),
    );
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const authorization = (init?.headers as Record<string, string>).authorization;
      if (authorization === 'Bearer work') return new Response('nope', { status: 500 });
      if (String(input).includes('format=credits'))
        return new Response('no weekly', { status: 500 });
      return Response.json({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 300 },
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      });
    });
    const extension = setup({
      auth: authenticatedAccounts(),
      preserveHome: true,
      customActions: [
        async (component) => {
          component.handleInput?.('r');
          await vi.waitFor(() => {
            expect(component.render(160).join('\n')).toContain('Updated 1 accounts; 1 failed');
          });
          expect(component.render(160).join('\n')).toContain(
            'Monthly 700 / 2,000 used · Weekly unavailable',
          );
          expect(component.render(160).join('\n')).toContain('refresh failed');
          component.handleInput?.('\u001b');
        },
      ],
    });

    await runAccountsCommand(extension);

    expect(loadQuotaCache().accounts['grok-cli']?.monthly.used).toBe(300);
    expect(loadQuotaCache().accounts['grok-cli-2']?.monthly.used).toBe(700);
  });

  it('does not restore quota cache after an account is removed during refresh', async () => {
    configureAccounts();
    let releaseMonthly = () => {};
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('format=credits')) {
        return new Response('no weekly', { status: 500 });
      }
      await new Promise<void>((resolve) => {
        releaseMonthly = resolve;
      });
      return Response.json({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 900 },
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      });
    });
    const extension = setup({ auth: authenticatedAccounts(), preserveHome: true });
    const refresh = extension.accountManagement.manager.refreshOne(
      extension.context as unknown as ExtensionContext,
      'grok-cli-2',
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const removal = extension.accountManagement.manager.remove(
      extension.context as unknown as ExtensionContext,
      'grok-cli-2',
    );

    releaseMonthly();
    await Promise.all([refresh, removal]);

    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Personal' },
    ]);
    expect(loadQuotaCache().accounts['grok-cli-2']).toBeUndefined();
  });

  it('handles uppercase R with no authenticated accounts without fetching', async () => {
    configureAccounts();
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    const extension = setup({
      preserveHome: true,
      customActions: [
        async (component) => {
          component.handleInput?.('R');
          expect(component.render(35).join('\n')).toContain('No logged-in accounts to refresh');
          expect(component.render(35).join('\n')).toContain('Personal — Login required');
          component.handleInput?.('\u001b');
        },
      ],
    });

    await runAccountsCommand(extension);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts outstanding quota requests when the selector closes', async () => {
    const accounts = numberedAccounts(5);
    configureAccounts('grok-cli', accounts, 6);
    const aborted = vi.fn();
    globalThis.fetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const extension = setupRefresh(accounts, async (component) => {
      component.handleInput?.('r');
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));
      component.handleInput?.('\u001b');
    });

    await runAccountsCommand(extension);
    await vi.waitFor(() => expect(aborted).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(loadQuotaCache().accounts).toEqual({});
  });

  it('runs at most three account refreshes concurrently', async () => {
    const accounts = numberedAccounts(5);
    configureAccounts('grok-cli', accounts, 6);
    const releases: (() => void)[] = [];
    let active = 0;
    let maximum = 0;
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('format=credits'))
        return new Response('no weekly', { status: 500 });
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return Response.json({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 300 },
          billingPeriodEnd: '2026-08-01T00:00:00.000Z',
        },
      });
    });
    const extension = setupRefresh(accounts, async (component) => {
      component.handleInput?.('r');
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      expect(maximum).toBe(3);
      releases.splice(0).forEach((release) => {
        release();
      });
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases.splice(0).forEach((release) => {
        release();
      });
      await vi.waitFor(() => expect(Object.keys(loadQuotaCache().accounts)).toHaveLength(5));
      component.handleInput?.('\u001b');
    });

    await runAccountsCommand(extension);

    expect(maximum).toBe(3);
  });

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

  it('uses the lowest available alias number and its matching default label', async () => {
    configureAccounts('grok-cli', [{ provider: 'grok-cli', label: 'Account 1' }], 4);
    const extension = setup({ preserveHome: true, selections: ['＋ Add account'], inputs: [''] });

    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-2',
      label: 'Account 2',
    });
    expect(loadConfig().config.accounts.nextAccountNumber).toBe(3);
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
      selections: ['Work — Authenticated'],
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
      selections: ['Work — Authenticated'],
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
      selections: ['Work — Authenticated'],
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
    await saveQuotaUsage('grok-cli-2', {
      monthly: {
        monthlyLimit: 2000,
        used: 300,
        billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      },
    });
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
    expect(loadQuotaCache().accounts['grok-cli-2']?.monthly.used).toBe(300);
  });

  it('logs out and removes an inactive alias after confirmation', async () => {
    configureAccounts();
    await saveQuotaUsage('grok-cli-2', {
      monthly: {
        monthlyLimit: 2000,
        used: 300,
        billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      },
    });
    const extension = setup({
      auth: {
        'grok-cli': oauthCredential('personal'),
        'grok-cli-2': oauthCredential('work'),
      },
      confirms: [true],
      model: { provider: 'grok-cli', id: 'grok-build' },
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Authenticated', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.authStorage.has('grok-cli-2')).toBe(false);
    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Personal' },
    ]);
    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-2');
    expect(loadQuotaCache().accounts['grok-cli-2']).toBeUndefined();
  });

  it('reuses grok-cli-2 for the next account after removing that alias', async () => {
    configureAccounts();
    const extension = setup({
      auth: authenticatedAccounts(),
      confirms: [true],
      inputs: ['Replacement'],
      model: { provider: 'grok-cli', id: 'grok-build' },
      preserveHome: true,
      selections: [
        'Manage accounts',
        'Work — Authenticated',
        'Log out and remove',
        '＋ Add account',
      ],
    });

    await runAccountsCommand(extension);
    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Personal' },
      { provider: 'grok-cli-2', label: 'Replacement' },
    ]);
    expect(extension.registerAccount).toHaveBeenCalledWith({
      provider: 'grok-cli-2',
      label: 'Replacement',
    });
    expect(extension.setEditorText).toHaveBeenCalledWith('/login grok-cli-2');
  });

  it('does not reuse an active alias until its deferred unregister completes', async () => {
    configureAccounts('grok-cli-2');
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      confirms: [true],
      inputs: ['Temporary', 'Replacement'],
      model: { provider: 'grok-cli-2', id: 'grok-build' },
      preserveHome: true,
      selections: [
        'Manage accounts',
        'Work — Active',
        'Log out and remove',
        '＋ Add account',
        '＋ Add account',
      ],
    });

    await runAccountsCommand(extension);
    await runAccountsCommand(extension);

    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-3',
      label: 'Temporary',
    });

    extension.accountManagement.handleModelSelect({
      model: { provider: 'openai' },
      previousModel: { provider: 'grok-cli-2' },
    });
    await runAccountsCommand(extension);

    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-2');
    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-2',
      label: 'Replacement',
    });
    expect(extension.setEditorText.mock.calls.map(([value]) => value)).toEqual([
      '/login grok-cli-3',
      '/login grok-cli-2',
    ]);
  });

  it('leaves an alias untouched when removal confirmation is cancelled', async () => {
    configureAccounts();
    const extension = setup({
      auth: { 'grok-cli-2': oauthCredential('work') },
      confirms: [false],
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Authenticated', 'Log out and remove'],
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

  it('does not switch a non-Grok model when removing the selected alias', async () => {
    configureAccounts('grok-cli-2');
    const extension = setup({
      auth: authenticatedAccounts(),
      confirms: [true],
      model: { provider: 'openai', id: 'gpt-5' },
      preserveHome: true,
      selections: ['Manage accounts', 'Work — Active', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli');
    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-2');
  });

  it('keeps the selected account when removing another inactive alias', async () => {
    configureAccounts(
      'grok-cli-2',
      [...TEST_ACCOUNTS, { provider: 'grok-cli-3', label: 'Client' }],
      4,
    );
    const extension = setup({
      auth: {
        ...authenticatedAccounts(),
        'grok-cli-3': oauthCredential('client'),
      },
      confirms: [true],
      model: { provider: 'openai', id: 'gpt-5' },
      preserveHome: true,
      selections: ['Manage accounts', 'Client — Authenticated', 'Log out and remove'],
    });

    await runAccountsCommand(extension);

    expect(extension.setModel).not.toHaveBeenCalled();
    expect(loadConfig().config.accounts.selectedProvider).toBe('grok-cli-2');
    expect(extension.unregisterProvider).toHaveBeenCalledWith('grok-cli-3');
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
      selections: ['Manage accounts', 'Work — Authenticated', 'Log in again'],
    });

    await runAccountsCommand(extension);

    expect(extension.setEditorText).toHaveBeenCalledWith('/login grok-cli-2');
  });

  it('keeps the base slot and resets its label when logging out', async () => {
    configureAccounts('grok-cli', [{ provider: 'grok-cli', label: 'Personal' }], 2);
    await saveQuotaUsage('grok-cli', {
      monthly: {
        monthlyLimit: 2000,
        used: 300,
        billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      },
    });
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
    expect(loadQuotaCache().accounts['grok-cli']).toBeUndefined();
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
      selections: ['Manage accounts', 'Personal — Authenticated', 'Log out'],
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
