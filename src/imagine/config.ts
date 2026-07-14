import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ImagineConfig = { enabled: boolean };

export const DEFAULT_IMAGINE_CONFIG: ImagineConfig = { enabled: true };

export const getImagineConfigPath = () =>
  join(process.env.HOME || homedir(), '.pi', 'grok-cli-imagine.json');

export function loadImagineConfig(configPath = getImagineConfigPath()): {
  config: ImagineConfig;
  warning?: string;
} {
  try {
    if (!existsSync(configPath)) return { config: { ...DEFAULT_IMAGINE_CONFIG } };
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: { ...DEFAULT_IMAGINE_CONFIG },
        warning: `Config ${configPath} must be a JSON object. Using defaults.`,
      };
    }
    const enabled = (parsed as { enabled?: unknown }).enabled;
    if (typeof enabled === 'boolean') return { config: { enabled } };
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      warning: `Invalid ${configPath}: enabled must be a boolean. Using enabled: true.`,
    };
  } catch (error) {
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      warning: `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}. Using defaults.`,
    };
  }
}

export function saveImagineConfig(config: ImagineConfig, configPath = getImagineConfigPath()) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
