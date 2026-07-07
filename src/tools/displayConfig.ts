import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const TOOL_DISPLAY_MODES = ['minimal', 'preview'] as const;

export type ToolDisplayMode = (typeof TOOL_DISPLAY_MODES)[number];

export interface ToolDisplayConfig {
  toolDisplay: ToolDisplayMode;
  grepPreviewMatches: number;
  globPreviewFiles: number;
  lsPreviewEntries: number;
  shellTailLines: number;
  readPreviewLines: number;
  writePreviewLines: number;
  webSearchPreviewChars: number;
}

const MODE_DEFAULTS: Record<ToolDisplayMode, ToolDisplayConfig> = {
  minimal: {
    toolDisplay: 'minimal',
    grepPreviewMatches: 0,
    globPreviewFiles: 0,
    lsPreviewEntries: 0,
    shellTailLines: 0,
    readPreviewLines: 0,
    writePreviewLines: 0,
    webSearchPreviewChars: 0,
  },
  preview: {
    toolDisplay: 'preview',
    grepPreviewMatches: 10,
    globPreviewFiles: 20,
    lsPreviewEntries: 20,
    shellTailLines: 20,
    readPreviewLines: 0,
    writePreviewLines: 0,
    webSearchPreviewChars: 500,
  },
};

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = { ...MODE_DEFAULTS.preview };

const homePath = () => process.env.HOME || homedir();

export const getToolDisplayConfigPath = () =>
  process.env.PI_GROK_CLI_TOOLS_CONFIG || join(homePath(), '.pi', 'grok-cli-tools.json');

export interface LoadedToolDisplayConfig {
  config: ToolDisplayConfig;
  warning?: string;
}

function isDisplayMode(value: unknown): value is ToolDisplayMode {
  return typeof value === 'string' && TOOL_DISPLAY_MODES.includes(value as ToolDisplayMode);
}

function normalizePositiveInteger(
  raw: Record<string, unknown>,
  key: keyof Omit<ToolDisplayConfig, 'toolDisplay'>,
  config: ToolDisplayConfig,
  warnings: string[],
) {
  if (!(key in raw)) return;
  const value = raw[key];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    config[key] = value;
    return;
  }
  warnings.push(`${key} must be a non-negative integer. Using ${config[key]}.`);
}

export function configForToolDisplayMode(mode: ToolDisplayMode): ToolDisplayConfig {
  return { ...MODE_DEFAULTS[mode] };
}

export function normalizeToolDisplayConfig(
  raw: Partial<ToolDisplayConfig>,
  warnings: string[] = [],
): ToolDisplayConfig {
  const mode = isDisplayMode(raw.toolDisplay)
    ? raw.toolDisplay
    : DEFAULT_TOOL_DISPLAY_CONFIG.toolDisplay;
  const config = configForToolDisplayMode(mode);

  if ('toolDisplay' in raw && !isDisplayMode(raw.toolDisplay)) {
    warnings.push(
      `toolDisplay must be one of ${TOOL_DISPLAY_MODES.join(', ')}. Using ${config.toolDisplay}.`,
    );
  }

  const record = raw as Record<string, unknown>;
  normalizePositiveInteger(record, 'grepPreviewMatches', config, warnings);
  normalizePositiveInteger(record, 'globPreviewFiles', config, warnings);
  normalizePositiveInteger(record, 'lsPreviewEntries', config, warnings);
  normalizePositiveInteger(record, 'shellTailLines', config, warnings);
  normalizePositiveInteger(record, 'readPreviewLines', config, warnings);
  normalizePositiveInteger(record, 'writePreviewLines', config, warnings);
  normalizePositiveInteger(record, 'webSearchPreviewChars', config, warnings);

  return config;
}

export function loadToolDisplayConfig(
  configPath = getToolDisplayConfigPath(),
): LoadedToolDisplayConfig {
  try {
    if (!existsSync(configPath)) return { config: { ...DEFAULT_TOOL_DISPLAY_CONFIG } };
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: { ...DEFAULT_TOOL_DISPLAY_CONFIG },
        warning: `Config ${configPath} must be a JSON object. Using defaults.`,
      };
    }
    const warnings: string[] = [];
    const config = normalizeToolDisplayConfig(parsed as Partial<ToolDisplayConfig>, warnings);
    return {
      config,
      warning: warnings.length ? `Invalid ${configPath}: ${warnings.join(' ')}` : undefined,
    };
  } catch (err) {
    return {
      config: { ...DEFAULT_TOOL_DISPLAY_CONFIG },
      warning: `Could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
    };
  }
}

export function saveToolDisplayConfig(
  config: ToolDisplayConfig,
  configPath = getToolDisplayConfigPath(),
) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(normalizeToolDisplayConfig(config), null, 2));
}

function formatConfig(config: ToolDisplayConfig, warning?: string): string {
  return [
    `grok-cli-tools display: ${config.toolDisplay}`,
    `grepPreviewMatches: ${config.grepPreviewMatches}`,
    `globPreviewFiles: ${config.globPreviewFiles}`,
    `lsPreviewEntries: ${config.lsPreviewEntries}`,
    `shellTailLines: ${config.shellTailLines}`,
    `readPreviewLines: ${config.readPreviewLines}`,
    `writePreviewLines: ${config.writePreviewLines}`,
    `webSearchPreviewChars: ${config.webSearchPreviewChars}`,
    `config: ${getToolDisplayConfigPath()}`,
    warning ? `warning: ${warning}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function registerModeCommand(pi: Pick<ExtensionAPI, 'registerCommand'>, mode: ToolDisplayMode) {
  pi.registerCommand(`grok-cli-tools:${mode}`, {
    description: `Set grok-cli tool display mode to ${mode}`,
    handler: async (_args, ctx) => {
      const config = configForToolDisplayMode(mode);
      saveToolDisplayConfig(config);
      ctx.ui.notify(formatConfig(config), 'info');
    },
  });
}

export function registerToolDisplayCommands(pi: Pick<ExtensionAPI, 'registerCommand'>) {
  pi.registerCommand('grok-cli-tools:status', {
    description: 'Show grok-cli tool display mode and preview limits',
    handler: async (_args, ctx) => {
      const { config, warning } = loadToolDisplayConfig();
      ctx.ui.notify(formatConfig(config, warning), warning ? 'warning' : 'info');
    },
  });

  registerModeCommand(pi, 'minimal');
  registerModeCommand(pi, 'preview');
}
