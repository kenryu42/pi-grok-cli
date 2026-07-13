import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configForToolDisplayMode,
  DEFAULT_TOOL_DISPLAY_CONFIG,
  getToolDisplayConfigPath,
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from '../../src/tools/displayConfig.js';
import { tempDir } from './toolTestHelpers.js';

describe('tool display config', () => {
  it('uses preview defaults when the config file is missing', () => {
    const path = join(tempDir('pi-grok-cli-tools-config-'), 'missing.json');

    expect(loadToolDisplayConfig(path)).toEqual({ config: DEFAULT_TOOL_DISPLAY_CONFIG });
  });

  it('uses mode-specific defaults and numeric overrides', () => {
    expect(normalizeToolDisplayConfig({ toolDisplay: 'minimal' })).toEqual(
      configForToolDisplayMode('minimal'),
    );
    expect(
      normalizeToolDisplayConfig({
        toolDisplay: 'preview',
        shellTailLines: 12,
        readPreviewLines: 2,
        writeCallPreviewLines: 8,
      }),
    ).toEqual({
      ...configForToolDisplayMode('preview'),
      shellTailLines: 12,
      readPreviewLines: 2,
      writeCallPreviewLines: 8,
    });
  });

  it('reports invalid files and values while falling back safely', () => {
    const invalidJsonPath = join(tempDir('pi-grok-cli-tools-config-'), 'invalid.json');
    writeFileSync(invalidJsonPath, '{', 'utf-8');

    expect(loadToolDisplayConfig(invalidJsonPath).warning).toMatch(/Could not read/);

    const nonObjectPath = join(tempDir('pi-grok-cli-tools-config-'), 'array.json');
    writeFileSync(nonObjectPath, '[]', 'utf-8');
    expect(loadToolDisplayConfig(nonObjectPath)).toEqual({
      config: DEFAULT_TOOL_DISPLAY_CONFIG,
      warning: `Config ${nonObjectPath} must be a JSON object. Using defaults.`,
    });

    const warnings: string[] = [];
    const config = normalizeToolDisplayConfig(
      { toolDisplay: 'maximal' as never, grepPreviewMatches: -1 },
      warnings,
    );
    expect(config.toolDisplay).toBe('preview');
    expect(config.grepPreviewMatches).toBe(DEFAULT_TOOL_DISPLAY_CONFIG.grepPreviewMatches);
    expect(warnings.join('\n')).toMatch(/toolDisplay/);
    expect(warnings.join('\n')).toMatch(/grepPreviewMatches/);
  });

  it('saves normalized config files', () => {
    const path = join(tempDir('pi-grok-cli-tools-config-'), '.pi', 'grok-cli-tools.json');
    const config = configForToolDisplayMode('minimal');

    saveToolDisplayConfig(config, path);

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(config);
  });

  it('supports an environment override for the config path', () => {
    const original = process.env.PI_GROK_CLI_TOOLS_CONFIG;
    const path = join(tempDir('pi-grok-cli-tools-config-'), 'custom.json');
    process.env.PI_GROK_CLI_TOOLS_CONFIG = path;
    try {
      expect(getToolDisplayConfigPath()).toBe(path);
    } finally {
      if (original === undefined) delete process.env.PI_GROK_CLI_TOOLS_CONFIG;
      else process.env.PI_GROK_CLI_TOOLS_CONFIG = original;
    }
  });
});
