import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cacheStats,
  clearCache,
  loadCache,
  makeCacheEntry,
  makeCacheKey,
  pruneCache,
  saveCache,
  updateCache,
  type VisionImage,
} from '../../src/vision/cache.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cachePath() {
  const dir = mkdtempSync(join(tmpdir(), 'grok-cli-vision-cache-'));
  tempDirs.push(dir);
  return join(dir, 'cache.json');
}

const image: VisionImage = {
  data: Buffer.from('png-bytes').toString('base64'),
  mimeType: 'image/png',
};
const prompt = 'describe this';

describe('grok-cli-vision cache', () => {
  it('starts empty for a missing cache file', () => {
    const path = cachePath();
    expect(loadCache(path).entries).toEqual({});
    expect(cacheStats(path).entries).toBe(0);
  });

  it('produces stable keys for identical inputs', () => {
    const keyA = makeCacheKey(image, 'grok-build', prompt);
    const keyB = makeCacheKey(image, 'grok-build', prompt);
    expect(keyA).toBe(keyB);
  });

  it('varies keys across model, prompt, and image bytes', () => {
    expect(makeCacheKey(image, 'grok-4.3', prompt)).not.toBe(
      makeCacheKey(image, 'grok-build', prompt),
    );
    expect(makeCacheKey(image, 'grok-build', 'other prompt')).not.toBe(
      makeCacheKey(image, 'grok-build', prompt),
    );
    const otherImage: VisionImage = {
      data: Buffer.from('other').toString('base64'),
      mimeType: 'image/png',
    };
    expect(makeCacheKey(otherImage, 'grok-build', prompt)).not.toBe(
      makeCacheKey(image, 'grok-build', prompt),
    );
  });

  it('saves and reloads entries', () => {
    const path = cachePath();
    const key = makeCacheKey(image, 'grok-build', prompt);
    const cache = loadCache(path);
    cache.entries[key] = makeCacheEntry(image, 'grok-build', prompt, 'a description');
    saveCache(cache, path);

    const reloaded = loadCache(path);
    expect(reloaded.entries[key]?.description).toBe('a description');
    expect(reloaded.entries[key]?.model).toBe('grok-build');
    expect(cacheStats(path).entries).toBe(1);
  });

  it('serializes updates so concurrent writers preserve distinct entries', async () => {
    const path = cachePath();
    const images: VisionImage[] = ['first', 'second'].map((value) => ({
      data: Buffer.from(value).toString('base64'),
      mimeType: 'image/png',
    }));

    await Promise.all(
      images.map((img, i) =>
        updateCache(path, (cache) => {
          cache.entries[makeCacheKey(img, 'grok-build', prompt)] = makeCacheEntry(
            img,
            'grok-build',
            prompt,
            `d${i}`,
          );
        }),
      ),
    );

    expect(Object.values(loadCache(path).entries).map((entry) => entry.description)).toEqual([
      'd0',
      'd1',
    ]);
  });

  it('prunes to the most recent entries by createdAt', () => {
    const path = cachePath();
    const cache = loadCache(path);
    const images: VisionImage[] = Array.from({ length: 4 }, (_, i) => ({
      data: Buffer.from(`img${i}`).toString('base64'),
      mimeType: 'image/png',
    }));
    images.forEach((img, i) => {
      const key = makeCacheKey(img, 'grok-build', prompt);
      const entry = makeCacheEntry(img, 'grok-build', prompt, `d${i}`);
      entry.createdAt = new Date(2020, 0, i + 1).toISOString();
      cache.entries[key] = entry;
    });

    pruneCache(cache, 2);
    expect(Object.keys(cache.entries)).toHaveLength(2);
    const descriptions = Object.values(cache.entries).map((e) => e.description);
    expect(descriptions).toEqual(['d3', 'd2']);
  });

  it('clearCache empties the cache file', () => {
    const path = cachePath();
    const cache = loadCache(path);
    cache.entries[makeCacheKey(image, 'grok-build', prompt)] = makeCacheEntry(
      image,
      'grok-build',
      prompt,
      'd',
    );
    saveCache(cache, path);

    clearCache(path);
    expect(loadCache(path).entries).toEqual({});
    expect(cacheStats(path).entries).toBe(0);
  });
});
