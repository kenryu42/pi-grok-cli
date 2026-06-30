import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveModels } from '../models/catalog.js';

const homePath = () => process.env.HOME || homedir();

export const getConfigPath = () => join(homePath(), '.pi', 'grok-cli-vision.json');
export const getCachePath = () => join(homePath(), '.pi', 'grok-cli-vision-cache.json');

export const DEFAULT_DESCRIBE_MODEL = 'grok-build';
export const DEFAULT_MAX_IMAGES = 4;
export const DEFAULT_CACHE_MAX_ENTRIES = 100;

export const DEFAULT_PROMPT =
  'Describe this image in detail. If it contains text, transcribe it exactly. ' +
  'If it shows code, reproduce it. If it shows a UI, describe layout and elements. ' +
  'Respond in the same language as any text in the image.';

export interface VisionConfig {
  enabled: boolean;
  model: string;
  maxImages: number;
  cacheEnabled: boolean;
  cacheMaxEntries: number;
}

export const DEFAULT_CONFIG: VisionConfig = {
  enabled: true,
  model: DEFAULT_DESCRIBE_MODEL,
  maxImages: DEFAULT_MAX_IMAGES,
  cacheEnabled: true,
  cacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
};

export interface LoadedConfig {
  config: VisionConfig;
  warning?: string;
}

/** Image-capable Grok CLI model ids that may be used as the describer. */
export function describableModels(): string[] {
  return resolveModels()
    .filter((m) => m.input.includes('image'))
    .map((m) => m.id);
}

function isDescribableModel(value: unknown): value is string {
  return typeof value === 'string' && describableModels().includes(value);
}

function normalizeMaxImages(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    !Number.isInteger(value)
  ) {
    return DEFAULT_MAX_IMAGES;
  }
  return value;
}

export function normalizeConfig(raw: Partial<VisionConfig>, warnings: string[] = []): VisionConfig {
  const config: VisionConfig = { ...DEFAULT_CONFIG };

  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') {
      config.enabled = raw.enabled;
    } else if (raw.enabled !== undefined) {
      warnings.push('enabled must be true or false. Using enabled=true.');
    }
  }

  if ('model' in raw) {
    if (isDescribableModel(raw.model)) {
      config.model = raw.model;
    } else if (raw.model !== undefined) {
      warnings.push(
        `Unknown model "${String(raw.model)}". Available: ${describableModels().join(', ')}. Using ${DEFAULT_CONFIG.model}.`,
      );
    }
  }

  if ('maxImages' in raw) {
    const normalized = normalizeMaxImages(raw.maxImages);
    config.maxImages = normalized;
    if (raw.maxImages !== normalized) {
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

export function loadConfig(configPath = getConfigPath()): LoadedConfig {
  try {
    if (!existsSync(configPath)) return { config: { ...DEFAULT_CONFIG } };
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: { ...DEFAULT_CONFIG },
        warning: `Config ${configPath} must be a JSON object. Using defaults.`,
      };
    }
    const warnings: string[] = [];
    const config = normalizeConfig(parsed as Partial<VisionConfig>, warnings);
    return {
      config,
      warning: warnings.length ? `Invalid ${configPath}: ${warnings.join(' ')}` : undefined,
    };
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `Could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
    };
  }
}

export function saveConfig(config: VisionConfig, configPath = getConfigPath()) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(normalizeConfig(config), null, 2));
}
