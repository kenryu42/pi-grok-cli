import { type Component, Text } from '@earendil-works/pi-tui';

export type NativeRenderContext<TState, TArgs> = {
  args: TArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

export function nativeRenderContext<TState, TSourceArgs, TNativeArgs>(
  context: NativeRenderContext<TState, TSourceArgs>,
  args: TNativeArgs,
): NativeRenderContext<TState, TNativeArgs> {
  return { ...context, args };
}

export function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

export function stringFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value;
}

export function normalizePath(filePath: string) {
  return filePath.replaceAll('\\', '/');
}

export function text(value: string): Text {
  return new Text(value, 0, 0);
}

function firstText(result: { content: { type: string; text?: string }[] }) {
  const first = result.content[0];
  if (first?.type !== 'text') return undefined;
  return first.text;
}

function renderResultText(
  result: { content: { type: string; text?: string }[] },
  expanded: boolean,
  summary: string,
) {
  return text(expanded ? (firstText(result) ?? summary) : summary);
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
) {
  return renderRunning(isPartial) ?? renderResultText(result, expanded, summary);
}

function detailRecord(result: { details: unknown }): Record<string, unknown> {
  if (!result.details || typeof result.details !== 'object') return {};
  return result.details as Record<string, unknown>;
}

export function numberDetail(result: { details: unknown }, key: string): number {
  const value = detailRecord(result)[key];
  if (typeof value !== 'number') return 0;
  return value;
}

export function booleanDetail(result: { details: unknown }, key: string): boolean {
  return detailRecord(result)[key] === true;
}

type FileDetails = { path: string; [key: string]: unknown };

type FileResult<T> = {
  content: [{ type: 'text'; text: string }];
  details: T;
};

export function fileNotFound<T extends FileDetails>(
  filePath: string,
  extraDetails: Omit<T, 'path'>,
): FileResult<T> {
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
): FileResult<T> {
  const message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Unknown error';
  return {
    content: [{ type: 'text', text: `${toolName} error: ${message}` }],
    details: { path: filePath, ...extraDetails, failed: true, error: message } as unknown as T,
  };
}
