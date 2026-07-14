import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getConfigPath, loadConfig, saveConfig } from '../config.js';
import { cacheStats, clearCache, getCachePath } from './cache.js';
import { handleReadResult } from './describe.js';

export function registerVisionFeature(pi: ExtensionAPI) {
  pi.on('tool_result', handleReadResult);

  pi.registerCommand('grok-cli-vision:status', {
    description: 'Show grok-cli-vision status, describer model, and cache stats',
    handler: async (_args, ctx) => {
      const loaded = loadConfig();
      const config = loaded.config.vision;
      const stats = cacheStats(getCachePath());
      ctx.ui.notify(
        [
          `grok-cli-vision: ${config.enabled ? 'ON' : 'OFF'}`,
          `describer: ${config.model}`,
          `maxImages: ${config.maxImages}`,
          `cache: ${config.cacheEnabled ? 'ON' : 'OFF'} (${stats.entries} entries, max ${config.cacheMaxEntries})`,
          `config: ${getConfigPath()}`,
          `cache file: ${stats.path}`,
          loaded.warning ? `warning: ${loaded.warning}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
        loaded.warning ? 'warning' : 'info',
      );
    },
  });

  pi.registerCommand('grok-cli-vision:on', {
    description: 'Enable grok-cli-vision image routing',
    handler: async (_args, ctx) => {
      const loaded = loadConfig();
      saveConfig({
        ...loaded.config,
        vision: { ...loaded.config.vision, enabled: true },
      });
      ctx.ui.notify(`grok-cli-vision: ON (${loaded.config.vision.model})`, 'info');
    },
  });

  pi.registerCommand('grok-cli-vision:off', {
    description: 'Disable grok-cli-vision image routing',
    handler: async (_args, ctx) => {
      const loaded = loadConfig();
      saveConfig({
        ...loaded.config,
        vision: { ...loaded.config.vision, enabled: false },
      });
      ctx.ui.notify('grok-cli-vision: OFF', 'info');
    },
  });

  pi.registerCommand('grok-cli-vision:cache-clear', {
    description: 'Clear the grok-cli-vision response cache',
    handler: async (_args, ctx) => {
      clearCache(getCachePath());
      ctx.ui.notify('grok-cli-vision cache: cleared', 'info');
    },
  });
}
