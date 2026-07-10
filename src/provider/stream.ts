import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamSimpleOpenAIResponses,
} from '@earendil-works/pi-ai/compat';

// Grok CLI client version. Keep it in sync with the version the official Grok
// CLI client emits (observed in captured cli-chat-proxy.grok.com traffic).
export const GROK_CLI_VERSION = '0.2.91';

// The version gate reads the client version out of User-Agent. The accepted
// format is the product/version pair the official clients emit — both the pager
// and shell tokens are included for parity with the native client.
export const GROK_CLI_USER_AGENT = `grok-pager/${GROK_CLI_VERSION} grok-shell/${GROK_CLI_VERSION} (macos; aarch64)`;

export const GROK_CLI_CLIENT_IDENTIFIER = 'grok-pager';
export const GROK_CLI_TOKEN_AUTH = 'xai-grok-cli';

/**
 * Static identification headers the inference endpoint requires on every
 * request (the version gate rejects requests whose User-Agent carries no Grok
 * version with HTTP 426 "version (none)").
 *
 * These are attached to each model definition so pi-coding-agent injects them
 * via `model.headers` on EVERY request — including tool-continuation turns
 * where the API-provider registry has reverted the custom `streamSimple`
 * handler to pi-ai's default. See `streamGrokCli` for the dynamic per-request
 * additions (conversation id).
 */
export function grokCliModelHeaders(modelId: string): Record<string, string> {
  return {
    'User-Agent': GROK_CLI_USER_AGENT,
    'x-grok-client-identifier': GROK_CLI_CLIENT_IDENTIFIER,
    'x-grok-client-version': GROK_CLI_VERSION,
    'x-xai-token-auth': GROK_CLI_TOKEN_AUTH,
    'x-grok-model-override': modelId,
  };
}

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * Re-asserts the static identification headers (also carried on the model via
 * `grokCliModelHeaders`) and adds the dynamic conversation id. The static
 * headers live on the model so they survive pi-ai's built-in
 * `openai-responses` provider being re-registered (which happens lazily on the
 * first turn and clobbers any custom `streamSimple`); this wrapper only runs on
 * turns where our provider is still the active one, so the model headers are the
 * load-bearing path and this is supplementary.
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;
  const headers = {
    ...options?.headers,
    ...grokCliModelHeaders(model.id),
  };

  if (sessionId) {
    headers['x-grok-conv-id'] = sessionId;
  }

  return streamSimpleOpenAIResponses(model as Model<'openai-responses'>, context, {
    ...options,
    headers,
    onResponse(response) {
      options?.onResponse?.(response, model);
    },
  });
}
