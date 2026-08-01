import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const homePath = () => process.env.HOME || homedir();
const LOCK_STALE_MS = 30_000;

export const getGrokCliDirectory = () => join(homePath(), '.pi', 'grok-cli');
export const getAccountVaultPath = () => join(getGrokCliDirectory(), 'accounts.json');
export const getConfigBackupPath = () => join(getGrokCliDirectory(), 'config.v2.backup.json');
export const getConfigPath = () => join(getGrokCliDirectory(), 'config.json');
export const getQuotaCachePath = () => join(getGrokCliDirectory(), 'quota-cache.json');

export const getLegacyConfigPath = () => join(homePath(), '.pi', 'grok-cli.json');
export const getLegacyImagineConfigPath = () => join(homePath(), '.pi', 'grok-cli-imagine.json');

function abandonedLock(path: string) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
      const pid = (owner as Record<string, unknown>).pid;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        return !processIsRunning(pid);
      }
    }
  } catch {}
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function recoveryPaths(lockPath: string) {
  const prefix = `${basename(lockPath)}.recovery.`;
  return readdirSync(dirname(lockPath))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dirname(lockPath), name));
}

function recoveryInProgress(lockPath: string) {
  return recoveryPaths(lockPath).some((path) => {
    try {
      const pid = Number(basename(path).split('.recovery.')[1]?.split('.')[0]);
      if (
        Number.isInteger(pid) &&
        pid > 0 &&
        processIsRunning(pid) &&
        Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS
      ) {
        return true;
      }
      rmSync(path, { force: true });
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      rmSync(path, { force: true });
      return false;
    }
  });
}

function releaseOwnedLock(lockPath: string, token: string) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    if (owner.token === token) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function recoverAbandonedLock(lockPath: string) {
  const recoveryPath = `${lockPath}.recovery.${process.pid}.${randomUUID()}`;
  closeSync(openSync(recoveryPath, 'wx', 0o600));
  try {
    if (abandonedLock(lockPath)) rmSync(lockPath, { force: true });
  } finally {
    unlinkSync(recoveryPath);
  }
}

export async function acquireFileLock(path: string) {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const startedAt = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  while (true) {
    if (Date.now() - startedAt >= LOCK_STALE_MS) {
      throw new Error(`Timed out waiting for file lock: ${lockPath}`);
    }
    if (recoveryInProgress(lockPath)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      const file = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(file);
      }
      if (recoveryInProgress(lockPath)) {
        releaseOwnedLock(lockPath, token);
        continue;
      }
      return async () => releaseOwnedLock(lockPath, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (abandonedLock(lockPath)) {
        recoverAbandonedLock(lockPath);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

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
