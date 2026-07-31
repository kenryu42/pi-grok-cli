import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmMarkerInstallation,
  migrateReleasedAccounts,
} from '../../src/provider/accountMigration.js';
import { ACCOUNT_VAULT_MARKER, getAccountVault } from '../../src/provider/accountVault.js';
import {
  getConfigBackupPath,
  getConfigPath,
  getLegacyConfigPath,
  getQuotaCachePath,
} from '../../src/storage.js';
import { oauthCredential, useTempHome, writeTestJson } from '../stateTestHelpers.js';

const setupHome = useTempHome();

const releasedConfig = {
  version: 2,
  accounts: {
    nextAccountNumber: 11,
    selectedProvider: 'grok-cli-10',
    items: [
      { provider: 'grok-cli', label: 'Personal' },
      { provider: 'grok-cli-2', label: 'Work' },
      { provider: 'grok-cli-10', label: 'Backup' },
    ],
  },
  imagine: { enabled: false },
};
const releasedAccountLabels = [
  { slot: 1, label: 'Personal' },
  { slot: 2, label: 'Work' },
  { slot: 10, label: 'Backup' },
];

describe('released account migration', () => {
  it('moves v0.6 account state into the vault and keeps a downgrade backup', async () => {
    setupHome();
    writeTestJson(getConfigPath(), releasedConfig);
    writeTestJson(getQuotaCachePath(), {
      version: 1,
      accounts: {
        'grok-cli': { updatedAt: '2026-07-01T00:00:00.000Z', monthly: {} },
        'grok-cli-10': { updatedAt: '2026-07-02T00:00:00.000Z', monthly: {} },
      },
    });
    const credentials = {
      'grok-cli': { ...oauthCredential('personal'), baseUrl: 'https://personal.example' },
      'grok-cli-10': oauthCredential('backup'),
    };
    const readCredential = vi.fn(
      (provider: string) => credentials[provider as keyof typeof credentials],
    );
    const original = readFileSync(getConfigPath(), 'utf8');

    expect(await migrateReleasedAccounts({ readCredential })).toEqual({ migrated: true });

    const vault = await getAccountVault();
    expect(vault.accounts.map(({ slot, label }) => ({ slot, label }))).toEqual(
      releasedAccountLabels,
    );
    expect(vault.accounts[0]?.credential).toMatchObject({
      access: 'personal',
      baseUrl: 'https://personal.example',
    });
    expect(vault.accounts[1]?.credential).toBeUndefined();
    expect(vault.activeAccountId).toBe(vault.accounts[2]?.id);
    expect(vault.migration).toEqual({
      legacyCredentialCopyComplete: true,
      markerInstallPending: true,
    });
    expect(readFileSync(getConfigBackupPath(), 'utf8')).toBe(original);
    expect(statSync(getConfigBackupPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual({
      version: 3,
      imagine: { enabled: false },
    });
    expect(Object.keys(JSON.parse(readFileSync(getQuotaCachePath(), 'utf8')).accounts)).toEqual([
      vault.accounts[0]?.id,
      vault.accounts[2]?.id,
    ]);
  });

  it('migrates the previously supported version 1 account configuration', async () => {
    setupHome();
    writeTestJson(getConfigPath(), { ...releasedConfig, version: 1 });

    await migrateReleasedAccounts({
      readCredential: (provider) =>
        provider === 'grok-cli-10' ? oauthCredential('backup') : undefined,
    });

    const vault = await getAccountVault();
    expect(vault.accounts.map(({ slot, label }) => ({ slot, label }))).toEqual(
      releasedAccountLabels,
    );
    expect(vault.activeAccountId).toBe(vault.accounts[2].id);
  });

  it('migrates a released config with missing account metadata as Account 1', async () => {
    setupHome();
    writeTestJson(getConfigPath(), { version: 2, imagine: { enabled: false } });
    const original = readFileSync(getConfigPath(), 'utf8');

    await migrateReleasedAccounts({
      readCredential: (provider) =>
        provider === 'grok-cli' ? oauthCredential('personal') : undefined,
    });

    expect((await getAccountVault()).accounts).toMatchObject([
      { id: 'account-1', label: 'Account 1', credential: { access: 'personal' } },
    ]);
    expect(readFileSync(getConfigBackupPath(), 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toEqual({
      version: 3,
      imagine: { enabled: false },
    });
  });

  it('normalizes tolerated legacy account entries before vault import', async () => {
    setupHome();
    writeTestJson(getConfigPath(), {
      version: 1,
      accounts: {
        nextAccountNumber: 5,
        selectedProvider: 'grok-cli-2',
        items: [
          { provider: 'grok-cli-2', label: 'Account 1' },
          { provider: 'grok-cli-3', label: 'Work' },
          { provider: 'grok-cli-4', label: 'Work' },
        ],
      },
      imagine: { enabled: true },
    });

    await migrateReleasedAccounts({
      readCredential: (provider) =>
        provider === 'grok-cli-3' ? oauthCredential('work') : undefined,
    });

    const vault = await getAccountVault();
    expect(vault.accounts.map(({ slot, label }) => ({ slot, label }))).toEqual([
      { slot: 1, label: 'Account 1' },
      { slot: 3, label: 'Work' },
    ]);
    expect(vault.activeAccountId).toBe(vault.accounts[1].id);
  });

  it('completes migration when the derived quota cache is malformed', async () => {
    setupHome();
    writeTestJson(getConfigPath(), releasedConfig);
    writeFileSync(getQuotaCachePath(), '{malformed');

    await expect(
      migrateReleasedAccounts({
        readCredential: (provider) =>
          provider === 'grok-cli' ? oauthCredential('personal') : undefined,
      }),
    ).resolves.toEqual({ migrated: true });

    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).version).toBe(3);
    expect((await getAccountVault()).accounts[0].credential?.access).toBe('personal');
  });

  it('retries without changing account identities or duplicating records', async () => {
    setupHome();
    writeTestJson(getConfigPath(), releasedConfig);
    const readCredential = (provider: string) =>
      provider === 'grok-cli' ? oauthCredential('personal') : undefined;

    await migrateReleasedAccounts({ readCredential });
    const first = await getAccountVault();
    await migrateReleasedAccounts({ readCredential });

    expect(await getAccountVault()).toEqual(first);
    expect(readFileSync(getConfigBackupPath(), 'utf8')).toContain('"version": 2');
  });

  it('serializes two upgrade migrations before either reads released state', async () => {
    setupHome();
    writeTestJson(getConfigPath(), releasedConfig);

    await Promise.all([
      migrateReleasedAccounts({
        readCredential: (provider) =>
          provider === 'grok-cli' ? oauthCredential('first') : undefined,
      }),
      migrateReleasedAccounts({
        readCredential: (provider) =>
          provider === 'grok-cli' ? oauthCredential('stale-second') : undefined,
      }),
    ]);

    expect((await getAccountVault()).accounts[0].credential?.access).toBe('first');
  });

  it('imports all accounts from the released legacy config path', async () => {
    setupHome();
    writeTestJson(getLegacyConfigPath(), releasedConfig);

    await migrateReleasedAccounts({
      readCredential: (provider) =>
        provider === 'grok-cli-10' ? oauthCredential('backup') : undefined,
    });

    expect((await getAccountVault()).accounts.map(({ slot, label }) => ({ slot, label }))).toEqual(
      releasedAccountLabels,
    );
    expect(existsSync(getLegacyConfigPath())).toBe(false);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).version).toBe(3);
  });

  it('migrates a normal Account 1 login when no extension config exists', async () => {
    setupHome();

    expect(
      await migrateReleasedAccounts({
        readCredential: (provider) =>
          provider === 'grok-cli' ? oauthCredential('personal') : undefined,
      }),
    ).toEqual({ migrated: true });

    const vault = await getAccountVault();
    expect(vault.accounts).toHaveLength(1);
    expect(vault.accounts[0]?.credential?.access).toBe('personal');
    expect(vault.activeAccountId).toBe(vault.accounts[0]?.id);
    expect(existsSync(getConfigBackupPath())).toBe(false);
  });

  it('rejects the vault marker as a real credential', async () => {
    setupHome();

    await migrateReleasedAccounts({
      readCredential: (provider) =>
        provider === 'grok-cli'
          ? {
              type: 'oauth',
              access: ACCOUNT_VAULT_MARKER,
              refresh: ACCOUNT_VAULT_MARKER,
              expires: Number.MAX_SAFE_INTEGER,
            }
          : undefined,
    });

    expect((await getAccountVault()).accounts[0].credential).toBeUndefined();
  });

  it('clears pending marker state only after the Pi marker is observed', async () => {
    setupHome();
    await migrateReleasedAccounts({
      readCredential: (provider) =>
        provider === 'grok-cli' ? oauthCredential('personal') : undefined,
    });

    expect(await confirmMarkerInstallation(() => undefined)).toBe(false);
    expect((await getAccountVault()).migration.markerInstallPending).toBe(true);
    expect(
      await confirmMarkerInstallation(() => ({
        type: 'oauth',
        access: ACCOUNT_VAULT_MARKER,
        refresh: ACCOUNT_VAULT_MARKER,
        expires: Number.MAX_SAFE_INTEGER,
      })),
    ).toBe(true);
    expect((await getAccountVault()).migration.markerInstallPending).toBe(false);
  });
});
