import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.js';
import { isGrokCliProvider } from './accounts.js';

export const SHIM_MODEL_IDS = new Set(['grok-build', 'grok-composer-2.5-fast']);

const TOOL_GROUPS = [
  { native: 'read', compatibility: ['Read'] },
  { native: 'write', compatibility: ['Write'] },
  { native: 'edit', compatibility: ['Edit', 'StrReplace'] },
  { native: 'grep', compatibility: ['Grep'] },
  { native: 'find', compatibility: ['Glob'] },
  { native: 'ls', compatibility: ['LS'] },
  { native: 'bash', compatibility: ['Shell'] },
] as const;

const WEB_SEARCH_GROUP = { native: 'web_search', compatibility: ['WebSearch'] } as const;
const LEGACY_DISCOVERY_TOOLS = ['Grep', 'Glob', 'LS'] as const;

type ToolScopeState = {
  deleteCaptured: boolean;
  deleteEnabled: boolean;
  initialized: boolean;
  legacyDiscoveryCaptured: boolean;
  legacyDiscoveryEnabled: string[];
  legacy: boolean;
};

type ToolScopeHandoff = {
  activeTools: string[];
  state: ToolScopeState;
};

type ToolScopeHandoffStore = {
  anonymous: ToolScopeHandoff[];
  bySessionFile: Map<string, ToolScopeHandoff>;
};

type ToolModel = {
  provider: string;
  id: string;
};

type SyncOptions = {
  captureDelete?: boolean;
  imagineEnabled?: boolean;
  webSearchRegistered?: boolean;
};

type ToolScopeAPI = Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'> & {
  events?: ExtensionAPI['events'];
  getAllTools: () => { name: string }[];
};

const toolScopeStates = new WeakMap<object, ToolScopeState>();
const globalToolScope = globalThis as typeof globalThis & {
  __piGrokCliToolScopeHandoffs?: ToolScopeHandoffStore;
};
const toolScopeHandoffs: ToolScopeHandoffStore = globalToolScope.__piGrokCliToolScopeHandoffs ?? {
  anonymous: [],
  bySessionFile: new Map(),
};
globalToolScope.__piGrokCliToolScopeHandoffs = toolScopeHandoffs;

function isLegacyModel(model: ToolModel | undefined) {
  return isGrokCliProvider(model?.provider) && SHIM_MODEL_IDS.has(model?.id ?? '');
}

function sameTools(currentTools: string[], nextTools: string[]) {
  return (
    currentTools.length === nextTools.length &&
    currentTools.every((toolName, index) => toolName === nextTools[index])
  );
}

function stateKey(pi: ToolScopeAPI) {
  return pi.events ?? pi;
}

export function handoffGrokTools(pi: ToolScopeAPI, targetSessionFile?: string) {
  const state = toolScopeStates.get(stateKey(pi));
  if (!state) return;
  const handoff = {
    activeTools: [...pi.getActiveTools()],
    state: { ...state, legacyDiscoveryEnabled: [...state.legacyDiscoveryEnabled] },
  };
  if (targetSessionFile) {
    toolScopeHandoffs.bySessionFile.set(targetSessionFile, handoff);
    return;
  }
  toolScopeHandoffs.anonymous.push(handoff);
}

export function restoreGrokTools(pi: ToolScopeAPI, sessionFile?: string) {
  const handoff = sessionFile
    ? toolScopeHandoffs.bySessionFile.get(sessionFile)
    : toolScopeHandoffs.anonymous.shift();
  if (!handoff) return;
  if (sessionFile) toolScopeHandoffs.bySessionFile.delete(sessionFile);
  toolScopeStates.set(stateKey(pi), {
    ...handoff.state,
    legacyDiscoveryEnabled: [...handoff.state.legacyDiscoveryEnabled],
  });
  const registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const activeTools = handoff.activeTools.filter((toolName) => registeredTools.has(toolName));
  if (!sameTools(pi.getActiveTools(), activeTools)) pi.setActiveTools(activeTools);
}

export function syncGrokTools(
  pi: ToolScopeAPI,
  model: ToolModel | undefined,
  options: SyncOptions = {},
) {
  const currentTools = pi.getActiveTools();
  const key = stateKey(pi);
  const state = toolScopeStates.get(key) ?? {
    deleteCaptured: false,
    deleteEnabled: false,
    initialized: false,
    legacyDiscoveryCaptured: false,
    legacyDiscoveryEnabled: [],
    legacy: false,
  };
  const legacy = isLegacyModel(model);
  const imagineEnabled = options.imagineEnabled ?? loadConfig().config.imagine.enabled;
  const groups = options.webSearchRegistered ? [...TOOL_GROUPS, WEB_SEARCH_GROUP] : TOOL_GROUPS;
  const registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const registeredCompatibilityTools = groups.flatMap((group) =>
    group.compatibility.filter((name) => registeredTools.has(name)),
  );
  const compatibilityToolsWereAutoActivated =
    !state.initialized &&
    registeredCompatibilityTools.length > 0 &&
    registeredCompatibilityTools.every((name) => currentTools.includes(name));
  const compatibilityVocabularyAvailable = groups.every(
    (group) =>
      !currentTools.includes(group.native) ||
      group.compatibility.some((name) => registeredTools.has(name)),
  );

  if (!state.legacyDiscoveryCaptured) {
    state.legacyDiscoveryCaptured = true;
    state.legacyDiscoveryEnabled = LEGACY_DISCOVERY_TOOLS.filter(
      (name) => registeredTools.has(name) && currentTools.includes(name),
    );
  }
  if (state.legacy) {
    state.legacyDiscoveryEnabled = LEGACY_DISCOVERY_TOOLS.filter(
      (name) => registeredTools.has(name) && currentTools.includes(name),
    );
  }

  if (options.captureDelete && !state.deleteCaptured) {
    state.deleteCaptured = true;
    state.deleteEnabled = currentTools.includes('Delete');
  }
  if (state.legacy) state.deleteEnabled = currentTools.includes('Delete');

  const handledGroups = new Set<(typeof groups)[number]>();
  const nextTools = currentTools.flatMap((toolName) => {
    if (toolName === 'image_gen') return imagineEnabled ? [toolName] : [];
    if (toolName === 'Delete') return legacy && state.deleteEnabled ? [toolName] : [];

    const group = groups.find(
      (candidate) =>
        candidate.native === toolName || candidate.compatibility.some((name) => name === toolName),
    );
    if (!group) return [toolName];
    if (handledGroups.has(group)) return [];
    handledGroups.add(group);

    const nativeActive = currentTools.includes(group.native);
    const activeCompatibility = currentTools.filter((name) =>
      group.compatibility.some((compatibilityName) => compatibilityName === name),
    );
    if (!registeredTools.has(group.native)) return [];
    if (!legacy || !compatibilityVocabularyAvailable) {
      return nativeActive ||
        (!compatibilityToolsWereAutoActivated && activeCompatibility.length > 0)
        ? [group.native]
        : [];
    }
    if (nativeActive) {
      const registeredCompatibility = group.compatibility.filter((name) =>
        registeredTools.has(name),
      );
      return registeredCompatibility.length > 0 ? registeredCompatibility : [group.native];
    }
    if (compatibilityToolsWereAutoActivated) {
      return activeCompatibility.filter((name) => state.legacyDiscoveryEnabled.includes(name));
    }
    return activeCompatibility.filter((name) => registeredTools.has(name));
  });

  if (legacy && compatibilityVocabularyAvailable) {
    nextTools.push(
      ...state.legacyDiscoveryEnabled.filter(
        (name) => registeredTools.has(name) && !nextTools.includes(name),
      ),
    );
  }

  if (
    legacy &&
    state.deleteEnabled &&
    registeredTools.has('Delete') &&
    !nextTools.includes('Delete')
  ) {
    nextTools.push('Delete');
  }
  if (imagineEnabled && registeredTools.has('image_gen') && !nextTools.includes('image_gen')) {
    nextTools.push('image_gen');
  }

  state.initialized = model !== undefined;
  state.legacy = legacy;
  toolScopeStates.set(key, state);
  if (sameTools(currentTools, nextTools)) return;
  pi.setActiveTools(nextTools);
}
