import {
  lazyStream,
  type Model,
  type OAuthCredentials,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimpleOpenAIResponses } from '@earendil-works/pi-ai/compat';
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderConfig,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent';
import * as oauth from '../auth/oauth.js';
import { getBaseUrl } from '../auth/oauth.js';
import { migrateLegacyConfig } from '../config.js';
import { registerImagineFeature, syncImageToolPreference } from '../imagine/register.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { confirmMarkerInstallation, migrateReleasedAccounts } from './accountMigration.js';
import { resolveAccountRoute } from './accountRouting.js';
import { registerAccountManagement } from './accounts.js';
import {
  ACCOUNT_1_ID,
  ACCOUNT_VAULT_MARKER,
  type AccountCredential,
  getAccountVault,
  mutateAccountVault,
} from './accountVault.js';
import { migrateSavedModelProviders } from './modelMigration.js';
import { removeQuotaUsage } from './quotaCache.js';
import { rememberRequestAccount } from './requestOwnership.js';
import { registerExhaustionRotation } from './rotation.js';
import { createSessionAccountSelection } from './sessionAccountSelection.js';
import { grokCliModelHeaders } from './stream.js';
import { registerUsageCommand } from './usage.js';

const marker = (): OAuthCredentials => ({
  access: ACCOUNT_VAULT_MARKER,
  refresh: ACCOUNT_VAULT_MARKER,
  expires: Number.MAX_SAFE_INTEGER,
});

function isMarker(credentials: OAuthCredentials) {
  return (
    credentials.access === ACCOUNT_VAULT_MARKER && credentials.refresh === ACCOUNT_VAULT_MARKER
  );
}

function accountCredential(credentials: OAuthCredentials): AccountCredential {
  return structuredClone(credentials) as AccountCredential;
}

export default function registerGrokCli(pi: ExtensionAPI) {
  const sessionSelection = createSessionAccountSelection(pi);
  let migrationWarning: string | undefined;
  let migrationError: string | undefined;
  let migrationErrorNotified = false;
  let migrationNotice: string | undefined;
  const migration = Promise.all([migrateReleasedAccounts(), migrateSavedModelProviders()])
    .then(async ([result, modelMigration]) => {
      const legacyMigration = migrateLegacyConfig();
      migrationWarning =
        [legacyMigration.warning, modelMigration.warning].filter(Boolean).join(' ') || undefined;
      await confirmMarkerInstallation();
      const vault = await getAccountVault();
      if (result.migrated && vault.migration.markerInstallPending) {
        migrationNotice =
          'Grok CLI accounts were copied to the secure account vault. Run /login and select Grok CLI once to finish setup. Old grok-cli-N login entries can then be removed with /logout.';
      }
    })
    .catch((error: unknown) => {
      migrationError = `Could not migrate Grok CLI accounts: ${
        error instanceof Error ? error.message : String(error)
      }`;
    });
  const exhaustionRotation = registerExhaustionRotation(pi, sessionSelection);
  const storedCredential = readStoredCredential('grok-cli');
  const environmentApiKey =
    process.env.GROK_CLI_OAUTH_TOKEN && storedCredential?.type !== 'oauth'
      ? '$GROK_CLI_OAUTH_TOKEN'
      : undefined;

  const oauthProvider = {
    name: 'Grok CLI',
    usesCallbackServer: true,

    async login(callbacks) {
      await migration;
      if (migrationError) throw new Error(migrationError);
      if (process.env.GROK_CLI_OAUTH_TOKEN) {
        throw new Error('Unset GROK_CLI_OAUTH_TOKEN before logging in to Grok CLI.');
      }

      const stored = readStoredCredential('grok-cli');
      const current = await getAccountVault();
      if (current.migration.markerInstallPending) {
        if (stored?.type === 'oauth' && !isMarker(stored)) {
          await mutateAccountVault((vault) => {
            const account = vault.accounts.find((candidate) => candidate.id === ACCOUNT_1_ID);
            if (!account) throw new Error('The permanent Grok CLI account is missing.');
            if (!account.credential) {
              account.credential = accountCredential(stored);
              account.revision += 1;
            }
            vault.activeAccountId ??= account.id;
          });
        }
        if ((await getAccountVault()).accounts.some((account) => account.credential))
          return marker();
      }

      if (current.accounts.some((account) => account.credential)) return marker();

      const revision = current.accounts.find((account) => account.id === ACCOUNT_1_ID)?.revision;
      if (revision === undefined) throw new Error('The permanent Grok CLI account is missing.');
      const credentials = await oauth.login(callbacks);
      await mutateAccountVault((vault) => {
        const account = vault.accounts.find((candidate) => candidate.id === ACCOUNT_1_ID);
        if (!account) throw new Error('The permanent Grok CLI account is missing.');
        if (account.revision !== revision) {
          throw new Error('The account changed while login was in progress. Try again.');
        }
        account.credential = accountCredential(credentials);
        account.revision += 1;
        vault.activeAccountId ??= account.id;
      });
      await removeQuotaUsage(ACCOUNT_1_ID).catch(() => undefined);
      exhaustionRotation.clearRecentExhaustion(ACCOUNT_1_ID);
      return marker();
    },

    async refreshToken(credentials) {
      if (isMarker(credentials) || process.env.GROK_CLI_OAUTH_TOKEN) return marker();
      return oauth.refresh(credentials);
    },

    getApiKey(credentials) {
      return credentials.access;
    },
  } satisfies NonNullable<ProviderConfig['oauth']>;

  pi.registerProvider('grok-cli', {
    name: 'Grok CLI',
    baseUrl: getBaseUrl(),
    ...(environmentApiKey ? { apiKey: environmentApiKey } : { oauth: oauthProvider }),
    api: 'openai-responses',
    models: resolveModels().map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers: grokCliModelHeaders(model.id),
    })),
    streamSimple(model, context, options?: SimpleStreamOptions) {
      const accountId = sessionSelection.accountId(options?.sessionId);
      return lazyStream(model, async () => {
        await migration;
        if (migrationError) throw new Error(migrationError);
        const route = await resolveAccountRoute(accountId);
        const stream = streamSimpleOpenAIResponses(
          {
            ...model,
            baseUrl: route.baseUrl,
            api: 'openai-responses',
          } as Model<'openai-responses'>,
          context,
          {
            ...options,
            apiKey: route.token,
          },
        );
        void stream.result().then(
          (message) => {
            rememberRequestAccount(message, route.accountId);
          },
          () => undefined,
        );
        return stream;
      });
    },
  });

  const accountManagement = registerAccountManagement(
    pi,
    exhaustionRotation.clearRecentExhaustion,
    sessionSelection,
  );
  const resolveSessionRoute = (ctx: Pick<ExtensionContext, 'sessionManager'>) =>
    resolveAccountRoute(sessionSelection.accountId(ctx.sessionManager.getSessionId()));
  registerImagineFeature(pi, undefined, async (ctx) => (await resolveSessionRoute(ctx)).token);

  pi.on('model_select', (_event) => {
    accountManagement.handleModelSelect();
    syncImageToolPreference(pi);
  });

  pi.on('before_agent_start', () => {
    syncImageToolPreference(pi);
  });

  pi.on('session_start', async (_event, ctx) => {
    await migration;
    const accountId = sessionSelection.restore(ctx);
    if (accountId && !process.env.GROK_CLI_OAUTH_TOKEN) sessionSelection.select(ctx, accountId);
    if (migrationError && !migrationErrorNotified) {
      ctx.ui.notify(`[pi-grok-cli] ${migrationError}`, 'warning');
      migrationErrorNotified = true;
    }
    if (migrationWarning) {
      ctx.ui.notify(`[pi-grok-cli] ${migrationWarning}`, 'warning');
      migrationWarning = undefined;
    }
    if (migrationNotice) {
      ctx.ui.notify(`[pi-grok-cli] ${migrationNotice}`, 'info');
      migrationNotice = undefined;
    }
    syncImageToolPreference(pi);
    if (process.env.GROK_CLI_OAUTH_TOKEN) {
      ctx.ui.notify(
        '[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery',
        'warning',
      );
    }
  });

  pi.on('session_tree', (_event, ctx) => {
    const accountId = sessionSelection.restore(ctx);
    if (accountId && !process.env.GROK_CLI_OAUTH_TOKEN) sessionSelection.select(ctx, accountId);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    sessionSelection.clear(ctx.sessionManager.getSessionId());
    await accountManagement.closeDashboard();
  });

  pi.on('before_provider_headers', (event, ctx) => {
    if (ctx.model?.provider !== 'grok-cli') return;
    event.headers['x-grok-conv-id'] = ctx.sessionManager.getSessionId();
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'grok-cli') return;
    const modelId = ctx.model?.id ?? '';
    const sessionId = ctx.sessionManager?.getSessionId();
    return sanitizePayload(event.payload as Record<string, unknown>, modelId, sessionId, ctx.cwd);
  });

  registerUsageCommand(pi, resolveSessionRoute);
}
