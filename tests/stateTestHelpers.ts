import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { ACCOUNT_VAULT_MARKER, mutateAccountVault } from '../src/provider/accountVault.js';
import { getConfigPath, writeFileAtomic } from '../src/storage.js';

export const TEST_ACCOUNTS = [
  { provider: 'grok-cli', label: 'Personal' },
  { provider: 'grok-cli-2', label: 'Work' },
];

export const oauthCredential = (access: string) => ({
  type: 'oauth' as const,
  access,
  refresh: `${access}-refresh`,
  expires: Date.now() + 60_000,
});

export function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}

export function saveTestAccounts(selectedProvider = 'grok-cli-2') {
  writeFileAtomic(
    getConfigPath(),
    `${JSON.stringify({
      version: 2,
      accounts: { nextAccountNumber: 3, selectedProvider, items: TEST_ACCOUNTS },
      imagine: { enabled: true },
    })}\n`,
  );
}

/**
 * Point HOME at a fresh temp dir for the whole test file, restoring it on
 * teardown. Returns a setup function that creates a new dir per call.
 */
export function useTempHome(): () => string {
  const originalHome = process.env.HOME;
  const dirs: string[] = [];
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-cli-test-'));
    dirs.push(dir);
    process.env.HOME = dir;
    return dir;
  };
}

export function useEnvironmentToken() {
  const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;
  afterEach(() => {
    if (originalToken === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN;
    else process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
  });
  return (token?: string) => {
    if (token === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN;
    else process.env.GROK_CLI_OAUTH_TOKEN = token;
  };
}

export function setAccount1Credential(access: string) {
  return mutateAccountVault((vault) => {
    vault.migration.legacyCredentialCopyComplete = true;
    vault.accounts[0].credential = oauthCredential(access);
    vault.accounts[0].revision += 1;
    vault.activeAccountId = 'account-1';
  });
}

export function writeTestJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePiCredentials(credentials: Record<string, unknown>) {
  writeTestJson(join(process.env.HOME as string, '.pi', 'agent', 'auth.json'), credentials);
}

export function writePiCredential(credential: {
  access: string;
  refresh: string;
  expires: number;
}) {
  writePiCredentials({ 'grok-cli': { type: 'oauth', ...credential } });
}

export function writePiVaultMarker() {
  writePiCredential({
    access: ACCOUNT_VAULT_MARKER,
    refresh: ACCOUNT_VAULT_MARKER,
    expires: Number.MAX_SAFE_INTEGER,
  });
}
