import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/**
 * Point HOME at a fresh temp dir for the whole test file, restoring it on
 * teardown. Returns a setup function that creates a new dir per call.
 */
export function useTempHome(): () => string {
  const originalHome = process.env.HOME;
  const dirs: string[] = [];
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-cli-vision-'));
    process.env.HOME = dir;
    return dir;
  };
}
