import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, migrateLegacyConfig } from '../src/config.js';
import {
  acquireFileLock,
  getConfigPath,
  getGrokCliDirectory,
  getLegacyConfigPath,
  getQuotaCachePath,
} from '../src/storage.js';
import { useTempHome } from './stateTestHelpers.js';

const setupHome = useTempHome();

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('Grok CLI storage', () => {
  it('groups extension-owned files under one directory without creating it on read', () => {
    const home = setupHome();

    expect(getGrokCliDirectory()).toBe(join(home, '.pi', 'grok-cli'));
    expect(getConfigPath()).toBe(join(home, '.pi', 'grok-cli', 'config.json'));
    expect(getQuotaCachePath()).toBe(join(home, '.pi', 'grok-cli', 'quota-cache.json'));
    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG });
    expect(existsSync(getGrokCliDirectory())).toBe(false);
  });

  it('migrates the consolidated config after a verified write', () => {
    const home = setupHome();
    mkdirSync(join(home, '.pi'), { recursive: true });
    writeJson(getLegacyConfigPath(), { ...DEFAULT_CONFIG, imagine: { enabled: false } });

    expect(migrateLegacyConfig()).toEqual({});

    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).version).toBe(3);
    expect(existsSync(getLegacyConfigPath())).toBe(false);
  });

  it('keeps the new config authoritative and preserves a conflicting legacy file', () => {
    setupHome();
    mkdirSync(getGrokCliDirectory(), { recursive: true });
    writeJson(getConfigPath(), DEFAULT_CONFIG);
    writeJson(getLegacyConfigPath(), { ...DEFAULT_CONFIG, imagine: { enabled: false } });

    const migration = migrateLegacyConfig();

    expect(migration.warning).toContain(getLegacyConfigPath());
    expect(loadConfig().config).toEqual(DEFAULT_CONFIG);
    expect(existsSync(getLegacyConfigPath())).toBe(true);
  });

  it('falls back to legacy files when the destination directory cannot be created', () => {
    const home = setupHome();
    mkdirSync(join(home, '.pi'), { recursive: true });
    writeJson(getLegacyConfigPath(), { ...DEFAULT_CONFIG, imagine: { enabled: false } });
    writeFileSync(getGrokCliDirectory(), 'not a directory');

    const migration = migrateLegacyConfig();

    expect(migration.warning).toMatch(/Could not migrate/);
    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(existsSync(getLegacyConfigPath())).toBe(true);
  });

  it('recovers an incomplete lock left by a stopped process', async () => {
    setupHome();
    mkdirSync(getGrokCliDirectory(), { recursive: true });
    const lockPath = `${getQuotaCachePath()}.lock`;
    writeFileSync(lockPath, '{');
    utimesSync(lockPath, new Date(0), new Date(0));
    vi.useFakeTimers();

    try {
      const pending = acquireFileLock(getQuotaCachePath());
      await vi.advanceTimersByTimeAsync(30_025);
      const release = await pending;
      await release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a stale lock after its process ID is reused', async () => {
    setupHome();
    mkdirSync(getGrokCliDirectory(), { recursive: true });
    const lockPath = `${getQuotaCachePath()}.lock`;
    writeJson(lockPath, { pid: process.pid, token: 'stale-owner' });
    utimesSync(lockPath, new Date(0), new Date(0));
    vi.useFakeTimers();

    try {
      const outcome = acquireFileLock(getQuotaCachePath()).then(
        (release) => ({ release }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(30_025);
      const result = await outcome;
      expect(result).not.toHaveProperty('error');
      if ('error' in result) throw result.error;
      await result.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a stale recovery barrier after its process ID is reused', async () => {
    setupHome();
    mkdirSync(getGrokCliDirectory(), { recursive: true });
    const lockPath = `${getQuotaCachePath()}.lock`;
    const recoveryPath = `${lockPath}.recovery.${process.pid}.stale`;
    writeFileSync(recoveryPath, '');
    utimesSync(recoveryPath, new Date(0), new Date(0));
    vi.useFakeTimers();

    try {
      const pending = acquireFileLock(getQuotaCachePath());
      const result = await Promise.race([
        pending.then((release) => ({ acquired: true as const, release })),
        new Promise<{ acquired: false }>((resolve) => {
          queueMicrotask(() => resolve({ acquired: false }));
        }),
      ]);
      if (!result.acquired) {
        rmSync(recoveryPath, { force: true });
        await vi.advanceTimersByTimeAsync(25);
        await (await pending)();
      } else {
        await result.release();
      }
      expect(existsSync(recoveryPath)).toBe(false);
      expect(result.acquired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues when a recovery barrier disappears during polling', async () => {
    setupHome();
    mkdirSync(getGrokCliDirectory(), { recursive: true });
    const lockPath = `${getQuotaCachePath()}.lock`;
    const recoveryPath = `${lockPath}.recovery.${process.pid}.gone`;
    symlinkSync(`${recoveryPath}.missing`, recoveryPath);

    const release = await acquireFileLock(getQuotaCachePath());
    await release();

    expect(existsSync(recoveryPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});
