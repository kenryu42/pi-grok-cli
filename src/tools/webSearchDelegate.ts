import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createEventBus, getAgentDir } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti/static';

export const PI_WEB_SEARCH_TOOL = 'web_search';

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

export function getWebSearchLoadError() {
  return lastLoadError;
}

function resolvePiCodingAgentRoot() {
  const mainEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return join(dirname(mainEntry), '..');
}

async function importPiExtensionLoader() {
  return import(join(resolvePiCodingAgentRoot(), 'dist/core/extensions/loader.js')) as Promise<{
    createExtensionRuntime: () => Record<string, unknown>;
    loadExtensionFromFactory: (
      factory: (api: ExtensionAPI) => void | Promise<void>,
      cwd: string,
      eventBus: ReturnType<typeof createEventBus>,
      runtime: Record<string, unknown>,
      extensionPath?: string,
    ) => Promise<{ tools: Map<string, { definition: { execute: WebSearchExecute } }> }>;
  }>;
}

export function isPiWebAccessInstalled() {
  return resolvePiWebAccessEntry() !== undefined;
}

function resolvePiWebAccessEntry(): string | undefined {
  const fileNames = ['index.ts', 'index.js'];
  const dirs = [
    join(getAgentDir(), 'npm', 'node_modules', 'pi-web-access'),
    join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-web-access'),
  ];

  for (const dir of dirs) {
    for (const file of fileNames) {
      const entry = join(dir, file);
      if (existsSync(entry)) return entry;
    }
  }

  return undefined;
}

function createJitiAliases() {
  const require = createRequire(import.meta.url);
  const codingAgent = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const agentCore = fileURLToPath(import.meta.resolve('@earendil-works/pi-agent-core'));
  const tui = fileURLToPath(import.meta.resolve('@earendil-works/pi-tui'));
  const ai = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
  const typeboxEntry = require.resolve('typebox');
  const typeboxCompileEntry = require.resolve('typebox/compile');
  const typeboxValueEntry = require.resolve('typebox/value');

  return {
    '@earendil-works/pi-coding-agent': codingAgent,
    '@earendil-works/pi-agent-core': agentCore,
    '@earendil-works/pi-tui': tui,
    '@earendil-works/pi-ai': ai,
    '@mariozechner/pi-coding-agent': codingAgent,
    '@mariozechner/pi-agent-core': agentCore,
    '@mariozechner/pi-tui': tui,
    '@mariozechner/pi-ai': ai,
    typebox: typeboxEntry,
    'typebox/compile': typeboxCompileEntry,
    'typebox/value': typeboxValueEntry,
    '@sinclair/typebox': typeboxEntry,
    '@sinclair/typebox/compile': typeboxCompileEntry,
    '@sinclair/typebox/value': typeboxValueEntry,
  };
}

async function importPiWebAccessFactory(entry: string) {
  const jiti = createJiti(import.meta.url, { alias: createJitiAliases(), moduleCache: false });
  const module = await jiti.import(entry, { default: true });
  if (typeof module !== 'function') {
    throw new Error('pi-web-access does not export a default factory function');
  }
  return module as (api: ExtensionAPI) => void | Promise<void>;
}

function wireRuntimeToLivePi(runtime: Record<string, unknown>, pi: ExtensionAPI) {
  runtime.assertActive = () => {};
  runtime.refreshTools = () => {};
  runtime.appendEntry = (customType: string, data: unknown) => pi.appendEntry(customType, data);
  runtime.sendMessage = (message: unknown, options?: unknown) =>
    pi.sendMessage(
      message as Parameters<ExtensionAPI['sendMessage']>[0],
      options as Parameters<ExtensionAPI['sendMessage']>[1],
    );
  runtime.sendUserMessage = (content: unknown, options?: unknown) =>
    pi.sendUserMessage(
      content as Parameters<ExtensionAPI['sendUserMessage']>[0],
      options as Parameters<ExtensionAPI['sendUserMessage']>[1],
    );
  runtime.setSessionName = (name: string) => pi.setSessionName(name);
  runtime.getSessionName = () => pi.getSessionName();
  runtime.setLabel = (entryId: string, label: string) => pi.setLabel(entryId, label);
  runtime.getActiveTools = () => pi.getActiveTools();
  runtime.getAllTools = () => pi.getAllTools();
  runtime.setActiveTools = (names: string[]) => pi.setActiveTools(names);
  runtime.getCommands = () => pi.getCommands();
  runtime.setModel = (model: unknown) =>
    pi.setModel(model as Parameters<ExtensionAPI['setModel']>[0]);
  runtime.getThinkingLevel = () => pi.getThinkingLevel();
  runtime.setThinkingLevel = (level: unknown) =>
    pi.setThinkingLevel(level as Parameters<ExtensionAPI['setThinkingLevel']>[0]);
}

/** Remember the live session ExtensionAPI (bound after session_start). */
export function bindLivePiWebAccess(pi: ExtensionAPI) {
  boundLivePi = pi;
  webSearchExecute = undefined;
  loadPromise = undefined;
}

async function captureWebSearchFromLivePi(pi: ExtensionAPI) {
  const entry = resolvePiWebAccessEntry();
  if (!entry) return;

  const { createExtensionRuntime, loadExtensionFromFactory } = await importPiExtensionLoader();
  const runtime = createExtensionRuntime();
  wireRuntimeToLivePi(runtime, pi);

  const factory = await importPiWebAccessFactory(entry);
  const extension = await loadExtensionFromFactory(
    factory,
    process.cwd(),
    createEventBus(),
    runtime,
    entry,
  );

  const registered = extension.tools.get(PI_WEB_SEARCH_TOOL);
  if (!registered) {
    lastLoadError = 'pi-web-access loaded but did not register web_search. Update pi-web-access.';
    return;
  }

  webSearchExecute = registered.definition.execute.bind(registered.definition) as WebSearchExecute;
  lastLoadError = undefined;
}

export async function ensureWebSearchDelegate(pi?: ExtensionAPI) {
  if (!isPiWebAccessInstalled()) return;

  const livePi = pi ?? boundLivePi;
  if (!livePi) return;

  if (webSearchExecute) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    lastLoadError = undefined;
    try {
      await captureWebSearchFromLivePi(livePi);
    } catch (err) {
      lastLoadError = err instanceof Error ? err.message : String(err);
      webSearchExecute = undefined;
    }
  })();

  return loadPromise;
}

export function getWebSearchDelegate() {
  return webSearchExecute;
}

export function clearWebSearchDelegateForTests() {
  webSearchExecute = undefined;
  loadPromise = undefined;
  lastLoadError = undefined;
  boundLivePi = undefined;
}

export function setWebSearchDelegateForTests(execute: WebSearchExecute) {
  webSearchExecute = execute;
  lastLoadError = undefined;
}
