import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { Credential } from '@earendil-works/pi-ai';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { hasTerminalControlCharacters } from '../config.js';
import {
  acquireFileLock,
  getAccountVaultPath,
  getConfigBackupPath,
  getConfigPath,
  getLegacyConfigPath,
  getQuotaCachePath,
  writeFileAtomic,
} from '../storage.js';
import {
  ACCOUNT_1_ID,
  ACCOUNT_VAULT_MARKER,
  type AccountCredential,
  getAccountVault,
  mutateAccountVault,
} from './accountVault.js';

type ReleasedAccount = { provider: string; label: string; slot: number };
type ReadCredential = (provider: string) => Credential | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function releasedAccount(provider: unknown, label: unknown): ReleasedAccount | undefined {
  if (typeof provider !== 'string' || typeof label !== 'string') return undefined;
  const normalizedLabel = label.trim();
  if (
    !normalizedLabel ||
    [...normalizedLabel].length > 40 ||
    hasTerminalControlCharacters(normalizedLabel)
  ) {
    return undefined;
  }
  if (provider === 'grok-cli') return { provider, label: normalizedLabel, slot: 1 };
  const match = /^grok-cli-((?:[2-9]|[1-9]\d+))$/.exec(provider);
  return match ? { provider, label: normalizedLabel, slot: Number(match[1]) } : undefined;
}

function readReleasedConfig() {
  const path = existsSync(getConfigPath())
    ? getConfigPath()
    : existsSync(getLegacyConfigPath())
      ? getLegacyConfigPath()
      : undefined;
  if (!path) {
    return {
      accounts: [{ provider: 'grok-cli', label: 'Account 1', slot: 1 }],
      imagine: { enabled: true },
      nextSlot: 2,
      selectedProvider: 'grok-cli',
    };
  }
  const contents = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(contents);
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  if (parsed.version === 3) return undefined;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`${path} is not a supported version 1 or 2 configuration`);
  }
  const releasedAccounts: {
    items: unknown[];
    selectedProvider?: unknown;
    nextAccountNumber?: unknown;
  } =
    isObject(parsed.accounts) && Array.isArray(parsed.accounts.items)
      ? {
          items: parsed.accounts.items,
          selectedProvider: parsed.accounts.selectedProvider,
          nextAccountNumber: parsed.accounts.nextAccountNumber,
        }
      : { items: [] };
  const baseIndex = releasedAccounts.items.findIndex(
    (account) =>
      isObject(account) &&
      releasedAccount(account.provider, account.label)?.provider === 'grok-cli',
  );
  const accountValues =
    baseIndex >= 0
      ? [
          releasedAccounts.items[baseIndex],
          ...releasedAccounts.items.filter((_account, index) => index !== baseIndex),
        ]
      : [{ provider: 'grok-cli', label: 'Account 1' }, ...releasedAccounts.items];
  const providers = new Set<string>();
  const labels = new Set<string>();
  const accounts = accountValues.flatMap((account) => {
    if (!isObject(account)) return [];
    const value = releasedAccount(account.provider, account.label);
    if (!value || providers.has(value.provider) || labels.has(value.label.toLocaleLowerCase())) {
      return [];
    }
    providers.add(value.provider);
    labels.add(value.label.toLocaleLowerCase());
    return [value];
  });
  const ordered = accounts.sort((left, right) => left.slot - right.slot);
  return {
    contents,
    path,
    accounts: ordered,
    selectedProvider:
      typeof releasedAccounts.selectedProvider === 'string'
        ? releasedAccounts.selectedProvider
        : 'grok-cli',
    nextSlot:
      typeof releasedAccounts.nextAccountNumber === 'number' &&
      Number.isInteger(releasedAccounts.nextAccountNumber)
        ? Math.max(
            releasedAccounts.nextAccountNumber,
            Math.max(...ordered.map(({ slot }) => slot)) + 1,
          )
        : Math.max(...ordered.map(({ slot }) => slot)) + 1,
    imagine:
      isObject(parsed.imagine) && typeof parsed.imagine.enabled === 'boolean'
        ? { enabled: parsed.imagine.enabled }
        : { enabled: true },
  };
}

function accountCredential(credential: Credential | undefined): AccountCredential | undefined {
  if (
    credential?.type !== 'oauth' ||
    !credential.access ||
    credential.access === ACCOUNT_VAULT_MARKER ||
    !credential.refresh ||
    credential.refresh === ACCOUNT_VAULT_MARKER ||
    !Number.isFinite(credential.expires)
  ) {
    return undefined;
  }
  const { type: _type, ...oauth } = credential;
  return structuredClone(oauth) as AccountCredential;
}

function migrateQuota(accountIds: Map<string, string>) {
  if (!existsSync(getQuotaCachePath())) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getQuotaCachePath(), 'utf8')) as unknown;
  } catch {
    return;
  }
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.accounts)) return;
  const migratedIds = new Set(accountIds.values());
  const accounts = Object.fromEntries(
    Object.entries(parsed.accounts).flatMap(([provider, value]) => {
      const accountId =
        accountIds.get(provider) ?? (migratedIds.has(provider) ? provider : undefined);
      return accountId ? [[accountId, value]] : [];
    }),
  );
  writeFileAtomic(
    getQuotaCachePath(),
    `${JSON.stringify({ ...parsed, accounts }, null, 2)}\n`,
    0o600,
  );
}

function preserveReleasedConfig(contents: string) {
  if (existsSync(getConfigBackupPath())) return;
  writeFileAtomic(getConfigBackupPath(), contents, 0o600);
  if (readFileSync(getConfigBackupPath(), 'utf8') !== contents) {
    throw new Error(`Could not verify ${getConfigBackupPath()}`);
  }
}

async function migrateReleasedAccountsUnlocked(
  options: { readCredential?: ReadCredential } = {},
): Promise<{ migrated: boolean }> {
  const released = readReleasedConfig();
  const current = await getAccountVault();
  if (
    !existsSync(getConfigPath()) &&
    !existsSync(getLegacyConfigPath()) &&
    current.migration.legacyCredentialCopyComplete
  ) {
    return { migrated: false };
  }
  if (!released && current.migration.legacyCredentialCopyComplete) return { migrated: false };
  if (!released) {
    await mutateAccountVault((vault) => {
      vault.migration.legacyCredentialCopyComplete = true;
    });
    return { migrated: true };
  }
  const source = released;
  const readCredential = options.readCredential ?? readStoredCredential;

  await mutateAccountVault((vault) => {
    const accounts = source.accounts.map((account) => {
      const existing = vault.accounts.find((candidate) => candidate.slot === account.slot);
      const credential = accountCredential(readCredential(account.provider));
      return {
        id: account.slot === 1 ? ACCOUNT_1_ID : (existing?.id ?? randomUUID()),
        slot: account.slot,
        label: account.label,
        ...(credential ? { credential } : {}),
        revision: existing?.revision ?? 0,
      };
    });
    const selected =
      accounts.find((account) => {
        const sourceAccount = source.accounts.find(
          (candidate) => candidate.provider === source.selectedProvider,
        );
        return account.credential && account.slot === sourceAccount?.slot;
      }) ?? accounts.find((account) => account.credential);
    vault.accounts = accounts;
    vault.nextSlot = source.nextSlot;
    if (selected) vault.activeAccountId = selected.id;
    else delete vault.activeAccountId;
    vault.migration.markerInstallPending = accounts.some((account) => account.credential);
    vault.migration.legacyCredentialCopyComplete = false;
  });

  const migrated = await getAccountVault();
  const accountIds = new Map(
    migrated.accounts.map((account) => [
      account.slot === 1 ? 'grok-cli' : `grok-cli-${account.slot}`,
      account.id,
    ]),
  );
  if ('contents' in source && typeof source.contents === 'string') {
    preserveReleasedConfig(source.contents);
  }
  migrateQuota(accountIds);
  if ('contents' in source) {
    writeFileAtomic(
      getConfigPath(),
      `${JSON.stringify({ version: 3, imagine: source.imagine }, null, 2)}\n`,
    );
    if (source.path === getLegacyConfigPath()) unlinkSync(source.path);
  }
  await mutateAccountVault((vault) => {
    vault.migration.legacyCredentialCopyComplete = true;
  });
  return { migrated: true };
}

export async function migrateReleasedAccounts(
  options: { readCredential?: ReadCredential } = {},
): Promise<{ migrated: boolean }> {
  const release = await acquireFileLock(`${getAccountVaultPath()}.migration`);
  try {
    return await migrateReleasedAccountsUnlocked(options);
  } finally {
    await release();
  }
}

export async function confirmMarkerInstallation(
  readCredential: ReadCredential = readStoredCredential,
) {
  if (!hasAccountVaultMarker(readCredential)) return false;
  return mutateAccountVault((vault) => {
    if (!vault.migration.markerInstallPending) return false;
    vault.migration.markerInstallPending = false;
    return true;
  });
}

export function hasAccountVaultMarker(readCredential: ReadCredential = readStoredCredential) {
  const credential = readCredential('grok-cli');
  return (
    credential?.type === 'oauth' &&
    credential.access === ACCOUNT_VAULT_MARKER &&
    credential.refresh === ACCOUNT_VAULT_MARKER
  );
}
