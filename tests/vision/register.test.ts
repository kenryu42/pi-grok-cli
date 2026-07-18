import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import { useTempHome } from './helpers.js';

const setupHome = useTempHome();

interface CommandConfig {
  handler: (args: string[], ctx: unknown) => Promise<void>;
}

type ToolResultHandler = (event: unknown, ctx: unknown) => unknown;

async function setupExtension() {
  const commands = new Map<string, CommandConfig>();
  const toolResultHandlers: ToolResultHandler[] = [];
  const { registerVisionFeature } = await import('../../src/vision/register.js');
  registerVisionFeature({
    on(event: string, handler: ToolResultHandler) {
      if (event === 'tool_result') toolResultHandlers.push(handler);
    },
    registerCommand(name: string, config: unknown) {
      commands.set(name, config as CommandConfig);
    },
  } as unknown as ExtensionAPI);
  return { commands, toolResultHandlers };
}

describe('registerVisionFeature', () => {
  it('registers the tool_result handler and three commands', async () => {
    setupHome();
    const { commands, toolResultHandlers } = await setupExtension();

    expect(toolResultHandlers).toHaveLength(1);
    expect([...commands.keys()].sort()).toEqual([
      'grok-cli-vision',
      'grok-cli-vision:cache-clear',
      'grok-cli-vision:status',
    ]);
  });

  it('status reports ON with the default describer and zero cache entries', async () => {
    setupHome();
    const { commands } = await setupExtension();
    const notify = vi.fn();

    await commands.get('grok-cli-vision:status')?.handler([], {
      ui: { notify },
    });

    const text = notify.mock.calls.at(-1)?.[0] as string;
    expect(text).toMatch(/grok-cli-vision: ON/);
    expect(text).toMatch(/describer: grok-build/);
    expect(text).toMatch(/cache: ON \(0 entries/);
  });

  it('toggles enabled state and persists it to the config file', async () => {
    setupHome();
    const { commands } = await setupExtension();
    const notify = vi.fn();
    saveConfig({ ...DEFAULT_CONFIG, imagine: { enabled: false } });

    await commands.get('grok-cli-vision')?.handler([], { ui: { notify } });
    expect(loadConfig().config.vision.enabled).toBe(false);
    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(notify).toHaveBeenCalledWith('grok-cli-vision: OFF', 'info');

    await commands.get('grok-cli-vision')?.handler([], { ui: { notify } });
    expect(loadConfig().config.vision.enabled).toBe(true);
    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(notify).toHaveBeenCalledWith('grok-cli-vision: ON (grok-build)', 'info');
  });

  it('clears cached vision descriptions and notifies the user', async () => {
    setupHome();
    const { commands } = await setupExtension();
    const { getCachePath, loadCache, saveCache } = await import('../../src/vision/cache.js');
    const notify = vi.fn();
    saveCache(
      {
        version: 1,
        entries: {
          cached: {
            createdAt: '2026-07-12T00:00:00.000Z',
            description: 'cached description',
            imageHash: 'image',
            mediaType: 'image/png',
            model: 'grok-build',
            promptHash: 'prompt',
          },
        },
      },
      getCachePath(),
    );

    await commands.get('grok-cli-vision:cache-clear')?.handler([], { ui: { notify } });

    expect(loadCache(getCachePath()).entries).toEqual({});
    expect(notify).toHaveBeenCalledWith('grok-cli-vision cache: cleared', 'info');
  });

  it('delegates read tool results to the vision handler', async () => {
    setupHome();
    const { toolResultHandlers } = await setupExtension();
    const result = await toolResultHandlers[0]?.(
      { type: 'tool_result', toolName: 'bash', content: [{ type: 'text', text: 'x' }] },
      {
        model: { input: ['text'] },
        modelRegistry: { getApiKeyForProvider: async () => 'token' },
        ui: { notify: vi.fn() },
        signal: undefined,
      },
    );

    expect(result).toBeUndefined();
  });
});
