import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { normalizeAspectRatio } from './aspect.js';
import { imagePreview } from './preview.js';
import {
  DEFAULT_IMAGINE_DEPENDENCIES,
  generateAndSaveImage,
  type ImagineDependencies,
  type ImagineTokenResolver,
} from './workflow.js';

const ImageGenParams = Type.Object({
  prompt: Type.String({ description: 'Text description of the image to generate.' }),
  aspect_ratio: Type.Optional(
    Type.String({
      description:
        "Aspect ratio of the generated image. Defaults to 'auto'. Examples: 1:1, 16:9, 9:16, 3:2, 2:3.",
      default: 'auto',
    }),
  ),
});

type ImageGenDetails = {
  path?: string;
  relativePath?: string;
  filename?: string;
  previewPath?: string;
  previewError?: string;
  error?: string;
};

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `Image Gen error: ${message}` }],
    details: { error: message },
  };
}

export function registerImageGenTool(
  pi: ExtensionAPI,
  dependencies: ImagineDependencies = DEFAULT_IMAGINE_DEPENDENCIES,
  resolveToken?: ImagineTokenResolver,
) {
  pi.registerTool<typeof ImageGenParams, ImageGenDetails>({
    name: 'image_gen',
    label: 'Image Gen',
    description:
      "Generate a new image from a text description using Imagine; returns the saved image's absolute path. For a request for one image, call this tool exactly once. Call it multiple times only when the user explicitly requests multiple images. Do not re-read or re-display the image unless the user asks.",
    promptGuidelines: [
      'For a request for one image, call image_gen exactly once. Call it multiple times only when the user explicitly requests multiple images.',
      'Do not repeat the saved path unless the user asks for it; the image_gen result already displays a copyable path.',
    ],
    parameters: ImageGenParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const prompt = params.prompt.trim();
        if (!prompt) throw new Error('Prompt is required');
        const aspectRatio = normalizeAspectRatio(params.aspect_ratio);
        const saved = await generateAndSaveImage(
          { ctx, prompt, aspectRatio, signal },
          dependencies,
          resolveToken,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                path: saved.absolutePath,
                filename: saved.filename,
                relative_path: saved.relativePath,
                message:
                  'Image generated successfully. Do not repeat the saved path unless the user asks.',
              }),
            },
          ],
          details: {
            path: saved.absolutePath,
            relativePath: saved.relativePath,
            filename: saved.filename,
            previewPath: saved.previewPath,
            previewError: saved.previewError,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
    renderCall(args, theme) {
      const prompt = args.prompt.length > 60 ? `${args.prompt.slice(0, 57)}...` : args.prompt;
      return new Text(
        theme.fg('toolTitle', theme.bold('Image Gen ')) +
          theme.fg('accent', `"${prompt}"`) +
          theme.fg('muted', ` (${args.aspect_ratio ?? 'auto'})`),
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg('muted', 'Generating image…'), 0, 0);
      if (result.details.error) {
        return new Text(theme.fg('error', `Image Gen error: ${result.details.error}`), 0, 0);
      }
      if (!result.details.path) return new Text(theme.fg('error', 'Image path unavailable'), 0, 0);
      const displayPath =
        result.details.relativePath && result.details.relativePath !== result.details.path
          ? `${result.details.relativePath} (${result.details.path})`
          : result.details.path;
      return imagePreview({
        path: result.details.path,
        previewPath: result.details.previewPath,
        previewError: result.details.previewError,
        label: `saved ${displayPath}`,
        theme,
        showImage: context.showImages,
      });
    },
  });
}
