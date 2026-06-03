import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerFileTools } from './files.js';
import { registerSearchTools } from './search.js';
import { registerShellTool } from './shell.js';
import { registerWebSearchTool } from './webSearch.js';
import { isPiWebAccessInstalled } from './webSearchDelegate.js';

/** Grok/Cursor shims always registered by this extension (excludes optional WebSearch). */
export const GROK_SHIM_TOOL_NAMES = [
  'Grep',
  'Glob',
  'LS',
  'Read',
  'Write',
  'StrReplace',
  'Edit',
  'Delete',
  'Shell',
] as const;

/** All shim names used when reconciling the active tool set (includes optional WebSearch). */
export const GROK_TOOL_NAMES_FOR_SCOPE = [...GROK_SHIM_TOOL_NAMES, 'WebSearch'] as const;

export const GROK_SUPPRESSED_TOOL_NAMES = ['web_search'] as const;

export function grokToolsToActivate() {
  const names: string[] = [...GROK_SHIM_TOOL_NAMES];
  if (isPiWebAccessInstalled()) names.push('WebSearch');
  return names;
}

export function registerGrokTools(pi: ExtensionAPI) {
  if (isPiWebAccessInstalled()) registerWebSearchTool(pi);
  registerSearchTools(pi);
  registerFileTools(pi);
  registerShellTool(pi);
}
