import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function paths(home: string) {
  return {
    config: join(home, '.pi', 'grok-cli', 'config.json'),
    data: join(home, '.pi', 'grok-cli'),
    imagine: join(home, '.pi', 'grok-cli-imagine.json'),
    pi: join(home, '.pi'),
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}

function writeConfig(home: string, value: unknown) {
  mkdirSync(paths(home).data, { recursive: true });
  writeJson(paths(home).config, value);
}

describe('Grok CLI configuration', () => {
  it('uses version 3 defaults without creating a file', () => {
    setupHome();

    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG });
    expect(DEFAULT_CONFIG).toEqual({ version: 3, imagine: { enabled: true } });
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it('saves only non-account settings in version 3', () => {
    const home = setupHome();

    saveConfig({ version: 3, imagine: { enabled: false } });

    expect(loadConfig()).toEqual({
      config: { version: 3, imagine: { enabled: false } },
    });
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8'))).toEqual({
      version: 3,
      imagine: { enabled: false },
    });
  });

  it('reads released version 2 settings without changing the source file', () => {
    const home = setupHome();
    const released = {
      version: 2,
      accounts: {
        nextAccountNumber: 3,
        selectedProvider: 'grok-cli-2',
        items: [
          { provider: 'grok-cli', label: 'Personal' },
          { provider: 'grok-cli-2', label: 'Work' },
        ],
      },
      imagine: { enabled: false },
    };
    writeConfig(home, released);

    expect(loadConfig().config).toEqual({ version: 3, imagine: { enabled: false } });
    expect(migrateLegacyConfig()).toEqual({});
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8'))).toEqual(released);
  });

  it('normalizes an invalid Imagine setting with a warning', () => {
    const home = setupHome();
    writeConfig(home, { version: 3, imagine: { enabled: 'yes' } });

    const loaded = loadConfig();

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toContain('imagine.enabled');
  });

  it('preserves an unsupported consolidated config', () => {
    const home = setupHome();
    writeConfig(home, { version: 4, imagine: { enabled: false } });

    expect(migrateLegacyConfig().warning).toContain('Unsupported config version 4');
    expect(JSON.parse(readFileSync(paths(home).config, 'utf8')).version).toBe(4);
  });

  it.each(['grok-cli', 'all'])('migrates released Imagine scope %s', (scope) => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { scope });

    expect(migrateLegacyConfig()).toEqual({});
    expect(loadConfig().config).toEqual(DEFAULT_CONFIG);
    expect(existsSync(paths(home).imagine)).toBe(false);
  });

  it('migrates a lone Imagine setting and removes only its legacy file', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { enabled: false });

    expect(migrateLegacyConfig()).toEqual({});
    expect(loadConfig().config).toEqual({ version: 3, imagine: { enabled: false } });
    expect(existsSync(paths(home).imagine)).toBe(false);
  });

  it('preserves a malformed legacy file', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeFileSync(paths(home).imagine, '{ nope');

    expect(migrateLegacyConfig().warning).toContain('Could not read');
    expect(existsSync(paths(home).imagine)).toBe(true);
    expect(existsSync(paths(home).config)).toBe(false);
  });

  it('preserves a legacy file when the destination is not writable', () => {
    const home = setupHome();
    mkdirSync(paths(home).pi, { recursive: true });
    writeJson(paths(home).imagine, { enabled: false });
    chmodSync(paths(home).pi, 0o500);
    const result = migrateLegacyConfig();
    chmodSync(paths(home).pi, 0o700);

    expect(result.warning).toContain('Could not migrate');
    expect(existsSync(paths(home).imagine)).toBe(true);
  });
});
