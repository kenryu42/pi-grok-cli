import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { XaiOAuthError } from '../shared/errors.js';
import { resolveAccountRoute } from './accountRouting.js';
import { accountRouteIsCurrent, isGrokCliProvider } from './accounts.js';
import { fetchBillingUsage, formatQuota } from './billing.js';
import { loadQuotaCache, saveQuotaUsageWhen } from './quotaCache.js';

export function registerUsageCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  resolveRoute: (ctx: ExtensionCommandContext) => ReturnType<typeof resolveAccountRoute> = () =>
    resolveAccountRoute(),
) {
  pi.registerCommand('grok-cli-usage', {
    description: 'Show Grok CLI provider status, quota, and token health',
    handler: async (_args, ctx) => {
      if (process.env.GROK_CLI_OAUTH_TOKEN) {
        ctx.ui.notify(
          '⚠️  Grok CLI: using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh available',
          'warning',
        );
      }

      try {
        const registry = ctx.modelRegistry;
        const grokModels = registry
          .getAll()
          .filter((model: Model<Api>) => isGrokCliProvider(model.provider));
        if (grokModels.length === 0) {
          ctx.ui.notify('Grok CLI: no models registered. Run /login grok-cli first.', 'warning');
          return;
        }

        const route = await resolveRoute(ctx).catch(() => undefined);
        if (!route) {
          ctx.ui.notify(formatQuota(undefined).join('\n'), 'info');
          return;
        }

        try {
          ctx.ui.notify('Fetching grok cli usage…', 'info');
          const usage = await fetchBillingUsage(route.token, AbortSignal.timeout(30_000));
          try {
            if (
              !(await saveQuotaUsageWhen(route.accountId, usage, () =>
                accountRouteIsCurrent(route),
              ))
            ) {
              throw new Error('The account changed while its usage was refreshing.');
            }
          } catch (error) {
            ctx.ui.notify(
              `Grok CLI quota cache update failed: ${error instanceof Error ? error.message : String(error)}`,
              'warning',
            );
          }
          ctx.ui.notify(formatQuota(usage).join('\n'), 'info');
        } catch (err) {
          ctx.ui.notify(
            `Grok CLI billing refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            'warning',
          );
          const cached = loadQuotaCache().accounts[route.accountId];
          ctx.ui.notify(
            cached
              ? `Grok CLI cached usage from ${cached.updatedAt}:\n${formatQuota(cached).join('\n')}`
              : formatQuota(undefined).join('\n'),
            'info',
          );
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
