import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { handleReadResult } from '../../src/vision/describe.js';

const BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const PNG = Buffer.from('fake-png-bytes').toString('base64');

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;
const tempDirs: string[] = [];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-cli-vision-desc-'));
  mkdirSync(join(dir, '.pi'), { recursive: true });
  tempDirs.push(dir);
  process.env.HOME = dir;
  delete process.env.GROK_CLI_OAUTH_TOKEN;
  fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ output_text: 'a screenshot of a button' }),
  );
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalToken === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN;
  else process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

interface CtxOverrides {
  modelInput?: ('text' | 'image')[];
  apiKey?: string;
  signal?: AbortSignal;
  withKey?: boolean;
}

function buildCtx(overrides: CtxOverrides = {}): ExtensionContext {
  const hasKey = overrides.withKey !== false;
  return {
    model: { input: overrides.modelInput ?? ['text'] },
    modelRegistry: hasKey
      ? { getApiKeyForProvider: async () => overrides.apiKey ?? 'provider-token' }
      : {},
    ui: { notify: vi.fn() },
    signal: overrides.signal,
  } as unknown as ExtensionContext;
}

function readEvent(content: unknown[], toolName = 'read'): ToolResultEvent {
  return {
    type: 'tool_result',
    toolName,
    toolCallId: 'call-1',
    input: {},
    content,
    isError: false,
    details: undefined,
  } as unknown as ToolResultEvent;
}

function imageBlock(data = PNG): unknown {
  return { type: 'image', data, mimeType: 'image/png' };
}

function lastBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('handleReadResult — no-op cases', () => {
  it('does nothing when the active model handles images natively', async () => {
    const result = await handleReadResult(
      readEvent([imageBlock()]),
      buildCtx({ modelInput: ['text', 'image'] }),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes when the model has no declared input (treated as non-vision, matching the read tool)', async () => {
    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx({ modelInput: [] }));
    expect(result?.content[0]).toMatchObject({ type: 'text' });
    expect((result?.content[0] as { text: string }).text).toContain('described by grok-build');
  });

  it('does nothing for a non-read tool', async () => {
    const result = await handleReadResult(readEvent([imageBlock()], 'bash'), buildCtx());
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the read result has no images', async () => {
    const result = await handleReadResult(
      readEvent([{ type: 'text', text: 'just text' }]),
      buildCtx(),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when routing is disabled via config', async () => {
    const configPath = join(process.env.HOME as string, '.pi', 'grok-cli.json');
    mkdirSync(join(process.env.HOME as string, '.pi'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        vision: { ...DEFAULT_CONFIG.vision, enabled: false },
      }),
    );

    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx());
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleReadResult — image routing', () => {
  it('describes an image via grok-build and replaces it with text', async () => {
    const ctx = buildCtx();
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/responses`);

    const body = lastBody();
    expect(body.model).toBe('grok-build');
    expect(body.stream).toBe(false);
    const content = (body.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content[1]).toEqual({
      type: 'input_image',
      image_url: `data:image/png;base64,${PNG}`,
      detail: 'auto',
    });

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer provider-token');
    expect(headers['x-grok-model-override']).toBe('grok-build');

    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual({
      type: 'text',
      text: '[Image 1 — described by grok-build]\na screenshot of a button',
    });
  });

  it('reuses a cached description without calling the API on the second sight', async () => {
    const ctx = buildCtx();
    await handleReadResult(readEvent([imageBlock()]), ctx);
    await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('prefers the GROK_CLI_OAUTH_TOKEN env var as the bearer', async () => {
    process.env.GROK_CLI_OAUTH_TOKEN = 'env-token';
    await handleReadResult(readEvent([imageBlock()]), buildCtx({ apiKey: 'should-not-be-used' }));

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer env-token');
  });

  it('describes multiple images with preserved order and labels', async () => {
    const result = await handleReadResult(
      readEvent([
        imageBlock(Buffer.from('img-a').toString('base64')),
        imageBlock(Buffer.from('img-b').toString('base64')),
      ]),
      buildCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.content).toEqual([
      { type: 'text', text: '[Image 1 — described by grok-build]\na screenshot of a button' },
      { type: 'text', text: '[Image 2 — described by grok-build]\na screenshot of a button' },
    ]);
  });

  it('preserves text when replacing images in mixed read results', async () => {
    const result = await handleReadResult(
      readEvent([{ type: 'text', text: 'file metadata' }, imageBlock()]),
      buildCtx(),
    );

    expect(result?.content).toEqual([
      { type: 'text', text: 'file metadata' },
      { type: 'text', text: '[Image 1 — described by grok-build]\na screenshot of a button' },
    ]);
  });

  it('stays silent while describing and writes the cache file', async () => {
    const ctx = buildCtx();
    await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringMatching(/Describing image/),
      'info',
    );
    const cachePath = join(process.env.HOME as string, '.pi', 'grok-cli-vision-cache.json');
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(Object.keys(cache.entries)).toHaveLength(1);
  });
});

describe('handleReadResult — failure handling', () => {
  it('returns a text error and warns when the API rejects the request', async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response('bad model', { status: 400 }));
    globalThis.fetch = fetchMock;

    const ctx = buildCtx();
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result?.content).toHaveLength(1);
    expect((result?.content[0] as { text: string }).text).toMatch(
      /Image 1 — description unavailable/,
    );
    expect((result?.content[0] as { text: string }).text).toMatch(/HTTP 400/);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/description failed/),
      'warning',
    );
  });

  it('returns a text error when the network call fails', async () => {
    fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('aborted');
    });
    globalThis.fetch = fetchMock;

    const ctx = buildCtx();
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(result?.content[0]).toMatchObject({
      type: 'text',
    });
    expect((result?.content[0] as { text: string }).text).toMatch(/description unavailable/);
  });

  it('returns a not-authenticated note and never calls the API without a key', async () => {
    const ctx = buildCtx({ withKey: false });
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.content).toEqual([
      { type: 'text', text: '[grok-cli-vision: image not described — not authenticated]' },
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), 'warning');
  });
});

describe('handleReadResult — response shapes and resilience', () => {
  it('reads descriptions from the output[] message-item fallback shape', async () => {
    fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'array-shape description' }],
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock;

    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx());
    expect(result?.content[0]).toMatchObject({ type: 'text' });
    expect((result?.content[0] as { text: string }).text).toContain('array-shape description');
  });

  it('treats an empty description as a failure', async () => {
    fetchMock = vi.fn<typeof fetch>(async () => Response.json({ output_text: '   ' }));
    globalThis.fetch = fetchMock;

    const ctx = buildCtx();
    const result = await handleReadResult(readEvent([imageBlock()]), ctx);
    expect((result?.content[0] as { text: string }).text).toMatch(/description unavailable/);
    expect((result?.content[0] as { text: string }).text).toMatch(/empty description/);
  });

  it('retries and recovers after a transient 500', async () => {
    const responses = [
      new Response('server error', { status: 500 }),
      Response.json({ output_text: 'recovered' }),
    ];
    let i = 0;
    fetchMock = vi.fn<typeof fetch>(async () => responses[i++] ?? (responses.at(-1) as Response));
    globalThis.fetch = fetchMock;

    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((result?.content[0] as { text: string }).text).toContain('recovered');
  });

  it('reports an exhausted rate-limit retry sequence', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: 'quota exhausted' } }, { status: 429 }),
    );
    globalThis.fetch = fetchMock;

    const resultPromise = handleReadResult(readEvent([imageBlock()]), buildCtx());
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((result?.content[0] as { text: string }).text).toContain(
      'Grok CLI rate limited the request (HTTP 429). Try again later: quota exhausted',
    );
  });

  it('reports an exhausted request-timeout retry sequence', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('expected request signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    globalThis.fetch = fetchMock;

    const resultPromise = handleReadResult(readEvent([imageBlock()]), buildCtx());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((result?.content[0] as { text: string }).text).toContain(
      'Grok CLI request timed out after 30s after 3 attempts.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops retrying when the request is cancelled', async () => {
    const controller = new AbortController();
    fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return new Response('server error', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const result = await handleReadResult(
      readEvent([imageBlock()]),
      buildCtx({ signal: controller.signal }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((result?.content[0] as { text: string }).text).toContain('request cancelled');
  });

  it.each([
    [401, 'Grok CLI rejected the API key (HTTP 401)'],
    [418, 'Grok CLI request failed (HTTP 418)'],
  ])('explains non-retryable HTTP %i responses', async (status, message) => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status }));
    globalThis.fetch = fetchMock;

    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((result?.content[0] as { text: string }).text).toContain(message);
  });

  it('reports a successful non-JSON response', async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response('<html>proxy error</html>'));
    globalThis.fetch = fetchMock;

    const result = await handleReadResult(readEvent([imageBlock()]), buildCtx());

    expect((result?.content[0] as { text: string }).text).toContain(
      'Grok CLI returned non-JSON response:',
    );
  });

  it('caps described images at maxImages and notes the skipped remainder', async () => {
    const configPath = join(process.env.HOME as string, '.pi', 'grok-cli.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        vision: { ...DEFAULT_CONFIG.vision, maxImages: 1 },
      }),
    );

    const result = await handleReadResult(
      readEvent([
        imageBlock(Buffer.from('first').toString('base64')),
        imageBlock(Buffer.from('second').toString('base64')),
      ]),
      buildCtx(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result?.content.at(-1)).toMatchObject({ type: 'text' });
    expect((result?.content.at(-1) as { text: string }).text).toMatch(
      /1 additional image\(s\) omitted/,
    );
  });
});
