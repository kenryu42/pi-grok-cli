import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerShellTool } from '../../src/tools/shell.js';
import {
  collectTools,
  executeTool,
  firstText,
  renderToolCall,
  renderToolResult,
  tempDir,
} from './toolTestHelpers.js';

describe('shell tool', () => {
  it('returns stdout, stderr, and exit zero details', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'printf stdout && printf stderr >&2' },
      cwd,
    );

    expect(firstText(result)).toBe('stdout\n[stderr]\nstderr');
    expect(result.details).toEqual({
      exitCode: 0,
      command: 'printf stdout && printf stderr >&2',
    });
  });

  it('runs commands in a resolved working directory', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    writeFileSync(join(cwd, 'target.txt'), 'from cwd', 'utf-8');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'cat target.txt', working_directory: '.' },
      cwd,
    );

    expect(firstText(result)).toBe('from cwd');
    expect(result.details).toEqual({
      exitCode: 0,
      command: 'cat target.txt',
    });
  });

  it('returns a clear placeholder when commands produce no output', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'true' },
      cwd,
    );

    expect(firstText(result)).toBe('(no output)');
    expect(result.details).toEqual({ exitCode: 0, command: 'true' });
  });

  it('includes exit code, error message, and captured output on failure', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'printf before && printf problem >&2 && exit 7' },
      cwd,
    );

    expect(firstText(result)).toContain('Shell error (exit code 7):');
    expect(firstText(result)).toContain('before\n[stderr]\nproblem');
    expect(result.details).toEqual({
      exitCode: 7,
      command: 'printf before && printf problem >&2 && exit 7',
    });
  });

  it('truncates large successful and failed output', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const tools = collectTools(registerShellTool);
    const largeOutput = "head -c 50001 /dev/zero | tr '\\0' x";

    const successResult = await executeTool(tools.get('Shell'), { command: largeOutput }, cwd);
    const failureResult = await executeTool(
      tools.get('Shell'),
      { command: `${largeOutput}; exit 9` },
      cwd,
    );

    expect(firstText(successResult)).toHaveLength('\n\n[Output truncated at 50KB]'.length + 50_000);
    expect(firstText(successResult).endsWith('[Output truncated at 50KB]')).toBe(true);
    expect(firstText(failureResult)).toContain('Shell error (exit code 9):');
    expect(firstText(failureResult).endsWith('[Output truncated at 50KB]')).toBe(true);
  });

  it('truncates multibyte output by characters without hitting exec buffer limits', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'perl -e \'print "漢" x 50001\'' },
      cwd,
    );

    expect(firstText(result)).toHaveLength('\n\n[Output truncated at 50KB]'.length + 50_000);
    expect(firstText(result).startsWith('Shell error')).toBe(false);
    expect(firstText(result).endsWith('[Output truncated at 50KB]')).toBe(true);
  });

  it('kills commands that exceed the timeout', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const command = 'node -e "setTimeout(()=>{},10000)"';
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command, timeout: 100 },
      cwd,
    );

    expect(firstText(result)).toContain('Shell error');
    expect(result.details.command).toBe(command);
    expect(result.details.signal).toMatch(/TERM|KILL/);
  });

  it('renders shell calls and result states', () => {
    const shell = collectTools(registerShellTool).get('Shell');

    expect(
      renderToolCall(shell, {
        command: 'pwd',
        working_directory: 'src',
      }),
    ).toBe('Shell pwd in src');
    expect(renderToolCall(shell, { command: 'pwd' })).toBe('Shell pwd');
    expect(
      renderToolResult(shell, {
        content: [{ type: 'text', text: 'full output' }],
        details: { exitCode: 0 },
      }),
    ).toBe('Exit 0');
    expect(
      renderToolResult(shell, {
        content: [{ type: 'text', text: 'spawn failed' }],
        details: { exitCode: 'ENOENT' },
      }),
    ).toBe('Exit 1');
    expect(
      renderToolResult(
        shell,
        {
          content: [{ type: 'text', text: 'full output' }],
          details: { exitCode: 0 },
        },
        { expanded: true, isPartial: false },
      ),
    ).toBe('full output');
    expect(
      renderToolResult(
        shell,
        {
          content: [{ type: 'text', text: 'still running' }],
          details: { exitCode: 0 },
        },
        { expanded: false, isPartial: true },
      ),
    ).toBe('Running...');
  });
});
