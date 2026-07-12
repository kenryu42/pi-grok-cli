import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerImagineFeature } from '../../src/imagine/register.js';
import { useTempHome } from '../vision/helpers.js';
import { imagineDependencies } from './helpers.js';

const setupHome = useTempHome();

function setup(token?: string) {
  setupHome();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const renderers = new Map<string, unknown>();
  const entries: { type: string; data: unknown }[] = [];
  const tools: { name: string }[] = [];
  const dependencies = imagineDependencies();
  let activeTools = ['read'];
  registerImagineFeature(
    {
      registerCommand(name: string, command: unknown) {
        commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<void> });
      },
      registerEntryRenderer(type: string, renderer: unknown) {
        renderers.set(type, renderer);
      },
      appendEntry(type: string, data: unknown) {
        entries.push({ type, data });
      },
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      getActiveTools() {
        return activeTools;
      },
      setActiveTools(toolsToActivate: string[]) {
        activeTools = toolsToActivate;
      },
    } as unknown as ExtensionAPI,
    dependencies,
  );
  const notify = vi.fn();
  const context = {
    cwd: '/project',
    model: { provider: 'openai' },
    ui: { notify },
    modelRegistry: { getApiKeyForProvider: vi.fn(async () => token) },
    sessionManager: {
      getSessionDir: () => '/sessions',
      getSessionId: () => 'id',
      getSessionFile: () => '/sessions/session.jsonl',
    },
  };
  return {
    commands,
    renderers,
    entries,
    tools,
    generate: dependencies.generateImage,
    convert: dependencies.convertToPng,
    save: dependencies.saveImage,
    savePreview: dependencies.savePreviewImage,
    notify,
    context,
    getActiveTools: () => activeTools,
  };
}

describe('registerImagineFeature command', () => {
  it('registers the command, entry renderer, and image_gen tool', () => {
    const extension = setup('token');
    expect(extension.commands.has('grok-cli-imagine')).toBe(true);
    expect(extension.renderers.has('grok-cli-imagine')).toBe(true);
    expect(extension.tools.map((tool) => tool.name)).toContain('image_gen');
  });

  it('generates, saves, appends a TUI-only entry, and reports the path', async () => {
    const extension = setup('token');
    await extension.commands
      .get('grok-cli-imagine')
      ?.handler('--aspect 16:9 --out ./cat.jpg a cat', extension.context);
    expect(extension.generate).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token', prompt: 'a cat', aspectRatio: '16:9' }),
    );
    expect(extension.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionDir: '/sessions',
        sessionId: 'id',
        outPath: join('/project', 'cat.jpg'),
      }),
    );
    expect(extension.savePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath: join('/project', 'cat.jpg'),
        sessionDir: '/sessions',
        sessionId: 'id',
      }),
    );
    expect(extension.entries).toEqual([
      {
        type: 'grok-cli-imagine',
        data: {
          path: '/sessions/id/images/1.jpg',
          relativePath: 'images/1.jpg',
          previewPath: '/sessions/id/images/.previews/1.png',
          prompt: 'a cat',
        },
      },
    ]);
    expect(extension.notify).toHaveBeenLastCalledWith(
      'Image saved to images/1.jpg (/sessions/id/images/1.jpg)',
      'info',
    );
  });

  it('keeps a successful JPEG when PNG preview conversion fails', async () => {
    const extension = setup('token');
    extension.convert.mockResolvedValueOnce(null);
    await extension.commands.get('grok-cli-imagine')?.handler('cat', extension.context);
    expect(extension.entries[0]?.data).toEqual({
      path: '/sessions/id/images/1.jpg',
      relativePath: 'images/1.jpg',
      previewError: 'PNG preview conversion unavailable',
      prompt: 'cat',
    });
    expect(extension.notify).toHaveBeenCalledWith(
      'Preview unavailable: PNG preview conversion unavailable',
      'warning',
    );
    expect(extension.notify).toHaveBeenLastCalledWith(
      'Image saved to images/1.jpg (/sessions/id/images/1.jpg)',
      'info',
    );
  });

  it('keeps a successful JPEG when the PNG sidecar cannot be written', async () => {
    const extension = setup('token');
    extension.savePreview.mockRejectedValueOnce(new Error('preview write failed'));
    await extension.commands.get('grok-cli-imagine')?.handler('cat', extension.context);
    expect(extension.entries[0]?.data).toEqual(
      expect.objectContaining({ previewError: 'preview write failed' }),
    );
    expect(extension.notify).toHaveBeenCalledWith(
      'Preview unavailable: preview write failed',
      'warning',
    );
    expect(extension.notify).toHaveBeenLastCalledWith(
      'Image saved to images/1.jpg (/sessions/id/images/1.jpg)',
      'info',
    );
  });

  it('does not call the API for invalid args or missing auth', async () => {
    const invalid = setup('token');
    await invalid.commands.get('grok-cli-imagine')?.handler('', invalid.context);
    expect(invalid.generate).not.toHaveBeenCalled();
    expect(invalid.notify).toHaveBeenCalledWith('Prompt is required', 'error');

    const missing = setup();
    await missing.commands.get('grok-cli-imagine')?.handler('cat', missing.context);
    expect(missing.generate).not.toHaveBeenCalled();
    expect(missing.notify.mock.calls.at(-1)?.[0]).toContain('/login grok-cli');
  });

  it('persists and immediately applies image_gen scope changes', async () => {
    const extension = setup('token');
    await extension.commands.get('grok-cli-imagine:scope')?.handler('all', extension.context);
    expect(extension.getActiveTools()).toContain('image_gen');
    expect(extension.notify).toHaveBeenLastCalledWith('image_gen scope: all providers', 'info');

    await extension.commands.get('grok-cli-imagine:scope')?.handler('grok-cli', extension.context);
    expect(extension.getActiveTools()).not.toContain('image_gen');
    expect(extension.notify).toHaveBeenLastCalledWith('image_gen scope: grok-cli only', 'info');
  });

  it('reports current scope and rejects invalid values', async () => {
    const extension = setup('token');
    await extension.commands.get('grok-cli-imagine:scope')?.handler('', extension.context);
    expect(extension.notify.mock.calls.at(-1)?.[0]).toContain('grok-cli only');
    await extension.commands.get('grok-cli-imagine:scope')?.handler('invalid', extension.context);
    expect(extension.notify).toHaveBeenLastCalledWith(
      'Usage: /grok-cli-imagine:scope grok-cli|all',
      'error',
    );
  });
});
