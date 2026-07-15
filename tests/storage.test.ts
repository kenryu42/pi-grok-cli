import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, migrateLegacyConfig } from '../src/config.js';
import {
  getConfigPath,
  getGrokCliDirectory,
  getLegacyConfigPath,
  getLegacyVisionCachePath,
  getQuotaCachePath,
  getVisionCachePath,
} from '../src/storage.js';
import { getCachePath } from '../src/vision/cache.js';
import { useTempHome } from './vision/helpers.js';

const setupHome = useTempHome();

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('Grok CLI storage', () => {
  it('groups extension-owned files under one directory without creating it on read', () => {
    const home = setupHome();

    expect(getGrokCliDirectory()).toBe(join(home, '.pi', 'grok-cli'));
    expect(getConfigPath()).toBe(join(home, '.pi', 'grok-cli', 'config.json'));
    expect(getVisionCachePath()).toBe(join(home, '.pi', 'grok-cli', 'vision-cache.json'));
    expect(getQuotaCachePath()).toBe(join(home, '.pi', 'grok-cli', 'quota-cache.json'));
    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG });
    expect(existsSync(getGrokCliDirectory())).toBe(false);
  });

  it('migrates the consolidated config and vision cache after verified writes', () => {
    const home = setupHome();
    mkdirSync(join(home, '.pi'), { recursive: true });
    writeJson(getLegacyConfigPath(), { ...DEFAULT_CONFIG, imagine: { enabled: false } });
    writeJson(getLegacyVisionCachePath(), {
      version: 1,
      entries: { cached: { description: 'keep' } },
    });

    expect(migrateLegacyConfig()).toEqual({});

    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).version).toBe(2);
    expect(JSON.parse(readFileSync(getVisionCachePath(), 'utf8'))).toEqual({
      version: 1,
      entries: { cached: { description: 'keep' } },
    });
    expect(existsSync(getLegacyConfigPath())).toBe(false);
    expect(existsSync(getLegacyVisionCachePath())).toBe(false);
    expect(getCachePath()).toBe(getVisionCachePath());
  });

  it('keeps new files authoritative and preserves conflicting legacy files', () => {
    setupHome();
    mkdirSync(getGrokCliDirectory(), { recursive: true });
    writeJson(getConfigPath(), DEFAULT_CONFIG);
    writeJson(getLegacyConfigPath(), { ...DEFAULT_CONFIG, imagine: { enabled: false } });
    writeJson(getVisionCachePath(), { version: 1, entries: { current: {} } });
    writeJson(getLegacyVisionCachePath(), { version: 1, entries: { legacy: {} } });

    const migration = migrateLegacyConfig();

    expect(migration.warning).toContain(getLegacyConfigPath());
    expect(migration.warning).toContain(getLegacyVisionCachePath());
    expect(loadConfig().config).toEqual(DEFAULT_CONFIG);
    expect(existsSync(getLegacyConfigPath())).toBe(true);
    expect(existsSync(getLegacyVisionCachePath())).toBe(true);
  });

  it('falls back to legacy files when the destination directory cannot be created', () => {
    const home = setupHome();
    const piDirectory = join(home, '.pi');
    mkdirSync(piDirectory, { recursive: true });
    writeJson(getLegacyConfigPath(), { ...DEFAULT_CONFIG, imagine: { enabled: false } });
    writeJson(getLegacyVisionCachePath(), { version: 1, entries: {} });
    chmodSync(piDirectory, 0o500);

    try {
      const migration = migrateLegacyConfig();

      expect(migration.warning).toMatch(/Could not migrate/);
      expect(loadConfig().config.imagine.enabled).toBe(false);
      expect(getCachePath()).toBe(getLegacyVisionCachePath());
      expect(existsSync(getLegacyConfigPath())).toBe(true);
      expect(existsSync(getLegacyVisionCachePath())).toBe(true);
    } finally {
      chmodSync(piDirectory, 0o700);
    }
  });
});
