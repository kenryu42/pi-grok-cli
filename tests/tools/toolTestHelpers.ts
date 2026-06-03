import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

export type ToolResult = {
  content: { type: string; text?: string }[];
  details: Record<string, unknown>;
};

type ExtensionHandler = (event: unknown) => unknown;

type Renderable = { render: (width: number) => string[] };

type ToolTheme = {
  bold: (text: string) => string;
  fg: (name: string, text: string) => string;
};

type RegisteredTool = {
  name: string;
  prepareArguments?: (params: Record<string, unknown>) => Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: { cwd: string },
  ) => Promise<ToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: ToolTheme) => Renderable;
  renderResult?: (
    result: ToolResult,
    state: { expanded: boolean; isPartial: boolean },
    theme: ToolTheme,
    args: Record<string, unknown>,
  ) => Renderable;
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
  if (!tool) throw new Error('Tool was not registered');
  return tool.execute('tool-call-id', params, new AbortController().signal, () => {}, {
    cwd,
  });
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
    .map((line) => line.trimEnd())
    .join('\n');
}

export const plainTheme = {
  bold: (text: string) => text,
  fg: (_name: string, text: string) => text,
};

export function renderToolCall(tool: RegisteredTool | undefined, args: Record<string, unknown>) {
  if (!tool?.renderCall) throw new Error('Tool call renderer was not registered');
  return renderText(tool.renderCall(args, plainTheme));
}

export function renderToolResult(
  tool: RegisteredTool | undefined,
  result: ToolResult,
  state = { expanded: false, isPartial: false },
) {
  if (!tool?.renderResult) {
    throw new Error('Tool result renderer was not registered');
  }
  return renderText(tool.renderResult(result, state, plainTheme, {}));
}

export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
