import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Text } from '@earendil-works/pi-tui';

const execFileAsync = promisify(execFile);

export const MAX_OUTPUT_CHARS = 50_000;
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
  return {
    content: [
      {
        type: 'text',
        text: `${toolName} error: ${err.message ?? 'Unknown error'}`,
      },
    ],
    details: { path: filePath, ...extraDetails } as T,
  };
}

export function toolError<T>(error: unknown, toolName: string, emptyDetails: T): ToolResult<T> {
  const err = error as ToolError;
  if (err.code === 1) {
    return {
      content: [{ type: 'text', text: 'No matches found' }],
      details: emptyDetails,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: `${toolName} error: ${err.message ?? 'Unknown error'}`,
      },
    ],
    details: emptyDetails,
  };
}

export async function execWithRgFallback(
  rgArgs: string[],
  grepArgs: string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<string> {
  if (await hasRipgrep()) {
    const result = await execFileAsync('rg', rgArgs, {
      cwd: options.cwd,
      maxBuffer: MAX_OUTPUT_CHARS * 2,
      signal: options.signal,
    });
    return result.stdout;
  }
  const result = await execFileAsync('grep', grepArgs, {
    cwd: options.cwd,
    maxBuffer: MAX_OUTPUT_CHARS * 2,
    signal: options.signal,
  });
  return result.stdout;
}
