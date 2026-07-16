import { describe, expect, it } from 'vitest';
import {
  formatGrokCliAccessDeniedHint,
  missingGrokCliScopes,
  tokenScopes,
  XAI_OAUTH_SCOPE,
} from '../../src/auth/config.js';

function jwt(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `hdr.${body}.sig`;
}

describe('Grok CLI OAuth scope defaults', () => {
  it('requests conversations scopes used by the official Grok CLI', () => {
    expect(XAI_OAUTH_SCOPE).toContain('grok-cli:access');
    expect(XAI_OAUTH_SCOPE).toContain('conversations:read');
    expect(XAI_OAUTH_SCOPE).toContain('conversations:write');
  });

  it('detects tokens missing cli-chat-proxy conversation scopes', () => {
    const incomplete = jwt({
      scope: 'openid profile email offline_access grok-cli:access api:access',
    });
    expect(tokenScopes(incomplete)).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'grok-cli:access',
      'api:access',
    ]);
    expect(missingGrokCliScopes(incomplete)).toEqual(['conversations:read', 'conversations:write']);
    expect(formatGrokCliAccessDeniedHint(incomplete)).toContain('missing required scopes');
  });

  it('accepts official-style tokens with conversation scopes', () => {
    const complete = jwt({
      scope:
        'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
    });
    expect(missingGrokCliScopes(complete)).toEqual([]);
    expect(formatGrokCliAccessDeniedHint(complete)).toContain('SuperGrok/Grok CLI access');
  });
});
