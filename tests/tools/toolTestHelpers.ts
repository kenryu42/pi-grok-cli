import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

export type ToolResult = {
  content: { type: string; text?: string }[];
  details: Record<string, unknown> | undefined;
};

type ExtensionHandler = (event: unknown) => unknown;

type Renderable = { render: (width: number) => string[] };

type ToolTheme = {
  bold: (text: string) => string;
  bg: (name: string, text: string) => string;
  fg: (name: string, text: string) => string;
  inverse: (text: string) => string;
};

type RenderContextOptions = {
  argsComplete?: boolean;
  cwd?: string;
  executionStarted?: boolean;
  expanded?: boolean;
  isError?: boolean;
  isPartial?: boolean;
  showImages?: boolean;
};

type RegisteredTool = {
  name: string;
  prepareArguments?: (params: Record<string, unknown>) => Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (result: ToolResult) => void,
    ctx: { cwd: string },
  ) => Promise<ToolResult>;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolTheme,
    context: ToolRenderContext,
  ) => Renderable;
  renderResult?: (
    result: ToolResult,
    state: { expanded: boolean; isPartial: boolean },
    theme: ToolTheme,
    context: ToolRenderContext,
  ) => Renderable;
};

type ToolRenderContext = {
  args: Record<string, unknown>;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Renderable | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

export function collectTools(registerTools: (pi: ExtensionAPI) => void) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, ExtensionHandler>();
  registerTools({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);
  return tools;
}

export async function executeTool(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>,
  cwd: string,
) {
  return executeToolWithOptions(tool, params, cwd);
}

export async function executeToolWithOptions(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>,
  cwd: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: (result: ToolResult) => void;
  } = {},
) {
  if (!tool) throw new Error('Tool was not registered');
  return tool.execute(
    'tool-call-id',
    params,
    options.signal ?? new AbortController().signal,
    options.onUpdate ?? (() => {}),
    { cwd },
  );
}

export function prepareToolArguments(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>,
) {
  if (!tool) throw new Error('Tool was not registered');
  return tool.prepareArguments?.(params) ?? params;
}

export async function executePreparedTool(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>,
  cwd: string,
) {
  if (!tool) throw new Error('Tool was not registered');
  return executeTool(tool, prepareToolArguments(tool, params), cwd);
}

export function firstText(result: ToolResult) {
  return result.content[0]?.text ?? '';
}

export function renderText(component: { render: (width: number) => string[] }) {
  return component
    .render(120)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join('\n');
}

export const plainTheme = {
  bold: (text: string) => text,
  bg: (_name: string, text: string) => text,
  fg: (_name: string, text: string) => text,
  inverse: (text: string) => text,
};

Object.assign(globalThis, {
  [Symbol.for('@earendil-works/pi-coding-agent:theme')]: plainTheme,
  [Symbol.for('@mariozechner/pi-coding-agent:theme')]: plainTheme,
});

export function renderToolCall(
  tool: RegisteredTool | undefined,
  args: Record<string, unknown>,
  options: RenderContextOptions = {},
) {
  if (!tool?.renderCall) throw new Error('Tool call renderer was not registered');
  return renderText(
    tool.renderCall(
      args,
      plainTheme,
      renderContext(
        args,
        {
          expanded: options.expanded ?? false,
          isPartial: options.isPartial ?? false,
        },
        undefined,
        options,
      ),
    ),
  );
}

export function renderToolResult(
  tool: RegisteredTool | undefined,
  result: ToolResult,
  state = { expanded: false, isPartial: false },
  args: Record<string, unknown> = {},
  options: RenderContextOptions = {},
) {
  if (!tool?.renderResult) {
    throw new Error('Tool result renderer was not registered');
  }
  return renderText(
    tool.renderResult(result, state, plainTheme, renderContext(args, state, result, options)),
  );
}

function renderContext(
  args: Record<string, unknown>,
  options = { expanded: false, isPartial: false },
  result?: ToolResult,
  overrides: RenderContextOptions = {},
): ToolRenderContext {
  return {
    args,
    toolCallId: 'tool-call-id',
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: overrides.cwd ?? '/project',
    executionStarted: overrides.executionStarted ?? result !== undefined,
    argsComplete: overrides.argsComplete ?? true,
    isPartial: options.isPartial,
    expanded: options.expanded,
    showImages: overrides.showImages ?? true,
    isError: overrides.isError ?? false,
  };
}

export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
