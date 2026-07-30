import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfig,
  migrateLegacyConfig,
  saveConfig,
} from '../src/config.js';
import { useTempHome } from './stateTestHelpers.js';

const setupHome = useTempHome();
const FEATURE_CONFIG = {
  ...DEFAULT_CONFIG,
  imagine: { enabled: false },
};

function paths(home: string) {
  return {
    config: join(home, '.pi', 'grok-cli', 'config.json'),
    data: join(home, '.pi', 'grok-cli'),
    imagine: join(home, '.pi', 'grok-cli-imagine.json'),
    pi: join(home, '.pi'),
    quota: join(home, '.pi', 'grok-cli-quota.json'),
    tools: join(home, '.pi', 'grok-cli-tools.json'),
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}

function writeConsolidatedConfig(home: string, value: unknown) {
  mkdirSync(paths(home).data, { recursive: true });
  writeJson(paths(home).config, value);
}

function withoutDirectoryWrites<T>(directory: string, action: () => T) {
  chmodSync(directory, 0o500);
  try {
    return action();
  } finally {
    chmodSync(directory, 0o700);
  }
}

describe('Grok CLI configuration', () => {
  it('uses defaults without creating a file when no configuration exists', () => {
    setupHome();

    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG });
    expect(existsSync(getConfigPath())).toBe(false);
    expect(migrateLegacyConfig()).toEqual({});
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it('atomically saves and loads the versioned configuration', () => {
    const home = setupHome();
    saveConfig(FEATURE_CONFIG);

    expect(loadConfig()).toEqual({ config: FEATURE_CONFIG });
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8')).version).toBe(2);
    expect(readdirSync(paths(home).data).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fills missing sections and normalizes invalid fields with warnings', () => {
    const home = setupHome();
    writeConsolidatedConfig(home, {
      version: 2,
      imagine: { enabled: 'yes' },
    });

    const loaded = loadConfig();

    expect(loaded.config.imagine).toEqual(DEFAULT_CONFIG.imagine);
    expect(loaded.warning).toMatch(/imagine\.enabled must be true or false/);
  });

  it('falls back to legacy settings without overwriting an unsupported version', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeConsolidatedConfig(home, { version: 3, imagine: { enabled: false } });
    writeJson(paths(home).imagine, { enabled: false });

    const migration = migrateLegacyConfig();

    expect(migration.warning).toMatch(/Unsupported.*version/);
    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8')).version).toBe(3);
    expect(existsSync(paths(home).imagine)).toBe(true);
  });

  it('migrates the current Imagine legacy file and leaves non-config data untouched', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { enabled: false });
    for (const path of [paths(home).tools, paths(home).quota]) {
      writeJson(path, { keep: true });
    }

    expect(migrateLegacyConfig()).toEqual({});
    expect(loadConfig().config).toEqual({
      ...DEFAULT_CONFIG,
      imagine: { enabled: false },
    });
    expect(existsSync(paths(home).imagine)).toBe(false);
    for (const path of [paths(home).tools, paths(home).quota]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it('migrates version 1 in place while preserving existing feature settings', () => {
    const home = setupHome();
    writeConsolidatedConfig(home, { ...FEATURE_CONFIG, version: 1 });

    expect(loadConfig()).toEqual({ config: FEATURE_CONFIG });
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8')).version).toBe(1);

    expect(migrateLegacyConfig()).toEqual({});
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8'))).toEqual(FEATURE_CONFIG);
  });

  it('normalizes account metadata and reports discarded entries', () => {
    const home = setupHome();
    writeConsolidatedConfig(home, {
      ...DEFAULT_CONFIG,
      accounts: {
        nextAccountNumber: 2,
        selectedProvider: 'missing',
        items: [
          { provider: 'grok-cli', label: ' Personal ' },
          { provider: 'grok-cli-2', label: 'Work' },
          { provider: 'grok-cli-2', label: 'Duplicate provider' },
          { provider: 'grok-cli-3', label: 'work' },
          { provider: 'grok-cli-10', label: 'Account 10' },
          { provider: 'other', label: 'Other' },
          { provider: 'grok-cli-4', label: 'bad\nlabel' },
        ],
      },
    });

    const loaded = loadConfig();

    expect(loaded.config.accounts).toEqual({
      nextAccountNumber: 3,
      selectedProvider: 'grok-cli',
      items: [
        { provider: 'grok-cli', label: 'Personal' },
        { provider: 'grok-cli-2', label: 'Work' },
        { provider: 'grok-cli-10', label: 'Account 10' },
      ],
    });
    expect(loaded.warning).toContain('accounts');
  });

  it('reserves the permanent base label when base metadata is missing', () => {
    const home = setupHome();
    writeConsolidatedConfig(home, {
      ...DEFAULT_CONFIG,
      accounts: {
        nextAccountNumber: 2,
        selectedProvider: 'grok-cli-2',
        items: [
          { provider: 'grok-cli-2', label: 'Account 1' },
          { provider: 'grok-cli-3', label: 'Work' },
        ],
      },
    });

    expect(loadConfig().config.accounts).toEqual({
      nextAccountNumber: 2,
      selectedProvider: 'grok-cli',
      items: [
        { provider: 'grok-cli', label: 'Account 1' },
        { provider: 'grok-cli-3', label: 'Work' },
      ],
    });
  });

  it.each(['grok-cli', 'all'])('migrates released Imagine scope %s to enabled', (scope) => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { scope });

    expect(migrateLegacyConfig()).toEqual({});
    expect(loadConfig().config.imagine.enabled).toBe(true);
    expect(existsSync(paths(home).imagine)).toBe(false);
  });

  it('migrates a lone Imagine legacy file', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { enabled: false });

    expect(migrateLegacyConfig()).toEqual({});
    expect(loadConfig().config).toEqual({
      ...DEFAULT_CONFIG,
      imagine: { enabled: false },
    });
  });

  it('preserves a malformed legacy file and skips migration', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeFileSync(paths(home).imagine, '{ nope');

    const migration = migrateLegacyConfig();

    expect(migration.warning).toMatch(/Could not read/);
    expect(existsSync(paths(home).config)).toBe(false);
    expect(existsSync(paths(home).imagine)).toBe(true);
    expect(loadConfig().config.imagine).toEqual(DEFAULT_CONFIG.imagine);
  });

  it('preserves legacy files and removes temporary output when migration cannot write', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { enabled: false });
    const migration = withoutDirectoryWrites(paths(home).pi, migrateLegacyConfig);

    expect(migration.warning).toMatch(/Could not migrate/);
    expect(existsSync(paths(home).config)).toBe(false);
    expect(existsSync(paths(home).imagine)).toBe(true);
    expect(readdirSync(paths(home).pi).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps a valid consolidated file authoritative and cleans recognized legacy files', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeConsolidatedConfig(home, {
      ...DEFAULT_CONFIG,
      imagine: { enabled: false },
    });
    writeJson(paths(home).imagine, { enabled: true });

    expect(migrateLegacyConfig()).toEqual({});
    expect(loadConfig().config.imagine.enabled).toBe(false);
    expect(existsSync(paths(home).imagine)).toBe(false);
    expect(migrateLegacyConfig()).toEqual({});
  });

  it('preserves malformed legacy files beside a valid consolidated config', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeConsolidatedConfig(home, DEFAULT_CONFIG);
    writeFileSync(paths(home).imagine, '{ nope');

    expect(migrateLegacyConfig().warning).toMatch(/Could not read/);
    expect(existsSync(paths(home).imagine)).toBe(true);
    expect(loadConfig().config).toEqual(DEFAULT_CONFIG);
  });

  it('preserves a recognized legacy file when cleanup fails and retries later', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeConsolidatedConfig(home, DEFAULT_CONFIG);
    writeJson(paths(home).imagine, { enabled: false });
    const migration = withoutDirectoryWrites(paths(home).pi, migrateLegacyConfig);

    expect(migration.warning).toMatch(/Could not remove/);
    expect(existsSync(paths(home).imagine)).toBe(true);
    expect(migrateLegacyConfig()).toEqual({});
    expect(existsSync(paths(home).imagine)).toBe(false);
  });
});
