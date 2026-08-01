import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_1_ID,
  getAccountVault,
  getAccountVaultSync,
  mutateAccountVault,
} from '../../src/provider/accountVault.js';
import { acquireFileLock, getAccountVaultPath } from '../../src/storage.js';
import { useTempHome } from '../stateTestHelpers.js';

const setupHome = useTempHome();

describe('Grok CLI account vault', () => {
  it('creates a locked vault with permanent Account 1 on its first mutation', async () => {
    const home = setupHome();

    await mutateAccountVault((vault) => {
      vault.accounts[0].label = 'Personal';
    });

    expect(await getAccountVault()).toEqual({
      version: 1,
      migration: {
        legacyCredentialCopyComplete: false,
        markerInstallPending: false,
      },
      nextSlot: 2,
      accounts: [
        {
          id: ACCOUNT_1_ID,
          slot: 1,
          label: 'Personal',
          revision: 0,
        },
      ],
    });
    expect(statSync(join(home, '.pi', 'grok-cli')).mode & 0o777).toBe(0o700);
    expect(statSync(getAccountVaultPath()).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent mutations without losing accounts or slots', async () => {
    setupHome();

    await Promise.all(
      Array.from({ length: 4 }, (_value, index) =>
        mutateAccountVault((vault) => {
          const slot = vault.nextSlot;
          vault.nextSlot += 1;
          vault.accounts.push({
            id: `account-${index + 2}`,
            slot,
            label: `Account ${slot}`,
            revision: 0,
          });
        }),
      ),
    );

    const vault = await getAccountVault();
    expect(vault.accounts.map((account) => account.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(vault.nextSlot).toBe(6);
  });

  it('rejects malformed or invalid state without changing the file', async () => {
    const home = setupHome();
    const path = getAccountVaultPath();
    mkdirSync(join(home, '.pi', 'grok-cli'), { recursive: true });

    for (const contents of [
      '{malformed',
      JSON.stringify({
        version: 1,
        migration: { legacyCredentialCopyComplete: false, markerInstallPending: false },
        nextSlot: 2,
        activeAccountId: 'missing',
        accounts: [{ id: ACCOUNT_1_ID, slot: 1, label: 'Account 1', revision: 0 }],
      }),
    ]) {
      writeFileSync(path, contents, { mode: 0o600 });

      await expect(getAccountVault()).rejects.toThrow(path);
      expect(readFileSync(path, 'utf8')).toBe(contents);
    }
  });

  it('distinguishes an invalid root from an unsupported vault version', async () => {
    const home = setupHome();
    const path = getAccountVaultPath();
    mkdirSync(join(home, '.pi', 'grok-cli'), { recursive: true });

    writeFileSync(path, '[]', { mode: 0o600 });
    await expect(getAccountVault()).rejects.toThrow('root must be a JSON object');

    writeFileSync(path, '{"version":2}', { mode: 0o600 });
    await expect(getAccountVault()).rejects.toThrow('unsupported version');
  });

  it('repairs permissive vault permissions after a successful mutation', async () => {
    const home = setupHome();
    await mutateAccountVault(() => undefined);
    chmodSync(join(home, '.pi', 'grok-cli'), 0o755);
    chmodSync(getAccountVaultPath(), 0o644);

    await mutateAccountVault(() => undefined);

    expect(statSync(join(home, '.pi', 'grok-cli')).mode & 0o777).toBe(0o700);
    expect(statSync(getAccountVaultPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${getAccountVaultPath()}.lock`)).toBe(false);
  });

  it('reads the atomic vault snapshot while another process holds the mutation lock', async () => {
    setupHome();
    await mutateAccountVault((vault) => {
      vault.accounts[0].label = 'Personal';
    });
    const release = await acquireFileLock(getAccountVaultPath());

    try {
      expect(getAccountVaultSync().accounts[0].label).toBe('Personal');
    } finally {
      await release();
    }
  });
});
