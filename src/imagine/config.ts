import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ImagineToolScope = 'grok-cli' | 'all';
export type ImagineConfig = { scope: ImagineToolScope };

export const DEFAULT_IMAGINE_CONFIG: ImagineConfig = { scope: 'grok-cli' };

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
    const scope = (parsed as { scope?: unknown }).scope;
    if (scope === 'grok-cli' || scope === 'all') return { config: { scope } };
    return {
      config: { ...DEFAULT_IMAGINE_CONFIG },
      warning: `Invalid ${configPath}: scope must be "grok-cli" or "all". Using grok-cli.`,
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
