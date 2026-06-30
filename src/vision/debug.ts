import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LOG_PATH = join(homedir(), '.pi', 'grok-cli-vision-debug.log');

export function isDebugEnabled(): boolean {
  return process.env.GROK_CLI_VISION_DEBUG === '1' || process.env.GROK_CLI_VISION_DEBUG === 'true';
}

/**
 * Append a timestamped line to ~/.pi/grok-cli-vision-debug.log when
 * GROK_CLI_VISION_DEBUG is set. Safe to call when disabled (no-op).
 */
export function debug(message: string): void {
  if (!isDebugEnabled()) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Never let diagnostics break the feature.
  }
}

export function getDebugLogPath(): string {
  return LOG_PATH;
}
