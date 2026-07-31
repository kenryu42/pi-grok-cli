import type { AssistantMessage } from '@earendil-works/pi-ai';

const requestAccounts = new WeakMap<AssistantMessage, string>();

export function rememberRequestAccount(message: AssistantMessage, accountId: string) {
  requestAccounts.set(message, accountId);
}

export function requestAccount(message: AssistantMessage) {
  return requestAccounts.get(message);
}
