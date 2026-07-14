import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import {
  AgentSessionRuntime,
  AuthStorage,
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { handoffGrokTools, restoreGrokTools, syncGrokTools } from '../../src/provider/toolScope.js';
import { registerGrokTools } from '../../src/tools/register.js';
import { tempDir } from '../tools/toolTestHelpers.js';

const toolScopeExtension: ExtensionFactory = (pi) => {
  const { webSearchRegistered } = registerGrokTools(pi);

  pi.on('session_start', (event, ctx) => {
    if (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork') {
      restoreGrokTools(pi, ctx.sessionManager.getSessionFile());
    }
    syncGrokTools(pi, ctx.model, {
      captureDelete: true,
      imagineEnabled: false,
      webSearchRegistered,
    });
  });

  pi.on('model_select', (event) => {
    syncGrokTools(pi, event.model, {
      imagineEnabled: false,
      webSearchRegistered,
    });
  });

  pi.on('before_agent_start', (_event, ctx) => {
    syncGrokTools(pi, ctx.model, {
      imagineEnabled: false,
      webSearchRegistered,
    });
  });

  pi.on('session_shutdown', (event) => {
    syncGrokTools(pi, undefined, {
      imagineEnabled: false,
      webSearchRegistered,
    });
    if (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork') {
      handoffGrokTools(pi, event.targetSessionFile);
    }
  });
};

async function toolScopeResources(cwd: string, agentDir: string) {
  mkdirSync(agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: 'tool-scope', factory: toolScopeExtension }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
}

async function scopedSession(options: {
  excludeTools?: string[];
  modelId?: string;
  noTools?: 'all';
  tools?: string[];
}) {
  const cwd = tempDir('pi-grok-cli-tool-scope-integration-');
  const agentDir = join(cwd, '.pi-agent');
  const resources = await toolScopeResources(cwd, agentDir);
  const model = {
    ...fauxProvider().getModel(),
    provider: 'grok-cli',
    id: options.modelId ?? 'grok-build',
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    settingsManager: resources.settingsManager,
    resourceLoader: resources.resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: options.tools,
    excludeTools: options.excludeTools,
    noTools: options.noTools,
  });
  await session.bindExtensions({ shutdownHandler: () => {} });
  return session;
}

async function scopedRuntime(persisted = false) {
  const cwd = tempDir('pi-grok-cli-tool-scope-runtime-');
  const agentDir = join(cwd, '.pi-agent');
  const sessionDir = join(cwd, 'sessions');
  mkdirSync(agentDir);
  const model = {
    ...fauxProvider().getModel(),
    provider: 'grok-cli',
    id: 'grok-build',
  };
  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      resourceLoaderOptions: {
        extensionFactories: [{ name: 'tool-scope', factory: toolScopeExtension }],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      model,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const created = await createRuntime({
    cwd,
    agentDir,
    sessionManager: persisted
      ? SessionManager.create(cwd, sessionDir)
      : SessionManager.inMemory(cwd),
  });
  const runtime = new AgentSessionRuntime(
    created.session,
    created.services,
    createRuntime,
    created.diagnostics,
    created.modelFallbackMessage,
  );
  const bindExtensions = async (session: typeof created.session) => {
    await session.bindExtensions({ shutdownHandler: () => {} });
  };
  await bindExtensions(runtime.session);
  runtime.setRebindSession(bindExtensions);
  return { cwd, runtime, sessionDir };
}

async function modelFacingTools(modelId: string) {
  const cwd = tempDir('pi-grok-cli-tool-scope-prompt-');
  const agentDir = join(cwd, '.pi-agent');
  const faux = fauxProvider({
    provider: 'grok-cli',
    models: [{ id: modelId }],
  });
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const model = faux.getModel();
  modelRegistry.registerProvider('grok-cli', {
    api: faux.api,
    apiKey: 'local-test-key',
    baseUrl: model.baseUrl,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
    streamSimple: faux.provider.streamSimple.bind(faux.provider),
  });
  const resources = await toolScopeResources(cwd, agentDir);
  let names: string[] = [];
  faux.setResponses([
    (context) => {
      names = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage('done');
    },
  ]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    model: modelRegistry.find('grok-cli', modelId),
    modelRegistry,
    resourceLoader: resources.resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: resources.settingsManager,
  });
  try {
    await session.bindExtensions({ shutdownHandler: () => {} });
    await session.prompt('Report available tools.');
    return names;
  } finally {
    session.dispose();
    modelRegistry.unregisterProvider('grok-cli');
  }
}

describe('tool scope through Pi registry filtering', () => {
  it.each([
    'grok-build',
    'grok-composer-2.5-fast',
  ])('sends the complete compatibility vocabulary to %s on a real agent turn', async (modelId) => {
    expect(await modelFacingTools(modelId)).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Write',
      'Grep',
      'Glob',
      'LS',
      'Delete',
    ]);
  });

  it('sends only native tools to a modern model on a real agent turn', async () => {
    expect(await modelFacingTools('grok-4.5')).toEqual(['read', 'bash', 'edit', 'write']);
  });

  it('activates the complete legacy tool set on a normal startup', async () => {
    const session = await scopedSession({});

    expect(session.getActiveToolNames()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Write',
      'Grep',
      'Glob',
      'LS',
      'Delete',
    ]);
    session.dispose();
  });

  it('does not restore native capabilities excluded before extension startup', async () => {
    const session = await scopedSession({
      excludeTools: ['write', 'edit', 'bash', 'Delete'],
    });

    expect(session.getActiveToolNames()).toEqual(['Read', 'Grep', 'Glob', 'LS']);
    session.dispose();
  });

  it('honors exact uppercase exclusions for legacy discovery defaults', async () => {
    const session = await scopedSession({
      excludeTools: ['Grep', 'Glob', 'LS'],
    });

    expect(session.getActiveToolNames()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Write',
      'Delete',
    ]);
    session.dispose();
  });

  it('keeps all tools disabled with --no-tools', async () => {
    const session = await scopedSession({ noTools: 'all' });

    expect(session.getActiveToolNames()).toEqual([]);
    session.dispose();
  });

  it('keeps a native allowlisted capability without enabling filtered-out shims', async () => {
    const session = await scopedSession({ tools: ['read'] });

    expect(session.getActiveToolNames()).toEqual(['read']);
    session.dispose();
  });

  it('does not turn auto-enabled shims into native tools for a modern model', async () => {
    const session = await scopedSession({ modelId: 'grok-4.5' });

    expect(session.getActiveToolNames()).toEqual(['read', 'bash', 'edit', 'write']);
    session.dispose();
  });

  it('does not resurrect a disabled Delete tool across reload', async () => {
    const session = await scopedSession({});
    session.setActiveToolsByName(
      session.getActiveToolNames().filter((toolName) => toolName !== 'Delete'),
    );

    await session.reload();

    expect(session.getActiveToolNames()).not.toContain('Delete');
    session.dispose();
  });

  it('preserves live capability choices across a new-session runtime replacement', async () => {
    const { runtime } = await scopedRuntime();
    runtime.session.setActiveToolsByName(
      runtime.session
        .getActiveToolNames()
        .filter((toolName) => toolName !== 'Write' && toolName !== 'Delete'),
    );

    await runtime.newSession();

    expect(runtime.session.getActiveToolNames()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Grep',
      'Glob',
      'LS',
    ]);
    await runtime.dispose();
  });

  it('preserves live capability choices across a resumed-session runtime replacement', async () => {
    const { cwd, runtime, sessionDir } = await scopedRuntime(true);
    const target = SessionManager.create(cwd, sessionDir);
    target.appendCustomEntry('target', {});
    runtime.session.setActiveToolsByName(
      runtime.session
        .getActiveToolNames()
        .filter((toolName) => toolName !== 'Write' && toolName !== 'Delete'),
    );

    await runtime.switchSession(target.getSessionFile() ?? '');

    expect(runtime.session.getActiveToolNames()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Grep',
      'Glob',
      'LS',
    ]);
    await runtime.dispose();
  });
});
