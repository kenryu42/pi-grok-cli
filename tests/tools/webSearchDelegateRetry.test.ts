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
});
