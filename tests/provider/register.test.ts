import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_VAULT_MARKER,
  getAccountVault,
  mutateAccountVault,
} from '../../src/provider/accountVault.js';
import { loadQuotaCache, saveQuotaUsage } from '../../src/provider/quotaCache.js';
import { getQuotaCachePath } from '../../src/storage.js';
import {
  deferred,
  oauthCredential,
  saveTestAccounts,
  setAccount1Credential,
} from '../stateTestHelpers.js';

const { mockOauthLogin, mockProviderStream } = vi.hoisted(() => ({
  mockOauthLogin: vi.fn(),
  mockProviderStream: vi.fn(),
}));

vi.mock('../../src/auth/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/oauth.js')>();
  return { ...actual, login: mockOauthLogin };
});

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimpleOpenAIResponses: mockProviderStream,
}));

interface CommandConfig {
  handler: (args: string[], ctx: TestContext) => Promise<void>;
}

interface RegisteredTool {
  name: string;
}

interface TestContext {
  cwd?: string;
  modelRegistry: {
    getAll: () => { provider: string; id: string }[];
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
  };
  model?: { provider: string; id: string };
  sessionManager?: {
    getSessionId: () => string;
    getBranch?: () => unknown[];
  };
  ui: {
    notify: (message: string, level: string) => void;
  };
}

type ExtensionHandler = (event: unknown, ctx: TestContext) => unknown;

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalTimeZone = process.env.TZ;
const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;
const tempDirs: string[] = [];

beforeEach(() => {
  mockOauthLogin.mockReset();
  mockOauthLogin.mockResolvedValue({
    access: 'new-access',
    refresh: 'new-refresh',
    expires: Date.now() + 60_000,
  });
  mockProviderStream.mockReset();
  mockProviderStream.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {},
    result: vi.fn(async () => ({
      role: 'assistant',
      content: [],
      api: 'openai-responses',
      provider: 'grok-cli',
      model: 'grok-build',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    })),
  }));
  process.env.TZ = 'America/New_York';
  const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-home-'));
  mkdirSync(join(dir, '.pi'));
  tempDirs.push(dir);
  process.env.HOME = dir;
});

afterEach(() => {
  vi.resetModules();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
  if (originalToken === undefined) {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
  } else {
    process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

async function setupExtension(initialActiveTools = ['read', 'bash']) {
  const commands = new Map<string, CommandConfig>();
  const providers = new Map<string, ProviderConfig>();
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, ExtensionHandler>();
  const allHandlers = new Map<string, ExtensionHandler[]>();
  let activeTools = initialActiveTools;
  const setActiveTools = vi.fn((toolNames: string[]) => {
    activeTools = toolNames;
  });
  const setModel = vi.fn(async (_model: { provider: string; id: string }) => true);
  const sendUserMessage = vi.fn();
  const entries: { customType: string; data: unknown }[] = [];
  const registerGrokCli = (await import('../../src/index.js')).default;
  registerGrokCli({
    registerProvider(name: string, config: ProviderConfig) {
      providers.set(name, config);
    },
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, handler);
      allHandlers.set(event, [...(allHandlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, config: unknown) {
      commands.set(name, config as CommandConfig);
    },
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return activeTools;
    },
    getAllTools() {
      return [
        'read',
        'bash',
        'edit',
        'write',
        'grep',
        'find',
        'ls',
        'web_search',
        ...tools.keys(),
      ].map((name) => ({ name }));
    },
    setActiveTools,
    setModel,
    sendUserMessage,
    entries,
  } as unknown as ExtensionAPI);
  return {
    commands,
    providers,
    tools,
    handlers,
    setActiveTools,
    setModel,
    sendUserMessage,
    entries,
    async emit(event: string, data: unknown, ctx: TestContext) {
      for (const handler of allHandlers.get(event) ?? []) await handler(data, ctx);
    },
    getActiveTools: () => activeTools,
  };
}

function sessionContext(sessionId: string, accountId?: string): TestContext {
  return {
    modelRegistry: { getAll: () => [] },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () =>
        accountId
          ? [
              {
                type: 'custom',
                id: 'account-entry',
                parentId: null,
                timestamp: new Date().toISOString(),
                customType: 'grok-cli-active-account-v1',
                data: { accountId },
              },
            ]
          : [],
    },
    ui: { notify: vi.fn() },
  };
}

async function drain(stream: AsyncIterable<unknown> | undefined) {
  if (!stream) throw new Error('Grok CLI test stream is missing.');
  for await (const _event of stream) {
    // The route setup completes before this empty test stream ends.
  }
}

function statusContext(notify: TestContext['ui']['notify']): TestContext {
  return {
    modelRegistry: {
      getAll: () => [
        { provider: 'grok-cli', id: 'grok-build' },
        { provider: 'grok-cli', id: 'grok-composer-2.5-fast' },
      ],
    },
    sessionManager: {
      getSessionId: () => 'session-a',
      getBranch: () => [],
    },
    ui: { notify },
  };
}

function emptyStatusContext(notify: TestContext['ui']['notify']): TestContext {
  return {
    modelRegistry: { getAll: () => [] },
    sessionManager: {
      getSessionId: () => 'session-a',
      getBranch: () => [],
    },
    ui: { notify },
  };
}

function contextForModel(provider: string, id = `${provider}-model`): TestContext {
  return {
    model: { provider, id },
    modelRegistry: { getAll: () => [] },
    sessionManager: {
      getSessionId: () => 'session-a',
      getBranch: () => [],
    },
    ui: { notify: vi.fn() },
  };
}

function setupHome() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-home-'));
  mkdirSync(join(dir, '.pi'));
  tempDirs.push(dir);
  process.env.HOME = dir;
  return dir;
}

function writeAuth(credentials: Record<string, unknown>) {
  const path = join(process.env.HOME as string, '.pi', 'agent', 'auth.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(credentials));
}

function writeMarker() {
  writeAuth({
    'grok-cli': {
      type: 'oauth',
      access: ACCOUNT_VAULT_MARKER,
      refresh: ACCOUNT_VAULT_MARKER,
      expires: Number.MAX_SAFE_INTEGER,
    },
  });
}

function billingResponse(monthlyLimit: unknown, used: unknown, billingPeriodEnd: unknown) {
  return Response.json({
    config: {
      monthlyLimit: { val: monthlyLimit },
      used: { val: used },
      billingPeriodEnd,
    },
  });
}

function creditsResponse(creditUsagePercent: unknown, billingPeriodEnd: string) {
  return Response.json({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-07T00:19:56+00:00',
        end: billingPeriodEnd,
      },
      creditUsagePercent,
      billingPeriodStart: '2026-07-07T00:19:56+00:00',
      billingPeriodEnd,
    },
  });
}

const billingFetchMock = (monthly: Response, credits: Response) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    return url.includes('format=credits') ? credits : monthly;
  });

async function runStatus(extension: Awaited<ReturnType<typeof setupExtension>>) {
  const notify = vi.fn();
  await extension.commands.get('grok-cli-usage')?.handler([], statusContext(notify));
  return notify;
}

describe('Grok CLI status command', () => {
  it('fetches monthly and weekly billing usage with the env token and no user id header', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    const fetchMock = billingFetchMock(
      billingResponse(4000, 1421, '2026-07-01T00:00:00+00:00'),
      creditsResponse(1.0, '2026-07-14T00:19:56+00:00'),
    );
    globalThis.fetch = fetchMock;
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cli-chat-proxy.grok.com/v1/billing');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer env-token',
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-userid');
    expect(notify.mock.calls.at(-1)?.[0]).toBe(
      [
        '  Usage:',
        '    Monthly',
        '      Credits    1,421 / 4,000 used  36%',
        '      Remaining  2,579 credits',
        '      Reset      Jun 30, 20:00 EDT America/New_York',
        '',
        '    Weekly',
        '      Limit      1% used',
        '      Reset      Jul 13, 20:19 EDT America/New_York',
      ].join('\n'),
    );
  });

  it('omits the weekly block when the credits endpoint is unavailable', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    const fetchMock = billingFetchMock(
      billingResponse(4000, 172, '2026-01-01T00:00:00+00:00'),
      new Response('nope', { status: 500 }),
    );
    globalThis.fetch = fetchMock;
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    );
    expect(notify.mock.calls.at(-1)?.[0]).toBe(
      [
        '  Usage:',
        '    Monthly',
        '      Credits    172 / 4,000 used  4%',
        '      Remaining  3,828 credits',
        '      Reset      Dec 31, 19:00 EST America/New_York',
      ].join('\n'),
    );
  });

  it('omits the weekly block when the reset timestamp is malformed', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    globalThis.fetch = billingFetchMock(
      billingResponse(4000, 172, '2026-01-01T00:00:00+00:00'),
      creditsResponse(1.0, 'not-a-date'),
    );
    const notify = await runStatus(await setupExtension());
    const message = notify.mock.calls.at(-1)?.[0] as string;

    expect(message).toContain('172 / 4,000 used  4%');
    expect(message).not.toContain('Weekly');
  });

  it('shows 0% weekly usage when creditUsagePercent is omitted at fresh-period start', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    globalThis.fetch = billingFetchMock(
      billingResponse(4000, 172, '2026-01-01T00:00:00+00:00'),
      creditsResponse(undefined, '2026-07-14T00:19:56+00:00'),
    );
    const notify = await runStatus(await setupExtension());

    expect(notify.mock.calls.at(-1)?.[0]).toBe(
      [
        '  Usage:',
        '    Monthly',
        '      Credits    172 / 4,000 used  4%',
        '      Remaining  3,828 credits',
        '      Reset      Dec 31, 19:00 EST America/New_York',
        '',
        '    Weekly',
        '      Limit      0% used',
        '      Reset      Jul 13, 20:19 EDT America/New_York',
      ].join('\n'),
    );
  });

  it('uses the active vault account when no environment token is set', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    await mutateAccountVault((vault) => {
      vault.migration.legacyCredentialCopyComplete = true;
      vault.accounts[0].credential = {
        access: 'provider-token',
        refresh: 'provider-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
      vault.activeAccountId = 'account-1';
    });
    writeMarker();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      billingResponse(4000, 100, '2026-07-01T00:00:00+00:00'),
    );
    globalThis.fetch = fetchMock;
    const extension = await setupExtension();
    const notify = vi.fn();
    const getApiKeyForProvider = vi.fn(async () => 'provider-token');

    await extension.commands.get('grok-cli-usage')?.handler([], {
      ...statusContext(notify),
      modelRegistry: {
        ...statusContext(notify).modelRegistry,
        getAll: () => [{ provider: 'grok-cli', id: 'grok-build' }],
        getApiKeyForProvider,
      },
    });

    expect(getApiKeyForProvider).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer provider-token',
    });
    expect(notify.mock.calls.at(-1)?.[0]).toContain('100 / 4,000 used  3%');
    expect(loadQuotaCache().accounts['account-1']?.monthly.used).toBe(100);
  });

  it('does not cache usage after the account changes during the request', async () => {
    await mutateAccountVault((vault) => {
      vault.migration.legacyCredentialCopyComplete = true;
      vault.accounts[0].credential = {
        ...oauthCredential('one'),
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
      vault.activeAccountId = 'account-1';
    });
    writeMarker();
    const monthly = deferred<Response>();
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('format=credits')) {
        return creditsResponse(10, '2026-07-14T00:19:56+00:00');
      }
      return monthly.promise;
    });
    const extension = await setupExtension();
    const notify = vi.fn();

    const pending = extension.commands.get('grok-cli-usage')?.handler([], statusContext(notify));
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    await mutateAccountVault((vault) => {
      delete vault.accounts[0].credential;
      vault.accounts[0].revision += 1;
      delete vault.activeAccountId;
    });
    monthly.resolve(billingResponse(4000, 100, '2026-07-01T00:00:00+00:00'));
    await pending;

    expect(loadQuotaCache().accounts['account-1']).toBeUndefined();
  });

  it('does not fetch billing when no token is available', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(notify.mock.calls.at(-1)?.[0]).toBe(
      [
        '  Usage:',
        '    no billing data available — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
      ].join('\n'),
    );
  });

  it('persists successful billing usage in the selected provider cache', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingResponse(4000, 1421, '2026-07-01T00:00:00+00:00'),
    );
    const extension = await setupExtension();
    await runStatus(extension);

    expect(loadQuotaCache().accounts['account-1']).toMatchObject({
      monthly: { monthlyLimit: 4000, used: 1421 },
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(existsSync(getQuotaCachePath())).toBe(true);
  });

  it('rejects invalid billing payloads instead of caching NaN values', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingResponse('4000', 1421, '2026-07-01T00:00:00+00:00'),
    );
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(existsSync(getQuotaCachePath())).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0]).toBe(
      [
        '  Usage:',
        '    no billing data available — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
      ].join('\n'),
    );
    expect(notify).toHaveBeenCalledWith(
      'Grok CLI billing refresh failed: invalid billing payload',
      'warning',
    );
  });

  it('rejects invalid billing reset timestamps', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () => billingResponse(4000, 1421, 'not-a-date'));
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(notify).toHaveBeenCalledWith(
      'Grok CLI billing refresh failed: invalid billing payload',
      'warning',
    );
    expect(notify.mock.calls.at(-1)?.[0]).toContain(
      'no billing data available — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
    );
  });

  it('shows the selected provider cached billing data when refresh fails', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    await saveQuotaUsage(
      'account-1',
      {
        monthly: {
          monthlyLimit: 4000,
          used: 1421,
          billingPeriodEnd: '2026-07-01T00:00:00+00:00',
        },
      },
      '2026-06-30T00:00:00.000Z',
    );
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(notify).toHaveBeenCalledWith(
      'Grok CLI billing refresh failed: billing endpoint returned 500',
      'warning',
    );
    expect(notify.mock.calls.at(-1)?.[0]).toContain('cached usage from');
    expect(notify.mock.calls.at(-1)?.[0]).toContain('1,421 / 4,000 used');
  });

  it('warns when no Grok models are registered', async () => {
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-usage')?.handler([], emptyStatusContext(notify));

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      'Grok CLI: no models registered. Run /login grok-cli first.',
      'warning',
    );
  });

  it('shows env-token bypass warning', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'token';
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-usage')?.handler([], {
      modelRegistry: {
        getAll: () =>
          Array.from({ length: 7 }, (_value, index) => ({
            provider: 'grok-cli',
            id: `grok-model-${index + 1}`,
          })),
      },
      ui: { notify },
    });

    expect(notify.mock.calls[0]).toEqual([
      '⚠️  Grok CLI: using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh available',
      'warning',
    ]);
  });

  it('reports registry errors as status warnings', async () => {
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-usage')?.handler([], {
      modelRegistry: {
        getAll: () => {
          throw new Error('registry unavailable');
        },
      },
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith('Grok CLI: registry unavailable', 'warning');
  });

  it('includes OAuth error codes in status warnings', async () => {
    const { XaiOAuthError } = await import('../../src/shared/errors.js');
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-usage')?.handler([], {
      modelRegistry: {
        getAll: () => {
          throw new XaiOAuthError('refresh failed', 'refresh_failed', true);
        },
      },
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith(
      'Grok CLI: refresh failed (code: refresh_failed)',
      'warning',
    );
  });
});

describe('Grok CLI provider registration', () => {
  it('registers one Grok CLI provider for all configured accounts', async () => {
    saveTestAccounts();

    const extension = await setupExtension();

    expect([...extension.providers.keys()]).toEqual(['grok-cli']);
    expect(extension.providers.get('grok-cli')?.name).toBe('Grok CLI');
  });

  it('routes two live Pi sessions through their own selected accounts', async () => {
    await mutateAccountVault((vault) => {
      vault.migration.legacyCredentialCopyComplete = true;
      vault.accounts[0].credential = {
        access: 'one',
        refresh: 'one-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
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
    writeMarker();
    const first = await setupExtension();
    const second = await setupExtension();
    await first.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      sessionContext('session-a', 'account-1'),
    );
    await second.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      sessionContext('session-b', 'work-id'),
    );
    const firstProvider = first.providers.get('grok-cli');
    const secondProvider = second.providers.get('grok-cli');
    const firstModel = firstProvider?.models?.[0];
    const secondModel = secondProvider?.models?.[0];
    if (!firstModel || !secondModel) throw new Error('Grok CLI test model is missing.');

    await Promise.all([
      drain(
        firstProvider.streamSimple?.(
          {
            ...firstModel,
            provider: 'grok-cli',
            api: 'openai-responses',
            baseUrl: 'https://cli-chat-proxy.grok.com',
          },
          { messages: [] },
          { sessionId: 'session-a' },
        ),
      ),
      drain(
        secondProvider.streamSimple?.(
          {
            ...secondModel,
            provider: 'grok-cli',
            api: 'openai-responses',
            baseUrl: 'https://cli-chat-proxy.grok.com',
          },
          { messages: [] },
          { sessionId: 'session-b' },
        ),
      ),
    ]);

    expect(mockProviderStream.mock.calls.map((call) => call[2]?.apiKey)).toEqual(['one', 'two']);
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
  });

  it('observes a failed provider result without creating an unhandled rejection', async () => {
    await setAccount1Credential('one');
    writeMarker();
    mockProviderStream.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {},
      result: () => Promise.reject(new Error('provider failed')),
    }));
    const extension = await setupExtension();
    const provider = extension.providers.get('grok-cli');
    const model = provider?.models?.[0];
    if (!model) throw new Error('Grok CLI test model is missing.');

    await drain(
      provider.streamSimple?.(
        {
          ...model,
          provider: 'grok-cli',
          api: 'openai-responses',
          baseUrl: 'https://cli-chat-proxy.grok.com',
        },
        { messages: [] },
        { sessionId: 'session-a' },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('stores the default account in a new Pi session', async () => {
    await setAccount1Credential('one');
    const extension = await setupExtension();

    await extension.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      sessionContext('session-a'),
    );

    expect(extension.entries).toContainEqual({
      customType: 'grok-cli-active-account-v1',
      data: { accountId: 'account-1' },
    });
  });

  it('uses the session account for the usage command', async () => {
    await mutateAccountVault((vault) => {
      vault.migration.legacyCredentialCopyComplete = true;
      vault.accounts[0].credential = {
        ...oauthCredential('one'),
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
      vault.accounts.push({
        id: 'work-id',
        slot: 2,
        label: 'Work',
        credential: {
          ...oauthCredential('two'),
          expires: Date.now() + 300_000,
        },
        revision: 1,
      });
      vault.nextSlot = 3;
      vault.activeAccountId = 'account-1';
    });
    writeMarker();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingResponse(4000, 100, '2026-07-01T00:00:00+00:00'),
    );
    const extension = await setupExtension();
    const context = sessionContext('session-b', 'work-id');
    context.modelRegistry.getAll = () => [{ provider: 'grok-cli', id: 'grok-build' }];
    await extension.emit('session_start', { type: 'session_start', reason: 'startup' }, context);

    await extension.commands.get('grok-cli-usage')?.handler([], context);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer two' }),
      }),
    );
  });

  it('uses OAuth and a custom stream in stored-account mode', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;

    const extension = await setupExtension();
    const provider = extension.providers.get('grok-cli');

    expect(provider?.oauth).toBeDefined();
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.streamSimple).toBeTypeOf('function');
  });

  it('uses only the environment API-key method when Pi has no stored OAuth credential', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';
    writeAuth({});

    const provider = (await setupExtension()).providers.get('grok-cli');

    expect(provider?.apiKey).toBe('$GROK_CLI_OAUTH_TOKEN');
    expect(provider?.oauth).toBeUndefined();
    expect(provider?.streamSimple).toBeTypeOf('function');
  });

  it('keeps only OAuth registration when an environment token and stored OAuth coexist', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';
    writeAuth({
      'grok-cli': {
        type: 'oauth',
        access: ACCOUNT_VAULT_MARKER,
        refresh: ACCOUNT_VAULT_MARKER,
        expires: Number.MAX_SAFE_INTEGER,
      },
    });

    const provider = (await setupExtension()).providers.get('grok-cli');

    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.oauth).toBeDefined();
  });

  it('stores a normal Grok login in Account 1 and returns only the Pi marker', async () => {
    const extension = await setupExtension();

    const result = await extension.providers
      .get('grok-cli')
      ?.oauth?.login({} as OAuthLoginCallbacks);

    expect(result).toEqual({
      access: ACCOUNT_VAULT_MARKER,
      refresh: ACCOUNT_VAULT_MARKER,
      expires: Number.MAX_SAFE_INTEGER,
    });
    await expect(getAccountVault()).resolves.toMatchObject({
      activeAccountId: 'account-1',
      accounts: [
        {
          id: 'account-1',
          credential: {
            access: 'new-access',
            refresh: 'new-refresh',
          },
          revision: 1,
        },
      ],
    });
  });

  it('does not restore Account 1 after it changes during OAuth login', async () => {
    const authorization = deferred<ReturnType<typeof oauthCredential>>();
    mockOauthLogin.mockReturnValueOnce(authorization.promise);
    const extension = await setupExtension();

    const pending = extension.providers.get('grok-cli')?.oauth?.login({} as OAuthLoginCallbacks);
    await mutateAccountVault((vault) => {
      vault.accounts[0].revision += 1;
    });
    authorization.resolve(oauthCredential('late-login'));

    await expect(pending).rejects.toThrow('account changed while login was in progress');
    expect((await getAccountVault()).accounts[0]).toMatchObject({ revision: 1 });
    expect((await getAccountVault()).accounts[0].credential).toBeUndefined();
  });

  it('reconnects an existing vault with no Pi credential or an existing marker', async () => {
    await mutateAccountVault((vault) => {
      vault.migration.legacyCredentialCopyComplete = true;
      vault.accounts[0].credential = {
        access: 'saved-access',
        refresh: 'saved-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision = 1;
      vault.activeAccountId = 'account-1';
    });
    const extension = await setupExtension();
    const provider = extension.providers.get('grok-cli');

    const disconnectedResult = await provider?.oauth?.login({} as OAuthLoginCallbacks);

    writeAuth({
      'grok-cli': {
        type: 'oauth',
        access: ACCOUNT_VAULT_MARKER,
        refresh: ACCOUNT_VAULT_MARKER,
        expires: Number.MAX_SAFE_INTEGER,
      },
    });
    const connectedResult = await provider?.oauth?.login({} as OAuthLoginCallbacks);

    expect(disconnectedResult?.access).toBe(ACCOUNT_VAULT_MARKER);
    expect(connectedResult?.access).toBe(ACCOUNT_VAULT_MARKER);
    expect(mockOauthLogin).not.toHaveBeenCalled();
  });

  it('installs the marker after copying the released Account 1 credential', async () => {
    saveTestAccounts('grok-cli');
    writeAuth({ 'grok-cli': oauthCredential('released-account') });
    const extension = await setupExtension();

    expect(
      (await extension.providers.get('grok-cli')?.oauth?.login({} as OAuthLoginCallbacks))?.access,
    ).toBe(ACCOUNT_VAULT_MARKER);
    expect(mockOauthLogin).not.toHaveBeenCalled();
    const vault = await getAccountVault();
    expect(vault).toMatchObject({
      activeAccountId: 'account-1',
      migration: { markerInstallPending: true },
    });
    expect(vault.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'account-1',
          credential: expect.objectContaining({ access: 'released-account' }),
        }),
      ]),
    );
  });

  it('does not replace a newer Account 1 login while installing the marker', async () => {
    saveTestAccounts('grok-cli');
    writeAuth({ 'grok-cli': oauthCredential('released-account') });
    const extension = await setupExtension();
    await extension.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      sessionContext('session-a'),
    );
    await mutateAccountVault((vault) => {
      vault.accounts[0].credential = {
        access: 'new-dashboard-login',
        refresh: 'new-dashboard-refresh',
        expires: Date.now() + 300_000,
      };
      vault.accounts[0].revision += 1;
    });

    await extension.providers.get('grok-cli')?.oauth?.login({} as OAuthLoginCallbacks);

    expect((await getAccountVault()).accounts[0].credential?.access).toBe('new-dashboard-login');
  });

  it('clears cached quota after a successful OAuth login', async () => {
    await saveQuotaUsage('account-1', {
      monthly: {
        monthlyLimit: 2000,
        used: 300,
        billingPeriodEnd: '2026-08-01T00:00:00.000Z',
      },
    });
    const extension = await setupExtension();

    await extension.providers.get('grok-cli')?.oauth?.login({} as OAuthLoginCallbacks);

    expect(mockOauthLogin).toHaveBeenCalledOnce();
    expect(loadQuotaCache().accounts['grok-cli']).toBeUndefined();
  });

  it('registers provider metadata and OAuth helpers', async () => {
    const extension = await setupExtension();
    const provider = extension.providers.get('grok-cli');

    expect(provider?.name).toBe('Grok CLI');
    expect(provider?.api).toBe('openai-responses');
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.streamSimple).toBeTypeOf('function');
    expect(provider?.models?.map((model) => model.id)).toContain('grok-build');
    expect(provider?.oauth?.usesCallbackServer).toBe(true);
    expect(provider?.oauth?.getApiKey({ access: 'access-token', refresh: '', expires: 0 })).toBe(
      'access-token',
    );
    expect(provider?.oauth?.modifyModels).toBeUndefined();
  });

  it('does not register provider aliases from the released account config', async () => {
    saveTestAccounts();

    const extension = await setupExtension();

    expect([...extension.providers.keys()]).toEqual(['grok-cli']);
  });

  it('adds conversation affinity headers only for Grok requests', async () => {
    const extension = await setupExtension();
    const grokEvent = { headers: { existing: 'keep' } as Record<string, string> };

    extension.handlers.get('before_provider_headers')?.(grokEvent, {
      ...contextForModel('grok-cli'),
      sessionManager: { getSessionId: () => 'session-123' },
    });

    expect(grokEvent.headers).toEqual({
      existing: 'keep',
      'x-grok-conv-id': 'session-123',
    });

    const openAiEvent = { headers: { existing: 'keep' } as Record<string, string> };
    extension.handlers.get('before_provider_headers')?.(openAiEvent, {
      ...contextForModel('openai'),
      sessionManager: { getSessionId: () => 'session-456' },
    });

    expect(openAiEvent.headers).toEqual({ existing: 'keep' });

    const aliasEvent = { headers: {} as Record<string, string> };
    extension.handlers.get('before_provider_headers')?.(aliasEvent, {
      ...contextForModel('grok-cli-2'),
      sessionManager: { getSessionId: () => 'session-alias' },
    });

    expect(aliasEvent.headers).toEqual({});
  });

  it('sanitizes Grok provider requests with the current session id', async () => {
    const extension = await setupExtension();
    const result = extension.handlers.get('before_provider_request')?.(
      {
        payload: {
          input: [{ role: 'system', content: 'system instruction' }],
        },
      },
      {
        cwd: process.cwd(),
        model: { provider: 'grok-cli', id: 'grok-4.3' },
        modelRegistry: { getAll: () => [] },
        sessionManager: { getSessionId: () => 'session-123' },
        ui: { notify: vi.fn() },
      },
    );

    expect(result).toEqual({
      input: [],
      instructions: 'system instruction',
      prompt_cache_key: 'session-123',
    });

    const aliasResult = extension.handlers.get('before_provider_request')?.(
      { payload: { input: [{ role: 'system', content: 'alias instruction' }] } },
      {
        cwd: process.cwd(),
        model: { provider: 'grok-cli-2', id: 'grok-build' },
        modelRegistry: { getAll: () => [] },
        sessionManager: { getSessionId: () => 'session-alias' },
        ui: { notify: vi.fn() },
      },
    );

    expect(aliasResult).toBeUndefined();
  });

  it('leaves non-Grok provider requests untouched', async () => {
    const extension = await setupExtension();
    const payload = { input: [{ role: 'system', content: 'keep' }] };
    const result = extension.handlers.get('before_provider_request')?.(
      { payload },
      {
        model: { provider: 'openai', id: 'gpt-4' },
        modelRegistry: { getAll: () => [] },
        sessionManager: { getSessionId: () => 'session-123' },
        ui: { notify: vi.fn() },
      },
    );

    expect(result).toBeUndefined();
    expect(payload).toEqual({ input: [{ role: 'system', content: 'keep' }] });
  });

  it('warns at session start when env-token bypass is active', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'token';
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.handlers.get('session_start')?.(
      {},
      {
        modelRegistry: { getAll: () => [] },
        sessionManager: {
          getSessionId: () => 'session-a',
          getBranch: () => [],
        },
        ui: { notify },
      },
    );

    expect(notify).toHaveBeenCalledWith(
      '[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery',
      'warning',
    );
  });
});

describe('Grok CLI feature registration', () => {
  it('migrates legacy configuration when the extension loads', async () => {
    const piDir = join(process.env.HOME as string, '.pi');
    writeFileSync(join(piDir, 'grok-cli-imagine.json'), JSON.stringify({ enabled: false }));

    const extension = await setupExtension();
    await extension.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      sessionContext('session-a'),
    );

    expect(existsSync(join(piDir, 'grok-cli', 'config.json'))).toBe(true);
    expect(existsSync(join(piDir, 'grok-cli-imagine.json'))).toBe(false);
  });

  it('imports the saved OAuth login before migrating a standalone Imagine setting', async () => {
    const piDir = join(process.env.HOME as string, '.pi');
    writeFileSync(join(piDir, 'grok-cli-imagine.json'), JSON.stringify({ enabled: false }));
    writeAuth({ 'grok-cli': oauthCredential('released-account') });
    const extension = await setupExtension();

    await extension.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      sessionContext('session-a'),
    );

    expect((await getAccountVault()).accounts[0].credential?.access).toBe('released-account');
    expect(JSON.parse(readFileSync(join(piDir, 'grok-cli', 'config.json'), 'utf8'))).toEqual({
      version: 3,
      imagine: { enabled: false },
    });
  });

  it('reports a migration failure only once at session start', async () => {
    const piDir = join(process.env.HOME as string, '.pi');
    writeFileSync(join(piDir, 'grok-cli-imagine.json'), '{ nope');
    const extension = await setupExtension();
    const context = contextForModel('grok-cli', 'grok-build');

    await extension.handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      context,
    );
    await extension.handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      context,
    );

    expect(context.ui.notify).toHaveBeenCalledTimes(1);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Could not read'),
      'warning',
    );
  });

  it('keeps a failed account migration blocking after its warning is shown', async () => {
    mkdirSync(join(process.env.HOME as string, '.pi', 'grok-cli'));
    writeFileSync(
      join(process.env.HOME as string, '.pi', 'grok-cli', 'config.json'),
      JSON.stringify({ version: 99 }),
    );
    const extension = await setupExtension();
    const context = contextForModel('grok-cli', 'grok-build');

    await extension.handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      context,
    );

    await expect(
      extension.providers.get('grok-cli')?.oauth?.login({} as OAuthLoginCallbacks),
    ).rejects.toThrow('Could not migrate Grok CLI accounts');
    expect(mockOauthLogin).not.toHaveBeenCalled();
  });

  it('registers only the image generation tool', async () => {
    const extension = await setupExtension();

    expect([...extension.tools.keys()]).toEqual(['image_gen']);
  });

  it('does not change the active account when a Grok model is selected', async () => {
    await setAccount1Credential('one');
    const extension = await setupExtension();

    const result = extension.handlers.get('model_select')?.(
      { model: { provider: 'grok-cli', id: 'grok-build' } },
      contextForModel('grok-cli', 'grok-build'),
    );

    expect(result).toBeUndefined();
    expect((await getAccountVault()).activeAccountId).toBe('account-1');
  });

  it('keeps native coding tools unchanged for Grok models', async () => {
    const extension = await setupExtension(['read', 'write', 'edit', 'bash']);

    await extension.handlers.get('model_select')?.(
      { model: { provider: 'grok-cli', id: 'grok-build' } },
      contextForModel('grok-cli', 'grok-build'),
    );

    expect(extension.getActiveTools()).toEqual(['read', 'write', 'edit', 'bash', 'image_gen']);
  });
});
