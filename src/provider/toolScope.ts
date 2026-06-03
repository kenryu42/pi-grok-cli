import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  GROK_SUPPRESSED_TOOL_NAMES,
  GROK_TOOL_NAMES_FOR_SCOPE,
  grokToolsToActivate,
} from '../tools/register.js';

export function syncGrokTools(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>,
  provider: string | undefined,
) {
  const currentTools = pi.getActiveTools();
  const baseTools = currentTools.filter(
    (toolName) =>
      !GROK_TOOL_NAMES_FOR_SCOPE.includes(toolName as (typeof GROK_TOOL_NAMES_FOR_SCOPE)[number]),
  );
  const nextTools =
    provider === 'grok-cli'
      ? [
          ...baseTools.filter(
            (toolName) =>
              !GROK_SUPPRESSED_TOOL_NAMES.includes(
                toolName as (typeof GROK_SUPPRESSED_TOOL_NAMES)[number],
              ),
          ),
          ...grokToolsToActivate(),
        ]
      : baseTools;

  if (
    currentTools.length === nextTools.length &&
    currentTools.every((toolName, i) => toolName === nextTools[i])
  ) {
    return;
  }

  pi.setActiveTools(nextTools);
}
