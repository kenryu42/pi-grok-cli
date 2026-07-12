import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

async function nextImagePath(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const indexes = (await fs.readdir(directory))
    .map((name) => name.match(/^(\d+)\.jpe?g$/i)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return join(directory, `${Math.max(0, ...indexes) + 1}.jpg`);
}

async function writeNumberedImage(directory: string, bytes: Buffer): Promise<string> {
  const imagePath = await nextImagePath(directory);
  try {
    await fs.writeFile(imagePath, bytes, { flag: 'wx' });
    return imagePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return writeNumberedImage(directory, bytes);
    }
    throw error;
  }
}

export async function saveImage(options: {
  b64: string;
  sessionDir?: string;
  sessionId?: string;
  outPath?: string;
  fallbackDir?: string;
}) {
  const bytes = Buffer.from(options.b64, 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error('Imagine did not return valid JPEG data');

  const usedFallback = !options.outPath && (!options.sessionDir || !options.sessionId);
  const absolutePath = options.outPath
    ? resolve(options.outPath)
    : await writeNumberedImage(
        options.sessionDir && options.sessionId
          ? join(options.sessionDir, options.sessionId, 'images')
          : (options.fallbackDir ?? join(tmpdir(), 'pi-grok-cli', 'images')),
        bytes,
      );
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  if (options.outPath) await fs.writeFile(absolutePath, bytes);
  const filename = basename(absolutePath);
  return {
    absolutePath,
    relativePath: options.outPath
      ? isAbsolute(options.outPath)
        ? options.outPath
        : resolve(options.outPath)
      : `images/${filename}`,
    filename,
    usedFallback,
  };
}

export async function savePreviewImage(options: {
  b64: string;
  absolutePath: string;
  filename: string;
  sessionDir?: string;
  sessionId?: string;
  outPath?: string;
  fallbackDir?: string;
}) {
  const previewDirectory = options.outPath
    ? options.sessionDir && options.sessionId
      ? join(options.sessionDir, options.sessionId, 'images', '.previews')
      : join(options.fallbackDir ?? join(tmpdir(), 'pi-grok-cli', 'images'), '.previews')
    : join(dirname(options.absolutePath), '.previews');
  const previewFilename = options.outPath
    ? `out-${createHash('sha256').update(options.absolutePath).digest('hex').slice(0, 16)}.png`
    : `${parse(options.filename).name}.png`;
  const previewPath = join(previewDirectory, previewFilename);
  await fs.mkdir(previewDirectory, { recursive: true });
  await fs.writeFile(previewPath, Buffer.from(options.b64, 'base64'));
  return previewPath;
}
