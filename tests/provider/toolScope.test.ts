import { describe, expect, it, vi } from 'vitest';
import { handoffGrokTools, restoreGrokTools, syncGrokTools } from '../../src/provider/toolScope.js';

type SyncOptions = {
  captureDelete?: boolean;
  imagineEnabled?: boolean;
  webSearchRegistered?: boolean;
};

const ALL_REGISTERED_TOOLS = [
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'bash',
  'web_search',
  'Read',
  'Write',
  'Edit',
  'StrReplace',
  'Grep',
  'Glob',
  'LS',
  'Shell',
  'WebSearch',
  'Delete',
  'image_gen',
];

const DEFAULT_AUTO_ACTIVE_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'Read',
  'Write',
  'Edit',
  'StrReplace',
  'Grep',
  'Glob',
  'LS',
  'Shell',
  'WebSearch',
  'Delete',
  'image_gen',
];
const AUTO_ACTIVE_SYNC_OPTIONS = {
  captureDelete: true,
  imagineEnabled: true,
  webSearchRegistered: true,
};

function toolState(initialTools: string[], registeredTools = ALL_REGISTERED_TOOLS) {
  let activeTools = [...initialTools];
  const setActiveTools = vi.fn((nextTools: string[]) => {
    activeTools = [...nextTools];
  });
  const pi = {
    getActiveTools: () => activeTools,
    getAllTools: () => registeredTools.map((name) => ({ name })),
    setActiveTools,
  };

  return {
    pi,
    setActiveTools,
    tools: () => activeTools,
    replaceTools(nextTools: string[]) {
      activeTools = [...nextTools];
    },
  };
}

function sync(
  state: ReturnType<typeof toolState>,
  provider: string | undefined,
  id: string | undefined,
  options: SyncOptions = {},
) {
  syncGrokTools(state.pi, provider && id ? { provider, id } : undefined, {
    imagineEnabled: false,
    webSearchRegistered: false,
    ...options,
  });
}

describe('syncGrokTools', () => {
  it.each([
    'grok-build',
    'grok-composer-2.5-fast',
  ])('uses compatibility names for exact legacy model %s', (id) => {
    const state = toolState(['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash']);

    sync(state, 'grok-cli', id, { captureDelete: true });

    expect(state.tools()).toEqual([
      'Read',
      'Write',
      'Edit',
      'StrReplace',
      'Grep',
      'Glob',
      'LS',
      'Shell',
    ]);
  });

  it.each([
    ['grok-cli', 'grok-4.5'],
    ['grok-cli', 'future-model'],
    ['grok-cli', 'grok-build-preview'],
    ['other-provider', 'grok-build'],
  ])('keeps native names for %s/%s', (provider, id) => {
    const state = toolState(['read', 'write', 'bash']);

    sync(state, provider, id, { captureDelete: true });

    expect(state.tools()).toEqual(['read', 'write', 'bash']);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it('translates only active capabilities and keeps image_gen independent', () => {
    const state = toolState(['custom-before', 'read', 'custom-after']);

    sync(state, 'grok-cli', 'grok-build', {
      captureDelete: true,
      imagineEnabled: true,
    });

    expect(state.tools()).toEqual(['custom-before', 'Read', 'custom-after', 'image_gen']);
    expect(state.tools()).not.toEqual(
      expect.arrayContaining(['Write', 'Edit', 'StrReplace', 'Delete', 'Shell']),
    );
  });

  it('does not resurrect capabilities excluded from the initial tool selection', () => {
    const state = toolState([]);

    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });

    expect(state.tools()).toEqual([]);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it('keeps legacy discovery shims active after normal extension auto-activation', () => {
    const state = toolState(DEFAULT_AUTO_ACTIVE_TOOLS);

    sync(state, 'grok-cli', 'grok-build', {
      captureDelete: true,
      imagineEnabled: true,
      webSearchRegistered: true,
    });

    expect(state.tools()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Write',
      'Grep',
      'Glob',
      'LS',
      'Delete',
      'image_gen',
    ]);
  });

  it('restores captured legacy discovery defaults after starting on a modern model', () => {
    const state = toolState(DEFAULT_AUTO_ACTIVE_TOOLS);

    sync(state, 'grok-cli', 'grok-4.5', AUTO_ACTIVE_SYNC_OPTIONS);
    expect(state.tools()).toEqual(['read', 'bash', 'edit', 'write', 'image_gen']);

    sync(state, 'grok-cli', 'grok-composer-2.5-fast', {
      imagineEnabled: true,
      webSearchRegistered: true,
    });
    expect(state.tools()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Write',
      'image_gen',
      'Grep',
      'Glob',
      'LS',
      'Delete',
    ]);
  });

  it('remembers disabled legacy discovery defaults across model switches', () => {
    const state = toolState(DEFAULT_AUTO_ACTIVE_TOOLS);
    sync(state, 'grok-cli', 'grok-build', {
      captureDelete: true,
      webSearchRegistered: true,
    });
    state.replaceTools(state.tools().filter((name) => name !== 'Glob'));

    sync(state, 'grok-cli', 'grok-4.5', { webSearchRegistered: true });
    sync(state, 'grok-cli', 'grok-build', { webSearchRegistered: true });

    expect(state.tools()).toEqual([
      'Read',
      'Shell',
      'Edit',
      'StrReplace',
      'Write',
      'Grep',
      'LS',
      'Delete',
    ]);
  });

  it('does not translate automatically activated shims into inactive native capabilities', () => {
    const state = toolState(DEFAULT_AUTO_ACTIVE_TOOLS);

    sync(state, 'grok-cli', 'grok-4.5', AUTO_ACTIVE_SYNC_OPTIONS);

    expect(state.tools()).toEqual(['read', 'bash', 'edit', 'write', 'image_gen']);
  });

  it('honors native CLI exclusions even when Pi auto-activates compatibility tools', () => {
    const state = toolState(
      [
        'read',
        'Read',
        'Write',
        'Edit',
        'StrReplace',
        'Grep',
        'Glob',
        'LS',
        'Shell',
        'WebSearch',
        'image_gen',
      ],
      ALL_REGISTERED_TOOLS.filter((name) => !['write', 'edit', 'bash', 'Delete'].includes(name)),
    );

    sync(state, 'grok-cli', 'grok-build', {
      captureDelete: true,
      imagineEnabled: true,
      webSearchRegistered: true,
    });

    expect(state.tools()).toEqual(['Read', 'Grep', 'Glob', 'LS', 'image_gen']);
  });

  it('keeps an allowed native capability usable when Pi filters out its shim registration', () => {
    const state = toolState(['read'], ['read']);

    sync(state, 'grok-cli', 'grok-build', {
      captureDelete: true,
      imagineEnabled: true,
      webSearchRegistered: true,
    });

    expect(state.tools()).toEqual(['read']);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it('keeps one native vocabulary when an active capability has no registered shim', () => {
    const state = toolState(
      [
        'read',
        'bash',
        'edit',
        'write',
        'Write',
        'Edit',
        'StrReplace',
        'Grep',
        'Glob',
        'LS',
        'Shell',
        'WebSearch',
        'Delete',
        'image_gen',
      ],
      ALL_REGISTERED_TOOLS.filter((name) => name !== 'Read'),
    );

    sync(state, 'grok-cli', 'grok-build', {
      captureDelete: true,
      imagineEnabled: true,
      webSearchRegistered: true,
    });

    expect(state.tools()).toEqual(['read', 'bash', 'edit', 'write', 'Delete', 'image_gen']);
  });

  it('preserves unmanaged tool order while entering and leaving legacy mode', () => {
    const state = toolState(['custom-a', 'read', 'custom-b', 'bash', 'custom-c']);

    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });
    expect(state.tools()).toEqual(['custom-a', 'Read', 'custom-b', 'Shell', 'custom-c']);

    sync(state, 'grok-cli', 'grok-4.5');
    expect(state.tools()).toEqual(['custom-a', 'read', 'custom-b', 'bash', 'custom-c']);
  });

  it('preserves individual compatibility choices while legacy mode remains active', () => {
    const state = toolState(['read', 'write']);
    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });
    state.replaceTools(['Read']);

    sync(state, 'grok-cli', 'grok-build');
    expect(state.tools()).toEqual(['Read']);

    sync(state, 'grok-cli', 'grok-4.5');
    expect(state.tools()).toEqual(['read']);
  });

  it('translates a newly enabled native capability before the next legacy prompt', () => {
    const state = toolState(['read']);
    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });
    state.replaceTools(['Read', 'write', 'custom']);

    sync(state, 'grok-cli', 'grok-build');

    expect(state.tools()).toEqual(['Read', 'Write', 'custom']);
    expect(state.tools()).not.toContain('write');
  });

  it('switches directly between legacy models without changing capabilities', () => {
    const state = toolState(['read', 'edit']);
    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });
    state.setActiveTools.mockClear();

    sync(state, 'grok-cli', 'grok-composer-2.5-fast');

    expect(state.tools()).toEqual(['Read', 'Edit', 'StrReplace']);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it('restores live compatibility capabilities to native names on shutdown', () => {
    const state = toolState(['read', 'write', 'bash']);
    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });
    state.replaceTools(['Read', 'Shell', 'custom']);

    sync(state, undefined, undefined);

    expect(state.tools()).toEqual(['read', 'bash', 'custom']);
    expect(state.tools()).not.toEqual(expect.arrayContaining(['Write', 'write']));
  });

  it('captures Delete once, preserves it across modes, and remembers a live disable', () => {
    const state = toolState(['read', 'Delete']);

    sync(state, 'grok-cli', 'grok-4.5', { captureDelete: true });
    expect(state.tools()).toEqual(['read']);

    sync(state, 'grok-cli', 'grok-build');
    expect(state.tools()).toEqual(['Read', 'Delete']);

    state.replaceTools(['Read']);
    sync(state, 'grok-cli', 'grok-build');
    sync(state, 'grok-cli', 'grok-4.5');
    sync(state, 'grok-cli', 'grok-build');
    expect(state.tools()).toEqual(['Read']);
  });

  it('never introduces Delete when the initial allowlist excluded it', () => {
    const state = toolState(['read']);

    sync(state, 'grok-cli', 'grok-4.5', { captureDelete: true });
    sync(state, 'grok-cli', 'grok-build');

    expect(state.tools()).toEqual(['Read']);
  });

  it('maps WebSearch only when its adapter is registered', () => {
    const registered = toolState(['web_search']);
    sync(registered, 'grok-cli', 'grok-build', {
      captureDelete: true,
      webSearchRegistered: true,
    });
    expect(registered.tools()).toEqual(['WebSearch']);
    sync(registered, 'grok-cli', 'grok-4.5', { webSearchRegistered: true });
    expect(registered.tools()).toEqual(['web_search']);

    const unavailable = toolState(['web_search']);
    sync(unavailable, 'grok-cli', 'grok-build', { captureDelete: true });
    expect(unavailable.tools()).toEqual(['web_search']);
    expect(unavailable.setActiveTools).not.toHaveBeenCalled();
  });

  it('applies enabled image_gen across provider and model changes', () => {
    const state = toolState(['read']);

    sync(state, 'openai', 'gpt-5', { captureDelete: true, imagineEnabled: true });
    expect(state.tools()).toEqual(['read', 'image_gen']);
    sync(state, 'grok-cli', 'grok-build', { imagineEnabled: true });
    expect(state.tools()).toEqual(['Read', 'image_gen']);
    sync(state, 'grok-cli', 'grok-4.5', { imagineEnabled: true });
    expect(state.tools()).toEqual(['read', 'image_gen']);
  });

  it('removes disabled image_gen without disturbing unrelated tools', () => {
    const state = toolState(['custom-a', 'image_gen', 'custom-b', 'read']);

    sync(state, 'openai', 'gpt-5', { captureDelete: true });

    expect(state.tools()).toEqual(['custom-a', 'custom-b', 'read']);
  });

  it('does not call setActiveTools when the ordered desired set is already active', () => {
    const state = toolState(['custom', 'Read']);

    sync(state, 'grok-cli', 'grok-build', { captureDelete: true });

    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it('restores only capabilities present in a replacement runtime registry', () => {
    const source = toolState(['read', 'write', 'custom']);
    sync(source, 'grok-cli', 'grok-build', { captureDelete: true });
    sync(source, undefined, undefined);
    handoffGrokTools(source.pi, '/sessions/restricted-target.jsonl');
    const target = toolState(
      ['read', 'Read', 'Delete', 'custom'],
      ['read', 'Read', 'Delete', 'custom'],
    );

    restoreGrokTools(target.pi, '/sessions/restricted-target.jsonl');
    sync(target, 'grok-cli', 'grok-build', { captureDelete: true });

    expect(target.tools()).toEqual(['Read', 'custom']);
    expect(target.tools()).not.toEqual(expect.arrayContaining(['write', 'Write', 'Delete']));
  });
});
