import {
  existsSync,
  promises as fs,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

type ReplacementEdit = { oldText: string; newText: string };
type FileDetails = { path: string; [key: string]: unknown };
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

async function canonicalizeWithinWorkspace(cwd: string, requestedPath: string) {
  const targetPath = resolve(cwd, requestedPath);
  const realCwd = await fs.realpath(cwd);
  const missingParts: string[] = [];
  let currentPath = targetPath;
  let realTarget: string | undefined;
  while (!realTarget) {
    try {
      realTarget = join(await fs.realpath(currentPath), ...[...missingParts].reverse());
    } catch (error) {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) throw error;
      missingParts.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
  if (realTarget !== realCwd && !realTarget.startsWith(`${realCwd}${sep}`)) {
    throw new Error('Path is outside the workspace');
  }
  return realTarget;
}

async function existingPathWithinWorkspace(cwd: string, requestedPath: string) {
  const safePath = await canonicalizeWithinWorkspace(cwd, requestedPath);
  return existsSync(safePath) ? safePath : undefined;
}

async function existingPathOrNotFound<T extends FileDetails>(
  cwd: string,
  requestedPath: string,
  extraDetails: Omit<T, 'path'>,
) {
  return (
    (await existingPathWithinWorkspace(cwd, requestedPath)) ??
    fileNotFound(resolve(cwd, requestedPath), extraDetails)
  );
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
        const safePath = await canonicalizeWithinWorkspace(ctx.cwd, params.path);
        if (signal?.aborted) throw new Error('The operation was aborted');

        let output = (await fs.readdir(safePath)).sort().join('\n');
        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[LS: output truncated at 50KB]`;
        }

        return {
          content: [{ type: 'text', text: output }],
          details: { path: safePath },
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
        const safePath = await existingPathOrNotFound(ctx.cwd, params.path, {
          exists: false,
          totalLines: 0,
        });
        if (typeof safePath !== 'string') return safePath;

        const content = readFileSync(safePath, 'utf-8');
        const lines = content.endsWith('\n')
          ? content.slice(0, -1).split('\n')
          : content.split('\n');

        const startLine = params.offset ?? 0;
        const endLine =
          params.limit !== undefined
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
          details: { path: safePath, totalLines: lines.length },
        };
      } catch (error: unknown) {
        const err = error as { code?: string };
        return fileError(error, 'Read', filePath, {
          exists: err.code !== 'ENOENT',
          totalLines: 0,
        });
      }
    },
    renderCall(args, theme) {
      const range =
        args.offset !== undefined || args.limit !== undefined
          ? theme.fg(
              'muted',
              ` (from ${args.offset ?? 0}${args.limit !== undefined ? `, ${args.limit} lines` : ''})`,
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
        const safePath = await canonicalizeWithinWorkspace(ctx.cwd, params.path);
        mkdirSync(dirname(safePath), { recursive: true });
        writeFileSync(safePath, params.content, 'utf-8');
        const bytesWritten = Buffer.byteLength(params.content, 'utf8');

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${bytesWritten} bytes to ${params.path}`,
            },
          ],
          details: { path: safePath, bytesWritten },
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
      const requestedPath = params.path;
      const filePath = resolve(ctx.cwd, requestedPath);

      try {
        const safePath = await replacementPathOrNotFound(ctx.cwd, requestedPath);
        if (typeof safePath !== 'string') return safePath;

        const content = readFileSync(safePath, 'utf-8');
        if (params.old_str === '') {
          return replacementResult('StrReplace error: old_str must not be empty', safePath);
        }

        const count = content.split(params.old_str).length - 1;

        if (count === 0) {
          return replacementResult(
            `String not found in ${params.path}: "${params.old_str}"`,
            safePath,
          );
        }

        const newContent = content.replaceAll(params.old_str, () => params.new_str);
        writeFileSync(safePath, newContent, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Replaced ${count} occurrence(s) in ${params.path}`,
            },
          ],
          details: { path: safePath, replacements: count },
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
        const safePath = await replacementPathOrNotFound(ctx.cwd, params.path);
        if (typeof safePath !== 'string') return safePath;
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
            details: { path: safePath, replacements: 0 },
          };
        }
        if (params.edits.some((edit) => edit.oldText === '')) {
          return replacementResult('Edit error: oldText must not be empty', safePath);
        }

        const result = applyEdits(readFileSync(safePath, 'utf-8'), params.edits);

        if (result.replacements === 0) {
          return replacementResult(`No replacement strings found in ${params.path}`, safePath);
        }

        writeFileSync(safePath, result.content, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Applied ${result.replacements} replacement(s) in ${params.path}`,
            },
          ],
          details: { path: safePath, replacements: result.replacements },
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
        const safePath = await existingPathOrNotFound(ctx.cwd, params.path, { deleted: false });
        if (typeof safePath !== 'string') return safePath;

        unlinkSync(safePath);

        return {
          content: [{ type: 'text', text: `Successfully deleted ${params.path}` }],
          details: { path: safePath, deleted: true },
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
