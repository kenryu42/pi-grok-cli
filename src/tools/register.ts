import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerFileTools } from './files.js';
import { createReadShim } from './read.js';
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

export function registerGrokTools(pi: ExtensionAPI) {
  const webSearchRegistered = isPiWebAccessInstalled();
  if (webSearchRegistered) registerWebSearchTool(pi);
  registerSearchTools(pi);
  registerFileTools(pi);
  pi.registerTool(createReadShim());
  registerShellTool(pi);
  return { webSearchRegistered };
}
