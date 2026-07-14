import { existsSync, promises as fs, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createWriteToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
  generateUnifiedPatch,
  type LsToolInput,
  type WriteToolInput,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {
  booleanDetail,
  fileError,
  fileNotFound,
  nativeRenderContext,
  numberDetail,
  recordFrom,
  renderResultSummary,
  stringFrom,
  text,
} from './rendering.js';

type ReplacementEdit = { oldText: string; newText: string };
type StrReplaceArgs = { path: string; old_str: string; new_str: string };
type StrReplaceDetails = {
  path: string;
  replacements: number;
  diff?: string;
  diffTruncated?: boolean;
};

type ToolTheme = {
  bold: (text: string) => string;
  fg: (name: 'accent' | 'toolTitle', text: string) => string;
};

export const STR_REPLACE_DIFF_MAX_CHARS = 26_000;
const STR_REPLACE_COLLAPSED_DIFF_MAX_CHARS = 4_000;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function replacementEdit(value: unknown): ReplacementEdit | undefined {
  const input = recordFrom(value);
  if (!input) return undefined;
  const oldText =
    stringFrom(input.oldText) ?? stringFrom(input.old_string) ?? stringFrom(input.old_str);
  const newText =
    stringFrom(input.newText) ?? stringFrom(input.new_string) ?? stringFrom(input.new_str);
  if (oldText === undefined || newText === undefined) return undefined;
  return { oldText, newText };
}

function editList(value: unknown): ReplacementEdit[] | undefined {
  const list = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(list)) return undefined;
  const edits = list.map(replacementEdit);
  if (edits.some((edit) => edit === undefined)) return undefined;
  return edits.filter((edit): edit is ReplacementEdit => edit !== undefined);
}

function normalizeWriteArgs(value: unknown): WriteToolInput {
  const input = recordFrom(value);
  return {
    path: stringFrom(input?.path) ?? stringFrom(input?.file_path) ?? '',
    content: stringFrom(input?.content) ?? stringFrom(input?.contents) ?? '',
  };
}

function normalizeLsArgs(value: unknown): LsToolInput {
  const input = recordFrom(value);
  return {
    path: stringFrom(input?.path),
    limit: typeof input?.limit === 'number' ? input.limit : undefined,
  };
}

function normalizeEditArgs(value: unknown): EditToolInput {
  const input = recordFrom(value);
  const topLevel = replacementEdit(input);
  const nested = replacementEdit(input?.strReplace);
  return {
    path: stringFrom(input?.path) ?? stringFrom(input?.file_path) ?? '',
    edits:
      editList(input?.edits) ??
      editList(recordFrom(input?.multiStrReplace)?.edits) ??
      (topLevel ? [topLevel] : undefined) ??
      (nested ? [nested] : []),
  };
}

function normalizeStrReplaceArgs(value: unknown): StrReplaceArgs {
  const input = recordFrom(value);
  return {
    path: stringFrom(input?.path) ?? '',
    old_str:
      stringFrom(input?.old_str) ??
      stringFrom(input?.old_string) ??
      stringFrom(input?.oldText) ??
      stringFrom(recordFrom(input?.strReplace)?.oldText) ??
      '',
    new_str:
      stringFrom(input?.new_str) ??
      stringFrom(input?.new_string) ??
      stringFrom(input?.newText) ??
      stringFrom(recordFrom(input?.strReplace)?.newText) ??
      '',
  };
}

function countOccurrences(content: string, search: string) {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const match = content.indexOf(search, offset);
    if (match === -1) return count;
    count += 1;
    offset = match + search.length;
  }
  return count;
}

function boundedDiff(filePath: string, before: string, after: string) {
  const fullDiff = generateUnifiedPatch(filePath, before, after);
  if (fullDiff.length <= STR_REPLACE_DIFF_MAX_CHARS) {
    return { diff: fullDiff, diffTruncated: false };
  }
  const notice = '\n[Diff truncated at 26000 characters]';
  return {
    diff: `${fullDiff.slice(0, STR_REPLACE_DIFF_MAX_CHARS - notice.length)}${notice}`,
    diffTruncated: true,
  };
}

function renderReplacementResult(
  result: { content: { type: string; text?: string }[]; details: unknown },
  expanded: boolean,
  isPartial: boolean,
  theme: {
    fg: (name: 'dim' | 'muted' | 'toolDiffAdded' | 'toolDiffRemoved', text: string) => string;
  },
) {
  const replacements = numberDetail(result, 'replacements');
  const summary =
    replacements === 0
      ? theme.fg('dim', 'No replacements')
      : theme.fg('muted', `${replacements} replacement(s)`);
  if (isPartial) return renderResultSummary(result, expanded, true, summary);
  const details = recordFrom(result.details);
  const diff = stringFrom(details?.diff);
  if (!diff) return text(summary);
  const limit = expanded ? STR_REPLACE_DIFF_MAX_CHARS : STR_REPLACE_COLLAPSED_DIFF_MAX_CHARS;
  const preview = diff.length <= limit ? diff : `${diff.slice(0, limit)}\n[Diff preview truncated]`;
  return text(
    `${summary}\n${preview
      .split('\n')
      .map((line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return theme.fg('toolDiffAdded', line);
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return theme.fg('toolDiffRemoved', line);
        }
        return line;
      })
      .join('\n')}`,
  );
}

function renderPathToolCall(toolName: string, filePath: string, theme: ToolTheme) {
  return text(theme.fg('toolTitle', theme.bold(`${toolName} `)) + theme.fg('accent', filePath));
}

type FileDetails = { path: string; [key: string]: unknown };

function existingPathOrNotFound<T extends FileDetails>(
  cwd: string,
  requestedPath: string,
  extraDetails: Omit<T, 'path'>,
) {
  const target = resolve(cwd, requestedPath);
  return existsSync(target) ? target : fileNotFound(target, extraDetails);
}

export function registerFileTools(pi: ExtensionAPI) {
  const nativeLs = createLsToolDefinition(process.cwd());
  pi.registerTool({
    ...nativeLs,
    name: 'LS',
    label: 'LS',
    prepareArguments: normalizeLsArgs,
    async execute(
      toolCallId: string,
      params: LsToolInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof nativeLs.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createLsToolDefinition(ctx.cwd).execute(
        toolCallId,
        normalizeLsArgs(params),
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof nativeLs.renderCall>>[1],
      context: Parameters<NonNullable<typeof nativeLs.renderCall>>[2],
    ) {
      const normalized = normalizeLsArgs(args);
      if (!nativeLs.renderCall) return text('');
      return nativeLs.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof nativeLs.renderResult>>[0],
      options: Parameters<NonNullable<typeof nativeLs.renderResult>>[1],
      theme: Parameters<NonNullable<typeof nativeLs.renderResult>>[2],
      context: Parameters<NonNullable<typeof nativeLs.renderResult>>[3],
    ) {
      const normalized = normalizeLsArgs(context.args);
      if (!nativeLs.renderResult) return text('');
      return nativeLs.renderResult(
        result,
        options,
        theme,
        nativeRenderContext(context, normalized),
      );
    },
  });

  const nativeWrite = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...nativeWrite,
    name: 'Write',
    label: 'Write',
    prepareArguments: normalizeWriteArgs,
    async execute(
      toolCallId: string,
      params: WriteToolInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof nativeWrite.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createWriteToolDefinition(ctx.cwd).execute(
        toolCallId,
        normalizeWriteArgs(params),
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof nativeWrite.renderCall>>[1],
      context: Parameters<NonNullable<typeof nativeWrite.renderCall>>[2],
    ) {
      const normalized = normalizeWriteArgs(args);
      if (!nativeWrite.renderCall) return text('');
      return nativeWrite.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof nativeWrite.renderResult>>[0],
      options: Parameters<NonNullable<typeof nativeWrite.renderResult>>[1],
      theme: Parameters<NonNullable<typeof nativeWrite.renderResult>>[2],
      context: Parameters<NonNullable<typeof nativeWrite.renderResult>>[3],
    ) {
      const normalized = normalizeWriteArgs(context.args);
      if (!nativeWrite.renderResult) return text('');
      return nativeWrite.renderResult(
        result,
        options,
        theme,
        nativeRenderContext(context, normalized),
      );
    },
  });

  const StrReplaceParams = Type.Object({
    path: Type.String({ description: 'Path to the file to modify' }),
    old_str: Type.String({ description: 'String to search for (exact match)' }),
    new_str: Type.String({ description: 'String to replace with' }),
  });

  pi.registerTool({
    name: 'StrReplace',
    label: 'StrReplace',
    description:
      'Replace all literal occurrences of a string in a file. old_str must not be empty.',
    parameters: StrReplaceParams,
    prepareArguments: normalizeStrReplaceArgs,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Operation aborted');
      if (params.old_str === '') throw new Error('old_str must not be empty');
      const filePath = resolve(ctx.cwd, params.path);
      return withFileMutationQueue(filePath, async () => {
        if (signal?.aborted) throw new Error('Operation aborted');
        const content = await fs.readFile(filePath, 'utf8');
        if (signal?.aborted) throw new Error('Operation aborted');
        const replacements = countOccurrences(content, params.old_str);
        if (replacements === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `String not found in ${params.path}: "${params.old_str}"`,
              },
            ],
            details: { path: filePath, replacements: 0 },
          };
        }

        const nextContent = content.replaceAll(params.old_str, () => params.new_str);
        const diff = boundedDiff(params.path, content, nextContent);
        if (signal?.aborted) throw new Error('Operation aborted');
        await fs.writeFile(filePath, nextContent, 'utf8');
        if (signal?.aborted) throw new Error('Operation aborted');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Replaced ${replacements} occurrence(s) in ${params.path}`,
            },
          ],
          details: { path: filePath, replacements, ...diff } satisfies StrReplaceDetails,
        };
      });
    },
    renderCall(args, theme) {
      return renderPathToolCall('StrReplace', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderReplacementResult(result, expanded, isPartial, theme);
    },
  });

  const nativeEdit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...nativeEdit,
    name: 'Edit',
    label: 'Edit',
    description:
      'Modify a file with exact text replacements. Every oldText must identify one unique, non-overlapping region in the original file. Use StrReplace for replace-all.',
    prepareArguments: normalizeEditArgs,
    async execute(
      toolCallId: string,
      params: EditToolInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof nativeEdit.execute>[3],
      ctx: ExtensionContext,
    ) {
      return createEditToolDefinition(ctx.cwd).execute(
        toolCallId,
        normalizeEditArgs(params),
        signal,
        onUpdate,
        ctx,
      );
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof nativeEdit.renderCall>>[1],
      context: Parameters<NonNullable<typeof nativeEdit.renderCall>>[2],
    ) {
      const normalized = normalizeEditArgs(args);
      if (!nativeEdit.renderCall) return text('');
      return nativeEdit.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof nativeEdit.renderResult>>[0],
      options: Parameters<NonNullable<typeof nativeEdit.renderResult>>[1],
      theme: Parameters<NonNullable<typeof nativeEdit.renderResult>>[2],
      context: Parameters<NonNullable<typeof nativeEdit.renderResult>>[3],
    ) {
      const normalized = normalizeEditArgs(context.args);
      if (!nativeEdit.renderResult) return text('');
      return nativeEdit.renderResult(
        result,
        options,
        theme,
        nativeRenderContext(context, normalized),
      );
    },
  });

  const DeleteParams = Type.Object({
    path: Type.String({ description: 'Path to the file to delete' }),
  });

  pi.registerTool({
    name: 'Delete',
    label: 'Delete',
    description: 'Delete a file from the filesystem.',
    parameters: DeleteParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);

      try {
        const resolved = existingPathOrNotFound(ctx.cwd, params.path, { deleted: false });
        if (typeof resolved !== 'string') return resolved;
        unlinkSync(resolved);
        return {
          content: [{ type: 'text', text: `Successfully deleted ${params.path}` }],
          details: { path: resolved, deleted: true },
        };
      } catch (error: unknown) {
        return fileError(error, 'Delete', filePath, { deleted: false });
      }
    },
    renderCall(args, theme) {
      return renderPathToolCall('Delete', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderResultSummary(
        result,
        expanded,
        isPartial,
        booleanDetail(result, 'deleted')
          ? theme.fg('muted', 'Deleted')
          : theme.fg('error', 'Not deleted'),
      );
    },
  });
}
