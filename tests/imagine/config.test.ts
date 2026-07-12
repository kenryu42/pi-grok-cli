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
  it('defaults to grok-cli scope', () => {
    setupHome();
    expect(loadImagineConfig()).toEqual({ config: DEFAULT_IMAGINE_CONFIG });
  });

  it('persists all-provider scope', () => {
    setupHome();
    saveImagineConfig({ scope: 'all' });
    expect(loadImagineConfig()).toEqual({ config: { scope: 'all' } });
  });

  it('falls back safely for invalid configuration', () => {
    setupHome();
    mkdirSync(dirname(getImagineConfigPath()), { recursive: true });
    writeFileSync(getImagineConfigPath(), JSON.stringify({ scope: 'somewhere' }));
    const loaded = loadImagineConfig();
    expect(loaded.config).toEqual(DEFAULT_IMAGINE_CONFIG);
    expect(loaded.warning).toContain('scope must be');
  });

  it('falls back safely for malformed JSON', () => {
    const home = setupHome();
    mkdirSync(join(home, '.pi'), { recursive: true });
    writeFileSync(getImagineConfigPath(), '{ nope');
    expect(loadImagineConfig().warning).toContain('Could not read');
  });
});
