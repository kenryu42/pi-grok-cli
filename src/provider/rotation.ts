import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAccountVault } from './accountVault.js';
import { type CachedQuota, isCachedQuotaFresh, loadQuotaCache } from './quotaCache.js';
import { requestAccount } from './requestOwnership.js';
import {
  createSessionAccountSelection,
  type SessionAccountSelection,
} from './sessionAccountSelection.js';

export const EXHAUSTED_BALANCE_ERROR =
  'OpenAI API error (402): 402 "Grok Build usage balance exhausted"';
export const ROTATION_CONTINUATION =
  'Continue the previous request using the newly selected Grok account. Do not repeat completed work.';
const RECENT_EXHAUSTION_COOLDOWN_MS = 5 * 60_000;

type FailedResponse = {
  accountId: string;
  model: string;
};

function isExhaustionMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<AssistantMessage>;
  return (
    candidate.role === 'assistant' &&
    candidate.provider === 'grok-cli' &&
    candidate.stopReason === 'error' &&
    candidate.errorMessage?.trim() === EXHAUSTED_BALANCE_ERROR
  );
}

function circularAccountIds(accountIds: string[], current: string) {
  const index = accountIds.indexOf(current);
  if (index < 0) return accountIds;
  return [...accountIds.slice(index + 1), ...accountIds.slice(0, index)];
}

function quotaScore(entry: CachedQuota | undefined, now: number) {
  if (!entry || !isCachedQuotaFresh(entry, now) || entry.monthly.monthlyLimit <= 0) {
    return undefined;
  }
  const monthly = Math.min(
    1,
    Math.max(0, (entry.monthly.monthlyLimit - entry.monthly.used) / entry.monthly.monthlyLimit),
  );
  if (!entry.weekly) return monthly;
  return Math.min(monthly, Math.min(1, Math.max(0, 1 - entry.weekly.creditUsagePercent / 100)));
}

function orderAccountsByQuota(
  accountIds: string[],
  accounts: Record<string, CachedQuota>,
  now: number,
) {
  const scored = accountIds.flatMap((accountId, index) => {
    const score = quotaScore(accounts[accountId], now);
    return score === undefined ? [] : [{ accountId, index, score }];
  });
  const ranked = [...scored].sort(
    (left, right) => right.score - left.score || left.index - right.index,
  );
  return accountIds.map((accountId, index) => {
    const scoredIndex = scored.findIndex((candidate) => candidate.index === index);
    return scoredIndex < 0 ? accountId : ranked[scoredIndex].accountId;
  });
}

export function registerExhaustionRotation(
  pi: ExtensionAPI,
  sessionSelection: SessionAccountSelection = createSessionAccountSelection(pi),
) {
  const exhausted = new Set<string>();
  const recentlyExhausted = new Map<string, number>();
  let pending: FailedResponse | undefined;
  let awaitingContinuation = false;

  const clearChain = () => {
    exhausted.clear();
    pending = undefined;
    awaitingContinuation = false;
  };

  const isRecentlyExhausted = (accountId: string, now: number) => {
    const exhaustedAt = recentlyExhausted.get(accountId);
    if (exhaustedAt === undefined) return false;
    if (now - exhaustedAt < RECENT_EXHAUSTION_COOLDOWN_MS) return true;
    recentlyExhausted.delete(accountId);
    return false;
  };

  pi.on('session_start', () => {
    clearChain();
    recentlyExhausted.clear();
  });

  pi.on('input', (event) => {
    if (event.source !== 'extension') clearChain();
  });

  pi.on('model_select', () => {
    if (pending) clearChain();
  });

  pi.on('message_end', (event, ctx) => {
    if (process.env.GROK_CLI_OAUTH_TOKEN) return;
    if (!isExhaustionMessage(event.message)) return;
    const accountId =
      requestAccount(event.message) ??
      sessionSelection.accountId(ctx.sessionManager.getSessionId());
    if (!accountId) return;
    pending = { accountId, model: event.message.model };
    exhausted.add(accountId);
    recentlyExhausted.set(accountId, Date.now());
    awaitingContinuation = false;
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (!pending) {
      if (awaitingContinuation) clearChain();
      return;
    }
    const failed = pending;
    pending = undefined;
    if (ctx.model?.provider !== 'grok-cli' || ctx.model.id !== failed.model) {
      clearChain();
      return;
    }

    const now = Date.now();
    const quotas = loadQuotaCache().accounts;
    const vault = await getAccountVault();
    const loggedIn = vault.accounts.filter((account) => account.credential);
    const eligible = circularAccountIds(
      vault.accounts.map((account) => account.id),
      failed.accountId,
    ).filter(
      (accountId) =>
        accountId !== failed.accountId &&
        !exhausted.has(accountId) &&
        !isRecentlyExhausted(accountId, now) &&
        loggedIn.some((account) => account.id === accountId),
    );
    const selectedId = orderAccountsByQuota(eligible, quotas, now)[0];
    const selected = vault.accounts.find(
      (account) => account.id === selectedId && account.credential,
    );
    const outcome = {
      loggedInIds: loggedIn.map((account) => account.id),
      ...(selected
        ? {
            selected: {
              id: selected.id,
              failedLabel:
                vault.accounts.find((account) => account.id === failed.accountId)?.label ??
                failed.accountId,
              label: selected.label,
            },
          }
        : {}),
    };
    if (outcome.loggedInIds.length < 2) {
      clearChain();
      return;
    }
    if (outcome.selected) {
      sessionSelection.select(ctx, outcome.selected.id);
      ctx.ui.notify(
        `Grok CLI: “${outcome.selected.failedLabel}” exhausted; switched to “${outcome.selected.label}” and continuing.`,
        'info',
      );
      awaitingContinuation = true;
      pi.sendUserMessage(ROTATION_CONTINUATION);
      return;
    }

    if (
      outcome.loggedInIds.every(
        (accountId) => exhausted.has(accountId) || isRecentlyExhausted(accountId, now),
      )
    ) {
      ctx.ui.notify('Grok CLI: all logged-in accounts are exhausted.', 'warning');
      clearChain();
      return;
    }
    ctx.ui.notify(
      'Grok CLI: no other logged-in account is available for automatic rotation.',
      'warning',
    );
    clearChain();
  });

  return {
    clearRecentExhaustion(accountId: string) {
      recentlyExhausted.delete(accountId);
    },
  };
}
