import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as oauth from '../auth/oauth.js';
import { getBaseUrl, type XaiOAuthCredentials } from '../auth/oauth.js';
import { type GrokCliAccount, loadConfig, migrateLegacyConfig } from '../config.js';
import { registerImagineFeature } from '../imagine/register.js';
import { type GrokCliModelConfig, resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { registerGrokTools } from '../tools/register.js';
import { bindLivePiWebAccess, ensureWebSearchDelegate } from '../tools/webSearchDelegate.js';
import { registerVisionFeature } from '../vision/register.js';
import { isGrokCliProvider, registerAccountManagement } from './accounts.js';
import { registerExhaustionRotation } from './rotation.js';
import { grokCliModelHeaders } from './stream.js';
import { handoffGrokTools, restoreGrokTools, syncGrokTools } from './toolScope.js';
import { registerUsageCommand } from './usage.js';

export default function registerGrokCli(pi: ExtensionAPI) {
  const migration = migrateLegacyConfig();
  const baseUrl = getBaseUrl();
  const models = resolveModels();

  const registerAccount = (account: GrokCliAccount) => {
    const oauthProvider = {
      name: `Grok CLI — ${account.label}`,
      usesCallbackServer: true,

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        return oauth.login(callbacks);
      },

      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return oauth.refresh(credentials);
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },

      modifyModels(registeredModels: Model<Api>[], credentials: OAuthCredentials) {
        const effectiveBaseUrl = String(
          (credentials as XaiOAuthCredentials).baseUrl ?? getBaseUrl(),
        ).replace(/\/+$/, '');

        return registeredModels.map((model) =>
          model.provider === account.provider ? { ...model, baseUrl: effectiveBaseUrl } : model,
        );
      },
    } satisfies Omit<OAuthProviderInterface, 'id'>;

    pi.registerProvider(account.provider, {
      name: `Grok CLI — ${account.label}`,
      baseUrl,
      ...(account.provider === 'grok-cli' ? { apiKey: '$GROK_CLI_OAUTH_TOKEN' } : {}),
      api: 'openai-responses',
      models: models.map((m: GrokCliModelConfig) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        thinkingLevelMap: m.thinkingLevelMap,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        // Carried as model.headers so the version-gate headers reach the server on
        // every request even when the API-provider registry reverts to pi-ai's
        // built-in openai-responses handler (see grokCliModelHeaders).
        headers: grokCliModelHeaders(m.id),
      })),
      oauth: oauthProvider,
    });
  };

  for (const account of loadConfig().config.accounts.items) registerAccount(account);
  const accountManagement = registerAccountManagement(pi, registerAccount);
  registerExhaustionRotation(pi);

  const { webSearchRegistered } = registerGrokTools(pi);
  registerImagineFeature(pi);

  const syncTools = (model: { provider: string; id: string } | undefined, captureDelete = false) =>
    syncGrokTools(pi, model, { captureDelete, webSearchRegistered });

  pi.on('model_select', (event) => {
    accountManagement.handleModelSelect(event);
    syncTools(event.model);
  });

  pi.on('before_agent_start', (_event, ctx) => {
    syncTools(ctx.model);
  });

  pi.on('session_start', async (event, ctx) => {
    if (migration.warning) {
      ctx.ui.notify(`[pi-grok-cli] ${migration.warning}`, 'warning');
      delete migration.warning;
    }
    if (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork') {
      restoreGrokTools(pi, ctx.sessionManager.getSessionFile());
    }
    syncTools(ctx.model, true);
    if (process.env.GROK_CLI_OAUTH_TOKEN) {
      ctx.ui.notify(
        '[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery',
        'warning',
      );
    }

    if (!webSearchRegistered) return;

    bindLivePiWebAccess(pi);
    await ensureWebSearchDelegate(pi);
    syncTools(ctx.model);
  });

  pi.on('session_shutdown', (event) => {
    syncTools(undefined);
    if (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork') {
      handoffGrokTools(pi, event.targetSessionFile);
    }
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

  registerVisionFeature(pi);
}
