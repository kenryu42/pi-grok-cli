import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { XaiOAuthError } from '../shared/errors.js';
import { fetchBillingUsage, formatQuota } from './quota.js';

export function registerStatusCommand(pi: Pick<ExtensionAPI, 'registerCommand'>) {
  pi.registerCommand('grok-cli-usage', {
    description: 'Show Grok CLI provider status, quota, and token health',
    handler: async (_args, ctx) => {
      const token = process.env.GROK_CLI_OAUTH_TOKEN;
      if (token) {
        ctx.ui.notify(
          '⚠️  Grok CLI: using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh available',
          'warning',
        );
      }

      try {
        const registry = ctx.modelRegistry;
        const grokModels = registry.getAll().filter((m: Model<Api>) => m.provider === 'grok-cli');
        if (grokModels.length === 0) {
          ctx.ui.notify('Grok CLI: no models registered. Run /login grok-cli first.', 'warning');
          return;
        }

        const modelNames = grokModels
          .slice(0, 5)
          .map((m: Model<Api>) => m.id)
          .join(', ');
        const suffix = grokModels.length > 5 ? ` (+${grokModels.length - 5} more)` : '';
        ctx.ui.notify(
          `✓ Grok CLI: ${grokModels.length} models available (${modelNames}${suffix})`,
          'info',
        );

        const apiKey = token ?? (await registry.getApiKeyForProvider?.('grok-cli'));
        if (!apiKey) {
          ctx.ui.notify(formatQuota(undefined).join('\n'), 'info');
          return;
        }

        try {
          ctx.ui.notify(formatQuota(await fetchBillingUsage(apiKey)).join('\n'), 'info');
        } catch (err) {
          ctx.ui.notify(
            `Grok CLI billing refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            'warning',
          );
          ctx.ui.notify(formatQuota(undefined).join('\n'), 'info');
        }
      } catch (err) {
        const msg =
          err instanceof XaiOAuthError
            ? `${err.message} (code: ${err.code})`
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.ui.notify(`Grok CLI: ${msg}`, 'warning');
      }
    },
  });
}
