import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig, saveConfig } from '../config.js';
import { DEFAULT_GROK_MODEL, GROK_CLI_PROVIDER, isGrokCliProvider } from './accounts.js';

export const EXHAUSTED_BALANCE_ERROR =
  'OpenAI API error (402): 402 "Grok Build usage balance exhausted"';
export const ROTATION_CONTINUATION =
  'Continue the previous request using the newly selected Grok account. Do not repeat completed work.';

type FailedResponse = {
  model: string;
  provider: string;
};

function isExhaustionMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<AssistantMessage>;
  return (
    candidate.role === 'assistant' &&
    isGrokCliProvider(candidate.provider) &&
    candidate.stopReason === 'error' &&
    candidate.errorMessage?.trim() === EXHAUSTED_BALANCE_ERROR
  );
}

function hasAccountAuth(ctx: ExtensionContext, provider: string) {
  return (
    ctx.modelRegistry.authStorage.has(provider) ||
    (provider === GROK_CLI_PROVIDER && Boolean(process.env.GROK_CLI_OAUTH_TOKEN))
  );
}

function circularProviders(providers: string[], current: string) {
  const index = providers.indexOf(current);
  if (index < 0) return providers;
  return [...providers.slice(index + 1), ...providers.slice(0, index)];
}

export function registerExhaustionRotation(pi: ExtensionAPI) {
  const exhausted = new Set<string>();
  const unavailable = new Set<string>();
  let pending: FailedResponse | undefined;
  let awaitingContinuation = false;

  const clearChain = () => {
    exhausted.clear();
    unavailable.clear();
    pending = undefined;
    awaitingContinuation = false;
  };

  pi.on('input', (event) => {
    if (event.source !== 'extension') clearChain();
  });

  pi.on('model_select', () => {
    if (pending) clearChain();
  });

  pi.on('message_end', (event) => {
    if (!isExhaustionMessage(event.message)) return;
    const message = event.message;
    const config = loadConfig().config;
    if (!config.accounts.items.some((account) => account.provider === message.provider)) {
      return;
    }
    pending = { provider: message.provider, model: message.model };
    exhausted.add(message.provider);
    awaitingContinuation = false;
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (!pending) {
      if (awaitingContinuation) clearChain();
      return;
    }

    const failed = pending;
    pending = undefined;
    if (ctx.model?.provider !== failed.provider || ctx.model.id !== failed.model) {
      clearChain();
      return;
    }

    const config = loadConfig().config;
    const authenticated = config.accounts.items.filter((account) =>
      hasAccountAuth(ctx, account.provider),
    );
    if (authenticated.length < 2) {
      clearChain();
      return;
    }

    for (const provider of circularProviders(
      config.accounts.items.map((account) => account.provider),
      failed.provider,
    )) {
      if (
        provider === failed.provider ||
        exhausted.has(provider) ||
        unavailable.has(provider) ||
        !authenticated.some((account) => account.provider === provider)
      ) {
        continue;
      }
      const model =
        ctx.modelRegistry.find(provider, failed.model) ??
        ctx.modelRegistry.find(provider, DEFAULT_GROK_MODEL);
      if (!model || !(await pi.setModel(model))) {
        unavailable.add(provider);
        continue;
      }

      const failedLabel = config.accounts.items.find(
        (account) => account.provider === failed.provider,
      )?.label;
      const selected = config.accounts.items.find((account) => account.provider === provider);
      if (!failedLabel || !selected) {
        unavailable.add(provider);
        continue;
      }
      config.accounts.selectedProvider = provider;
      saveConfig(config);
      ctx.ui.notify(
        `Grok CLI: “${failedLabel}” exhausted; switched to “${selected.label}” and continuing.`,
        'info',
      );
      awaitingContinuation = true;
      pi.sendUserMessage(ROTATION_CONTINUATION);
      return;
    }

    if (authenticated.every((account) => exhausted.has(account.provider))) {
      ctx.ui.notify('Grok CLI: all logged-in accounts are exhausted.', 'warning');
    } else {
      ctx.ui.notify(
        'Grok CLI: no other logged-in account is available for automatic rotation.',
        'warning',
      );
    }
    clearChain();
  });
}
