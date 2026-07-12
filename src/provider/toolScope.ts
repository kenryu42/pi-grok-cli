import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type ImagineToolScope, loadImagineConfig } from '../imagine/config.js';
import {
  GROK_IMAGINE_TOOL_NAMES,
  GROK_SUPPRESSED_TOOL_NAMES,
  GROK_TOOL_NAMES_FOR_SCOPE,
  grokToolsToActivate,
} from '../tools/register.js';

const preservedSuppressedTools = new WeakMap<object, string[]>();

export function syncGrokTools(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>,
  provider: string | undefined,
  imagineScope: ImagineToolScope = loadImagineConfig().config.scope,
) {
  const currentTools = pi.getActiveTools();
  const baseTools = currentTools.filter(
    (toolName) =>
      !GROK_TOOL_NAMES_FOR_SCOPE.includes(toolName as (typeof GROK_TOOL_NAMES_FOR_SCOPE)[number]),
  );
  const suppressedTools = baseTools.filter((toolName) =>
    GROK_SUPPRESSED_TOOL_NAMES.includes(toolName as (typeof GROK_SUPPRESSED_TOOL_NAMES)[number]),
  );
  if (suppressedTools.length > 0) preservedSuppressedTools.set(pi, suppressedTools);

  const nextTools =
    provider === 'grok-cli'
      ? [
          ...baseTools.filter((toolName) => !suppressedTools.includes(toolName)),
          ...grokToolsToActivate(),
        ]
      : [
          ...baseTools,
          ...(preservedSuppressedTools.get(pi) ?? []).filter(
            (toolName) => !baseTools.includes(toolName),
          ),
          ...(imagineScope === 'all' ? GROK_IMAGINE_TOOL_NAMES : []),
        ];

  if (provider !== 'grok-cli') preservedSuppressedTools.delete(pi);

  if (
    currentTools.length === nextTools.length &&
    currentTools.every((toolName, i) => toolName === nextTools[i])
  ) {
    return;
  }

  pi.setActiveTools(nextTools);
}
