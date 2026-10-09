export const PINNED_GROK_CLI_VERSION = '1.0.46';

const STABLE_VERSION_TIMEOUT_MS = 5_000;

let stableVersion: Promise<string> | undefined;

/**
 * The inference endpoint rejects requests with HTTP 426 when
 * `x-grok-client-version` is missing or older than its minimum supported
 * release; it ignores User-Agent. Reading the latest stable release from the
 * pointer the official installer uses keeps requests above a raised minimum
 * without an extension release.
 */
export function resolveGrokCliVersion() {
  stableVersion ??= fetch(process.env.PI_GROK_CLI_VERSION_URL || 'https://x.ai/cli/stable', {
    signal: AbortSignal.timeout(STABLE_VERSION_TIMEOUT_MS),
  })
    .then(async (response) => {
      const version = response.ok ? (await response.text()).trim() : '';
      return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) ? version : PINNED_GROK_CLI_VERSION;
    })
    .catch(() => PINNED_GROK_CLI_VERSION);
  return stableVersion;
}

let sharedVersionRefresh: Promise<string> | undefined;

export function refreshGrokCliVersion() {
  if (!sharedVersionRefresh) {
    stableVersion = undefined;
    sharedVersionRefresh = resolveGrokCliVersion().finally(() => {
      sharedVersionRefresh = undefined;
    });
  }
  return sharedVersionRefresh;
}

export function grokCliModelHeaders(modelId: string): Record<string, string> {
  return {
    'x-grok-client-identifier': 'grok-shell',
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': modelId,
  };
}

const OFFICIAL_CLIENT_USER_AGENT_PLATFORM = 'macos; aarch64';

export function grokCliVersionHeaders(version: string): Record<string, string> {
  return {
    'User-Agent': `grok-shell/${version} (${OFFICIAL_CLIENT_USER_AGENT_PLATFORM})`,
    'x-grok-client-version': version,
  };
}
