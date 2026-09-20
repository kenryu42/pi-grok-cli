import { readFile } from 'node:fs/promises';
import { getImageDimensions } from '@earendil-works/pi-tui';

export async function imageFileToDataUri(filePath: string, signal?: AbortSignal) {
  const bytes = await readFile(filePath, { signal });
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
