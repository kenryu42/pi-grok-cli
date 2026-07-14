import { createReadToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { nativeRenderContext, recordFrom, text } from './rendering.js';

type ReadInput = {
  path: string;
  offset?: number;
  limit?: number;
};

/**
 * Cursor/Grok-trained models call a capital-`Read` tool. Rather than
 * reimplement file reading (which loses the native tool's image support,
 * byte-aware truncation, and 1-indexed offset), this registers `Read` as a
 * thin alias over pi's built-in `read` tool definition.
 *
 * The native `read` resolves paths against the `cwd` captured at construction
 * time (it does not read `ctx.cwd`), so `execute` rebuilds the definition per
 * call with the live `ctx.cwd`. Everything else — `parameters`, `description`,
 * `renderCall`, `renderResult`, prompt guidance — is delegated to the native
 * tool; only `name`/`label`/`prepareArguments` differ.
 */
export function createReadShim() {
  const native = createReadToolDefinition(process.cwd());

  const normalize = (args: unknown): ReadInput => {
    const input = recordFrom(args);
    if (!input) return { path: '' };
    const path = typeof input.path === 'string' ? input.path : input.file_path;
    return {
      path: typeof path === 'string' ? path : '',
      offset: typeof input.offset === 'number' ? input.offset : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    };
  };

  return {
    ...native,
    name: 'Read',
    label: 'Read',
    prepareArguments: normalize,
    async execute(
      toolCallId: string,
      params: ReadInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof native.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof native.renderCall>>[1],
      context: Parameters<NonNullable<typeof native.renderCall>>[2],
    ) {
      const normalized = normalize(args);
      if (!native.renderCall) return text('');
      return native.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof native.renderResult>>[0],
      options: Parameters<NonNullable<typeof native.renderResult>>[1],
      theme: Parameters<NonNullable<typeof native.renderResult>>[2],
      context: Parameters<NonNullable<typeof native.renderResult>>[3],
    ) {
      const normalized = normalize(context.args);
      if (!native.renderResult) return text('');
      return native.renderResult(result, options, theme, nativeRenderContext(context, normalized));
    },
  };
}
