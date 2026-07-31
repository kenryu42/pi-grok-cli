import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

const LEGACY_PROVIDER = /^grok-cli-(?:[2-9]|[1-9]\d+)$/;
const LEGACY_MODEL_PATTERN = /^grok-cli-(?:[2-9]|[1-9]\d+)(?=\/)/;

async function migrateSettings(directory: string) {
  if (!existsSync(join(directory, 'settings.json'))) return false;
  const settings = SettingsManager.create(join(directory, '.pi-grok-cli-migration'), directory);
  const current = settings.getGlobalSettings();
  const defaultProvider =
    typeof current.defaultProvider === 'string' && LEGACY_PROVIDER.test(current.defaultProvider)
      ? 'grok-cli'
      : current.defaultProvider;
  const enabledModels = Array.isArray(current.enabledModels)
    ? [
        ...new Set(
          current.enabledModels.map((pattern) => pattern.replace(LEGACY_MODEL_PATTERN, 'grok-cli')),
        ),
      ]
    : current.enabledModels;
  if (
    defaultProvider === current.defaultProvider &&
    JSON.stringify(enabledModels) === JSON.stringify(current.enabledModels)
  ) {
    return false;
  }
  if (defaultProvider !== current.defaultProvider && defaultProvider) {
    settings.setDefaultProvider(defaultProvider);
  }
  if (JSON.stringify(enabledModels) !== JSON.stringify(current.enabledModels)) {
    settings.setEnabledModels(enabledModels);
  }
  await settings.flush();
  const errors = settings.drainErrors();
  if (errors[0]) throw errors[0].error;
  return true;
}

export async function migrateSavedModelProviders(agentDir = getAgentDir(), cwd = process.cwd()) {
  try {
    const settingsChanged = (
      await Promise.all(
        [...new Set([agentDir, join(cwd, '.pi')])].map((directory) => migrateSettings(directory)),
      )
    ).some(Boolean);
    return { migrated: settingsChanged };
  } catch (error) {
    return {
      migrated: false,
      warning: `Could not migrate saved Grok model providers: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
  }
}
