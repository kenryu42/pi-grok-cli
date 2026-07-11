import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model, OAuthCredentials, OAuthProviderInterface } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROK_SHIM_TOOL_NAMES, grokToolsToActivate } from '../../src/tools/register.js';
import * as webSearchDelegate from '../../src/tools/webSearchDelegate.js';

const { streamSimpleOpenAIResponses, mockPiWebAccessInstalled } = vi.hoisted(() => ({
  mockPiWebAccessInstalled: vi.fn(() => true),
  streamSimpleOpenAIResponses: vi.fn(
    (
      _model: unknown,
      _context: unknown,
      options?: {
        onResponse?: (response: { headers: Record<string, string> }) => void;
      },
    ) => {
      options?.onResponse?.({
        headers: {
          'x-ratelimit-remaining-requests': '179',
          'x-ratelimit-limit-requests': '180',
          'x-ratelimit-remaining-tokens': '7500000',
          'x-ratelimit-limit-tokens': '7500000',
          'x-grok-context-window': '512000',
          'x-zero-data-retention': 'true',
        },
      });
      return {};
    },
  ),
}));

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai/compat')>()),
  streamSimpleOpenAIResponses,
}));

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
  process.env.TZ = 'America/New_York';
});

afterEach(() => {
  vi.resetModules();
  streamSimpleOpenAIResponses.mockClear();
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
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools,
  } as unknown as ExtensionAPI);
  return { commands, providers, tools, handlers, setActiveTools };
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

function contextForModel(provider: string): TestContext {
  return {
    model: { provider, id: `${provider}-model` },
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

const theme = {
  bold: (text: string) => text,
  fg: (_name: string, text: string) => text,
};

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

  it('omits malformed weekly billing data while preserving monthly usage', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    globalThis.fetch = billingFetchMock(
      billingResponse(4000, 172, '2026-01-01T00:00:00+00:00'),
      creditsResponse('invalid', 'not-a-date'),
    );
    const notify = await runStatus(await setupExtension());
    const message = notify.mock.calls.at(-1)?.[0] as string;

    expect(message).toContain('172 / 4,000 used  4%');
    expect(message).not.toContain('Weekly');
  });

  it('uses the registered provider token when no env token is set', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      billingResponse(4000, 100, '2026-07-01T00:00:00+00:00'),
    );
    globalThis.fetch = fetchMock;
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-usage')?.handler([], {
      ...statusContext(notify),
      modelRegistry: {
        ...statusContext(notify).modelRegistry,
        getApiKeyForProvider: async () => 'provider-token',
      },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer provider-token',
    });
    expect(notify.mock.calls.at(-1)?.[0]).toContain('100 / 4,000 used  3%');
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

  it('does not persist billing usage to the global pi config directory', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    const home = setupHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingResponse(4000, 1421, '2026-07-01T00:00:00+00:00'),
    );
    const extension = await setupExtension();
    await runStatus(extension);

    expect(existsSync(join(home, '.pi', 'grok-cli-quota.json'))).toBe(false);
  });

  it('rejects invalid billing payloads instead of caching NaN values', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    const home = setupHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingResponse('4000', 1421, '2026-07-01T00:00:00+00:00'),
    );
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(existsSync(join(home, '.pi', 'grok-cli-quota.json'))).toBe(false);
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

  it('shows no billing data when refresh fails', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    setupHome();
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(notify).toHaveBeenCalledWith(
      'Grok CLI billing refresh failed: billing endpoint returned 500',
      'warning',
    );
    expect(notify.mock.calls.at(-1)?.[0]).toContain(
      'no billing data available — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
    );
  });

  it('does not cache stream response rate-limit headers as quota', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    const home = setupHome();
    const extension = await setupExtension();
    extension.providers
      .get('grok-cli')
      ?.streamSimple?.(
        { provider: 'grok-cli', id: 'grok-build' } as Model<Api>,
        { messages: [] },
        {},
      );

    expect(existsSync(join(home, '.pi', 'grok-cli-quota.json'))).toBe(false);
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
  it('registers provider metadata and OAuth helpers', async () => {
    const extension = await setupExtension();
    const provider = extension.providers.get('grok-cli');

    expect(provider?.name).toBe('Grok CLI');
    expect(provider?.api).toBe('openai-responses');
    expect(provider?.apiKey).toBe('$GROK_CLI_OAUTH_TOKEN');
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
  it('registers the Grok/Cursor-native tool shims', async () => {
    const extension = await setupExtension();

    expect([...extension.tools.keys()].sort()).toEqual([...grokToolsToActivate()].sort());
  });

  it('does not register WebSearch when pi-web-access is not installed', async () => {
    const extension = await setupExtension(['read', 'bash'], false);

    expect([...extension.tools.keys()].sort()).toEqual([...GROK_SHIM_TOOL_NAMES].sort());
    expect(extension.tools.has('WebSearch')).toBe(false);
  });

  it('enables Grok tools for Grok models while preserving other active tools', async () => {
    const extension = await setupExtension(['read', 'custom_tool', 'web_search']);

    await extension.handlers.get('model_select')?.(
      { model: { provider: 'grok-cli', id: 'grok-build' } },
      contextForModel('grok-cli'),
    );

    const next = extension.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(next).not.toContain('web_search');
    expect(next).toEqual(['read', 'custom_tool', ...grokToolsToActivate()]);
  });

  it('removes Grok tools for non-Grok models while preserving other active tools', async () => {
    const extension = await setupExtension(['read', 'Grep', 'custom_tool', 'Shell']);

    await extension.handlers.get('model_select')?.(
      { model: { provider: 'openai', id: 'gpt-4' } },
      contextForModel('openai'),
    );

    expect(extension.setActiveTools).toHaveBeenLastCalledWith(['read', 'custom_tool']);
  });

  it('syncs tool scope before each agent turn from the current context model', async () => {
    const extension = await setupExtension(['read']);

    await extension.handlers.get('before_agent_start')?.({}, contextForModel('grok-cli'));

    expect(extension.setActiveTools).toHaveBeenLastCalledWith(['read', ...grokToolsToActivate()]);
  });

  it('does not update active tools when the selection is already correct', async () => {
    const extension = await setupExtension(['read', ...grokToolsToActivate()]);

    await extension.handlers.get('before_agent_start')?.({}, contextForModel('grok-cli'));

    expect(extension.setActiveTools).not.toHaveBeenCalled();
  });
});

describe('Grok CLI tool rendering', () => {
  it('adds renderers to every Grok tool shim', async () => {
    const extension = await setupExtension();

    for (const name of grokToolsToActivate()) {
      expect(extension.tools.get(name)?.renderCall).toBeTypeOf('function');
      expect(extension.tools.get(name)?.renderResult).toBeTypeOf('function');
    }
  });

  it('keeps collapsed search output compact and expands to full output', async () => {
    const extension = await setupExtension();
    const grep = extension.tools.get('Grep');
    const result = {
      content: [{ type: 'text', text: 'src/a.ts:1:match\nsrc/b.ts:2:match' }],
      details: { matchCount: 2 },
    };

    const collapsed = renderText(
      grep?.renderResult?.(result, { expanded: false, isPartial: false }, theme, {}) as Renderable,
    );
    const expanded = renderText(
      grep?.renderResult?.(result, { expanded: true, isPartial: false }, theme, {}) as Renderable,
    );

    expect(collapsed).toBe('2 match(es)');
    expect(collapsed).not.toContain('src/a.ts');
    expect(expanded).toContain('src/a.ts:1:match');
  });

  it('renders compact summaries for file mutations, delete, and shell tools', async () => {
    const extension = await setupExtension();

    expect(
      renderText(
        extension.tools.get('Write')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long write output' }],
            details: { bytesWritten: 42 },
          },
          { expanded: false, isPartial: false },
          theme,
          {},
        ) as Renderable,
      ),
    ).toBe('42 bytes written');
    expect(
      renderText(
        extension.tools.get('StrReplace')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long replace output' }],
            details: { replacements: 3 },
          },
          { expanded: false, isPartial: false },
          theme,
          {},
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
          {},
        ) as Renderable,
      ),
    ).toBe('Deleted');
    expect(
      renderText(
        extension.tools.get('Shell')?.renderResult?.(
          {
            content: [{ type: 'text', text: 'long shell output' }],
            details: { exitCode: 2 },
          },
          { expanded: false, isPartial: false },
          theme,
          {},
        ) as Renderable,
      ),
    ).toBe('Exit 2');
  });
});
