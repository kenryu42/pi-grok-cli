import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getBaseUrl, XAI_ISSUER, XAI_OAUTH_CLIENT_ID, XAI_TOKEN_ENDPOINT } from './config.js';
import type { XaiOAuthCredentials } from './oauth.js';

function expiryMilliseconds(value: unknown) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1_000_000_000_000 && value < 100_000_000_000_000
      ? value
      : undefined;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseGrokCredentials(value: unknown): XaiOAuthCredentials | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = (value as Record<string, unknown>)[`${XAI_ISSUER}::${XAI_OAUTH_CLIENT_ID}`];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;

  const record = entry as Record<string, unknown>;
  const expires = expiryMilliseconds(record.expires_at);
  if (
    typeof record.key !== 'string' ||
    !record.key ||
    typeof record.refresh_token !== 'string' ||
    !record.refresh_token ||
    record.oidc_issuer !== XAI_ISSUER ||
    record.oidc_client_id !== XAI_OAUTH_CLIENT_ID ||
    expires === undefined
  ) {
    return undefined;
  }

  return {
    access: record.key,
    refresh: record.refresh_token,
    expires,
    tokenEndpoint: XAI_TOKEN_ENDPOINT,
    baseUrl: getBaseUrl(),
  };
}

export async function readGrokCredentials() {
  try {
    return parseGrokCredentials(
      JSON.parse(await readFile(join(homedir(), '.grok', 'auth.json'), 'utf8')),
    );
  } catch {
    return undefined;
  }
}
