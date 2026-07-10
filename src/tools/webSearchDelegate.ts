import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import {
  createEventBus,
  createExtensionRuntime,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

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
let bindGeneration = 0;

export function getWebSearchLoadError() {
  return lastLoadError;
}

function isCurrentBinding(pi: ExtensionAPI, generation: number) {
  return bindGeneration === generation && (!boundLivePi || boundLivePi === pi);
}

function resolvePiCodingAgentRoot(dir: string): string {
  const packageJson = join(dir, 'package.json');
  if (
    existsSync(packageJson) &&
    JSON.parse(readFileSync(packageJson, 'utf8')).name === '@earendil-works/pi-coding-agent'
  ) {
    return dir;
  }

  const parent = dirname(dir);
  if (parent === dir) {
    throw new Error(`Could not find @earendil-works/pi-coding-agent package root from ${dir}`);
  }
  return resolvePiCodingAgentRoot(parent);
}

export function resolvePiExtensionLoaderPaths(mainEntry: string) {
  const root = resolvePiCodingAgentRoot(dirname(mainEntry));
  return [
    join(root, 'dist/core/extensions/index.js'),
    join(root, 'dist/core/extensions/loader.js'),
  ];
}

async function importPiExtensionLoader() {
  const publicModule = (await import('@earendil-works/pi-coding-agent')) as Record<string, unknown>;
  if ('loadExtensions' in publicModule && typeof publicModule.loadExtensions === 'function') {
    return publicModule.loadExtensions as LoadExtensions;
  }

  const mainEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const paths = resolvePiExtensionLoaderPaths(mainEntry);
  const loaderPath = paths.find((path) => existsSync(path));
  if (!loaderPath) {
    throw new Error(`Could not find pi extension loader. Attempted: ${paths.join(', ')}`);
  }

  const loader = (await import(pathToFileURL(loaderPath).href)) as Record<string, unknown>;
  if (typeof loader.loadExtensions !== 'function') {
    throw new Error(`Pi extension loader does not export loadExtensions: ${loaderPath}`);
  }
  return loader.loadExtensions as LoadExtensions;
}

type LoadExtensions = (
  paths: string[],
  cwd: string,
  eventBus: ReturnType<typeof createEventBus>,
  runtime: ReturnType<typeof createExtensionRuntime>,
) => Promise<LoadExtensionsResult>;

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
  bindGeneration += 1;
  boundLivePi = pi;
  webSearchExecute = undefined;
  loadPromise = undefined;
}

async function captureWebSearchFromLivePi(pi: ExtensionAPI, generation: number) {
  const entry = resolvePiWebAccessEntry();
  if (!entry) return;

  const loadExtensions = await importPiExtensionLoader();
  const runtime = createExtensionRuntime();
  wireRuntimeToLivePi(runtime as unknown as Record<string, unknown>, pi);

  const result = await loadExtensions([entry], process.cwd(), createEventBus(), runtime);
  const loadError = result.errors[0]?.error;
  if (loadError) throw new Error(loadError);

  const extension = result.extensions[0];
  if (!extension) throw new Error(`Pi did not load extension: ${entry}`);

  const registered = extension.tools.get(PI_WEB_SEARCH_TOOL);
  if (!registered) {
    if (!isCurrentBinding(pi, generation)) return;
    lastLoadError = 'pi-web-access loaded but did not register web_search. Update pi-web-access.';
    return;
  }

  if (!isCurrentBinding(pi, generation)) return;
  webSearchExecute = registered.definition.execute.bind(registered.definition) as WebSearchExecute;
  lastLoadError = undefined;
}

export async function ensureWebSearchDelegate(
  pi?: ExtensionAPI,
  isInstalled: () => boolean = isPiWebAccessInstalled,
) {
  if (!isInstalled()) return;

  const livePi = pi ?? boundLivePi;
  if (!livePi) return;

  const generation = bindGeneration;
  if (!isCurrentBinding(livePi, generation)) return;
  if (webSearchExecute) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (isCurrentBinding(livePi, generation)) lastLoadError = undefined;
    try {
      await captureWebSearchFromLivePi(livePi, generation);
    } catch (err) {
      if (!isCurrentBinding(livePi, generation)) return;
      lastLoadError = err instanceof Error ? err.message : String(err);
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
