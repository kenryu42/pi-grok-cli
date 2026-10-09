import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AccountVault } from '../../src/provider/accountVault.js';

export const liveCredential = (access: string) => ({
  access,
  refresh: `${access}-refresh`,
  expires: Date.now() + 300_000,
});

export function addWorkAccount(vault: AccountVault) {
  vault.accounts.push({
    id: 'work-id',
    slot: 2,
    label: 'Work',
    credential: liveCredential('two'),
    revision: 1,
  });
  vault.nextSlot = 3;
}

export function assistantMessage(fields: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'grok-cli',
    model: 'grok-build',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...fields,
  };
}
