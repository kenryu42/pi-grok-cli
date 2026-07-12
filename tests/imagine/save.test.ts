import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveImage, savePreviewImage } from '../../src/imagine/save.js';
import { tempDir } from '../tools/toolTestHelpers.js';

const JPEG = '/9j/2Q==';

describe('saveImage', () => {
  it('writes sequential session image filenames without overwriting', async () => {
    const sessionDir = tempDir('imagine-session-');
    const first = await saveImage({ b64: JPEG, sessionDir, sessionId: 'session-id' });
    const second = await saveImage({ b64: JPEG, sessionDir, sessionId: 'session-id' });

    expect(first).toEqual({
      absolutePath: join(sessionDir, 'session-id', 'images', '1.jpg'),
      relativePath: 'images/1.jpg',
      filename: '1.jpg',
      usedFallback: false,
    });
    expect(second.filename).toBe('2.jpg');
    expect(await fs.readFile(first.absolutePath)).toEqual(Buffer.from(JPEG, 'base64'));
  });

  it('assigns distinct filenames to concurrent saves', async () => {
    const sessionDir = tempDir('imagine-concurrent-');
    const saved = await Promise.all(
      Array.from({ length: 4 }, () =>
        saveImage({ b64: JPEG, sessionDir, sessionId: 'session-id' }),
      ),
    );
    expect(new Set(saved.map((image) => image.filename)).size).toBe(4);
  });

  it('honors an output override and creates its parent directory', async () => {
    const outPath = join(tempDir('imagine-out-'), 'nested', 'cat.jpg');
    const saved = await saveImage({ b64: JPEG, outPath });
    expect(saved.absolutePath).toBe(outPath);
    expect(saved.relativePath).toBe(outPath);
    expect(saved.filename).toBe('cat.jpg');
  });

  it('uses a numbered temporary directory without session storage', async () => {
    const fallbackDir = tempDir('imagine-fallback-');
    const saved = await saveImage({ b64: JPEG, fallbackDir });
    expect(saved.usedFallback).toBe(true);
    expect(basename(saved.absolutePath)).toBe('1.jpg');
    expect(saved.relativePath).toBe('images/1.jpg');
  });

  it('rejects non-JPEG image data', async () => {
    await expect(
      saveImage({ b64: 'aGVsbG8=', outPath: join(tempDir('bad-jpeg-'), 'x.jpg') }),
    ).rejects.toThrow('valid JPEG');
  });
});

describe('savePreviewImage', () => {
  it('stores numbered previews in the session-internal preview directory', async () => {
    const sessionDir = tempDir('imagine-preview-');
    const previewPath = await savePreviewImage({
      b64: 'cG5n',
      absolutePath: join(sessionDir, 'session-id', 'images', '1.jpg'),
      filename: '1.jpg',
      sessionDir,
      sessionId: 'session-id',
    });
    expect(previewPath).toBe(join(sessionDir, 'session-id', 'images', '.previews', '1.png'));
    expect(await fs.readFile(previewPath, 'utf8')).toBe('png');
  });

  it('uses deterministic distinct hashes for output overrides', async () => {
    const sessionDir = tempDir('imagine-preview-out-');
    const first = await savePreviewImage({
      b64: 'cG5n',
      absolutePath: '/outputs/cat.jpg',
      filename: 'cat.jpg',
      outPath: '/outputs/cat.jpg',
      sessionDir,
      sessionId: 'session-id',
    });
    const repeated = await savePreviewImage({
      b64: 'cG5nMg==',
      absolutePath: '/outputs/cat.jpg',
      filename: 'cat.jpg',
      outPath: '/outputs/cat.jpg',
      sessionDir,
      sessionId: 'session-id',
    });
    const other = await savePreviewImage({
      b64: 'cG5n',
      absolutePath: '/outputs/dog.jpg',
      filename: 'dog.jpg',
      outPath: '/outputs/dog.jpg',
      sessionDir,
      sessionId: 'session-id',
    });
    expect(repeated).toBe(first);
    expect(other).not.toBe(first);
    expect(basename(first)).toMatch(/^out-[a-f0-9]{16}\.png$/);
  });

  it('uses the ephemeral preview directory without session storage', async () => {
    const fallbackDir = tempDir('imagine-preview-fallback-');
    const previewPath = await savePreviewImage({
      b64: 'cG5n',
      absolutePath: join(fallbackDir, '1.jpg'),
      filename: '1.jpg',
      fallbackDir,
    });
    expect(previewPath).toBe(join(fallbackDir, '.previews', '1.png'));
  });

  it('assigns distinct sidecars to concurrent numbered images', async () => {
    const sessionDir = tempDir('imagine-preview-concurrent-');
    const previews = await Promise.all(
      ['1.jpg', '2.jpg', '3.jpg'].map((filename) =>
        savePreviewImage({
          b64: 'cG5n',
          absolutePath: join(sessionDir, 'session-id', 'images', filename),
          filename,
          sessionDir,
          sessionId: 'session-id',
        }),
      ),
    );
    expect(new Set(previews).size).toBe(3);
  });
});
