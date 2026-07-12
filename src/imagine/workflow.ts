import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { convertToPng } from '@earendil-works/pi-coding-agent';
import { IMAGINE_AUTH_ERROR, resolveImagineToken } from './auth.js';
import { generateImage } from './generate.js';
import { saveImage, savePreviewImage } from './save.js';

export type ImagineDependencies = {
  generateImage: typeof generateImage;
  convertToPng: typeof convertToPng;
  saveImage: typeof saveImage;
  savePreviewImage: typeof savePreviewImage;
};

export const DEFAULT_IMAGINE_DEPENDENCIES: ImagineDependencies = {
  generateImage,
  convertToPng,
  saveImage,
  savePreviewImage,
};

export type SavedImagineImage = Awaited<ReturnType<typeof saveImage>> & {
  previewPath?: string;
  previewError?: string;
};

export async function generateAndSaveImage(
  options: {
    ctx: ExtensionContext;
    prompt: string;
    aspectRatio: string;
    resolution?: string;
    signal?: AbortSignal;
    outPath?: string;
  },
  dependencies: ImagineDependencies,
): Promise<SavedImagineImage> {
  const token = await resolveImagineToken(options.ctx);
  if (!token) throw new Error(IMAGINE_AUTH_ERROR);
  const generated = await dependencies.generateImage({
    token,
    prompt: options.prompt,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    signal: options.signal,
  });
  const persisted = options.ctx.sessionManager.getSessionFile() !== undefined;
  const saved = await dependencies.saveImage({
    b64: generated.b64,
    sessionDir: persisted ? options.ctx.sessionManager.getSessionDir() : undefined,
    sessionId: persisted ? options.ctx.sessionManager.getSessionId() : undefined,
    outPath: options.outPath,
  });
  try {
    const preview = await dependencies.convertToPng(generated.b64, generated.mimeType);
    if (preview?.mimeType !== 'image/png') {
      throw new Error('PNG preview conversion unavailable');
    }
    return {
      ...saved,
      previewPath: await dependencies.savePreviewImage({
        b64: preview.data,
        absolutePath: saved.absolutePath,
        filename: saved.filename,
        sessionDir: persisted ? options.ctx.sessionManager.getSessionDir() : undefined,
        sessionId: persisted ? options.ctx.sessionManager.getSessionId() : undefined,
        outPath: options.outPath,
      }),
    };
  } catch (error) {
    return {
      ...saved,
      previewError: error instanceof Error ? error.message : String(error),
    };
  }
}
