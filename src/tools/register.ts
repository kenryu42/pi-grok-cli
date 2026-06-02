import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerFileTools } from './files.js';
import { registerSearchTools } from './search.js';
import { registerShellTool } from './shell.js';

export const GROK_TOOL_NAMES = [
  'Grep',
  'Glob',
  'LS',
  'Read',
  'Write',
  'StrReplace',
  'Edit',
  'Delete',
  'Shell',
];

export function registerGrokTools(pi: ExtensionAPI) {
  registerSearchTools(pi);
  registerFileTools(pi);
  registerShellTool(pi);
}
