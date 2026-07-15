import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js';
import { loadQuotaCache, saveQuotaUsage } from '../../src/provider/quotaCache.js';
import { getQuotaCachePath } from '../../src/storage.js';
import { GROK_SHIM_TOOL_NAMES } from '../../src/tools/register.js';
import * as webSearchDelegate from '../../src/tools/webSearchDelegate.js';
import { plainTheme as theme } from '../tools/toolTestHelpers.js';
import { saveTestAccounts } from '../vision/helpers.js';

const { mockOauthLogin, mockPiWebAccessInstalled } = vi.hoisted(() => ({
  mockOauthLogin: vi.fn(),
  mockPiWebAccessInstalled: vi.fn(() => true),
}));

vi.mock('../../src/auth/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/oauth.js')>();
  return { ...actual, login: mockOauthLogin };
});

vi.mock('../../src/tools/webSearchDelegate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/webSearchDelegate.js')>();
  return {
    ...actual,
    isPiWebAccessInstalled: () => mockPiWebAccessInstalled(),
    bindLivePiWebAccess: vi.fn(),
    ensureWebSearchDelegate: vi.fn(async () => undefined),
  };
});

interface CommandConfig {
  handler: (args: string[], ctx: TestContext) => Promise<void>;
}

interface RegisteredTool {
  name: string;
  renderCall?: (...args: unknown[]) => Renderable;
  renderResult?: (...args: unknown[]) => Renderable;
}

interface Renderable {
  render: (width: number) => string[];
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

async function setupExtension(initialActiveTools = ['read', 'bash'], piWebAccessInstalled = true) {
  vi.spyOn(webSearchDelegate, 'isPiWebAccessInstalled').mockReturnValue(piWebAccessInstalled);
  const commands = new Map<string, CommandConfig>();
  const providers = new Map<string, ProviderConfig>();
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, ExtensionHandler>();
  let activeTools = initialActiveTools;
  const setActiveTools = vi.fn((toolNames: string[]) => {
    activeTools = toolNames;
  });
  const registerGrokCli = (await import('../../src/index.js')).default;
  registerGrokCli({
    registerProvider(name: string, config: ProviderConfig) {
      providers.set(name, config);
    },
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, config: unknown) {
      commands.set(name, config as CommandConfig);
    },
    registerEntryRenderer() {},
    appendEntry() {},
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
  } as unknown as ExtensionAPI);
  return {
    commands,
    providers,
    tools,
    handlers,
    setActiveTools,
    getActiveTools: () => activeTools,
    replaceActiveTools(nextTools: string[]) {
      activeTools = [...nextTools];
    },
  };
}

function statusContext(notify: TestContext['ui']['notify']): TestContext {
  return {
    modelRegistry: {
      getAll: () => [
        { provider: 'grok-cli', id: 'grok-build' },
        { provider: 'grok-cli', id: 'grok-composer-2.5-fast' },
      ],
    },
    ui: { notify },
  };
}

function emptyStatusContext(notify: TestContext['ui']['notify']): TestContext {
  return {
    modelRegistry: { getAll: () => [] },
    ui: { notify },
  };
}

function contextForModel(provider: string, id = `${provider}-model`): TestContext {
  return {
    model: { provider, id },
    modelRegistry: { getAll: () => [] },
    ui: { notify: vi.fn() },
  };
}

function renderText(component: Renderable): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join('\n');
}

function renderContext(args: Record<string, unknown> = {}) {
  return {
    args,
    toolCallId: 'tool-call-id',
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: '/project',
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
}

function setupHome() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-home-'));
  mkdirSync(join(dir, '.pi'));
  tempDirs.push(dir);
  process.env.HOME = dir;
  return dir;
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

  it('uses the registered provider token when no env token is set', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    saveConfig({
      ...DEFAULT_CONFIG,
      accounts: {
        nextAccountNumber: 3,
        selectedProvider: 'grok-cli-2',
        items: [
          { provider: 'grok-cli', label: 'Personal' },
          { provider: 'grok-cli-2', label: 'Work' },
        ],
      },
    });
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
        getAll: () => [{ provider: 'grok-cli-2', id: 'grok-build' }],
        getApiKeyForProvider,
      },
    });

    expect(getApiKeyForProvider).toHaveBeenCalledWith('grok-cli-2');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer provider-token',
    });
    expect(notify.mock.calls.at(-1)?.[0]).toContain('100 / 4,000 used  3%');
    expect(loadQuotaCache().accounts['grok-cli-2']?.monthly.used).toBe(100);
    expect(loadQuotaCache().accounts['grok-cli']).toBeUndefined();
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
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingResponse(4000, 1421, '2026-07-01T00:00:00+00:00'),
    );
    const extension = await setupExtension();
    await runStatus(extension);

    expect(loadQuotaCache().accounts['grok-cli']).toMatchObject({
      monthly: { monthlyLimit: 4000, used: 1421 },
    });
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
      'grok-cli',
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
  it('clears cached quota after a successful OAuth login', async () => {
    await saveQuotaUsage('grok-cli', {
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

    expect(provider?.name).toBe('Grok CLI — Account 1');
    expect(provider?.api).toBe('openai-responses');
    expect(provider?.apiKey).toBe('$GROK_CLI_OAUTH_TOKEN');
    expect(provider?.streamSimple).toBeUndefined();
    expect(provider?.models?.map((model) => model.id)).toContain('grok-build');
    expect((provider?.oauth as Omit<OAuthProviderInterface, 'id'>)?.usesCallbackServer).toBe(true);
    expect(provider?.oauth?.getApiKey({ access: 'access-token', refresh: '', expires: 0 })).toBe(
      'access-token',
    );
    expect(
      provider?.oauth?.modifyModels?.(
        [
          { provider: 'grok-cli', id: 'grok-build', baseUrl: 'old' } as Model<Api>,
          { provider: 'openai', id: 'gpt-4', baseUrl: 'keep' } as Model<Api>,
        ],
        {
          access: 'access-token',
          refresh: 'refresh-token',
          expires: 123,
          baseUrl: 'https://example.invalid/custom///',
        } as OAuthCredentials,
      ),
    ).toEqual([
      {
        provider: 'grok-cli',
        id: 'grok-build',
        baseUrl: 'https://example.invalid/custom',
      },
      { provider: 'openai', id: 'gpt-4', baseUrl: 'keep' },
    ]);
  });

  it('registers configured aliases with independent OAuth keys and labeled names', async () => {
    saveTestAccounts();

    const extension = await setupExtension();
    const base = extension.providers.get('grok-cli');
    const alias = extension.providers.get('grok-cli-2');

    expect(base?.name).toBe('Grok CLI — Personal');
    expect(base?.apiKey).toBe('$GROK_CLI_OAUTH_TOKEN');
    expect(alias?.name).toBe('Grok CLI — Work');
    expect(alias?.apiKey).toBeUndefined();
    expect(alias?.models?.map((model) => model.id)).toEqual(base?.models?.map((model) => model.id));
    expect(
      alias?.oauth?.modifyModels?.(
        [
          { provider: 'grok-cli', id: 'grok-build', baseUrl: 'base' } as Model<Api>,
          { provider: 'grok-cli-2', id: 'grok-build', baseUrl: 'old' } as Model<Api>,
        ],
        {
          access: 'access-token',
          refresh: 'refresh-token',
          expires: 123,
          baseUrl: 'https://example.invalid/work///',
        } as OAuthCredentials,
      ),
    ).toEqual([
      { provider: 'grok-cli', id: 'grok-build', baseUrl: 'base' },
      {
        provider: 'grok-cli-2',
        id: 'grok-build',
        baseUrl: 'https://example.invalid/work',
      },
    ]);
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

    expect(aliasEvent.headers).toEqual({ 'x-grok-conv-id': 'session-alias' });
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

    expect(aliasResult).toEqual({
      input: [],
      instructions: 'alias instruction',
      prompt_cache_key: 'session-alias',
    });
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
        ui: { notify },
      },
    );

    expect(notify).toHaveBeenCalledWith(
      '[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery',
      'warning',
    );
  });
});

describe('Grok CLI tool scoping', () => {
  it('migrates legacy configuration when the extension loads', async () => {
    const piDir = join(process.env.HOME as string, '.pi');
    writeFileSync(join(piDir, 'grok-cli-imagine.json'), JSON.stringify({ enabled: false }));

    await setupExtension();

    expect(existsSync(join(piDir, 'grok-cli', 'config.json'))).toBe(true);
    expect(existsSync(join(piDir, 'grok-cli-imagine.json'))).toBe(false);
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

  it('registers the Grok/Cursor-native tool shims', async () => {
    const extension = await setupExtension();

    expect([...extension.tools.keys()].sort()).toEqual(
      [...GROK_SHIM_TOOL_NAMES, 'WebSearch', 'image_gen'].sort(),
    );
  });

  it('does not register WebSearch when pi-web-access is not installed', async () => {
    const extension = await setupExtension(['read', 'bash'], false);

    expect([...extension.tools.keys()].sort()).toEqual(
      [...GROK_SHIM_TOOL_NAMES, 'image_gen'].sort(),
    );
    expect(extension.tools.has('WebSearch')).toBe(false);
  });

  it('uses only enabled compatibility capabilities for exact legacy models', async () => {
    const extension = await setupExtension(['read', 'custom_tool', 'web_search']);

    await extension.handlers.get('model_select')?.(
      { model: { provider: 'grok-cli', id: 'grok-build' } },
      contextForModel('grok-cli', 'grok-build'),
    );

    const next = extension.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(next).not.toContain('web_search');
    expect(next).toEqual(['Read', 'custom_tool', 'WebSearch', 'image_gen']);
    expect(next).not.toEqual(expect.arrayContaining(['Write', 'Delete', 'Shell']));
  });

  it('translates compatibility names back to native tools for non-Grok models', async () => {
    const extension = await setupExtension(['read', 'Grep', 'custom_tool', 'Shell']);

    await extension.handlers.get('model_select')?.(
      { model: { provider: 'openai', id: 'gpt-4' } },
      contextForModel('openai'),
    );

    expect(extension.setActiveTools).toHaveBeenLastCalledWith([
      'read',
      'grep',
      'custom_tool',
      'bash',
      'image_gen',
    ]);
  });

  it('syncs tool scope before each agent turn from the current context model', async () => {
    const extension = await setupExtension(['read']);

    await extension.handlers.get('before_agent_start')?.(
      {},
      contextForModel('grok-cli', 'grok-build'),
    );

    expect(extension.setActiveTools).toHaveBeenLastCalledWith(['Read', 'image_gen']);
  });

  it('does not update active tools when the selection is already correct', async () => {
    const extension = await setupExtension(['Read', 'image_gen']);

    await extension.handlers.get('before_agent_start')?.(
      {},
      contextForModel('grok-cli', 'grok-build'),
    );

    expect(extension.setActiveTools).not.toHaveBeenCalled();
  });

  it('keeps modern and unknown Grok models on native tools', async () => {
    for (const id of ['grok-4.5', 'future-model']) {
      const extension = await setupExtension(['read', 'bash']);

      await extension.handlers.get('model_select')?.(
        { model: { provider: 'grok-cli', id } },
        contextForModel('grok-cli', id),
      );

      expect(extension.getActiveTools()).toEqual(['read', 'bash', 'image_gen']);
    }
  });

  it('captures Delete on first session start and restores native names on shutdown', async () => {
    const extension = await setupExtension(['read', 'Delete']);

    await extension.handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      contextForModel('grok-cli', 'grok-build'),
    );
    expect(extension.getActiveTools()).toEqual(['Read', 'Delete', 'image_gen']);

    extension.replaceActiveTools(['Read', 'custom', 'image_gen']);
    await extension.handlers.get('session_shutdown')?.(
      { type: 'session_shutdown', reason: 'reload' },
      contextForModel('grok-cli', 'grok-build'),
    );
    expect(extension.getActiveTools()).toEqual(['read', 'custom', 'image_gen']);
  });

  it('reconciles live tool changes before the next legacy prompt', async () => {
    const extension = await setupExtension(['read']);
    await extension.handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      contextForModel('grok-cli', 'grok-build'),
    );
    extension.replaceActiveTools(['Read', 'write', 'custom', 'image_gen']);

    await extension.handlers.get('before_agent_start')?.(
      {},
      contextForModel('grok-cli', 'grok-build'),
    );

    expect(extension.getActiveTools()).toEqual(['Read', 'Write', 'custom', 'image_gen']);
  });

  it('leaves native web_search available when the optional adapter is unavailable', async () => {
    const extension = await setupExtension(['web_search'], false);

    await extension.handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      contextForModel('grok-cli', 'grok-build'),
    );

    expect(extension.getActiveTools()).toEqual(['web_search', 'image_gen']);
  });
});

describe('Grok CLI tool rendering', () => {
  it('adds renderers to every Grok tool shim', async () => {
    const extension = await setupExtension();

    for (const name of [...GROK_SHIM_TOOL_NAMES, 'WebSearch', 'image_gen']) {
      expect(extension.tools.get(name)?.renderCall).toBeTypeOf('function');
      expect(extension.tools.get(name)?.renderResult).toBeTypeOf('function');
    }
  });

  it('delegates collapsed and expanded search output rendering', async () => {
    const extension = await setupExtension();
    const grep = extension.tools.get('Grep');
    const result = {
      content: [{ type: 'text', text: 'src/a.ts:1:match\nsrc/b.ts:2:match' }],
      details: undefined,
    };

    const collapsed = renderText(
      grep?.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        theme,
        renderContext({ pattern: 'match' }),
      ) as Renderable,
    );
    const expanded = renderText(
      grep?.renderResult?.(
        result,
        { expanded: true, isPartial: false },
        theme,
        renderContext({ pattern: 'match' }),
      ) as Renderable,
    );

    expect(collapsed).toContain('src/a.ts:1:match');
    expect(collapsed).toContain('src/b.ts:2:match');
    expect(expanded).toContain('src/a.ts:1:match');
  });

  it('uses native results for delegated tools and retained summaries for custom tools', async () => {
    const extension = await setupExtension();

    expect(
      renderText(
        extension.tools.get('Write')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long write output' }],
            details: undefined,
          },
          { expanded: false, isPartial: false },
          theme,
          renderContext({ path: 'notes.txt', content: 'content' }),
        ) as Renderable,
      ),
    ).toBe('');
    expect(
      renderText(
        extension.tools.get('StrReplace')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long replace output' }],
            details: { replacements: 3 },
          },
          { expanded: false, isPartial: false },
          theme,
          renderContext({ path: 'notes.txt', old_str: 'old', new_str: 'new' }),
        ) as Renderable,
      ),
    ).toBe('3 replacement(s)');
    expect(
      renderText(
        extension.tools.get('Delete')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long delete output' }],
            details: { deleted: true },
          },
          { expanded: false, isPartial: false },
          theme,
          renderContext({ path: 'notes.txt' }),
        ) as Renderable,
      ),
    ).toBe('Deleted');
    expect(
      renderText(
        extension.tools.get('Shell')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long shell output' }],
            details: undefined,
          },
          { expanded: false, isPartial: false },
          theme,
          renderContext({ command: 'printf output' }),
        ) as Renderable,
      ),
    ).toContain('long shell output');
  });
});
