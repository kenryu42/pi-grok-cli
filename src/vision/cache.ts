import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface CacheEntry {
  createdAt: string;
  description: string;
  imageHash: string;
  mediaType: string;
  model: string;
  promptHash: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface VisionImage {
  data: string;
  mimeType: string;
}

function emptyCache(): CacheFile {
  return { version: 1, entries: {} };
}

export function loadCache(cachePath: string): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (
      raw?.version === 1 &&
      raw.entries &&
      typeof raw.entries === 'object' &&
      !Array.isArray(raw.entries)
    ) {
      return raw as CacheFile;
    }
  } catch {
    // Missing or invalid cache: start fresh.
  }
  return emptyCache();
}

export function saveCache(cache: CacheFile, cachePath: string) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export function clearCache(cachePath: string) {
  saveCache(emptyCache(), cachePath);
}

export function cacheStats(cachePath: string): { entries: number; path: string } {
  return { entries: Object.keys(loadCache(cachePath).entries).length, path: cachePath };
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function makeCacheKey(img: VisionImage, model: string, prompt: string): string {
  const imageHash = hash(Buffer.from(img.data, 'base64'));
  return hash(JSON.stringify({ imageHash, mediaType: img.mimeType, model, prompt }));
}

export function makeCacheEntry(
  img: VisionImage,
  model: string,
  prompt: string,
  description: string,
): CacheEntry {
  return {
    createdAt: new Date().toISOString(),
    description,
    imageHash: hash(Buffer.from(img.data, 'base64')),
    mediaType: img.mimeType || 'unknown',
    model,
    promptHash: hash(prompt),
  };
}

export function pruneCache(cache: CacheFile, maxEntries: number) {
  const entries = Object.entries(cache.entries).sort(
    ([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  cache.entries = Object.fromEntries(entries.slice(0, maxEntries));
}
