import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ACCOUNT_1_ID, getAccountVaultSync } from './accountVault.js';

export const SESSION_ACCOUNT_ENTRY = 'grok-cli-active-account-v1';

function storedAccountId(
  entry: ReturnType<ExtensionContext['sessionManager']['getBranch']>[number],
) {
  if (entry.type !== 'custom' || entry.customType !== SESSION_ACCOUNT_ENTRY) return undefined;
  if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return undefined;
  const accountId = (entry.data as Record<string, unknown>).accountId;
  return typeof accountId === 'string' && accountId ? accountId : undefined;
}

export function createSessionAccountSelection(pi: Pick<ExtensionAPI, 'appendEntry'>) {
  const selections = new Map<string, string>();

  return {
    accountId(sessionId: string | undefined) {
      if (process.env.GROK_CLI_OAUTH_TOKEN) return ACCOUNT_1_ID;
      const vault = getAccountVaultSync();
      const selected = sessionId
        ? vault.accounts.find(
            (account) => account.id === selections.get(sessionId) && account.credential,
          )
        : undefined;
      if (selected) return selected.id;
      if (sessionId) selections.delete(sessionId);
      return (
        vault.accounts.find(
          (account) => account.id === vault.activeAccountId && account.credential,
        ) ?? vault.accounts.find((account) => account.credential)
      )?.id;
    },
    restore(ctx: Pick<ExtensionContext, 'sessionManager'>) {
      const sessionId = ctx.sessionManager.getSessionId();
      const restored = ctx.sessionManager
        .getBranch()
        .reduceRight<string | undefined>(
          (accountId, entry) => accountId ?? storedAccountId(entry),
          undefined,
        );
      if (restored) selections.set(sessionId, restored);
      else selections.delete(sessionId);
      return this.accountId(sessionId);
    },
    select(ctx: Pick<ExtensionContext, 'sessionManager'>, accountId: string) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (selections.get(sessionId) === accountId) return;
      selections.set(sessionId, accountId);
      pi.appendEntry(SESSION_ACCOUNT_ENTRY, { accountId });
    },
    clear(sessionId: string) {
      selections.delete(sessionId);
    },
  };
}

export type SessionAccountSelection = ReturnType<typeof createSessionAccountSelection>;
