import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerImageGenTool } from '../../src/imagine/tool.js';
import { useEnvironmentToken, useTempHome } from '../stateTestHelpers.js';
import { imagineDependencies } from './helpers.js';

const setupHome = useTempHome();
const setToken = useEnvironmentToken();

function setup(token?: string, resolveToken?: () => Promise<string | undefined>) {
  setupHome();
  setToken(token);
  let tool: Record<string, unknown> | undefined;
  const dependencies = imagineDependencies();
  registerImageGenTool(
    {
      registerTool(value) {
        tool = value as unknown as Record<string, unknown>;
      },
    } as ExtensionAPI,
    dependencies,
    resolveToken,
  );
  const context = {
    modelRegistry: { getApiKeyForProvider: vi.fn(async () => token) },
    sessionManager: {
      getSessionDir: () => '/sessions',
      getSessionId: () => 'id',
      getSessionFile: () => '/sessions/session.jsonl',
    },
  };
  return {
    tool: tool as {
      name: string;
      description: string;
      promptGuidelines?: string[];
      execute: (...args: unknown[]) => Promise<{
        content: { type: string; text: string }[];
        details: Record<string, unknown>;
      }>;
      renderCall: (...args: unknown[]) => { render: (width: number) => string[] };
      renderResult: (...args: unknown[]) => { render: (width: number) => string[] };
    },
    generate: dependencies.generateImage,
    convert: dependencies.convertToPng,
    save: dependencies.saveImage,
    context,
  };
}

describe('image_gen tool', () => {
  it('returns path-only content and path details', async () => {
    const test = setup('token');
    const signal = new AbortController().signal;
    const result = await test.tool.execute(
      'call',
      { prompt: 'cat' },
      signal,
      undefined,
      test.context,
    );
    expect(test.tool.name).toBe('image_gen');
    expect(test.generate).toHaveBeenCalledWith(
      expect.objectContaining({ signal, aspectRatio: 'auto' }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: '/sessions/id/images/1.jpg',
            filename: '1.jpg',
            relative_path: 'images/1.jpg',
            message:
              'Image generated successfully. Do not repeat the saved path unless the user asks.',
          }),
        },
      ],
      details: {
        path: '/sessions/id/images/1.jpg',
        relativePath: 'images/1.jpg',
        filename: '1.jpg',
        previewPath: '/sessions/id/images/.previews/1.png',
      },
    });
    expect(result.content.every((part: { type: string }) => part.type === 'text')).toBe(true);
  });

  it('uses the supplied session token resolver', async () => {
    const resolveToken = vi.fn(async () => 'session-token');
    const test = setup(undefined, resolveToken);

    await test.tool.execute('call', { prompt: 'cat' }, undefined, undefined, test.context);

    expect(resolveToken).toHaveBeenCalledWith(test.context);
    expect(test.generate).toHaveBeenCalledWith(expect.objectContaining({ token: 'session-token' }));
  });

  it('requires exactly one call for singular requests while allowing explicit multiples', () => {
    const test = setup('token');
    expect(test.tool.description).toContain(
      'For a request for one image, call this tool exactly once',
    );
    expect(test.tool.description).toContain(
      'only when the user explicitly requests multiple images',
    );
    expect(test.tool.promptGuidelines?.join(' ')).toContain(
      'For a request for one image, call image_gen exactly once',
    );
    expect(test.tool.description).not.toContain('When telling the user where it was saved');
    expect(test.tool.promptGuidelines?.join(' ')).not.toContain('include its absolute path');
    expect(test.tool.promptGuidelines?.join(' ')).toContain(
      'Do not repeat the saved path unless the user asks',
    );
  });

  it('keeps model content successful and exposes a non-fatal preview error in details', async () => {
    const test = setup('token');
    test.convert.mockResolvedValueOnce(null);
    const result = await test.tool.execute(
      'call',
      { prompt: 'cat' },
      undefined,
      undefined,
      test.context,
    );
    expect(result.content[0]?.text).not.toContain('preview');
    expect(result.details.previewError).toBe('PNG preview conversion unavailable');
  });

  it('rejects empty prompts, invalid aspects, and missing auth before fetch', async () => {
    for (const [params, token] of [
      [{ prompt: ' ' }, 'token'],
      [{ prompt: 'cat', aspect_ratio: '5:4' }, 'token'],
      [{ prompt: 'cat' }, undefined],
    ] as const) {
      const test = setup(token);
      const result = await test.tool.execute('call', params, undefined, undefined, test.context);
      expect(result.details.error).toBeTruthy();
      expect(test.generate).not.toHaveBeenCalled();
    }
  });

  it('renders calls, running state, and path-only results without reading missing files', () => {
    const test = setup('token');
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    expect(test.tool.renderCall({ prompt: 'cat' }, theme, {}).render(120).join('\n')).toContain(
      'Image Gen "cat" (auto)',
    );
    expect(
      test.tool
        .renderResult({ content: [], details: {} }, { expanded: false, isPartial: true }, theme, {
          showImages: false,
        })
        .render(120)
        .join('\n'),
    ).toContain('Generating image');
    expect(
      test.tool
        .renderResult(
          {
            content: [],
            details: { path: '/missing.jpg', relativePath: 'images/1.jpg' },
          },
          { expanded: false, isPartial: false },
          theme,
          { showImages: true },
        )
        .render(120)
        .join('\n'),
    ).toContain('saved images/1.jpg (/missing.jpg)');
  });
});
