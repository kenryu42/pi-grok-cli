import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import {
  getConfigPath,
  getLegacyConfigPath,
  getLegacyImagineConfigPath,
  migrateStoredFile,
  writeFileAtomic,
} from './storage.js';

export { getConfigPath, getLegacyImagineConfigPath } from './storage.js';

export const CONFIG_VERSION = 3 as const;
export type ImagineConfig = { enabled: boolean };
export interface GrokCliConfig {
  version: typeof CONFIG_VERSION;
  imagine: ImagineConfig;
}

export const DEFAULT_IMAGINE_CONFIG: ImagineConfig = { enabled: true };
export const DEFAULT_CONFIG: GrokCliConfig = {
  version: CONFIG_VERSION,
  imagine: DEFAULT_IMAGINE_CONFIG,
};

export interface LoadedConfig {
  config: GrokCliConfig;
  warning?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function combineWarnings(warnings: (string | undefined)[]) {
  const combined = warnings.filter((warning): warning is string => Boolean(warning));
  return combined.length ? combined.join(' ') : undefined;
}

export function hasTerminalControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function normalizeImagineConfig(raw: unknown, warnings: string[]): ImagineConfig {
  if (raw === undefined) return { ...DEFAULT_IMAGINE_CONFIG };
  if (!isObject(raw)) {
    warnings.push('imagine must be a JSON object. Using defaults.');
    return { ...DEFAULT_IMAGINE_CONFIG };
  }
  if (typeof raw.enabled === 'boolean') return { enabled: raw.enabled };
  if (raw.enabled !== undefined) {
    warnings.push('imagine.enabled must be true or false. Using enabled=true.');
  }
  return { ...DEFAULT_IMAGINE_CONFIG };
}

function parseConfig(path: string): LoadedConfig & { supported: boolean; imagineDefined: boolean } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(parsed)) {
      return {
        config: structuredClone(DEFAULT_CONFIG),
        supported: false,
        imagineDefined: false,
        warning: `Config ${path} must be a JSON object. Using legacy settings or defaults.`,
      };
    }
    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== CONFIG_VERSION) {
      return {
        config: structuredClone(DEFAULT_CONFIG),
        supported: false,
        imagineDefined: false,
        warning: `Unsupported config version ${String(parsed.version)} in ${path}. Using legacy settings or defaults.`,
      };
    }
    const warnings: string[] = [];
    const config = {
      version: CONFIG_VERSION,
      imagine: normalizeImagineConfig(parsed.imagine, warnings),
    } satisfies GrokCliConfig;
    return {
      config,
      supported: true,
      imagineDefined: Object.hasOwn(parsed, 'imagine'),
      ...(warnings.length ? { warning: `Invalid ${path}: ${warnings.join(' ')}` } : {}),
    };
  } catch (error) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      supported: false,
      imagineDefined: false,
      warning: `Could not read ${path}: ${errorMessage(error)}. Using legacy settings or defaults.`,
    };
  }
}

function parseLegacyImagine(path: string) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(parsed)) {
      return {
        config: { ...DEFAULT_IMAGINE_CONFIG },
        recognized: false,
        warning: `Legacy config ${path} must be a JSON object.`,
      };
    }
    if (typeof parsed.enabled === 'boolean') {
      return { config: { enabled: parsed.enabled }, recognized: true };
    }
    if (parsed.scope === 'grok-cli' || parsed.scope === 'all') {
      return { config: { enabled: true }, recognized: true };
    }
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      recognized: false,
      warning: `Invalid ${path}: expected enabled or a recognized scope.`,
    };
  } catch (error) {
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      recognized: false,
      warning: `Could not read ${path}: ${errorMessage(error)}.`,
    };
  }
}

export function loadConfig(): LoadedConfig {
  const path = existsSync(getConfigPath())
    ? getConfigPath()
    : existsSync(getLegacyConfigPath())
      ? getLegacyConfigPath()
      : undefined;
  if (path) {
    const loaded = parseConfig(path);
    if (loaded.supported) {
      return loaded.warning
        ? { config: loaded.config, warning: loaded.warning }
        : { config: loaded.config };
    }
    if (existsSync(getLegacyImagineConfigPath())) {
      const legacy = parseLegacyImagine(getLegacyImagineConfigPath());
      return {
        config: { version: CONFIG_VERSION, imagine: legacy.config },
        warning: combineWarnings([loaded.warning, legacy.warning]),
      };
    }
    return { config: loaded.config, ...(loaded.warning ? { warning: loaded.warning } : {}) };
  }
  if (!existsSync(getLegacyImagineConfigPath())) {
    return { config: structuredClone(DEFAULT_CONFIG) };
  }
  const legacy = parseLegacyImagine(getLegacyImagineConfigPath());
  return {
    config: { version: CONFIG_VERSION, imagine: legacy.config },
    ...(legacy.warning ? { warning: legacy.warning } : {}),
  };
}

export function saveConfig(config: GrokCliConfig) {
  writeFileAtomic(
    getConfigPath(),
    `${JSON.stringify(
      { version: CONFIG_VERSION, imagine: normalizeImagineConfig(config.imagine, []) },
      null,
      2,
    )}\n`,
  );
}

export function migrateLegacyConfig(): { warning?: string } {
  const storageWarning = migrateStoredFile(getLegacyConfigPath(), getConfigPath());
  if (!existsSync(getConfigPath()) && existsSync(getLegacyConfigPath())) {
    return storageWarning ? { warning: storageWarning } : {};
  }
  const legacyPath = getLegacyImagineConfigPath();
  const legacy = existsSync(legacyPath) ? parseLegacyImagine(legacyPath) : undefined;
  if (existsSync(getConfigPath())) {
    const loaded = parseConfig(getConfigPath());
    if (!loaded.supported) {
      const warning = combineWarnings([storageWarning, loaded.warning, legacy?.warning]);
      return warning ? { warning } : {};
    }
    if (legacy?.recognized && loaded.imagineDefined) {
      try {
        unlinkSync(legacyPath);
      } catch (error) {
        return {
          warning: combineWarnings([
            storageWarning,
            legacy.warning,
            `Could not remove legacy config ${legacyPath}: ${errorMessage(error)}.`,
          ]),
        };
      }
    }
    const warning = combineWarnings([storageWarning, loaded.warning, legacy?.warning]);
    return warning ? { warning } : {};
  }
  if (!legacy?.recognized) {
    const warning = combineWarnings([storageWarning, legacy?.warning]);
    return warning ? { warning } : {};
  }
  try {
    saveConfig({ version: CONFIG_VERSION, imagine: legacy.config });
    if (JSON.stringify(loadConfig().config.imagine) !== JSON.stringify(legacy.config)) {
      return {
        warning: `Could not verify migrated config ${getConfigPath()}. Legacy files were preserved.`,
      };
    }
    unlinkSync(legacyPath);
    return storageWarning ? { warning: storageWarning } : {};
  } catch (error) {
    return {
      warning: combineWarnings([
        storageWarning,
        `Could not migrate configuration to ${getConfigPath()}: ${errorMessage(error)}. Legacy files were preserved.`,
      ]),
    };
  }
}
