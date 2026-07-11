import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  describableModels,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from '../../src/vision/config.js';
import { useTempHome } from './helpers.js';

const setupHome = useTempHome();

function writeConfig(config: unknown) {
  const configPath = join(process.env.HOME as string, '.pi', 'grok-cli-vision.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config));
}

describe('grok-cli-vision config', () => {
  it('returns defaults when no config file exists', () => {
    setupHome();
    const { config, warning } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warning).toBeUndefined();
  });

  it('loads a valid config', () => {
    setupHome();
    writeConfig({
      enabled: false,
      model: 'grok-build',
      maxImages: 2,
      cacheEnabled: false,
      cacheMaxEntries: 25,
    });

    const { config, warning } = loadConfig();
    expect(config).toEqual({
      enabled: false,
      model: 'grok-build',
      maxImages: 2,
      cacheEnabled: false,
      cacheMaxEntries: 25,
    });
    expect(warning).toBeUndefined();
  });

  it('falls back to defaults with a warning for invalid fields', () => {
    setupHome();
    writeConfig({
      enabled: 'yes',
      model: 'not-a-model',
      maxImages: -3,
      cacheEnabled: 'yes',
      cacheMaxEntries: 0,
    });

    const { config, warning } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warning).toMatch(/enabled must be true or false/);
    expect(warning).toMatch(/Unknown model "not-a-model"/);
    expect(warning).toMatch(/maxImages must be a positive integer/);
    expect(warning).toMatch(/cacheEnabled must be true or false/);
    expect(warning).toMatch(/cacheMaxEntries must be a positive integer/);
  });

  it('warns when the config file is not a JSON object', () => {
    setupHome();
    writeConfig([1, 2, 3]);

    const { config, warning } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warning).toMatch(/must be a JSON object/);
  });

  it('warns on invalid JSON', () => {
    setupHome();
    const configPath = join(process.env.HOME as string, '.pi', 'grok-cli-vision.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ not json');

    const { config, warning } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warning).toMatch(/Could not read/);
  });

  it('saveConfig writes normalized values and round-trips through loadConfig', () => {
    setupHome();
    saveConfig({ ...DEFAULT_CONFIG, enabled: false, maxImages: 3 });

    const { config } = loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.maxImages).toBe(3);
    expect(config.model).toBe('grok-build');
  });

  it('normalizeConfig rejects a describer model that lacks image input', () => {
    const warnings: string[] = [];
    const config = normalizeConfig({ model: 'grok-composer-2.5-fast' }, warnings);
    expect(config.model).toBe('grok-build');
    expect(warnings.join(' ')).toMatch(/Unknown model "grok-composer-2.5-fast"/);
  });

  it('describableModels only lists image-capable models', () => {
    const models = describableModels();
    expect(models).toContain('grok-build');
    expect(models).not.toContain('grok-composer-2.5-fast');
  });
});
