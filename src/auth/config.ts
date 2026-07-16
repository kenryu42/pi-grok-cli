export const XAI_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_CLIENT_ID =
  process.env.PI_GROK_CLI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_TOKEN_ENDPOINT = `${XAI_ISSUER}/oauth2/token`;

// Official Grok CLI requests conversations scopes for cli-chat-proxy access.
// Keep openid/profile/email/offline_access for Pi's OAuth storage + refresh.
export const XAI_OAUTH_SCOPE =
  process.env.PI_GROK_CLI_OAUTH_SCOPE ||
  'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';

export const REQUIRED_GROK_CLI_SCOPES = [
  'grok-cli:access',
  'conversations:read',
  'conversations:write',
] as const;

export function getBaseUrl() {
  return (
    process.env.PI_GROK_CLI_BASE_URL ||
    process.env.GROK_CLI_BASE_URL ||
    'https://cli-chat-proxy.grok.com/v1'
  ).replace(/\/+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = globalThis.atob(padded);
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function tokenScopes(accessToken: string): string[] {
  const scope = decodeJwtPayload(accessToken)?.scope;
  return typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
}

export function missingGrokCliScopes(accessToken: string): string[] {
  const granted = new Set(tokenScopes(accessToken));
  return REQUIRED_GROK_CLI_SCOPES.filter((scope) => !granted.has(scope));
}

export function formatGrokCliAccessDeniedHint(accessToken?: string): string {
  const missing = accessToken ? missingGrokCliScopes(accessToken) : [];
  if (missing.length > 0) {
    return (
      `Grok CLI token is missing required scopes (${missing.join(', ')}). ` +
      'Run /login grok-cli again (prefer "Use existing Grok Build login" if available) so the token includes conversations:read/write.'
    );
  }
  return (
    'Grok CLI returned Access denied. Confirm this xAI account has SuperGrok/Grok CLI access, ' +
    'or run /login grok-cli and choose "Use existing Grok Build login" if the official Grok CLI works on this machine.'
  );
}
