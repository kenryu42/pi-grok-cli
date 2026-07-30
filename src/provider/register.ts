import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import * as oauth from '../auth/oauth.js';
import { getBaseUrl, type XaiOAuthCredentials } from '../auth/oauth.js';
import { type GrokCliAccount, loadConfig, migrateLegacyConfig } from '../config.js';
import { registerImagineFeature, syncImageToolPreference } from '../imagine/register.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { isGrokCliProvider, registerAccountManagement } from './accounts.js';
import { removeQuotaUsage } from './quotaCache.js';
import { registerExhaustionRotation } from './rotation.js';
import { grokCliModelHeaders } from './stream.js';
import { registerUsageCommand } from './usage.js';

export default function registerGrokCli(pi: ExtensionAPI) {
  const migration = migrateLegacyConfig();
  const baseUrl = getBaseUrl();
  const models = resolveModels();
  const exhaustionRotation = registerExhaustionRotation(pi);

  const registerAccount = (account: GrokCliAccount) => {
    const oauthProvider = {
      name: `Grok CLI — ${account.label}`,
      usesCallbackServer: true,

      async login(callbacks) {
        const credentials = await oauth.login(callbacks);
        await removeQuotaUsage(account.provider).catch(() => undefined);
        exhaustionRotation.clearRecentExhaustion(account.provider);
        return credentials;
      },

      async refreshToken(credentials) {
        return oauth.refresh(credentials);
      },

      getApiKey(credentials) {
        return credentials.access;
      },

      modifyModels(registeredModels, credentials) {
        const effectiveBaseUrl = String(
          (credentials as XaiOAuthCredentials).baseUrl ?? getBaseUrl(),
        ).replace(/\/+$/, '');

        return registeredModels.map((model) =>
          model.provider === account.provider ? { ...model, baseUrl: effectiveBaseUrl } : model,
        );
      },
    } satisfies NonNullable<ProviderConfig['oauth']>;

    pi.registerProvider(account.provider, {
      name: `Grok CLI — ${account.label}`,
      baseUrl,
      ...(account.provider === 'grok-cli' ? { apiKey: '$GROK_CLI_OAUTH_TOKEN' } : {}),
      api: 'openai-responses',
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        // Carried as model.headers so the version-gate headers reach the server on
        // every request even when the API-provider registry reverts to pi-ai's
        // built-in openai-responses handler (see grokCliModelHeaders).
        headers: grokCliModelHeaders(model.id),
      })),
      oauth: oauthProvider,
    });
  };

  loadConfig().config.accounts.items.forEach(registerAccount);
  const accountManagement = registerAccountManagement(pi, registerAccount);

  registerImagineFeature(pi);

  pi.on('model_select', (event) => {
    accountManagement.handleModelSelect(event);
    syncImageToolPreference(pi);
  });

  pi.on('before_agent_start', () => {
    syncImageToolPreference(pi);
  });

  pi.on('session_start', (_event, ctx) => {
    if (migration.warning) {
      ctx.ui.notify(`[pi-grok-cli] ${migration.warning}`, 'warning');
      delete migration.warning;
    }
    syncImageToolPreference(pi);
    if (process.env.GROK_CLI_OAUTH_TOKEN) {
      ctx.ui.notify(
        '[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery',
        'warning',
      );
    }
  });

  pi.on('session_shutdown', async () => {
    await accountManagement.closeDashboard();
  });

  pi.on('before_provider_headers', (event, ctx) => {
    if (!isGrokCliProvider(ctx.model?.provider)) return;
    event.headers['x-grok-conv-id'] = ctx.sessionManager.getSessionId();
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (!isGrokCliProvider(ctx.model?.provider)) return;

    const modelId = ctx.model?.id ?? '';
    const sessionId = ctx.sessionManager?.getSessionId();
    return sanitizePayload(event.payload as Record<string, unknown>, modelId, sessionId, ctx.cwd);
  });

  registerUsageCommand(pi);
}
