import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { convertToPng } from '@earendil-works/pi-coding-agent';
import { afterEach, vi } from 'vitest';
import type { savePreviewImage } from '../../src/imagine/save.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function imagineDependencies() {
  return {
    generateImage: vi.fn(async () => ({ b64: '/9j/2Q==', mimeType: 'image/jpeg' as const })),
    convertToPng: vi.fn<typeof convertToPng>(async () => ({
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    })),
    saveImage: vi.fn(async () => ({
      absolutePath: '/sessions/id/images/1.jpg',
      relativePath: 'images/1.jpg',
      filename: '1.jpg',
      usedFallback: false,
    })),
    savePreviewImage: vi.fn<typeof savePreviewImage>(
      async () => '/sessions/id/images/.previews/1.png',
    ),
  };
}
