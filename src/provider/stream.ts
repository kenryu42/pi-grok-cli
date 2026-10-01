// Grok CLI release sent when the latest stable release cannot be looked up.
// Keep it at a current official release so it stays above the endpoint minimum.
export const GROK_CLI_VERSION = '1.0.46';

const STABLE_VERSION_TIMEOUT_MS = 5_000;

let stableVersion: Promise<string> | undefined;

/**
 * The inference endpoint rejects requests with HTTP 426 when
 * `x-grok-client-version` is missing or older than its minimum supported
 * release; it ignores User-Agent. Reading the latest stable release from the
 * pointer the official installer uses keeps requests above a raised minimum
 * without an extension release. The lookup runs once per process until a
 * request is rejected by the gate.
 */
export function resolveGrokCliVersion() {
  stableVersion ??= fetch(process.env.PI_GROK_CLI_VERSION_URL || 'https://x.ai/cli/stable', {
    signal: AbortSignal.timeout(STABLE_VERSION_TIMEOUT_MS),
  })
    .then(async (response) => {
      const version = response.ok ? (await response.text()).trim() : '';
      return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) ? version : GROK_CLI_VERSION;
    })
    .catch(() => GROK_CLI_VERSION);
  return stableVersion;
}

// Discards the cached release after the gate rejects it and looks it up again.
export function refreshGrokCliVersion() {
  stableVersion = undefined;
  return resolveGrokCliVersion();
}

/**
 * Static identification headers attached to each model definition so Pi sends
 * them on every request. The version headers are added per request by the
 * provider stream once the version is resolved.
 */
export function grokCliModelHeaders(modelId: string): Record<string, string> {
  return {
    'x-grok-client-identifier': 'grok-shell',
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': modelId,
  };
}

// Same format as the official Grok CLI client's own version headers.
export function grokCliVersionHeaders(version: string): Record<string, string> {
  return {
    'User-Agent': `grok-shell/${version} (macos; aarch64)`,
    'x-grok-client-version': version,
  };
}
