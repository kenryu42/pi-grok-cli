import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { cacheStats, clearCache } from './cache.js';
import { getCachePath, getConfigPath, loadConfig, saveConfig } from './config.js';
import { handleReadResult } from './describe.js';

export function registerVisionFeature(pi: ExtensionAPI) {
  pi.on('tool_result', handleReadResult);

  pi.registerCommand('grok-cli-vision:status', {
    description: 'Show grok-cli-vision status, describer model, and cache stats',
    handler: async (_args, ctx) => {
      const { config, warning } = loadConfig();
      const stats = cacheStats(getCachePath());
      ctx.ui.notify(
        [
          `grok-cli-vision: ${config.enabled ? 'ON' : 'OFF'}`,
          `describer: ${config.model}`,
          `maxImages: ${config.maxImages}`,
          `cache: ${config.cacheEnabled ? 'ON' : 'OFF'} (${stats.entries} entries, max ${config.cacheMaxEntries})`,
          `config: ${getConfigPath()}`,
          `cache file: ${stats.path}`,
          warning ? `warning: ${warning}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
        warning ? 'warning' : 'info',
      );
    },
  });

  pi.registerCommand('grok-cli-vision:on', {
    description: 'Enable grok-cli-vision image routing',
    handler: async (_args, ctx) => {
      const { config } = loadConfig();
      saveConfig({ ...config, enabled: true });
      ctx.ui.notify(`grok-cli-vision: ON (${config.model})`, 'info');
    },
  });

  pi.registerCommand('grok-cli-vision:off', {
    description: 'Disable grok-cli-vision image routing',
    handler: async (_args, ctx) => {
      const { config } = loadConfig();
      saveConfig({ ...config, enabled: false });
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
