import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testAgentDir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-'));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  getAgentDir: () => testAgentDir,
}));

import {
  bindLivePiWebAccess,
  clearWebSearchDelegateForTests,
  ensureWebSearchDelegate,
  getWebSearchDelegate,
  getWebSearchLoadError,
} from '../../src/tools/webSearchDelegate.js';

afterEach(() => {
  clearWebSearchDelegateForTests();
  vi.unstubAllGlobals();
});

describe('webSearchDelegate retry', () => {
  it('loads the public extension factory and delegates the complete execution contract', async () => {
    const extensionDir = join(testAgentDir, 'npm', 'node_modules', 'pi-web-access');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, 'index.js'),
      `
export default function (pi) {
  pi.registerTool({
    name: 'web_search',
    execute: async (id, params, signal, onUpdate, ctx) => ({
      content: [{ type: 'text', text: JSON.stringify({ id, params, aborted: signal.aborted, hasUpdate: typeof onUpdate === 'function', cwd: ctx.cwd }) }],
      details: {},
    }),
  })
}
`,
    );
    const pi = { registerTool() {} } as unknown as Parameters<typeof ensureWebSearchDelegate>[0];

    await ensureWebSearchDelegate(pi);

    expect(getWebSearchLoadError()).toBeUndefined();
    const delegate = getWebSearchDelegate();
    expect(delegate).toBeTypeOf('function');
    if (!delegate) throw new Error('expected delegate');
    const result = await delegate(
      'call-1',
      { query: 'xAI' },
      new AbortController().signal,
      () => undefined,
      { cwd: '/workspace' } as import('@earendil-works/pi-coding-agent').ExtensionContext,
    );
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({
        id: 'call-1',
        params: { query: 'xAI' },
        aborted: false,
        hasUpdate: true,
        cwd: '/workspace',
      }),
    });
  });

  it('retries after a failed delegate load', async () => {
    const extensionDir = join(testAgentDir, 'npm', 'node_modules', 'pi-web-access');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, 'index.js'),
      `
export default function (pi) {
  globalThis.webSearchDelegateLoadAttempts = (globalThis.webSearchDelegateLoadAttempts ?? 0) + 1
  if (globalThis.webSearchDelegateLoadAttempts === 1) throw new Error('temporary load failure')
  pi.registerTool({
    name: 'web_search',
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  })
}
`,
    );
    vi.stubGlobal('webSearchDelegateLoadAttempts', 0);
    const pi = {} as Parameters<typeof ensureWebSearchDelegate>[0];

    await ensureWebSearchDelegate(pi);
    expect(getWebSearchDelegate()).toBeUndefined();
    expect(getWebSearchLoadError()).toBe('temporary load failure');

    await ensureWebSearchDelegate(pi);
    expect(getWebSearchDelegate()).toBeTypeOf('function');
    expect(getWebSearchLoadError()).toBeUndefined();
  });

  it('reports an incompatible package without a public default factory', async () => {
    const extensionDir = join(testAgentDir, 'npm', 'node_modules', 'pi-web-access');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, 'index.js'), 'export const version = "old"\n');

    await ensureWebSearchDelegate({} as Parameters<typeof ensureWebSearchDelegate>[0]);

    expect(getWebSearchDelegate()).toBeUndefined();
    expect(getWebSearchLoadError()).toBe(
      'pi-web-access is incompatible. Install pi-web-access 0.13.0 or newer with a public default extension factory.',
    );
  });

  it('shares one public factory load across concurrent first calls', async () => {
    const extensionDir = join(testAgentDir, 'npm', 'node_modules', 'pi-web-access');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, 'index.js'),
      `
export default async function (pi) {
  globalThis.concurrentDelegateLoads += 1
  await globalThis.finishConcurrentDelegateLoad
  pi.registerTool({ name: 'web_search', execute: async () => ({ content: [], details: {} }) })
}
`,
    );
    let finish = () => {};
    vi.stubGlobal('concurrentDelegateLoads', 0);
    vi.stubGlobal(
      'finishConcurrentDelegateLoad',
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pi = {} as Parameters<typeof ensureWebSearchDelegate>[0];

    const first = ensureWebSearchDelegate(pi);
    const second = ensureWebSearchDelegate(pi);
    const globals = globalThis as unknown as { concurrentDelegateLoads: number };
    await vi.waitFor(() => expect(globals.concurrentDelegateLoads).toBe(1));
    finish();
    await Promise.all([first, second]);
    expect(globals.concurrentDelegateLoads).toBe(1);
  });

  it('reports extensions that do not register web_search', async () => {
    const extensionDir = join(testAgentDir, 'npm', 'node_modules', 'pi-web-access');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, 'index.js'),
      `
export default function (pi) {
  pi.registerTool({
    name: 'fetch_content',
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  })
}
`,
    );
    const pi = {} as Parameters<typeof ensureWebSearchDelegate>[0];

    await ensureWebSearchDelegate(pi);

    expect(getWebSearchDelegate()).toBeUndefined();
    expect(getWebSearchLoadError()).toBe(
      'pi-web-access loaded but did not register web_search. Update pi-web-access.',
    );
  });

  it('does not let a stale load replace the delegate for a newer binding', async () => {
    const extensionDir = join(testAgentDir, 'npm', 'node_modules', 'pi-web-access');
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, 'index.js'),
      `
export default async function (pi) {
  const load = globalThis.webSearchDelegateLoads.shift()
  load.started()
  await load.wait
  pi.registerTool({
    name: 'web_search',
    execute: async () => ({ content: [{ type: 'text', text: load.name }], details: {} }),
  })
}
`,
    );
    let startFirstLoad = () => {};
    const firstLoadStarted = new Promise<void>((resolve) => {
      startFirstLoad = resolve;
    });
    let finishFirstLoad = () => {};
    const firstLoadWait = new Promise<void>((resolve) => {
      finishFirstLoad = resolve;
    });
    vi.stubGlobal('webSearchDelegateLoads', [
      { name: 'first', started: startFirstLoad, wait: firstLoadWait },
      { name: 'second', started: () => {}, wait: Promise.resolve() },
    ]);
    const firstPi = {} as Parameters<typeof bindLivePiWebAccess>[0];
    const secondPi = {} as Parameters<typeof bindLivePiWebAccess>[0];

    bindLivePiWebAccess(firstPi);
    const firstLoad = ensureWebSearchDelegate();
    await firstLoadStarted;

    bindLivePiWebAccess(secondPi);
    await ensureWebSearchDelegate();
    const secondDelegate = getWebSearchDelegate();
    expect(secondDelegate).toBeTypeOf('function');

    finishFirstLoad();
    await firstLoad;
    expect(getWebSearchDelegate()).toBe(secondDelegate);
  });
});
