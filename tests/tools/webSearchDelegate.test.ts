import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindLivePiWebAccess,
  clearWebSearchDelegateForTests,
  ensureWebSearchDelegate,
  getWebSearchDelegate,
  getWebSearchLoadError,
  isPiWebAccessInstalled,
  resolvePiExtensionLoaderPaths,
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
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toBe('ok');
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
    const isInstalled = vi.fn(() => false);
    const result = await ensureWebSearchDelegate(undefined, isInstalled);
    expect(isInstalled).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
    expect(getWebSearchDelegate()).toBeUndefined();
  });

  it('getWebSearchLoadError returns last error string', () => {
    clearWebSearchDelegateForTests();
    // After clear, no error is set; the function should return undefined
    const error = getWebSearchLoadError();
    expect(error).toBeUndefined();
  });

  it('resolves extension loader paths from a nested package main entry', () => {
    const packageRoot = join(mkdtempSync(join(tmpdir(), 'pi-grok-cli-')), 'pi-coding-agent');
    const mainEntry = join(packageRoot, 'dist', 'esm', 'index.js');
    mkdirSync(join(packageRoot, 'dist', 'core', 'extensions'), { recursive: true });
    mkdirSync(join(packageRoot, 'dist', 'esm'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-coding-agent' }),
    );

    expect(resolvePiExtensionLoaderPaths(mainEntry)).toEqual([
      join(packageRoot, 'dist', 'core', 'extensions', 'index.js'),
      join(packageRoot, 'dist', 'core', 'extensions', 'loader.js'),
    ]);
  });
});
