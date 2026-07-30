import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';

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

export function saveTestAccounts(selectedProvider = 'grok-cli-2') {
  saveConfig({
    ...DEFAULT_CONFIG,
    accounts: { nextAccountNumber: 3, selectedProvider, items: TEST_ACCOUNTS },
  });
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
    process.env.HOME = dir;
    return dir;
  };
}
