import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, migrateLegacyConfig } from '../src/config.js';
import {
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
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).version).toBe(2);
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
});
