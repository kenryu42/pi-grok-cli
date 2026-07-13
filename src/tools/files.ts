import {
  existsSync,
  promises as fs,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  booleanDetail,
  currentToolDisplayConfig,
  fileError,
  fileNotFound,
  firstText,
  MAX_OUTPUT_CHARS,
  numberDetail,
  previewLines,
  recordFrom,
  renderResultSummary,
  renderResultWithPreview,
  stringDetail,
  stringFrom,
  type ToolError,
  text,
} from './rendering.js';

type ReplacementEdit = { oldText: string; newText: string };
type WriteArgs = { path: string; content: string };
type StrReplaceArgs = { path: string; old_str: string; new_str: string };
type EditArgs = {
  path: string;
  edits?: ReplacementEdit[];
  applyPatch?: { patchContent: string };
  strReplace?: ReplacementEdit;
  multiStrReplace?: { edits: ReplacementEdit[] };
};

type ToolTheme = {
  bold: (text: string) => string;
  fg: (
    name:
      | 'accent'
      | 'dim'
      | 'error'
      | 'muted'
      | 'toolDiffAdded'
      | 'toolDiffContext'
      | 'toolDiffRemoved'
      | 'toolTitle',
    text: string,
  ) => string;
};

function parseEditList(value: unknown): ReplacementEdit[] | undefined {
  const editList = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(editList)) return undefined;
  if (
    !editList.every(
      (edit) =>
        typeof recordFrom(edit)?.oldText === 'string' &&
        typeof recordFrom(edit)?.newText === 'string',
    )
  ) {
    return undefined;
  }
  return editList.map((edit) => ({
    oldText: stringFrom(recordFrom(edit)?.oldText) ?? '',
    newText: stringFrom(recordFrom(edit)?.newText) ?? '',
  }));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function editFromText(oldText: unknown, newText: unknown) {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
  return [{ oldText, newText }];
}

function editsFromArgs(input: Record<string, unknown>) {
  return (
    parseEditList(input.edits) ??
    parseEditList(recordFrom(input.multiStrReplace)?.edits) ??
    editFromText(input.oldText, input.newText) ??
    editFromText(recordFrom(input.strReplace)?.oldText, recordFrom(input.strReplace)?.newText)
  );
}

function applyEdits(content: string, edits: ReplacementEdit[]) {
  return edits.reduce(
    (result, edit) => {
      const count = result.content.split(edit.oldText).length - 1;
      return {
        content:
          count === 0
            ? result.content
            : result.content.replaceAll(edit.oldText, () => edit.newText),
        replacements: result.replacements + count,
      };
    },
    { content, replacements: 0 },
  );
}

function replacementResult(text: string, filePath: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { path: filePath, replacements: 0 },
  };
}

function replacementSummary(replacements: number) {
  if (replacements === 0) return 'No replacements';
  return `${replacements} ${replacements === 1 ? 'replacement' : 'replacements'}`;
}

function splitDisplayLines(value: string) {
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function generateDisplayDiff(oldContent: string, newContent: string, contextLines = 2) {
  if (oldContent === newContent) return '';
  const oldLines = splitDisplayLines(oldContent);
  const newLines = splitDisplayLines(newContent);

  // Equal-length edits (typical replaceAll on whole lines): emit separate hunks so
  // unchanged lines between replacements stay context instead of one giant replace span.
  if (oldLines.length === newLines.length) {
    const changed = oldLines.flatMap((line, index) => (line === newLines[index] ? [] : [index]));
    if (changed.length === 0) return '';

    const show = new Set(
      changed.flatMap((index) =>
        Array.from(
          {
            length:
              Math.min(oldLines.length - 1, index + contextLines) -
              Math.max(0, index - contextLines) +
              1,
          },
          (_, offset) => Math.max(0, index - contextLines) + offset,
        ),
      ),
    );

    return [...show]
      .sort((a, b) => a - b)
      .flatMap((index, position, indices) => {
        const gap = position > 0 && index > (indices[position - 1] ?? index) + 1 ? ['...'] : [];
        if (oldLines[index] !== newLines[index]) {
          return [...gap, `-${index + 1} ${oldLines[index]}`, `+${index + 1} ${newLines[index]}`];
        }
        return [...gap, ` ${index + 1} ${oldLines[index]}`];
      })
      .join('\n');
  }

  // Unequal line counts: fall back to a single prefix/suffix span.
  const firstChanged = oldLines.findIndex((line, index) => line !== newLines[index]);
  const changeStart =
    firstChanged === -1 ? Math.min(oldLines.length, newLines.length) : firstChanged;
  const maxSuffix = Math.min(oldLines.length - changeStart, newLines.length - changeStart);
  const commonSuffix = Array.from({ length: maxSuffix }).findIndex(
    (_, index) => oldLines.at(-index - 1) !== newLines.at(-index - 1),
  );
  const suffixLength = commonSuffix === -1 ? maxSuffix : commonSuffix;
  const oldChangeEnd = oldLines.length - suffixLength;
  const newChangeEnd = newLines.length - suffixLength;
  const beforeStart = Math.max(0, changeStart - contextLines);
  const afterEnd = Math.min(oldLines.length, oldChangeEnd + contextLines);

  return [
    ...oldLines
      .slice(beforeStart, changeStart)
      .map((line, index) => ` ${beforeStart + index + 1} ${line}`),
    ...oldLines
      .slice(changeStart, oldChangeEnd)
      .map((line, index) => `-${changeStart + index + 1} ${line}`),
    ...newLines
      .slice(changeStart, newChangeEnd)
      .map((line, index) => `+${changeStart + index + 1} ${line}`),
    ...oldLines
      .slice(oldChangeEnd, afterEnd)
      .map((line, index) => ` ${oldChangeEnd + index + 1} ${line}`),
  ].join('\n');
}

function renderDisplayDiff(diff: string, theme: ToolTheme) {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+')) return theme.fg('toolDiffAdded', line);
      if (line.startsWith('-')) return theme.fg('toolDiffRemoved', line);
      return theme.fg('toolDiffContext', line);
    })
    .join('\n');
}

function renderReplacementResult(
  result: { content: { type: string; text?: string }[]; details: unknown },
  expanded: boolean,
  isPartial: boolean,
  theme: ToolTheme,
) {
  const replacements = numberDetail(result, 'replacements');
  const summary =
    replacements === 0
      ? theme.fg('dim', replacementSummary(replacements))
      : theme.fg('muted', replacementSummary(replacements));
  const diff = stringDetail(result, 'diff');
  if (isPartial || replacements === 0 || !diff) {
    return renderResultSummary(result, expanded, isPartial, summary);
  }
  return text(`${renderDisplayDiff(diff, theme)}\n\n${summary}`);
}

function renderPathToolCall(toolName: string, filePath: string, theme: ToolTheme) {
  return text(theme.fg('toolTitle', theme.bold(`${toolName} `)) + theme.fg('accent', filePath));
}

function writeCallPreviewLines(value: string, limit: number) {
  if (limit <= 0) return [];
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = normalized.at(-1) === '' ? normalized.slice(0, -1) : normalized;
  if (lines.length <= limit) return lines;
  return [
    ...lines.slice(0, limit),
    `... (${lines.length - limit} more lines, ${lines.length} total)`,
  ];
}

function renderWriteToolCall(
  args: Record<string, unknown>,
  theme: ToolTheme,
  context?: { expanded?: boolean },
) {
  const call =
    theme.fg('toolTitle', theme.bold('Write ')) + theme.fg('accent', stringFrom(args.path) ?? '');
  const content = stringFrom(args.content) ?? stringFrom(args.contents);
  if (!content) return text(call);
  const lines = writeCallPreviewLines(
    content,
    context?.expanded ? Number.MAX_SAFE_INTEGER : currentToolDisplayConfig().writeCallPreviewLines,
  );
  if (lines.length === 0) return text(call);
  return text(`${call}\n\n${theme.fg('dim', lines.join('\n'))}`);
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

function replacementPathOrNotFound(cwd: string, requestedPath: string) {
  return existingPathOrNotFound(cwd, requestedPath, { replacements: 0 });
}

export function registerFileTools(pi: ExtensionAPI) {
  // ── LS tool ──────────────────────────────────────────────────────────

  const LsParams = Type.Object({
    path: Type.String({
      description: 'Directory path to list',
    }),
  });

  pi.registerTool({
    name: 'LS',
    label: 'LS',
    description: 'List the contents of a directory, including hidden files.',
    parameters: LsParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const targetPath = resolve(ctx.cwd, params.path);

      try {
        if (signal?.aborted) throw new Error('The operation was aborted');

        let output = (await fs.readdir(targetPath)).sort().join('\n');
        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[LS: output truncated at 50KB]`;
        }

        return {
          content: [{ type: 'text', text: output }],
          details: { path: targetPath },
        };
      } catch (error: unknown) {
        const err = error as ToolError;
        const message = err.message ?? 'Unknown error';
        return {
          content: [
            {
              type: 'text',
              text: `LS error: ${message}`,
            },
          ],
          details: { path: targetPath, failed: true, error: message },
        };
      }
    },
    renderCall(args, theme) {
      return renderPathToolCall('LS', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderResultWithPreview(
        result,
        { expanded, isPartial },
        theme.fg('muted', stringDetail(result, 'path')),
        previewLines(firstText(result) ?? '', currentToolDisplayConfig().lsPreviewEntries),
        theme,
      );
    },
  });

  // ── Write tool ───────────────────────────────────────────────────────

  const WriteParams = Type.Object({
    path: Type.String({
      description: 'Path to the file to write',
    }),
    content: Type.String({
      description: 'Content to write to the file',
    }),
  });

  pi.registerTool({
    name: 'Write',
    label: 'Write',
    description:
      'Create or overwrite a file with the given content. Creates parent directories if needed.',
    parameters: WriteParams,

    prepareArguments(args) {
      const input = recordFrom(args);
      if (!input) return args as WriteArgs;
      return {
        ...input,
        content: stringFrom(input.content) ?? stringFrom(input.contents),
      } as WriteArgs;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);

      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, params.content, 'utf-8');
        const bytesWritten = Buffer.byteLength(params.content, 'utf8');

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${bytesWritten} bytes to ${params.path}`,
            },
          ],
          details: { path: filePath, bytesWritten },
        };
      } catch (error: unknown) {
        const err = error as ToolError;
        const message = err.message ?? 'Unknown error';
        return {
          content: [
            {
              type: 'text',
              text: `Write error: ${message}`,
            },
          ],
          details: { path: filePath, bytesWritten: 0, failed: true, error: message },
        };
      }
    },
    renderCall(args, theme, context) {
      return renderWriteToolCall(args, theme, context);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return text('Running...');
      // Match native pi write: successful results stay empty in both collapsed and
      // expanded views. Written content is shown on renderCall; result is for errors.
      if (!booleanDetail(result, 'failed') && recordFrom(context)?.isError !== true)
        return text('');
      return renderResultSummary(
        result,
        expanded,
        false,
        theme.fg('error', firstText(result) ?? 'Write failed'),
      );
    },
  });

  // ── StrReplace tool ──────────────────────────────────────────────────

  const StrReplaceParams = Type.Object({
    path: Type.String({
      description: 'Path to the file to modify',
    }),
    old_str: Type.String({
      description: 'String to search for (exact match)',
    }),
    new_str: Type.String({
      description: 'String to replace with',
    }),
  });

  pi.registerTool({
    name: 'StrReplace',
    label: 'StrReplace',
    description:
      'Replace all occurrences of a string in a file. The old_str must be an exact match.',
    parameters: StrReplaceParams,

    prepareArguments(args) {
      const input = recordFrom(args);
      if (!input) return args as StrReplaceArgs;
      return {
        ...input,
        old_str:
          stringFrom(input.old_str) ??
          stringFrom(input.old_string) ??
          stringFrom(input.oldText) ??
          stringFrom(recordFrom(input.strReplace)?.oldText),
        new_str:
          stringFrom(input.new_str) ??
          stringFrom(input.new_string) ??
          stringFrom(input.newText) ??
          stringFrom(recordFrom(input.strReplace)?.newText),
      } as StrReplaceArgs;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requestedPath = params.path;
      const filePath = resolve(ctx.cwd, requestedPath);

      try {
        const resolved = replacementPathOrNotFound(ctx.cwd, requestedPath);
        if (typeof resolved !== 'string') return resolved;

        const content = readFileSync(resolved, 'utf-8');
        if (params.old_str === '') {
          return replacementResult('StrReplace error: old_str must not be empty', resolved);
        }

        const count = content.split(params.old_str).length - 1;

        if (count === 0) {
          return replacementResult(
            `String not found in ${params.path}: "${params.old_str}"`,
            resolved,
          );
        }

        const newContent = content.replaceAll(params.old_str, () => params.new_str);
        writeFileSync(resolved, newContent, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Replaced ${count} occurrence(s) in ${params.path}`,
            },
          ],
          details: {
            path: resolved,
            replacements: count,
            diff: generateDisplayDiff(content, newContent),
          },
        };
      } catch (error: unknown) {
        return fileError(error, 'StrReplace', filePath, { replacements: 0 });
      }
    },
    renderCall(args, theme) {
      return renderPathToolCall('StrReplace', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderReplacementResult(result, expanded, isPartial, theme);
    },
  });

  // ── Edit tool ────────────────────────────────────────────────────────

  const EditItemParams = Type.Object({
    oldText: Type.String({
      description: 'String to search for (exact match)',
    }),
    newText: Type.String({
      description: 'String to replace with',
    }),
    replaceAll: Type.Optional(
      Type.Boolean({
        description:
          'Accepted for Cursor compatibility. Replacements are always applied to all matches.',
      }),
    ),
  });

  const EditParams = Type.Object({
    path: Type.String({
      description: 'Path to the file to modify',
    }),
    edits: Type.Optional(
      Type.Array(EditItemParams, {
        description: 'Exact text replacements to apply sequentially',
      }),
    ),
    applyPatch: Type.Optional(
      Type.Object({
        patchContent: Type.String({
          description: 'Unsupported unified patch content',
        }),
      }),
    ),
    strReplace: Type.Optional(EditItemParams),
    multiStrReplace: Type.Optional(
      Type.Object({
        edits: Type.Array(EditItemParams),
      }),
    ),
  });

  pi.registerTool({
    name: 'Edit',
    label: 'Edit',
    description:
      'Modify a file with exact text replacement. applyPatch is not supported by this Grok tool shim.',
    parameters: EditParams,

    prepareArguments(args) {
      const input = recordFrom(args);
      if (!input) return args as EditArgs;
      return {
        ...input,
        edits: editsFromArgs(input),
      } as EditArgs;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);

      try {
        const resolved = replacementPathOrNotFound(ctx.cwd, params.path);
        if (typeof resolved !== 'string') return resolved;
        if (!params.edits?.length) {
          return {
            content: [
              {
                type: 'text',
                text: params.applyPatch
                  ? 'Edit error: applyPatch is not supported by this Grok tool shim'
                  : 'Edit error: provide at least one exact text replacement',
              },
            ],
            details: { path: resolved, replacements: 0 },
          };
        }
        if (params.edits.some((edit) => edit.oldText === '')) {
          return replacementResult('Edit error: oldText must not be empty', resolved);
        }

        const result = applyEdits(readFileSync(resolved, 'utf-8'), params.edits);

        if (result.replacements === 0) {
          return replacementResult(`No replacement strings found in ${params.path}`, resolved);
        }

        writeFileSync(resolved, result.content, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Applied ${result.replacements} replacement(s) in ${params.path}`,
            },
          ],
          details: { path: resolved, replacements: result.replacements },
        };
      } catch (error: unknown) {
        return fileError(error, 'Edit', filePath, { replacements: 0 });
      }
    },
    renderCall(args, theme) {
      return renderPathToolCall('Edit', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderReplacementResult(result, expanded, isPartial, theme);
    },
  });

  // ── Delete tool ──────────────────────────────────────────────────────

  const DeleteParams = Type.Object({
    path: Type.String({
      description: 'Path to the file to delete',
    }),
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
