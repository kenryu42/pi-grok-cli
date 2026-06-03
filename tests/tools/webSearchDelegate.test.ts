import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWebSearchDelegateForTests,
  getWebSearchDelegate,
  isPiWebAccessInstalled,
  setWebSearchDelegateForTests,
} from '../../src/tools/webSearchDelegate.js';

afterEach(() => {
  clearWebSearchDelegateForTests();
  vi.restoreAllMocks();
});

describe('webSearchDelegate', () => {
  it('returns delegate set for tests', async () => {
    setWebSearchDelegateForTests(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      details: {},
    }));

    const delegate = getWebSearchDelegate();
    expect(delegate).toBeTypeOf('function');
    if (!delegate) throw new Error('expected delegate');
    const result = await delegate('id', {}, new AbortController().signal, undefined, {
      cwd: '/tmp',
      hasUI: false,
    } as import('@earendil-works/pi-coding-agent').ExtensionContext);
    expect(result.content[0]?.text).toBe('ok');
  });

  it('isPiWebAccessInstalled reflects agent install path', () => {
    const installed = isPiWebAccessInstalled();
    expect(typeof installed).toBe('boolean');
  });
});
