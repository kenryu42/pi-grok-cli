import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const PI_WEB_SEARCH_TOOL = 'web_search';
const MINIMUM_PI_WEB_ACCESS_VERSION = '0.13.0';

export type WebSearchExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: import('@earendil-works/pi-coding-agent').ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

let webSearchExecute: WebSearchExecute | undefined;
let loadPromise: Promise<void> | undefined;
let lastLoadError: string | undefined;
let boundLivePi: ExtensionAPI | undefined;
let bindGeneration = 0;
let importGeneration = 0;

export function getWebSearchLoadError() {
  return lastLoadError;
}

function isCurrentBinding(pi: ExtensionAPI, generation: number) {
  return bindGeneration === generation && (!boundLivePi || boundLivePi === pi);
}

function resolvePiWebAccessEntry() {
  for (const dir of [
    join(getAgentDir(), 'npm', 'node_modules', 'pi-web-access'),
    join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-web-access'),
  ]) {
    for (const file of ['index.ts', 'index.js']) {
      const entry = join(dir, file);
      if (existsSync(entry)) return entry;
    }
  }
  return undefined;
}

export function isPiWebAccessInstalled() {
  return resolvePiWebAccessEntry() !== undefined;
}

function createToolRegistrationAdapter(
  pi: ExtensionAPI,
  registerTool: (tool: ToolDefinition) => void,
) {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === 'registerTool') return registerTool;
      if (property === 'registerCommand' || property === 'registerShortcut' || property === 'on') {
        return () => undefined;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function captureWebSearchFromPublicFactory(pi: ExtensionAPI, generation: number) {
  const entry = resolvePiWebAccessEntry();
  if (!entry) return;

  const module = (await import(
    `${pathToFileURL(entry).href}?pi-grok-cli-load=${++importGeneration}`
  )) as Record<string, unknown>;
  if (typeof module.default !== 'function') {
    throw new Error(
      `pi-web-access is incompatible. Install pi-web-access ${MINIMUM_PI_WEB_ACCESS_VERSION} or newer with a public default extension factory.`,
    );
  }

  let webSearch: ToolDefinition | undefined;
  await (module.default as (pi: ExtensionAPI) => void | Promise<void>)(
    createToolRegistrationAdapter(pi, (tool) => {
      if (tool.name === PI_WEB_SEARCH_TOOL) webSearch = tool;
    }),
  );

  if (!webSearch) {
    if (!isCurrentBinding(pi, generation)) return;
    lastLoadError = 'pi-web-access loaded but did not register web_search. Update pi-web-access.';
    return;
  }
  if (!isCurrentBinding(pi, generation)) return;
  webSearchExecute = webSearch.execute.bind(webSearch) as WebSearchExecute;
  lastLoadError = undefined;
}

/** Remember the live session ExtensionAPI (bound after session_start). */
export function bindLivePiWebAccess(pi: ExtensionAPI) {
  bindGeneration += 1;
  boundLivePi = pi;
  webSearchExecute = undefined;
  loadPromise = undefined;
}

export async function ensureWebSearchDelegate(
  pi?: ExtensionAPI,
  isInstalled: () => boolean = isPiWebAccessInstalled,
) {
  if (!isInstalled()) return;

  const livePi = pi ?? boundLivePi;
  if (!livePi) return;

  const generation = bindGeneration;
  if (!isCurrentBinding(livePi, generation) || webSearchExecute) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (isCurrentBinding(livePi, generation)) lastLoadError = undefined;
    try {
      await captureWebSearchFromPublicFactory(livePi, generation);
    } catch (error) {
      if (!isCurrentBinding(livePi, generation)) return;
      lastLoadError = error instanceof Error ? error.message : String(error);
      webSearchExecute = undefined;
    } finally {
      if (isCurrentBinding(livePi, generation)) loadPromise = undefined;
    }
  })();

  return loadPromise;
}

export function getWebSearchDelegate() {
  return webSearchExecute;
}

export function clearWebSearchDelegateForTests() {
  bindGeneration += 1;
  webSearchExecute = undefined;
  loadPromise = undefined;
  lastLoadError = undefined;
  boundLivePi = undefined;
}

export function setWebSearchDelegateForTests(execute: WebSearchExecute) {
  webSearchExecute = execute;
  lastLoadError = undefined;
}
