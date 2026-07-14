import { Type } from '@earendil-works/pi-ai';
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type GrepToolInput,
} from '@earendil-works/pi-coding-agent';
import { executeGlob, normalizeGlobArgs } from './glob.js';
import { nativeRenderContext, recordFrom, stringFrom, text } from './rendering.js';

function normalizeGrepArgs(value: unknown): GrepToolInput {
  const input = recordFrom(value);
  return {
    pattern: stringFrom(input?.pattern) ?? stringFrom(input?.query) ?? '',
    path: stringFrom(input?.path),
    glob: stringFrom(input?.glob) ?? stringFrom(input?.include) ?? stringFrom(input?.glob_filter),
    ignoreCase:
      typeof input?.ignoreCase === 'boolean'
        ? input.ignoreCase
        : typeof input?.ignore_case === 'boolean'
          ? input.ignore_case
          : undefined,
    literal: typeof input?.literal === 'boolean' ? input.literal : undefined,
    context: typeof input?.context === 'number' ? input.context : undefined,
    limit: typeof input?.limit === 'number' ? input.limit : undefined,
  };
}

export function registerSearchTools(pi: ExtensionAPI) {
  const nativeGrep = createGrepToolDefinition(process.cwd());
  pi.registerTool({
    ...nativeGrep,
    name: 'Grep',
    label: 'Grep',
    prepareArguments: normalizeGrepArgs,
    async execute(
      toolCallId: string,
      params: GrepToolInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof nativeGrep.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createGrepToolDefinition(ctx.cwd).execute(
        toolCallId,
        normalizeGrepArgs(params),
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof nativeGrep.renderCall>>[1],
      context: Parameters<NonNullable<typeof nativeGrep.renderCall>>[2],
    ) {
      const normalized = normalizeGrepArgs(args);
      if (!nativeGrep.renderCall) return text('');
      return nativeGrep.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof nativeGrep.renderResult>>[0],
      options: Parameters<NonNullable<typeof nativeGrep.renderResult>>[1],
      theme: Parameters<NonNullable<typeof nativeGrep.renderResult>>[2],
      context: Parameters<NonNullable<typeof nativeGrep.renderResult>>[3],
    ) {
      const normalized = normalizeGrepArgs(context.args);
      if (!nativeGrep.renderResult) return text('');
      return nativeGrep.renderResult(
        result,
        options,
        theme,
        nativeRenderContext(context, normalized),
      );
    },
  });

  const GlobParams = Type.Object({
    pattern: Type.String({
      description: 'Glob pattern to match files (e.g. **/*.ts, src/**/*.json)',
    }),
    path: Type.Optional(
      Type.String({
        description: 'Directory to search within. Defaults to current working directory.',
      }),
    ),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of files to return.' })),
  });
  const nativeFind = createFindToolDefinition(process.cwd());
  pi.registerTool({
    name: 'Glob',
    label: 'Glob',
    description:
      'Find files matching a glob pattern, newest first. Returns workspace-relative or absolute paths.',
    parameters: GlobParams,
    prepareArguments: normalizeGlobArgs,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeGlob(normalizeGlobArgs(params), ctx.cwd, signal);
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof nativeFind.renderCall>>[1],
      context: Parameters<NonNullable<typeof nativeFind.renderCall>>[2],
    ) {
      const normalized = normalizeGlobArgs(args);
      if (!nativeFind.renderCall) return text('');
      return nativeFind.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof nativeFind.renderResult>>[0],
      options: Parameters<NonNullable<typeof nativeFind.renderResult>>[1],
      theme: Parameters<NonNullable<typeof nativeFind.renderResult>>[2],
      context: Parameters<NonNullable<typeof nativeFind.renderResult>>[3],
    ) {
      const normalized = normalizeGlobArgs(context.args);
      if (!nativeFind.renderResult) return text('');
      return nativeFind.renderResult(
        result,
        options,
        theme,
        nativeRenderContext(context, normalized),
      );
    },
  });
}
