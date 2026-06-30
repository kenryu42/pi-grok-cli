import { createReadToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { recordFrom } from './rendering.js';

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
  };
}
