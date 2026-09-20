import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { getImageDimensions } from '@earendil-works/pi-tui';

const MAX_SOURCE_BYTES = 400 * 1024;

export async function imageFileToDataUri(filePath: string, signal?: AbortSignal) {
  if ((await stat(filePath)).size > MAX_SOURCE_BYTES) {
    throw new Error(
      'Source image exceeds the 400 KiB limit. Resize or compress it before editing.',
    );
  }
  // Read at most one byte beyond the limit, even if the file grows after stat.
  const bytes = await buffer(createReadStream(filePath, { end: MAX_SOURCE_BYTES, signal }));
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new Error(
      'Source image exceeds the 400 KiB limit. Resize or compress it before editing.',
    );
  }
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : undefined;
  const data = bytes.toString('base64');
  const dimensions = mime ? getImageDimensions(data, mime) : null;
  if (!mime || !dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1) {
    throw new Error(`Unsupported image file: ${filePath}. Use a PNG, JPEG, or WebP image.`);
  }
  return `data:${mime};base64,${data}`;
}
