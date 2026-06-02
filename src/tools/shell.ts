import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  detailRecord,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
  renderResultText,
  renderRunning,
  text,
} from './rendering.js';

const execFileAsync = promisify(execFile);

function shellCommand(command: string): { file: string; args: string[] } | undefined {
  if (process.platform === 'win32') {
    if (existsSync('C:\\Windows\\System32\\cmd.exe')) {
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
    }
    if (existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')) {
      return {
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-Command', command],
      };
    }
    return undefined;
  }

  if (
    process.platform !== 'darwin' &&
    process.platform !== 'linux' &&
    process.platform !== 'freebsd'
  ) {
    return undefined;
  }

  if (existsSync('/bin/bash')) return { file: '/bin/bash', args: ['-c', command] };
  if (existsSync('/usr/bin/bash')) return { file: '/usr/bin/bash', args: ['-c', command] };
  if (existsSync('/bin/sh')) return { file: '/bin/sh', args: ['-c', command] };
  if (existsSync('/usr/bin/sh')) return { file: '/usr/bin/sh', args: ['-c', command] };
  return undefined;
}

export function registerShellTool(pi: ExtensionAPI) {
  // ── Shell tool ───────────────────────────────────────────────────────

  const ShellParams = Type.Object({
    command: Type.String({
      description: 'Shell command to execute',
    }),
    working_directory: Type.Optional(
      Type.String({
        description: 'Working directory for the command',
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: 'Timeout in milliseconds (default: 120000)',
      }),
    ),
  });

  pi.registerTool({
    name: 'Shell',
    label: 'Shell',
    description: 'Execute a shell command and return stdout, stderr, and exit code.',
    parameters: ShellParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = params.working_directory ? resolve(ctx.cwd, params.working_directory) : ctx.cwd;
      const timeout = params.timeout ?? 120_000;

      try {
        const shell = shellCommand(params.command);
        if (!shell) {
          return {
            content: [
              {
                type: 'text',
                text: 'Shell error: unsupported platform or shell not found',
              },
            ],
            details: { exitCode: 1, command: params.command },
          };
        }
        const { stdout, stderr } = await execFileAsync(shell.file, shell.args, {
          cwd,
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout,
          signal,
        });

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += `\n[stderr]\n${stderr}`;

        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
        }

        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { exitCode: 0, command: params.command },
        };
      } catch (error: unknown) {
        const err = error as {
          code?: unknown;
          message?: string;
          stdout?: string;
          stderr?: string;
        };
        const exitCode = typeof err.code === 'number' ? err.code : 1;

        let output = '';
        if (err.stdout) output += err.stdout;
        if (err.stderr) output += `\n[stderr]\n${err.stderr}`;

        if (output.length > MAX_OUTPUT_CHARS) {
          output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
        }

        return {
          content: [
            {
              type: 'text',
              text: `Shell error (exit code ${err.code ?? 'unknown'}): ${err.message ?? 'Unknown error'}${output ? `\n${output}` : ''}`,
            },
          ],
          details: {
            exitCode,
            command: params.command,
          },
        };
      }
    },
    renderCall(args, theme) {
      const cwd = args.working_directory ? theme.fg('muted', ` in ${args.working_directory}`) : '';
      return text(
        theme.fg('toolTitle', theme.bold('Shell ')) + theme.fg('accent', args.command) + cwd,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const running = renderRunning(isPartial);
      if (running) return running;
      const exitCode =
        typeof detailRecord(result).exitCode === 'number' ? detailRecord(result).exitCode : 1;
      return renderResultText(
        result,
        expanded,
        exitCode === 0 ? theme.fg('muted', 'Exit 0') : theme.fg('warning', `Exit ${exitCode}`),
      );
    },
  });
}
