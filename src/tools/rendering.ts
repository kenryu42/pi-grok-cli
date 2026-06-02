import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { Text } from '@earendil-works/pi-tui';

const execFileAsync = promisify(execFile);

export const MAX_OUTPUT_CHARS = 50_000;
export const MAX_OUTPUT_BYTES = MAX_OUTPUT_CHARS * 4 + 1024;
export const MAX_LINES = 500;

export function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

export function stringFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value;
}

export function truncateLines(lines: string[]): string {
  if (lines.length > MAX_LINES) {
    return (
      lines.slice(0, MAX_LINES).join('\n') +
      `\n\n[Showing first ${MAX_LINES} of ${lines.length} results. Refine your pattern to narrow results.]`
    );
  }
  return lines.join('\n');
}

export function truncateChars(output: string): string {
  if (output.length > MAX_OUTPUT_CHARS) {
    return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
  }
  return output;
}

export function globToRegExp(pattern: string) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*' && pattern[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

export function normalizePath(filePath: string) {
  return filePath.replaceAll('\\', '/');
}

export async function listFilesRecursive(
  searchPath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw new Error('The operation was aborted');
  const stats = await fs.stat(searchPath);
  if (stats.isFile()) return [searchPath];
  if (!stats.isDirectory()) return [];

  return (
    await Promise.all(
      (
        await fs.readdir(searchPath, { withFileTypes: true })
      ).map((entry) => {
        const entryPath = join(searchPath, entry.name);
        if (entry.isDirectory()) return listFilesRecursive(entryPath, signal);
        if (entry.isFile()) return [entryPath];
        return [];
      }),
    )
  ).flat();
}

let rgAvailable: boolean | undefined;
export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable;
  try {
    await execFileAsync('rg', ['--version']);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

export type ToolError = { code?: number; message?: string };
export type ToolResult<T> = {
  content: [{ type: 'text'; text: string }];
  details: T;
};

export function text(text: string): Text {
  return new Text(text, 0, 0);
}

function firstText(result: { content: { type: string; text?: string }[] }) {
  const first = result.content[0];
  if (first?.type !== 'text') return undefined;
  return first.text;
}

export function renderResultText(
  result: { content: { type: string; text?: string }[] },
  expanded: boolean,
  summary: string,
): Text {
  if (expanded) return text(firstText(result) ?? summary);
  return text(summary);
}

export function renderRunning(isPartial: boolean): Text | undefined {
  if (!isPartial) return undefined;
  return text('Running...');
}

export function renderResultSummary(
  result: { content: { type: string; text?: string }[] },
  expanded: boolean,
  isPartial: boolean,
  summary: string,
): Text {
  const running = renderRunning(isPartial);
  if (running) return running;
  return renderResultText(result, expanded, summary);
}

export function detailRecord(result: { details: unknown }): Record<string, unknown> {
  if (!result.details || typeof result.details !== 'object') return {};
  return result.details as Record<string, unknown>;
}

export function numberDetail(result: { details: unknown }, key: string): number {
  const value = detailRecord(result)[key];
  if (typeof value !== 'number') return 0;
  return value;
}

export function stringDetail(result: { details: unknown }, key: string): string {
  const value = detailRecord(result)[key];
  if (typeof value !== 'string') return '';
  return value;
}

export function booleanDetail(result: { details: unknown }, key: string): boolean {
  const value = detailRecord(result)[key];
  return value === true;
}

type FileDetails = { path: string; [key: string]: unknown };

export function fileNotFound<T extends FileDetails>(
  filePath: string,
  extraDetails: Omit<T, 'path'>,
): ToolResult<T> {
  return {
    content: [{ type: 'text', text: `File not found: ${filePath}` }],
    details: { path: filePath, ...extraDetails } as T,
  };
}

export function fileError<T extends FileDetails>(
  error: unknown,
  toolName: string,
  filePath: string,
  extraDetails: Omit<T, 'path'>,
): ToolResult<T> {
  const err = error as ToolError;
  const message = err.message ?? 'Unknown error';
  return {
    content: [
      {
        type: 'text',
        text: `${toolName} error: ${message}`,
      },
    ],
    details: { path: filePath, ...extraDetails, failed: true, error: message } as unknown as T,
  };
}

export function toolError<T>(error: unknown, toolName: string, emptyDetails: T): ToolResult<T> {
  const err = error as ToolError;
  if (toolName === 'Grep' && err.code === 1) {
    return {
      content: [{ type: 'text', text: 'No matches found' }],
      details: emptyDetails,
    };
  }
  const message = err.message ?? 'Unknown error';
  return {
    content: [
      {
        type: 'text',
        text: `${toolName} error: ${message}`,
      },
    ],
    details: { ...emptyDetails, failed: true, error: message } as T,
  };
}

export async function execWithRgFallback(
  rgArgs: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    pattern: string;
    searchPath: string;
    include?: string;
  },
): Promise<string> {
  if (await hasRipgrep()) {
    const result = await execFileAsync('rg', rgArgs, {
      cwd: options.cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal: options.signal,
    });
    return result.stdout;
  }

  const regex = new RegExp(options.pattern);
  const matcher = options.include ? globToRegExp(normalizePath(options.include)) : undefined;
  return (
    await Promise.all(
      (
        await listFilesRecursive(options.searchPath, options.signal)
      )
        .filter((file) => {
          if (!matcher) return true;
          if (!options.include?.includes('/')) return matcher.test(basename(file));
          return matcher.test(normalizePath(relative(options.cwd, file)));
        })
        .map(async (file) =>
          (
            await fs.readFile(file, 'utf8')
          )
            .split(/\r?\n/)
            .flatMap((line, index) => (regex.test(line) ? `${file}:${index + 1}:${line}` : [])),
        ),
    )
  )
    .flat()
    .join('\n');
}
