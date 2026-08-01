import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, getConfigPath, loadConfig, saveConfig } from '../../src/config.js';
import { useTempHome } from '../stateTestHelpers.js';

const setupHome = useTempHome();

describe('Imagine configuration', () => {
  it('defaults to enabled', () => {
    setupHome();
    expect(loadConfig().config.imagine).toEqual({ enabled: true });
  });

  it.each([true, false])('persists enabled: %s across loads', (enabled) => {
    setupHome();
    saveConfig({ ...DEFAULT_CONFIG, imagine: { enabled } });
    expect(loadConfig().config.imagine).toEqual({ enabled });
  });

  it('falls back safely for invalid configuration', () => {
    setupHome();
    mkdirSync(dirname(getConfigPath()), { recursive: true });
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, imagine: { enabled: 'yes' } }));
    const loaded = loadConfig();
    expect(loaded.config.imagine).toEqual(DEFAULT_CONFIG.imagine);
    expect(loaded.warning).toContain('imagine.enabled must be true or false');
  });

  it('falls back safely for malformed JSON', () => {
    setupHome();
    mkdirSync(dirname(getConfigPath()), { recursive: true });
    writeFileSync(getConfigPath(), '{ nope');
    expect(loadConfig().warning).toContain('Could not read');
  });
});
