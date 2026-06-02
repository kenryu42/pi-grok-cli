import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GROK_TOOL_NAMES } from '../tools/register.js';

export function syncGrokTools(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>,
  provider: string | undefined,
) {
  const currentTools = pi.getActiveTools();
  const baseTools = currentTools.filter((toolName) => !GROK_TOOL_NAMES.includes(toolName));
  const nextTools = provider === 'grok-cli' ? [...baseTools, ...GROK_TOOL_NAMES] : baseTools;

  if (
    currentTools.length === nextTools.length &&
    currentTools.every((toolName, i) => toolName === nextTools[i])
  ) {
    return;
  }

  pi.setActiveTools(nextTools);
}
