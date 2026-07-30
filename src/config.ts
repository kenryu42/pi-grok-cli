import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import {
  getConfigPath,
  getLegacyConfigPath,
  getLegacyImagineConfigPath,
  migrateStoredFile,
  writeFileAtomic,
} from './storage.js';

export { getConfigPath, getLegacyImagineConfigPath } from './storage.js';

export const CONFIG_VERSION = 2 as const;
const LEGACY_CONFIG_VERSION = 1;

export type ImagineConfig = { enabled: boolean };

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
}

export const DEFAULT_IMAGINE_CONFIG: ImagineConfig = { enabled: true };

export const DEFAULT_ACCOUNTS_CONFIG: AccountsConfig = {
  nextAccountNumber: 2,
  selectedProvider: 'grok-cli',
  items: [{ provider: 'grok-cli', label: 'Account 1' }],
};

export const DEFAULT_CONFIG: GrokCliConfig = {
  version: CONFIG_VERSION,
  accounts: DEFAULT_ACCOUNTS_CONFIG,
  imagine: DEFAULT_IMAGINE_CONFIG,
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

function defaultConfig(): GrokCliConfig {
  return {
    version: CONFIG_VERSION,
    accounts: {
      ...DEFAULT_ACCOUNTS_CONFIG,
      items: DEFAULT_ACCOUNTS_CONFIG.items.map((account) => ({ ...account })),
    },
    imagine: { ...DEFAULT_IMAGINE_CONFIG },
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

export function findAvailableAccountNumber(
  providers: Iterable<string>,
  reservedProviders: Iterable<string> = [],
) {
  const unavailable = new Set([...providers, ...reservedProviders]);
  const find = (number: number): number =>
    unavailable.has(`grok-cli-${number}`) ? find(number + 1) : number;
  return find(2);
}

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
  const selectedProvider =
    typeof raw.selectedProvider === 'string' && providers.has(raw.selectedProvider)
      ? raw.selectedProvider
      : 'grok-cli';

  return {
    nextAccountNumber: findAvailableAccountNumber(providers),
    selectedProvider,
    items,
  };
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

function normalizeConfig(
  raw: { accounts?: unknown; imagine?: unknown },
  warnings: string[],
): GrokCliConfig {
  return {
    version: CONFIG_VERSION,
    accounts: normalizeAccountsConfig(raw.accounts, warnings),
    imagine: normalizeImagineConfig(raw.imagine, warnings),
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

function loadLegacyConfig(): LegacyConfig {
  const imaginePath = getLegacyImagineConfigPath();
  const imagine = existsSync(imaginePath) ? parseLegacyImagine(imaginePath) : undefined;
  return {
    config: {
      version: CONFIG_VERSION,
      accounts: defaultConfig().accounts,
      imagine: imagine?.config ?? { ...DEFAULT_IMAGINE_CONFIG },
    },
    existingPaths: [imagine ? imaginePath : undefined].filter((path): path is string =>
      Boolean(path),
    ),
    recognizedPaths: [imagine?.recognized ? imaginePath : undefined].filter(
      (path): path is string => Boolean(path),
    ),
    warning: imagine?.warning,
  };
}

export function loadConfig(): LoadedConfig {
  const configPath = existsSync(getConfigPath())
    ? getConfigPath()
    : existsSync(getLegacyConfigPath())
      ? getLegacyConfigPath()
      : undefined;
  if (!configPath) {
    const legacy = loadLegacyConfig();
    return legacy.warning
      ? { config: legacy.config, warning: legacy.warning }
      : { config: legacy.config };
  }
  const loaded = parseConfig(configPath);
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
  writeFileAtomic(getConfigPath(), `${JSON.stringify(normalizeConfig(config, []), null, 2)}\n`);
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
  const migratedLegacyConfig = existsSync(getLegacyConfigPath()) && !existsSync(getConfigPath());
  const storageWarning = migrateStoredFile(getLegacyConfigPath(), getConfigPath(), true);
  if (!existsSync(getConfigPath()) && existsSync(getLegacyConfigPath())) {
    return { warning: storageWarning };
  }
  const legacy = loadLegacyConfig();
  if (existsSync(getConfigPath())) {
    const loaded = parseConfig(getConfigPath());
    if (!loaded.valid) {
      return { warning: combineWarnings([storageWarning, loaded.warning, legacy.warning]) };
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
              storageWarning,
              verified.warning,
              `Could not verify migrated config ${getConfigPath()}. Legacy files were preserved.`,
            ]),
          };
        }
      } catch (error) {
        return {
          warning: combineWarnings([
            storageWarning,
            `Could not migrate configuration ${getConfigPath()}: ${errorMessage(error)}. Legacy files were preserved.`,
          ]),
        };
      }
    }
    const cleanupWarning = removeLegacyConfigs([
      ...legacy.recognizedPaths,
      ...(migratedLegacyConfig ? [getLegacyConfigPath()] : []),
    ]);
    const warning = combineWarnings([
      storageWarning,
      loaded.warning,
      legacy.warning,
      cleanupWarning,
    ]);
    return warning ? { warning } : {};
  }
  if (legacy.existingPaths.length === 0) {
    return storageWarning ? { warning: storageWarning } : {};
  }
  if (legacy.recognizedPaths.length !== legacy.existingPaths.length) {
    return { warning: combineWarnings([storageWarning, legacy.warning]) };
  }
  try {
    saveConfig(legacy.config);
    const verified = parseConfig(getConfigPath());
    if (!verified.valid || JSON.stringify(verified.config) !== JSON.stringify(legacy.config)) {
      return {
        warning: combineWarnings([
          storageWarning,
          verified.warning,
          `Could not verify migrated config ${getConfigPath()}. Legacy files were preserved.`,
        ]),
      };
    }
  } catch (error) {
    return {
      warning: combineWarnings([
        storageWarning,
        `Could not migrate legacy configuration to ${getConfigPath()}: ${errorMessage(error)}. Legacy files were preserved.`,
      ]),
    };
  }
  const warning = combineWarnings([storageWarning, removeLegacyConfigs(legacy.recognizedPaths)]);
  return warning ? { warning } : {};
}
