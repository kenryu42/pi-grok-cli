import * as oauth from '../auth/oauth.js';
import { getBaseUrl } from '../auth/oauth.js';
import { confirmMarkerInstallation, hasAccountVaultMarker } from './accountMigration.js';
import {
  ACCOUNT_1_ID,
  type AccountCredential,
  getAccountVault,
  mutateAccountVault,
} from './accountVault.js';

export interface AccountRoute {
  accountId: string;
  revision: number;
  token: string;
  baseUrl: string;
  source: 'environment' | 'vault';
}

const refreshes = new Map<string, Promise<AccountCredential>>();

function route(accountId: string, revision: number, credential: AccountCredential): AccountRoute {
  return {
    accountId,
    revision,
    token: credential.access,
    baseUrl: (credential.baseUrl ?? getBaseUrl()).replace(/\/+$/, ''),
    source: 'vault',
  };
}

async function refreshRoute(
  accountId: string,
  revision: number,
  credential: AccountCredential,
  fallbackToActive: boolean,
) {
  const key = `${accountId}:${revision}`;
  const pending =
    refreshes.get(key) ??
    oauth
      .refresh(credential as typeof credential & Record<string, unknown>)
      .then((refreshed) => refreshed as AccountCredential);
  refreshes.set(key, pending);
  try {
    const refreshed = await pending;
    const stored = await mutateAccountVault((vault) => {
      const account = vault.accounts.find((candidate) => candidate.id === accountId);
      if (!account?.credential || account.revision !== revision) return undefined;
      account.credential = refreshed;
      account.revision += 1;
      return route(account.id, account.revision, account.credential);
    });
    if (stored) return stored;
    return resolveAccountRoute(fallbackToActive ? undefined : accountId);
  } finally {
    if (refreshes.get(key) === pending) refreshes.delete(key);
  }
}

export async function resolveAccountRoute(accountId?: string): Promise<AccountRoute> {
  if (process.env.GROK_CLI_OAUTH_TOKEN) {
    return {
      accountId: ACCOUNT_1_ID,
      revision: 0,
      token: process.env.GROK_CLI_OAUTH_TOKEN,
      baseUrl: getBaseUrl().replace(/\/+$/, ''),
      source: 'environment',
    };
  }

  let vault = await getAccountVault();
  if (vault.migration.markerInstallPending && (await confirmMarkerInstallation())) {
    vault = await getAccountVault();
  }
  if (!hasAccountVaultMarker()) {
    throw new Error('Grok CLI account migration is ready. Please run /login and select Grok CLI.');
  }
  const account = accountId
    ? vault.accounts.find(
        (candidate) => candidate.id === accountId && candidate.credential !== undefined,
      )
    : (vault.accounts.find(
        (candidate) => candidate.id === vault.activeAccountId && candidate.credential !== undefined,
      ) ?? vault.accounts.find((candidate) => candidate.credential !== undefined));
  if (!account?.credential) {
    throw new Error('Grok CLI login is required. Run /login and select Grok CLI.');
  }
  if (!accountId && vault.activeAccountId !== account.id) {
    await mutateAccountVault((latest) => {
      const selected = latest.accounts.find(
        (candidate) => candidate.id === account.id && candidate.credential !== undefined,
      );
      if (selected) latest.activeAccountId = selected.id;
    });
  }
  if (Date.now() < account.credential.expires) {
    return route(account.id, account.revision, account.credential);
  }
  return refreshRoute(account.id, account.revision, account.credential, accountId === undefined);
}
