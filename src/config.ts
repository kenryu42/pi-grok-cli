import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveModels } from './models/catalog.js';

export const CONFIG_VERSION = 2 as const;
const LEGACY_CONFIG_VERSION = 1;
export const DEFAULT_DESCRIBE_MODEL = 'grok-build';
export const DEFAULT_MAX_IMAGES = 4;
export const DEFAULT_CACHE_MAX_ENTRIES = 100;

export type ImagineConfig = { enabled: boolean };

export interface VisionConfig {
  enabled: boolean;
  model: string;
  maxImages: number;
  cacheEnabled: boolean;
  cacheMaxEntries: number;
}

export interface GrokCliAccount {
  provider: string;
  label: string;
}

export interface AccountsConfig {
  nextAccountNumber: number;
  selectedProvider: string;
  items: GrokCliAccount[];
}

export interface GrokCliConfig {
  version: typeof CONFIG_VERSION;
  accounts: AccountsConfig;
  imagine: ImagineConfig;
  vision: VisionConfig;
}

export const DEFAULT_IMAGINE_CONFIG: ImagineConfig = { enabled: true };

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  enabled: true,
  model: DEFAULT_DESCRIBE_MODEL,
  maxImages: DEFAULT_MAX_IMAGES,
  cacheEnabled: true,
  cacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
};

export const DEFAULT_ACCOUNTS_CONFIG: AccountsConfig = {
  nextAccountNumber: 2,
  selectedProvider: 'grok-cli',
  items: [{ provider: 'grok-cli', label: 'Account 1' }],
};

export const DEFAULT_CONFIG: GrokCliConfig = {
  version: CONFIG_VERSION,
  accounts: DEFAULT_ACCOUNTS_CONFIG,
  imagine: DEFAULT_IMAGINE_CONFIG,
  vision: DEFAULT_VISION_CONFIG,
};

export interface LoadedConfig {
  config: GrokCliConfig;
  warning?: string;
}

type ParsedConfig = LoadedConfig & { valid: boolean; needsMigration: boolean };

type LegacyConfig = LoadedConfig & {
  existingPaths: string[];
  recognizedPaths: string[];
};

const homePath = () => process.env.HOME || homedir();

export const getConfigPath = () => join(homePath(), '.pi', 'grok-cli.json');
export const getLegacyImagineConfigPath = () => join(homePath(), '.pi', 'grok-cli-imagine.json');
export const getLegacyVisionConfigPath = () => join(homePath(), '.pi', 'grok-cli-vision.json');

function defaultConfig(): GrokCliConfig {
  return {
    version: CONFIG_VERSION,
    accounts: {
      ...DEFAULT_ACCOUNTS_CONFIG,
      items: DEFAULT_ACCOUNTS_CONFIG.items.map((account) => ({ ...account })),
    },
    imagine: { ...DEFAULT_IMAGINE_CONFIG },
    vision: { ...DEFAULT_VISION_CONFIG },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

const accountNumber = (provider: string) => {
  if (provider === 'grok-cli') return 1;
  const match = /^grok-cli-((?:[2-9]|[1-9]\d+))$/.exec(provider);
  return match ? Number(match[1]) : undefined;
};

function normalizeAccountsConfig(raw: unknown, warnings: string[]): AccountsConfig {
  if (raw === undefined) return defaultConfig().accounts;
  if (!isObject(raw) || !Array.isArray(raw.items)) {
    warnings.push('accounts must be an object with an items array. Using defaults.');
    return defaultConfig().accounts;
  }

  const invalid: unknown[] = [];
  const providers = new Set<string>();
  const labels = new Set<string>();
  const baseIndex = raw.items.findIndex((value) => {
    if (!isObject(value) || value.provider !== 'grok-cli' || typeof value.label !== 'string') {
      return false;
    }
    const label = value.label.trim();
    return Boolean(label) && [...label].length <= 40 && !hasTerminalControlCharacters(label);
  });
  const accountValues =
    baseIndex >= 0
      ? [raw.items[baseIndex], ...raw.items.filter((_value, index) => index !== baseIndex)]
      : [{ provider: 'grok-cli', label: 'Account 1' }, ...raw.items];
  const items = accountValues.flatMap((value) => {
    if (!isObject(value) || typeof value.provider !== 'string' || typeof value.label !== 'string') {
      invalid.push(value);
      return [];
    }
    const label = value.label.trim();
    const normalizedLabel = label.toLocaleLowerCase();
    if (
      accountNumber(value.provider) === undefined ||
      !label ||
      [...label].length > 40 ||
      hasTerminalControlCharacters(label) ||
      providers.has(value.provider) ||
      labels.has(normalizedLabel)
    ) {
      invalid.push(value);
      return [];
    }
    providers.add(value.provider);
    labels.add(normalizedLabel);
    return [{ provider: value.provider, label }];
  });

  if (!providers.has('grok-cli')) {
    items.unshift({ provider: 'grok-cli', label: 'Account 1' });
    providers.add('grok-cli');
  } else {
    items.sort((left, right) =>
      left.provider === 'grok-cli' ? -1 : right.provider === 'grok-cli' ? 1 : 0,
    );
  }

  if (invalid.length)
    warnings.push('accounts contains invalid or duplicate entries. Ignoring them.');
  const highestAccountNumber = Math.max(
    ...items.map((account) => accountNumber(account.provider) ?? 1),
  );
  const requestedNext =
    typeof raw.nextAccountNumber === 'number' &&
    Number.isInteger(raw.nextAccountNumber) &&
    raw.nextAccountNumber >= 2
      ? raw.nextAccountNumber
      : 2;
  const selectedProvider =
    typeof raw.selectedProvider === 'string' && providers.has(raw.selectedProvider)
      ? raw.selectedProvider
      : 'grok-cli';

  return {
    nextAccountNumber: Math.max(requestedNext, highestAccountNumber + 1),
    selectedProvider,
    items,
  };
}

export function describableModels(): string[] {
  return resolveModels()
    .filter((model) => model.input.includes('image'))
    .map((model) => model.id);
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

export function normalizeVisionConfig(
  raw: Partial<VisionConfig>,
  warnings: string[] = [],
): VisionConfig {
  const config: VisionConfig = { ...DEFAULT_VISION_CONFIG };

  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') {
      config.enabled = raw.enabled;
    } else if (raw.enabled !== undefined) {
      warnings.push('enabled must be true or false. Using enabled=true.');
    }
  }

  if ('model' in raw) {
    if (typeof raw.model === 'string' && describableModels().includes(raw.model)) {
      config.model = raw.model;
    } else if (raw.model !== undefined) {
      warnings.push(
        `Unknown model "${String(raw.model)}". Available: ${describableModels().join(', ')}. Using ${DEFAULT_DESCRIBE_MODEL}.`,
      );
    }
  }

  if ('maxImages' in raw) {
    if (
      typeof raw.maxImages === 'number' &&
      Number.isFinite(raw.maxImages) &&
      raw.maxImages > 0 &&
      Number.isInteger(raw.maxImages)
    ) {
      config.maxImages = raw.maxImages;
    } else if (raw.maxImages !== undefined) {
      warnings.push(`maxImages must be a positive integer. Using ${DEFAULT_MAX_IMAGES}.`);
    }
  }

  if ('cacheEnabled' in raw) {
    if (typeof raw.cacheEnabled === 'boolean') {
      config.cacheEnabled = raw.cacheEnabled;
    } else if (raw.cacheEnabled !== undefined) {
      warnings.push('cacheEnabled must be true or false. Using cacheEnabled=true.');
    }
  }

  if ('cacheMaxEntries' in raw) {
    if (
      typeof raw.cacheMaxEntries === 'number' &&
      Number.isInteger(raw.cacheMaxEntries) &&
      raw.cacheMaxEntries > 0
    ) {
      config.cacheMaxEntries = raw.cacheMaxEntries;
    } else if (raw.cacheMaxEntries !== undefined) {
      warnings.push(
        `cacheMaxEntries must be a positive integer. Using ${DEFAULT_CACHE_MAX_ENTRIES}.`,
      );
    }
  }

  return config;
}

function normalizeConfig(
  raw: { accounts?: unknown; imagine?: unknown; vision?: unknown },
  warnings: string[],
): GrokCliConfig {
  const vision = raw.vision;
  if (vision !== undefined && !isObject(vision)) {
    warnings.push('vision must be a JSON object. Using defaults.');
  }
  return {
    version: CONFIG_VERSION,
    accounts: normalizeAccountsConfig(raw.accounts, warnings),
    imagine: normalizeImagineConfig(raw.imagine, warnings),
    vision: normalizeVisionConfig(isObject(vision) ? vision : {}, warnings),
  };
}

function parseConfig(configPath: string): ParsedConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!isObject(parsed)) {
      return {
        config: defaultConfig(),
        needsMigration: false,
        valid: false,
        warning: `Config ${configPath} must be a JSON object. Using legacy settings or defaults.`,
      };
    }
    if (parsed.version !== CONFIG_VERSION && parsed.version !== LEGACY_CONFIG_VERSION) {
      return {
        config: defaultConfig(),
        needsMigration: false,
        valid: false,
        warning: `Unsupported config version ${String(parsed.version)} in ${configPath}. Using legacy settings or defaults.`,
      };
    }
    const warnings: string[] = [];
    return {
      config: normalizeConfig(parsed, warnings),
      needsMigration: parsed.version === LEGACY_CONFIG_VERSION,
      valid: true,
      warning: warnings.length ? `Invalid ${configPath}: ${warnings.join(' ')}` : undefined,
    };
  } catch (error) {
    return {
      config: defaultConfig(),
      needsMigration: false,
      valid: false,
      warning: `Could not read ${configPath}: ${errorMessage(error)}. Using legacy settings or defaults.`,
    };
  }
}

function parseLegacyImagine(configPath: string): {
  config: ImagineConfig;
  recognized: boolean;
  warning?: string;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!isObject(parsed)) {
      return {
        config: { ...DEFAULT_IMAGINE_CONFIG },
        recognized: false,
        warning: `Legacy config ${configPath} must be a JSON object.`,
      };
    }
    if ('enabled' in parsed) {
      if (typeof parsed.enabled === 'boolean') {
        return { config: { enabled: parsed.enabled }, recognized: true };
      }
      return {
        config: { ...DEFAULT_IMAGINE_CONFIG },
        recognized: false,
        warning: `Invalid ${configPath}: enabled must be a boolean.`,
      };
    }
    if (parsed.scope === 'grok-cli' || parsed.scope === 'all') {
      return { config: { enabled: true }, recognized: true };
    }
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      recognized: false,
      warning: `Invalid ${configPath}: expected enabled or a recognized scope.`,
    };
  } catch (error) {
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      recognized: false,
      warning: `Could not read ${configPath}: ${errorMessage(error)}.`,
    };
  }
}

function parseLegacyVision(configPath: string): {
  config: VisionConfig;
  recognized: boolean;
  warning?: string;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!isObject(parsed)) {
      return {
        config: { ...DEFAULT_VISION_CONFIG },
        recognized: false,
        warning: `Legacy config ${configPath} must be a JSON object.`,
      };
    }
    const warnings: string[] = [];
    const config = normalizeVisionConfig(parsed, warnings);
    return {
      config,
      recognized: warnings.length === 0,
      warning: warnings.length ? `Invalid ${configPath}: ${warnings.join(' ')}` : undefined,
    };
  } catch (error) {
    return {
      config: { ...DEFAULT_VISION_CONFIG },
      recognized: false,
      warning: `Could not read ${configPath}: ${errorMessage(error)}.`,
    };
  }
}

function loadLegacyConfig(): LegacyConfig {
  const imaginePath = getLegacyImagineConfigPath();
  const visionPath = getLegacyVisionConfigPath();
  const imagine = existsSync(imaginePath) ? parseLegacyImagine(imaginePath) : undefined;
  const vision = existsSync(visionPath) ? parseLegacyVision(visionPath) : undefined;
  return {
    config: {
      version: CONFIG_VERSION,
      accounts: defaultConfig().accounts,
      imagine: imagine?.config ?? { ...DEFAULT_IMAGINE_CONFIG },
      vision: vision?.config ?? { ...DEFAULT_VISION_CONFIG },
    },
    existingPaths: [imagine ? imaginePath : undefined, vision ? visionPath : undefined].filter(
      (path): path is string => Boolean(path),
    ),
    recognizedPaths: [
      imagine?.recognized ? imaginePath : undefined,
      vision?.recognized ? visionPath : undefined,
    ].filter((path): path is string => Boolean(path)),
    warning: combineWarnings([imagine?.warning, vision?.warning]),
  };
}

export function loadConfig(): LoadedConfig {
  if (!existsSync(getConfigPath())) {
    const legacy = loadLegacyConfig();
    return legacy.warning
      ? { config: legacy.config, warning: legacy.warning }
      : { config: legacy.config };
  }
  const loaded = parseConfig(getConfigPath());
  if (loaded.valid) {
    return loaded.warning
      ? { config: loaded.config, warning: loaded.warning }
      : { config: loaded.config };
  }
  const legacy = loadLegacyConfig();
  return {
    config: legacy.config,
    warning: combineWarnings([loaded.warning, legacy.warning]),
  };
}

export function saveConfig(config: GrokCliConfig) {
  const configPath = getConfigPath();
  const tempPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  mkdirSync(dirname(configPath), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(normalizeConfig(config, []), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(tempPath, configPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function removeLegacyConfigs(paths: string[]) {
  return combineWarnings(
    paths.flatMap((path) => {
      try {
        unlinkSync(path);
        return [];
      } catch (error) {
        return [`Could not remove legacy config ${path}: ${errorMessage(error)}.`];
      }
    }),
  );
}

export function migrateLegacyConfig(): { warning?: string } {
  const legacy = loadLegacyConfig();
  if (existsSync(getConfigPath())) {
    const loaded = parseConfig(getConfigPath());
    if (!loaded.valid) {
      return { warning: combineWarnings([loaded.warning, legacy.warning]) };
    }
    if (loaded.needsMigration) {
      try {
        saveConfig(loaded.config);
        const verified = parseConfig(getConfigPath());
        if (
          !verified.valid ||
          verified.needsMigration ||
          JSON.stringify(verified.config) !== JSON.stringify(loaded.config)
        ) {
          return {
            warning: combineWarnings([
              verified.warning,
              `Could not verify migrated config ${getConfigPath()}. Legacy files were preserved.`,
            ]),
          };
        }
      } catch (error) {
        return {
          warning: `Could not migrate configuration ${getConfigPath()}: ${errorMessage(error)}. Legacy files were preserved.`,
        };
      }
    }
    const cleanupWarning = removeLegacyConfigs(legacy.recognizedPaths);
    const warning = combineWarnings([loaded.warning, legacy.warning, cleanupWarning]);
    return warning ? { warning } : {};
  }
  if (legacy.existingPaths.length === 0) return {};
  if (legacy.recognizedPaths.length !== legacy.existingPaths.length) {
    return { warning: legacy.warning };
  }
  try {
    saveConfig(legacy.config);
    const verified = parseConfig(getConfigPath());
    if (!verified.valid || JSON.stringify(verified.config) !== JSON.stringify(legacy.config)) {
      return {
        warning: combineWarnings([
          verified.warning,
          `Could not verify migrated config ${getConfigPath()}. Legacy files were preserved.`,
        ]),
      };
    }
  } catch (error) {
    return {
      warning: `Could not migrate legacy configuration to ${getConfigPath()}: ${errorMessage(error)}. Legacy files were preserved.`,
    };
  }
  const warning = removeLegacyConfigs(legacy.recognizedPaths);
  return warning ? { warning } : {};
}
