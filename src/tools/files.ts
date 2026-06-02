import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  booleanDetail,
  detailRecord,
  fileError,
  fileNotFound,
  MAX_OUTPUT_CHARS,
  numberDetail,
  recordFrom,
  renderResultSummary,
  stringDetail,
  stringFrom,
  type ToolError,
  text,
} from './rendering.js';

const execFileAsync = promisify(execFile);

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
  fg: (name: 'accent' | 'toolTitle', text: string) => string;
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

function renderReplacementResult(
  result: { content: { type: string; text?: string }[]; details: unknown },
  expanded: boolean,
  isPartial: boolean,
  theme: { fg: (name: 'dim' | 'muted', text: string) => string },
) {
  const replacements = numberDetail(result, 'replacements');
  return renderResultSummary(
    result,
    expanded,
    isPartial,
    replacements === 0
      ? theme.fg('dim', 'No replacements')
      : theme.fg('muted', `${replacements} replacement(s)`),
  );
}

function renderPathToolCall(toolName: string, filePath: string, theme: ToolTheme) {
  return text(theme.fg('toolTitle', theme.bold(`${toolName} `)) + theme.fg('accent', filePath));
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
        const { stdout } = await execFileAsync('ls', ['-la', targetPath], {
          cwd: ctx.cwd,
          maxBuffer: MAX_OUTPUT_CHARS * 2,
          signal,
        });

        let output = stdout.trim();
        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[LS: output truncated at 50KB]`;
        }

        return {
          content: [{ type: 'text', text: output }],
          details: { path: targetPath },
        };
      } catch (error: unknown) {
        const err = error as ToolError;
        return {
          content: [
            {
              type: 'text',
              text: `LS error: ${err.message ?? 'Unknown error'}`,
            },
          ],
          details: { path: targetPath },
        };
      }
    },
    renderCall(args, theme) {
      return renderPathToolCall('LS', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderResultSummary(
        result,
        expanded,
        isPartial,
        theme.fg('muted', stringDetail(result, 'path')),
      );
    },
  });

  // ── Read tool ────────────────────────────────────────────────────────

  const ReadParams = Type.Object({
    path: Type.String({
      description: 'Path to the file to read',
    }),
    offset: Type.Optional(
      Type.Number({
        description: 'Line number to start reading from (0-indexed)',
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: 'Maximum number of lines to read',
      }),
    ),
  });

  pi.registerTool({
    name: 'Read',
    label: 'Read',
    description: 'Read the contents of a file. Returns the file content with line numbers.',
    parameters: ReadParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);

      try {
        if (!existsSync(filePath)) {
          return fileNotFound(filePath, { exists: false, totalLines: 0 });
        }

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        const startLine = params.offset ?? 0;
        const endLine = params.limit
          ? Math.min(startLine + params.limit, lines.length)
          : Math.min(startLine + 2000, lines.length);

        const selectedLines = lines.slice(startLine, endLine);
        const numberedLines = selectedLines.map((line, i) => `${startLine + i + 1}\t${line}`);

        let output = numberedLines.join('\n');
        if (endLine < lines.length) {
          output += `\n\n[Showing lines ${startLine + 1}-${endLine} of ${lines.length} total lines. Use offset to see more.]`;
        }

        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
        }

        return {
          content: [{ type: 'text', text: output }],
          details: { path: filePath, totalLines: lines.length },
        };
      } catch (error: unknown) {
        return fileError(error, 'Read', filePath, {
          exists: false,
          totalLines: 0,
        });
      }
    },
    renderCall(args, theme) {
      const range =
        args.offset !== undefined || args.limit !== undefined
          ? theme.fg(
              'muted',
              ` (from ${args.offset ?? 0}${args.limit ? `, ${args.limit} lines` : ''})`,
            )
          : '';
      return text(
        theme.fg('toolTitle', theme.bold('Read ')) + theme.fg('accent', args.path) + range,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderResultSummary(
        result,
        expanded,
        isPartial,
        detailRecord(result).exists === false
          ? theme.fg('error', 'File not found')
          : theme.fg('muted', `${numberDetail(result, 'totalLines')} line(s)`),
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

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
            },
          ],
          details: { path: filePath, bytesWritten: params.content.length },
        };
      } catch (error: unknown) {
        const err = error as ToolError;
        return {
          content: [
            {
              type: 'text',
              text: `Write error: ${err.message ?? 'Unknown error'}`,
            },
          ],
          details: { path: filePath, bytesWritten: 0 },
        };
      }
    },
    renderCall(args, theme) {
      return renderPathToolCall('Write', args.path, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderResultSummary(
        result,
        expanded,
        isPartial,
        theme.fg('muted', `${numberDetail(result, 'bytesWritten')} bytes written`),
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
      const filePath = resolve(ctx.cwd, params.path);

      try {
        if (!existsSync(filePath)) {
          return fileNotFound(filePath, { replacements: 0 });
        }

        const content = readFileSync(filePath, 'utf-8');
        if (params.old_str === '') {
          return replacementResult('StrReplace error: old_str must not be empty', filePath);
        }

        const count = content.split(params.old_str).length - 1;

        if (count === 0) {
          return replacementResult(
            `String not found in ${params.path}: "${params.old_str}"`,
            filePath,
          );
        }

        const newContent = content.replaceAll(params.old_str, () => params.new_str);
        writeFileSync(filePath, newContent, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Replaced ${count} occurrence(s) in ${params.path}`,
            },
          ],
          details: { path: filePath, replacements: count },
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

      if (!existsSync(filePath)) {
        return fileNotFound(filePath, { replacements: 0 });
      }

      try {
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
            details: { path: filePath, replacements: 0 },
          };
        }
        if (params.edits.some((edit) => edit.oldText === '')) {
          return replacementResult('Edit error: oldText must not be empty', filePath);
        }

        const result = applyEdits(readFileSync(filePath, 'utf-8'), params.edits);

        if (result.replacements === 0) {
          return replacementResult(`No replacement strings found in ${params.path}`, filePath);
        }

        writeFileSync(filePath, result.content, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Applied ${result.replacements} replacement(s) in ${params.path}`,
            },
          ],
          details: { path: filePath, replacements: result.replacements },
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
        if (!existsSync(filePath)) {
          return fileNotFound(filePath, { deleted: false });
        }

        unlinkSync(filePath);

        return {
          content: [{ type: 'text', text: `Successfully deleted ${params.path}` }],
          details: { path: filePath, deleted: true },
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
