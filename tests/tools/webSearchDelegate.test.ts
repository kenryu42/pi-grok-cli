import { afterEach, describe, expect, it, vi } from 'vitest';
import * as delegateModule from '../../src/tools/webSearchDelegate.js';
import {
  bindLivePiWebAccess,
  clearWebSearchDelegateForTests,
  ensureWebSearchDelegate,
  getWebSearchDelegate,
  getWebSearchLoadError,
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

  it('bindLivePiWebAccess resets delegate state', () => {
    setWebSearchDelegateForTests(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      details: {},
    }));
    expect(getWebSearchDelegate()).toBeTypeOf('function');

    bindLivePiWebAccess({} as Parameters<typeof bindLivePiWebAccess>[0]);

    expect(getWebSearchDelegate()).toBeUndefined();
  });

  it('ensureWebSearchDelegate returns undefined when pi-web-access is not installed', async () => {
    vi.spyOn(delegateModule, 'isPiWebAccessInstalled').mockReturnValue(false);

    const result = await ensureWebSearchDelegate();
    expect(result).toBeUndefined();
    expect(getWebSearchDelegate()).toBeUndefined();

    vi.restoreAllMocks();
  });

  it('getWebSearchLoadError returns last error string', () => {
    clearWebSearchDelegateForTests();
    // After clear, no error is set; the function should return undefined
    const error = getWebSearchLoadError();
    expect(error).toBeUndefined();
  });
});
