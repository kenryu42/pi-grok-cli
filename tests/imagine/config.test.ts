import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGINE_CONFIG,
  getImagineConfigPath,
  loadImagineConfig,
  saveImagineConfig,
} from '../../src/imagine/config.js';
import { useTempHome } from '../vision/helpers.js';

const setupHome = useTempHome();

describe('Imagine configuration', () => {
  it('defaults to enabled', () => {
    setupHome();
    expect(loadImagineConfig()).toEqual({ config: DEFAULT_IMAGINE_CONFIG });
    expect(DEFAULT_IMAGINE_CONFIG).toEqual({ enabled: true });
  });

  it.each([true, false])('persists enabled: %s across loads', (enabled) => {
    setupHome();
    saveImagineConfig({ enabled });
    expect(loadImagineConfig()).toEqual({ config: { enabled } });
  });

  it('falls back safely for invalid configuration', () => {
    setupHome();
    mkdirSync(dirname(getImagineConfigPath()), { recursive: true });
    writeFileSync(getImagineConfigPath(), JSON.stringify({ enabled: 'yes' }));
    const loaded = loadImagineConfig();
    expect(loaded.config).toEqual(DEFAULT_IMAGINE_CONFIG);
    expect(loaded.warning).toContain('enabled must be a boolean');
  });

  it('falls back safely for malformed JSON', () => {
    const home = setupHome();
    mkdirSync(join(home, '.pi'), { recursive: true });
    writeFileSync(getImagineConfigPath(), '{ nope');
    expect(loadImagineConfig().warning).toContain('Could not read');
  });
});
