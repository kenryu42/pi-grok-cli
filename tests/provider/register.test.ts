import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
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
const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;
const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  streamSimpleOpenAIResponses.mockClear();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
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

async function runStatus(extension: Awaited<ReturnType<typeof setupExtension>>) {
  const notify = vi.fn();
  await extension.commands.get('grok-cli-status')?.handler([], statusContext(notify));
  return notify;
}

describe('Grok CLI status command', () => {
  it('uses only cached quota data and tells users to make requests first', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(notify.mock.calls.at(-1)?.[0]).toBe(
      [
        '  Quota:',
        '',
        '  grok-build:',
        '    no cached quota data — make a request with this model first',
        '',
        '  grok-composer-2.5-fast:',
        '    no cached quota data — make a request with this model first',
      ].join('\n'),
    );
  });

  it('shows separate cached quotas for build and composer', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    const extension = await setupExtension();
    const provider = extension.providers.get('grok-cli');
    provider?.streamSimple?.({ provider: 'grok-cli', id: 'grok-build' }, {}, {});
    provider?.streamSimple?.({ provider: 'grok-cli', id: 'grok-composer-2.5-fast' }, {}, {});
    const notify = await runStatus(extension);

    expect(notify.mock.calls.at(-1)?.[0]).toContain('grok-build:\n    Cached:');
    expect(notify.mock.calls.at(-1)?.[0]).toContain('grok-composer-2.5-fast:\n    Cached:');
    expect(notify.mock.calls.at(-1)?.[0]).toContain('Requests: 179/180 remaining');
  });

  it('shows cached quotas for registered Grok models instead of hard-coded names', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    setupHome();
    const extension = await setupExtension();
    extension.providers
      .get('grok-cli')
      ?.streamSimple?.({ provider: 'grok-cli', id: 'custom' }, {}, {});
    const notify = vi.fn();

    await extension.commands.get('grok-cli-status')?.handler([], {
      modelRegistry: {
        getAll: () => [{ provider: 'grok-cli', id: 'custom' }],
      },
      ui: { notify },
    });

    expect(notify.mock.calls.at(-1)?.[0]).toContain('custom:\n    Cached:');
    expect(notify.mock.calls.at(-1)?.[0]).not.toContain('grok-build:');
  });

  it('persists cached quotas to the global pi config directory', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    const home = setupHome();
    const extension = await setupExtension();
    extension.providers
      .get('grok-cli')
      ?.streamSimple?.({ provider: 'grok-cli', id: 'grok-build' }, {}, {});

    expect(
      JSON.parse(readFileSync(join(home, '.pi', 'grok-cli-quota.json'), 'utf8')).models[
        'grok-build'
      ].remainingRequests,
    ).toBe(179);
  });

  it('ignores incomplete quota headers instead of caching NaN values', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    const home = setupHome();
    streamSimpleOpenAIResponses.mockImplementationOnce((_model, _context, options) => {
      options?.onResponse?.({
        headers: {
          'x-ratelimit-remaining-tokens': '7500000',
          'x-ratelimit-limit-tokens': '7500000',
        },
      });
      return {};
    });
    const extension = await setupExtension();
    extension.providers
      .get('grok-cli')
      ?.streamSimple?.({ provider: 'grok-cli', id: 'grok-build' }, {}, {});
    const notify = await runStatus(extension);

    expect(existsSync(join(home, '.pi', 'grok-cli-quota.json'))).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0]).not.toContain('NaN');
    expect(notify.mock.calls.at(-1)?.[0]).toContain(
      'no cached quota data — make a request with this model first',
    );
  });

  it('loads cached quotas from the global pi config directory', async () => {
    delete process.env.GROK_CLI_OAUTH_TOKEN;
    const home = setupHome();
    writeFileSync(
      join(home, '.pi', 'grok-cli-quota.json'),
      JSON.stringify({
        version: 1,
        models: {
          'grok-build': {
            remainingRequests: 42,
            limitRequests: 180,
            remainingTokens: 1_000,
            limitTokens: 2_000,
            contextWindow: 512_000,
            zeroDataRetention: true,
            capturedAt: Date.now(),
          },
        },
      }),
    );
    const extension = await setupExtension();
    const notify = await runStatus(extension);

    expect(notify.mock.calls.at(-1)?.[0]).toContain('Requests: 42/180 remaining');
  });

  it('warns when no Grok models are registered', async () => {
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-status')?.handler([], emptyStatusContext(notify));

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      'Grok CLI: no models registered. Run /login grok-cli first.',
      'warning',
    );
  });

  it('shows env-token bypass and truncates long model lists', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'token';
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-status')?.handler([], {
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
    expect(notify.mock.calls[1]).toEqual([
      '✓ Grok CLI: 7 models available (grok-model-1, grok-model-2, grok-model-3, grok-model-4, grok-model-5 (+2 more))',
      'info',
    ]);
  });

  it('reports registry errors as status warnings', async () => {
    const extension = await setupExtension();
    const notify = vi.fn();

    await extension.commands.get('grok-cli-status')?.handler([], {
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

    await extension.commands.get('grok-cli-status')?.handler([], {
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
    expect(provider?.models.map((model) => model.id)).toContain('grok-build');
    expect(provider?.oauth?.getApiKey({ access: 'access-token' })).toBe('access-token');
    expect(
      provider?.oauth?.modifyModels(
        [
          { provider: 'grok-cli', id: 'grok-build', baseUrl: 'old' },
          { provider: 'openai', id: 'gpt-4', baseUrl: 'keep' },
        ],
        {
          access: 'access-token',
          refresh: 'refresh-token',
          expires: 123,
          baseUrl: 'https://example.invalid/custom///',
        },
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
