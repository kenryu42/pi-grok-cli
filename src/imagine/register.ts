import { isAbsolute, resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { syncGrokTools } from '../provider/toolScope.js';
import { type ImagineToolScope, loadImagineConfig, saveImagineConfig } from './config.js';
import { parseImagineArgs } from './parseArgs.js';
import { imagePreview } from './preview.js';
import { registerImageGenTool } from './tool.js';
import {
  DEFAULT_IMAGINE_DEPENDENCIES,
  generateAndSaveImage,
  type ImagineDependencies,
} from './workflow.js';

const ENTRY_TYPE = 'grok-cli-imagine';

function scopeLabel(scope: ImagineToolScope) {
  return scope === 'all' ? 'all providers' : 'grok-cli only';
}

type ImagineEntry = {
  path: string;
  relativePath: string;
  previewPath?: string;
  previewError?: string;
  prompt?: string;
};
export function registerImagineFeature(
  pi: ExtensionAPI,
  dependencies: ImagineDependencies = DEFAULT_IMAGINE_DEPENDENCIES,
) {
  pi.registerEntryRenderer<ImagineEntry>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    if (!entry.data) return;
    const preview = imagePreview({
      path: entry.data.path,
      previewPath: entry.data.previewPath,
      previewError: entry.data.previewError,
      label: `Imagine ${entry.data.relativePath}`,
      theme,
    });
    if (!expanded || !entry.data.prompt) return preview;
    const container = new Container();
    container.addChild(preview);
    container.addChild(new Text(theme.fg('muted', entry.data.prompt), 0, 0));
    return container;
  });

  pi.registerCommand('grok-cli-imagine', {
    description: 'Generate an image with Grok Imagine',
    handler: async (args, ctx) => {
      try {
        const parsed = parseImagineArgs(args);
        ctx.ui.notify('Generating image…', 'info');
        const saved = await generateAndSaveImage(
          {
            ctx,
            prompt: parsed.prompt,
            aspectRatio: parsed.aspectRatio,
            resolution: parsed.resolution,
            signal: ctx.signal,
            outPath: parsed.outPath
              ? isAbsolute(parsed.outPath)
                ? parsed.outPath
                : resolve(ctx.cwd, parsed.outPath)
              : undefined,
          },
          dependencies,
        );
        pi.appendEntry<ImagineEntry>(ENTRY_TYPE, {
          path: saved.absolutePath,
          relativePath: saved.relativePath,
          previewPath: saved.previewPath,
          previewError: saved.previewError,
          prompt: parsed.prompt,
        });
        if (saved.usedFallback) {
          ctx.ui.notify(
            'Session storage unavailable; saved image in temporary storage.',
            'warning',
          );
        }
        if (saved.previewError) {
          ctx.ui.notify(`Preview unavailable: ${saved.previewError}`, 'warning');
        }
        ctx.ui.notify(`Image saved to ${saved.relativePath} (${saved.absolutePath})`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  pi.registerCommand('grok-cli-imagine:scope', {
    description: 'Set image_gen availability to grok-cli or all providers',
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value) {
        const loaded = loadImagineConfig();
        if (loaded.warning) ctx.ui.notify(loaded.warning, 'warning');
        ctx.ui.notify(`image_gen scope: ${scopeLabel(loaded.config.scope)}`, 'info');
        return;
      }
      if (value !== 'grok-cli' && value !== 'all') {
        ctx.ui.notify('Usage: /grok-cli-imagine:scope grok-cli|all', 'error');
        return;
      }
      saveImagineConfig({ scope: value });
      syncGrokTools(pi, ctx.model?.provider, value);
      ctx.ui.notify(`image_gen scope: ${scopeLabel(value)}`, 'info');
    },
  });

  registerImageGenTool(pi, dependencies);
}
