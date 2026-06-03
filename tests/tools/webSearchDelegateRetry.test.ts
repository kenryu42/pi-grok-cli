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
