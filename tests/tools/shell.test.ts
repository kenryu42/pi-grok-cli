import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerShellTool } from '../../src/tools/shell.js';
import {
  collectTools,
  executePreparedTool,
  executeTool,
  executeToolWithOptions,
  firstText,
  prepareToolArguments,
  renderToolCall,
  renderToolResult,
  tempDir,
} from './toolTestHelpers.js';

describe('shell tool', () => {
  it('returns stdout and stderr in native stream order', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'printf stdout && printf stderr >&2' },
      cwd,
    );

    expect(firstText(result)).toBe('stdoutstderr');
    expect(result.details).toBeUndefined();
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
    expect(result.details).toBeUndefined();
  });

  it('returns a clear placeholder when commands produce no output', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'true' },
      cwd,
    );

    expect(firstText(result)).toBe('(no output)');
    expect(result.details).toBeUndefined();
  });

  it('includes exit code, error message, and captured output on failure', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    await expect(
      executeTool(
        collectTools(registerShellTool).get('Shell'),
        { command: 'printf before && printf problem >&2 && exit 7' },
        cwd,
      ),
    ).rejects.toThrow(/before.*problem.*Command exited with code 7/is);
  });

  it('truncates large successful and failed output', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const tools = collectTools(registerShellTool);
    const largeOutput = 'node -e "for(let i=0;i<2500;i++) console.log(i)"';

    const successResult = await executeTool(tools.get('Shell'), { command: largeOutput }, cwd);
    const details = successResult.details as {
      truncation?: { truncated: boolean };
      fullOutputPath?: string;
    };

    expect(details.truncation?.truncated).toBe(true);
    expect(firstText(successResult)).toContain('Full output:');
    await expect(
      executeTool(
        tools.get('Shell'),
        { command: 'node -e "for(let i=0;i<2500;i++) console.log(i); process.exit(9)"' },
        cwd,
      ),
    ).rejects.toThrow(/Command exited with code 9/);
  });

  it('truncates multibyte output by characters without hitting exec buffer limits', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'perl -e \'print "漢" x 50001\'' },
      cwd,
    );

    expect((result.details as { truncation?: { truncated: boolean } }).truncation?.truncated).toBe(
      true,
    );
    expect(firstText(result)).toContain('Full output:');
    expect(firstText(result).length).toBeLessThan(50_001);
  });

  it('kills commands that exceed the timeout', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const command = 'node -e "setTimeout(()=>{},10000)"';
    await expect(
      executeTool(collectTools(registerShellTool).get('Shell'), { command, timeout: 100 }, cwd),
    ).rejects.toThrow(/Command timed out after 0\.1 seconds/);
  });

  it('renders shell calls and result states', () => {
    const shell = collectTools(registerShellTool).get('Shell');

    expect(
      renderToolCall(shell, {
        command: 'pwd',
        working_directory: 'src',
      }),
    ).toBe('$ pwd (timeout 120s)');
    expect(renderToolCall(shell, { command: 'pwd' })).toBe('$ pwd (timeout 120s)');
    expect(
      renderToolResult(shell, {
        content: [{ type: 'text', text: 'full output' }],
        details: { exitCode: 0 },
      }),
    ).toContain('full output');
    expect(
      renderToolResult(shell, {
        content: [{ type: 'text', text: 'spawn failed' }],
        details: { exitCode: 'ENOENT' },
      }),
    ).toContain('spawn failed');
    expect(
      renderToolResult(
        shell,
        {
          content: [{ type: 'text', text: 'full output' }],
          details: { exitCode: 0 },
        },
        { expanded: true, isPartial: false },
      ),
    ).toContain('full output');
    expect(
      renderToolResult(
        shell,
        {
          content: [{ type: 'text', text: 'still running' }],
          details: { exitCode: 0 },
        },
        { expanded: false, isPartial: true },
      ),
    ).toContain('still running');
  });
});

describe('native Shell adapter contracts', () => {
  it('normalizes cmd and preserves the 120-second compatibility default', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const shell = collectTools(registerShellTool).get('Shell');

    expect(prepareToolArguments(shell, { cmd: 'printf ready' })).toEqual({
      command: 'printf ready',
      timeout: 120_000,
      working_directory: undefined,
    });
    const result = await executePreparedTool(shell, { cmd: 'printf ready' }, cwd);
    expect(firstText(result)).toBe('ready');
  });

  it('converts millisecond timeouts to native seconds', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');

    await expect(
      executeTool(
        collectTools(registerShellTool).get('Shell'),
        { command: 'node -e "setTimeout(()=>{},10000)"', timeout: 100 },
        cwd,
      ),
    ).rejects.toThrow(/timed out after 0\.1 seconds/i);
  });

  it('streams native stdout and stderr updates', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const updates: string[] = [];

    const result = await executeToolWithOptions(
      collectTools(registerShellTool).get('Shell'),
      {
        command:
          "node -e \"process.stdout.write('first'); setTimeout(()=>process.stderr.write('second'),150)\"",
      },
      cwd,
      { onUpdate: (update) => updates.push(firstText(update)) },
    );

    expect(updates.some((update) => update.includes('first'))).toBe(true);
    expect(firstText(result)).toContain('first');
    expect(firstText(result)).toContain('second');
  });

  it('throws native cancellation and nonzero-exit errors', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const shell = collectTools(registerShellTool).get('Shell');
    const controller = new AbortController();
    const execution = executeToolWithOptions(
      shell,
      { command: 'node -e "setTimeout(()=>{},10000)"' },
      cwd,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await expect(execution).rejects.toThrow(/Command aborted/i);
    await expect(
      executeTool(shell, { command: 'printf before && printf problem >&2 && exit 7' }, cwd),
    ).rejects.toThrow(/before.*problem.*exited with code 7/is);
  });

  it('kills descendant processes when native cancellation aborts Shell', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const marker = join(cwd, 'descendant-survived.txt');
    const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 500)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setTimeout(() => {}, 10000)`;
    const controller = new AbortController();
    const execution = executeToolWithOptions(
      collectTools(registerShellTool).get('Shell'),
      { command: `node -e ${JSON.stringify(parent)}` },
      cwd,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);

    await expect(execution).rejects.toThrow(/Command aborted/i);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(marker)).toBe(false);
  });

  it('retains a full-output file when native truncation occurs', async () => {
    const cwd = tempDir('pi-grok-cli-shell-');
    const result = await executeTool(
      collectTools(registerShellTool).get('Shell'),
      { command: 'node -e "for(let i=0;i<2500;i++) console.log(i)"' },
      cwd,
    );
    const details = result.details as {
      fullOutputPath?: string;
      truncation?: { truncated: boolean };
    };

    expect(details.truncation?.truncated).toBe(true);
    expect(details.fullOutputPath).toBeTypeOf('string');
    expect(existsSync(details.fullOutputPath ?? '')).toBe(true);
    expect(firstText(result)).toContain('Full output:');
  });

  it('uses native Shell call and collapsed/expanded result rendering', () => {
    const shell = collectTools(registerShellTool).get('Shell');
    const args = { cmd: 'pwd', timeout: 100 };
    const result = {
      content: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive\nsix' }],
      details: {},
    };

    expect(renderToolCall(shell, args)).toContain('$ pwd (timeout 0.1s)');
    const collapsed = renderToolResult(shell, result, { expanded: false, isPartial: false }, args);
    const expanded = renderToolResult(shell, result, { expanded: true, isPartial: false }, args);
    expect(collapsed).toContain('six');
    expect(collapsed).not.toContain('one');
    expect(expanded).toContain('one');
    expect(expanded).toContain('six');
  });

  it('keeps native partial and error output visible', () => {
    const shell = collectTools(registerShellTool).get('Shell');
    const args = { command: 'printf working' };

    expect(
      renderToolResult(
        shell,
        { content: [{ type: 'text', text: 'streaming output' }], details: undefined },
        { expanded: false, isPartial: true },
        args,
      ),
    ).toContain('streaming output');
    expect(
      renderToolResult(
        shell,
        { content: [{ type: 'text', text: 'Command exited with code 7' }], details: undefined },
        { expanded: false, isPartial: false },
        args,
        { isError: true },
      ),
    ).toContain('Command exited with code 7');
  });
});
