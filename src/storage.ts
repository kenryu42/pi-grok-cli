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

const homePath = () => process.env.HOME || homedir();

export const getGrokCliDirectory = () => join(homePath(), '.pi', 'grok-cli');
export const getConfigPath = () => join(getGrokCliDirectory(), 'config.json');
export const getQuotaCachePath = () => join(getGrokCliDirectory(), 'quota-cache.json');

export const getLegacyConfigPath = () => join(homePath(), '.pi', 'grok-cli.json');
export const getLegacyImagineConfigPath = () => join(homePath(), '.pi', 'grok-cli-imagine.json');

export function writeFileAtomic(path: string, contents: string, mode?: number) {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode === undefined ? {} : { mode }),
    });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function migrateStoredFile(source: string, destination: string, preserveSource = false) {
  if (!existsSync(source)) return undefined;
  if (existsSync(destination)) {
    return `Could not migrate ${source}: ${destination} already exists. The legacy file was preserved.`;
  }
  let verified = false;
  try {
    const contents = readFileSync(source, 'utf8');
    writeFileAtomic(destination, contents);
    if (readFileSync(destination, 'utf8') !== contents) {
      throw new Error(`could not verify ${destination}`);
    }
    verified = true;
    if (!preserveSource) unlinkSync(source);
    return undefined;
  } catch (error) {
    if (!verified && existsSync(destination)) rmSync(destination, { force: true });
    return `Could not migrate ${source} to ${destination}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved.`;
  }
}
