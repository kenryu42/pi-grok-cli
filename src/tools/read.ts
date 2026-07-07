import { createReadToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  argsFromRenderContext,
  currentToolDisplayConfig,
  firstText,
  previewLines,
  recordFrom,
  renderResultWithPreview,
} from './rendering.js';

type ReadInput = {
  path: string;
  offset?: number;
  limit?: number;
};

type Theme = { fg: (name: 'muted' | 'dim', text: string) => string };

function readSummary(context: unknown) {
  const args = argsFromRenderContext(context);
  const path = typeof args.path === 'string' ? args.path : stringFromUnknown(args.file_path);
  const offset = typeof args.offset === 'number' ? args.offset : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  const range = [
    offset === undefined ? undefined : `offset=${offset}`,
    limit === undefined ? undefined : `limit=${limit}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (!path) return 'Read complete';
  return range ? `Read ${path} (${range})` : `Read ${path}`;
}

function stringFromUnknown(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Cursor/Grok-trained models call a capital-`Read` tool. Rather than
 * reimplement file reading (which loses the native tool's image support,
 * byte-aware truncation, and 1-indexed offset), this registers `Read` as a
 * thin alias over pi's built-in `read` tool definition.
 *
 * The native `read` resolves paths against the `cwd` captured at construction
 * time (it does not read `ctx.cwd`), so `execute` rebuilds the definition per
 * call with the live `ctx.cwd`. The expanded result renderer delegates to the
 * native tool; the collapsed renderer shows a configurable path summary and an
 * optional short preview.
 */
export function createReadShim() {
  const native = createReadToolDefinition(process.cwd());

  return {
    ...native,
    name: 'Read',
    label: 'Read',
    prepareArguments(args: unknown): ReadInput {
      const input = recordFrom(args);
      if (!input) return { path: '' };
      const path = typeof input.path === 'string' ? input.path : input.file_path;
      return {
        path: typeof path === 'string' ? path : '',
        offset: typeof input.offset === 'number' ? input.offset : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      };
    },
    async execute(
      toolCallId: string,
      params: ReadInput,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return createReadToolDefinition(ctx.cwd).execute(
        toolCallId,
        params,
        signal,
        onUpdate as never,
        ctx,
      );
    },
    renderResult(
      result: { content: { type: string; text?: string }[] },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: unknown,
    ) {
      if (options.expanded) {
        return (
          native.renderResult?.(
            result as never,
            options as never,
            theme as never,
            context as never,
          ) ??
          renderResultWithPreview(
            result,
            options,
            theme.fg('muted', readSummary(context)),
            [],
            theme,
          )
        );
      }
      return renderResultWithPreview(
        result,
        options,
        theme.fg('muted', readSummary(context)),
        previewLines(firstText(result) ?? '', currentToolDisplayConfig().readPreviewLines),
        theme,
      );
    },
  };
}
