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
 * via `model.headers` on every request. The dynamic conversation id is added
 * through the provider-scoped `before_provider_headers` hook.
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
