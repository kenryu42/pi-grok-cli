import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
  type BashToolInput,
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { nativeRenderContext, recordFrom, stringFrom, text } from './rendering.js';

type ShellArgs = {
  command: string;
  working_directory?: string;
  timeout: number;
};

function normalizeShellArgs(value: unknown): ShellArgs {
  const input = recordFrom(value);
  return {
    command: stringFrom(input?.command) ?? stringFrom(input?.cmd) ?? '',
    timeout: typeof input?.timeout === 'number' ? input.timeout : 120_000,
    working_directory: stringFrom(input?.working_directory),
  };
}

function nativeShellArgs(value: unknown): BashToolInput {
  const input = normalizeShellArgs(value);
  return { command: input.command, timeout: input.timeout / 1000 };
}

export function registerShellTool(pi: ExtensionAPI) {
  const ShellParams = Type.Object({
    command: Type.String({ description: 'Shell command to execute' }),
    working_directory: Type.Optional(
      Type.String({ description: 'Working directory for the command' }),
    ),
    timeout: Type.Optional(
      Type.Number({ description: 'Timeout in milliseconds (default: 120000)' }),
    ),
  });
  const nativeBash = createBashToolDefinition(process.cwd());

  pi.registerTool({
    name: 'Shell',
    label: 'Shell',
    description:
      'Execute a shell command with native streaming, process-tree cancellation, and bounded output.',
    parameters: ShellParams,
    prepareArguments: normalizeShellArgs,
    async execute(
      toolCallId: string,
      params: ShellArgs,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof nativeBash.execute>[3],
      ctx: ExtensionContext,
    ) {
      const normalized = normalizeShellArgs(params);
      return createBashToolDefinition(
        normalized.working_directory ? resolve(ctx.cwd, normalized.working_directory) : ctx.cwd,
      ).execute(toolCallId, nativeShellArgs(normalized), signal, onUpdate, ctx);
    },
    renderCall(
      args: unknown,
      theme: Parameters<NonNullable<typeof nativeBash.renderCall>>[1],
      context: Parameters<NonNullable<typeof nativeBash.renderCall>>[2],
    ) {
      const normalized = nativeShellArgs(args);
      if (!nativeBash.renderCall) return text('');
      return nativeBash.renderCall(normalized, theme, nativeRenderContext(context, normalized));
    },
    renderResult(
      result: Parameters<NonNullable<typeof nativeBash.renderResult>>[0],
      options: Parameters<NonNullable<typeof nativeBash.renderResult>>[1],
      theme: Parameters<NonNullable<typeof nativeBash.renderResult>>[2],
      context: Parameters<NonNullable<typeof nativeBash.renderResult>>[3],
    ) {
      const normalized = nativeShellArgs(context.args);
      if (!nativeBash.renderResult) return text('');
      return nativeBash.renderResult(
        result,
        options,
        theme,
        nativeRenderContext(context, normalized),
      );
    },
  });
}
