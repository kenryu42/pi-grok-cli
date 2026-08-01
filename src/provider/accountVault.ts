import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  acquireFileLock,
  getAccountVaultPath,
  getGrokCliDirectory,
  writeFileAtomic,
} from '../storage.js';

export const ACCOUNT_1_ID = 'account-1';
export const ACCOUNT_VAULT_MARKER = 'pi-grok-cli-account-vault-v1';

export interface AccountCredential {
  access: string;
  refresh: string;
  expires: number;
  tokenEndpoint?: string;
  discovery?: {
    authorization_endpoint: string;
    token_endpoint: string;
    device_authorization_endpoint?: string;
  };
  idToken?: string;
  tokenType?: string;
  baseUrl?: string;
}

export interface VaultAccount {
  id: string;
  slot: number;
  label: string;
  credential?: AccountCredential;
  revision: number;
}

export interface AccountVault {
  version: 1;
  migration: {
    legacyCredentialCopyComplete: boolean;
    markerInstallPending: boolean;
  };
  nextSlot: number;
  activeAccountId?: string;
  accounts: VaultAccount[];
}

const defaultVault = (): AccountVault => ({
  version: 1,
  migration: {
    legacyCredentialCopyComplete: false,
    markerInstallPending: false,
  },
  nextSlot: 2,
  accounts: [{ id: ACCOUNT_1_ID, slot: 1, label: 'Account 1', revision: 0 }],
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string';
}

function parseCredential(value: unknown): AccountCredential | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.access !== 'string' ||
    !value.access ||
    value.access === ACCOUNT_VAULT_MARKER ||
    typeof value.refresh !== 'string' ||
    !value.refresh ||
    value.refresh === ACCOUNT_VAULT_MARKER ||
    typeof value.expires !== 'number' ||
    !Number.isFinite(value.expires) ||
    !validOptionalString(value.tokenEndpoint) ||
    !validOptionalString(value.idToken) ||
    !validOptionalString(value.tokenType) ||
    !validOptionalString(value.baseUrl)
  ) {
    return undefined;
  }
  if (
    value.discovery !== undefined &&
    (!isObject(value.discovery) ||
      typeof value.discovery.authorization_endpoint !== 'string' ||
      typeof value.discovery.token_endpoint !== 'string' ||
      !validOptionalString(value.discovery.device_authorization_endpoint))
  ) {
    return undefined;
  }
  return {
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(typeof value.tokenEndpoint === 'string' ? { tokenEndpoint: value.tokenEndpoint } : {}),
    ...(isObject(value.discovery)
      ? {
          discovery: {
            authorization_endpoint: String(value.discovery.authorization_endpoint),
            token_endpoint: String(value.discovery.token_endpoint),
            ...(typeof value.discovery.device_authorization_endpoint === 'string'
              ? { device_authorization_endpoint: value.discovery.device_authorization_endpoint }
              : {}),
          },
        }
      : {}),
    ...(typeof value.idToken === 'string' ? { idToken: value.idToken } : {}),
    ...(typeof value.tokenType === 'string' ? { tokenType: value.tokenType } : {}),
    ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
  };
}

function parseVault(value: unknown, path: string): AccountVault {
  const invalid = (reason: string): never => {
    throw new Error(`Invalid Grok CLI account vault at ${path}: ${reason}`);
  };
  if (!isObject(value)) return invalid('root must be a JSON object');
  if (value.version !== 1) invalid('unsupported version');
  const raw = value;
  if (
    !isObject(raw.migration) ||
    typeof raw.migration.legacyCredentialCopyComplete !== 'boolean' ||
    typeof raw.migration.markerInstallPending !== 'boolean'
  ) {
    invalid('invalid migration state');
  }
  const migration = raw.migration as {
    legacyCredentialCopyComplete: boolean;
    markerInstallPending: boolean;
  };
  if (!Number.isInteger(raw.nextSlot) || Number(raw.nextSlot) < 2) {
    invalid('invalid next slot');
  }
  if (!Array.isArray(raw.accounts) || !raw.accounts.length) return invalid('accounts are missing');

  const ids = new Set<string>();
  const slots = new Set<number>();
  const labels = new Set<string>();
  const accounts = raw.accounts.map((candidate, index): VaultAccount => {
    if (
      !isObject(candidate) ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      !Number.isInteger(candidate.slot) ||
      Number(candidate.slot) < 1 ||
      typeof candidate.label !== 'string' ||
      !candidate.label.trim() ||
      typeof candidate.revision !== 'number' ||
      !Number.isInteger(candidate.revision) ||
      Number(candidate.revision) < 0
    ) {
      return invalid(`invalid account at index ${index}`);
    }
    const slot = Number(candidate.slot);
    const label = candidate.label.trim();
    if (ids.has(candidate.id) || slots.has(slot) || labels.has(label.toLocaleLowerCase())) {
      return invalid(`duplicate account at index ${index}`);
    }
    const credential =
      candidate.credential === undefined ? undefined : parseCredential(candidate.credential);
    if (candidate.credential !== undefined && !credential) {
      return invalid(`invalid credential at index ${index}`);
    }
    ids.add(candidate.id);
    slots.add(slot);
    labels.add(label.toLocaleLowerCase());
    return {
      id: candidate.id,
      slot,
      label,
      ...(credential ? { credential } : {}),
      revision: Number(candidate.revision),
    };
  });

  if (accounts[0]?.id !== ACCOUNT_1_ID || accounts[0].slot !== 1) {
    invalid('Account 1 must be first and permanent');
  }
  if (Number(raw.nextSlot) <= Math.max(...accounts.map((account) => account.slot))) {
    invalid('next slot must be greater than every account slot');
  }
  if (
    raw.activeAccountId !== undefined &&
    (typeof raw.activeAccountId !== 'string' ||
      !accounts.some(
        (account) => account.id === raw.activeAccountId && account.credential !== undefined,
      ))
  ) {
    invalid('active account must be logged in');
  }

  return {
    version: 1,
    migration: {
      legacyCredentialCopyComplete: migration.legacyCredentialCopyComplete,
      markerInstallPending: migration.markerInstallPending,
    },
    nextSlot: Number(raw.nextSlot),
    ...(typeof raw.activeAccountId === 'string' ? { activeAccountId: raw.activeAccountId } : {}),
    accounts,
  };
}

async function withVaultLock<T>(action: (current: AccountVault) => T, write: boolean) {
  const directory = getGrokCliDirectory();
  const path = getAccountVaultPath();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const release = await acquireFileLock(path);
  try {
    const current = existsSync(path)
      ? parseVault(JSON.parse(readFileSync(path, 'utf8')) as unknown, path)
      : defaultVault();
    const next = structuredClone(current);
    const result = action(next);
    if (!write) return result;
    const validated = parseVault(next, path);
    writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`, 0o600);
    chmodSync(path, 0o600);
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Grok CLI account vault at ${path}: ${error.message}`);
    }
    throw error;
  } finally {
    await release();
  }
}

export function getAccountVault() {
  return withVaultLock((current) => structuredClone(current), false);
}

export function getAccountVaultSync() {
  const directory = getGrokCliDirectory();
  const path = getAccountVaultPath();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  try {
    return existsSync(path)
      ? parseVault(JSON.parse(readFileSync(path, 'utf8')) as unknown, path)
      : defaultVault();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Grok CLI account vault at ${path}: ${error.message}`);
    }
    throw error;
  }
}

export function mutateAccountVault<T>(mutation: (vault: AccountVault) => T) {
  return withVaultLock(mutation, true);
}
