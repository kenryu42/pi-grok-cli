import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerFileTools } from '../../src/tools/files.js';
import {
  collectTools,
  executePreparedTool,
  executeTool,
  executeToolWithOptions,
  firstText,
  prepareToolArguments,
  renderToolCall,
  renderToolResult,
  type ToolResult,
  tempDir,
} from './toolTestHelpers.js';

function expectStoryState(result: ToolResult, cwd: string, replacements: number, content: string) {
  expect(result.details).toMatchObject({
    path: expectedPath(cwd, 'story.txt'),
    replacements,
  });
  expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe(content);
}

function expectedPath(cwd: string, ...parts: string[]) {
  return join(cwd, ...parts);
}

function strReplace(cwd: string, old_str: string, new_str: string) {
  return executeTool(
    collectTools(registerFileTools).get('StrReplace'),
    { path: 'story.txt', old_str, new_str },
    cwd,
  );
}

function strReplaceWithPreparedArgs(cwd: string, params: Record<string, unknown>) {
  return executePreparedTool(
    collectTools(registerFileTools).get('StrReplace'),
    { path: 'story.txt', ...params },
    cwd,
  );
}

describe('file tools', () => {
  it('lists directory contents including hidden files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, '.hidden'), 'secret', 'utf-8');
    writeFileSync(join(cwd, 'visible.txt'), 'visible', 'utf-8');

    const result = await executeTool(collectTools(registerFileTools).get('LS'), { path: '.' }, cwd);

    expect(firstText(result)).toContain('.hidden');
    expect(firstText(result)).toContain('visible.txt');
    expect(result.details).toBeUndefined();
  });

  it('truncates oversized directory listings', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    Array.from({ length: 700 }, (_, index) =>
      writeFileSync(join(cwd, `${String(index).padStart(4, '0')}-${'x'.repeat(70)}`), '', 'utf-8'),
    );

    const result = await executeTool(collectTools(registerFileTools).get('LS'), { path: '.' }, cwd);

    expect(firstText(result).split('\n').slice(0, 500)).toHaveLength(500);
    expect(firstText(result)).toContain('500 entries limit reached');
    expect(result.details).toMatchObject({ entryLimitReached: 500 });
  });

  it('lists directory contents when Unix ls is not on PATH', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const oldPath = process.env.PATH;
    process.env.PATH = tempDir('pi-grok-cli-empty-bin-');
    vi.resetModules();
    writeFileSync(join(cwd, 'visible.txt'), 'visible', 'utf-8');

    try {
      const result = await executeTool(
        collectTools((await import('../../src/tools/files.js')).registerFileTools).get('LS'),
        { path: '.' },
        cwd,
      );

      expect(firstText(result)).toContain('visible.txt');
      expect(result.details).toBeUndefined();
    } finally {
      process.env.PATH = oldPath;
      vi.resetModules();
    }
  });

  it('reports filesystem errors for invalid file operations', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    mkdirSync(join(cwd, 'dir'));
    writeFileSync(join(cwd, 'blocked'), 'not a directory', 'utf-8');
    const tools = collectTools(registerFileTools);

    const lsResult = executeTool(tools.get('LS'), { path: 'missing-dir' }, cwd);
    const writeResult = executeTool(
      tools.get('Write'),
      { path: 'blocked/file.txt', content: 'content' },
      cwd,
    );
    const replaceResult = executeTool(
      tools.get('StrReplace'),
      { path: 'dir', old_str: 'old', new_str: 'new' },
      cwd,
    );
    const deleteResult = await executeTool(tools.get('Delete'), { path: 'dir' }, cwd);

    await expect(lsResult).rejects.toThrow(/Path not found/);
    await expect(writeResult).rejects.toThrow();
    await expect(replaceResult).rejects.toThrow();
    expect(firstText(deleteResult).startsWith('Delete error:')).toBe(true);
    expect(deleteResult.details).toEqual({
      path: join(cwd, 'dir'),
      deleted: false,
      failed: true,
      error: expect.stringMatching(
        /EISDIR: illegal operation on a directory|operation not permitted/,
      ),
    });
  });

  it('allows file operations on paths outside the workspace', async () => {
    const parent = tempDir('pi-grok-cli-files-parent-');
    const cwd = join(parent, 'workspace');
    mkdirSync(cwd);
    const tools = collectTools(registerFileTools);

    const writeResult = await executeTool(
      tools.get('Write'),
      { path: '../outside.txt', content: 'hello' },
      cwd,
    );
    expect(firstText(writeResult)).toBe('Successfully wrote 5 bytes to ../outside.txt');
    expect(existsSync(join(parent, 'outside.txt'))).toBe(true);

    const replaceResult = await executeTool(
      tools.get('StrReplace'),
      { path: '../outside.txt', old_str: 'hello', new_str: 'world' },
      cwd,
    );
    expect(firstText(replaceResult)).toBe('Replaced 1 occurrence(s) in ../outside.txt');
    expect(readFileSync(join(parent, 'outside.txt'), 'utf-8')).toBe('world');

    const lsResult = await executeTool(tools.get('LS'), { path: '..' }, cwd);
    expect(firstText(lsResult)).toContain('outside.txt');
  });

  it('writes Cursor-style contents arguments', async () => {
    const cwd = tempDir('pi-grok-cli-files-');

    const result = await executePreparedTool(
      collectTools(registerFileTools).get('Write'),
      { path: 'nested/notes.txt', contents: 'alpha\nbeta' },
      cwd,
    );

    expect(firstText(result)).toBe('Successfully wrote 10 bytes to nested/notes.txt');
    expect(readFileSync(join(cwd, 'nested/notes.txt'), 'utf-8')).toBe('alpha\nbeta');
    expect(result.details).toBeUndefined();
  });

  it('adopts the native Write result contract for multibyte content', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const result = await executeTool(
      collectTools(registerFileTools).get('Write'),
      { path: 'emoji.txt', content: 'a🙂漢' },
      cwd,
    );

    expect(firstText(result)).toBe('Successfully wrote 4 bytes to emoji.txt');
    expect(result.details).toBeUndefined();
  });

  it('replaces every exact string occurrence', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    const result = await strReplace(cwd, 'red', 'green');

    expect(firstText(result)).toBe('Replaced 2 occurrence(s) in story.txt');
    expectStoryState(result, cwd, 2, 'green blue green');
  });

  it('rejects empty replacement search strings without changing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    await expect(strReplace(cwd, '', 'green')).rejects.toThrow(/must not be empty/);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf8')).toBe('red blue red');
  });

  it('treats replacement text as a literal string', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'abc', 'utf-8');

    const result = await strReplace(cwd, 'a', '$&');

    expect(firstText(result)).toBe('Replaced 1 occurrence(s) in story.txt');
    expectStoryState(result, cwd, 1, '$&bc');
  });

  it('preserves BOM and CRLF bytes outside StrReplace matches', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'windows.txt'), '\uFEFFalpha\r\nbeta\r\n', 'utf8');

    await executeTool(
      collectTools(registerFileTools).get('StrReplace'),
      { path: 'windows.txt', old_str: 'beta', new_str: 'gamma' },
      cwd,
    );

    expect(readFileSync(join(cwd, 'windows.txt'), 'utf8')).toBe('\uFEFFalpha\r\ngamma\r\n');
  });

  it('replaces string occurrences with Grok and Cursor argument variants', async () => {
    const oldStringCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(oldStringCwd, 'story.txt'), 'red blue red', 'utf-8');

    const oldStringResult = await strReplaceWithPreparedArgs(oldStringCwd, {
      old_string: 'red',
      new_string: 'green',
    });

    expect(firstText(oldStringResult)).toBe('Replaced 2 occurrence(s) in story.txt');
    expectStoryState(oldStringResult, oldStringCwd, 2, 'green blue green');

    const oldTextCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(oldTextCwd, 'story.txt'), 'red blue red', 'utf-8');

    const oldTextResult = await strReplaceWithPreparedArgs(oldTextCwd, {
      oldText: 'red',
      newText: 'green',
    });

    expect(firstText(oldTextResult)).toBe('Replaced 2 occurrence(s) in story.txt');
    expectStoryState(oldTextResult, oldTextCwd, 2, 'green blue green');

    const nestedCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(nestedCwd, 'story.txt'), 'red blue red', 'utf-8');

    const nestedResult = await strReplaceWithPreparedArgs(nestedCwd, {
      strReplace: { oldText: 'red', newText: 'green' },
    });

    expect(firstText(nestedResult)).toBe('Replaced 2 occurrence(s) in story.txt');
    expectStoryState(nestedResult, nestedCwd, 2, 'green blue green');
  });

  it('edits files with single, multiple, and stringified replacement inputs', async () => {
    const singleCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(singleCwd, 'story.txt'), 'red blue', 'utf-8');

    const singleResult = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { path: 'story.txt', oldText: 'red', newText: 'green' },
      singleCwd,
    );

    expect(firstText(singleResult)).toBe('Successfully replaced 1 block(s) in story.txt.');
    expect(singleResult.details).toMatchObject({
      diff: expect.stringContaining('green blue'),
      patch: expect.stringContaining('story.txt'),
    });
    expect(readFileSync(join(singleCwd, 'story.txt'), 'utf-8')).toBe('green blue');

    const multipleCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(multipleCwd, 'story.txt'), 'red blue', 'utf-8');

    const multipleResult = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      {
        path: 'story.txt',
        edits: [
          { oldText: 'red', newText: 'green' },
          { oldText: 'blue', newText: 'yellow' },
        ],
      },
      multipleCwd,
    );

    expect(firstText(multipleResult)).toBe('Successfully replaced 2 block(s) in story.txt.');
    expect(multipleResult.details).toMatchObject({
      diff: expect.stringContaining('green yellow'),
      patch: expect.stringContaining('story.txt'),
    });
    expect(readFileSync(join(multipleCwd, 'story.txt'), 'utf-8')).toBe('green yellow');

    const stringifiedCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(stringifiedCwd, 'story.txt'), 'red blue', 'utf-8');

    const stringifiedResult = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      {
        path: 'story.txt',
        edits: JSON.stringify([{ oldText: 'red', newText: 'green' }]),
      },
      stringifiedCwd,
    );

    expect(firstText(stringifiedResult)).toBe('Successfully replaced 1 block(s) in story.txt.');
    expect(stringifiedResult.details).toMatchObject({
      diff: expect.stringContaining('green blue'),
      patch: expect.stringContaining('story.txt'),
    });
    expect(readFileSync(join(stringifiedCwd, 'story.txt'), 'utf-8')).toBe('green blue');
  });

  it('edits files with literal replacement text', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'abc', 'utf-8');

    const result = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { path: 'story.txt', oldText: 'a', newText: '$&' },
      cwd,
    );

    expect(firstText(result)).toBe('Successfully replaced 1 block(s) in story.txt.');
    expect(result.details).toMatchObject({
      diff: expect.stringContaining('$&bc'),
      patch: expect.stringContaining('story.txt'),
    });
    expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe('$&bc');
  });

  it('rejects empty edit search strings without changing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    await expect(
      executePreparedTool(
        collectTools(registerFileTools).get('Edit'),
        { path: 'story.txt', oldText: '', newText: 'green' },
        cwd,
      ),
    ).rejects.toThrow(/oldText must not be empty/);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe('red blue red');
  });

  it('reports unsupported edit strategies without changing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    await expect(
      executePreparedTool(
        collectTools(registerFileTools).get('Edit'),
        { path: 'story.txt', applyPatch: { patchContent: 'patch' } },
        cwd,
      ),
    ).rejects.toThrow(/edits must contain at least one/);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe('red blue red');
  });

  it('rejects malformed edit lists without changing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');
    const edit = collectTools(registerFileTools).get('Edit');

    await expect(
      executePreparedTool(edit, { path: 'story.txt', edits: '{ not json' }, cwd),
    ).rejects.toThrow(/edits must contain at least one/);
    await expect(
      executePreparedTool(edit, { path: 'story.txt', edits: [{ oldText: 'red' }] }, cwd),
    ).rejects.toThrow(/edits must contain at least one/);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe('red blue red');
  });

  it('reports no-match and filesystem failures from Edit', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');
    mkdirSync(join(cwd, 'directory'));
    const edit = collectTools(registerFileTools).get('Edit');

    await expect(
      executePreparedTool(edit, { path: 'story.txt', oldText: 'purple', newText: 'green' }, cwd),
    ).rejects.toThrow(/Could not find the exact text/);
    await expect(
      executePreparedTool(edit, { path: 'directory', oldText: 'red', newText: 'green' }, cwd),
    ).rejects.toThrow(/Could not edit file|EISDIR/);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe('red blue red');
  });

  it('leaves files unchanged when the replacement string is absent', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    const result = await strReplace(cwd, 'purple', 'green');

    expect(firstText(result)).toBe('String not found in story.txt: "purple"');
    expectStoryState(result, cwd, 0, 'red blue red');
  });

  it('deletes existing files and reports missing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'remove.txt'), 'delete me', 'utf-8');
    const tools = collectTools(registerFileTools);

    const deletedResult = await executeTool(tools.get('Delete'), { path: 'remove.txt' }, cwd);

    expect(firstText(deletedResult)).toBe('Successfully deleted remove.txt');
    expect(deletedResult.details).toEqual({
      path: expectedPath(cwd, 'remove.txt'),
      deleted: true,
    });
    expect(existsSync(join(cwd, 'remove.txt'))).toBe(false);

    const missingResult = await executeTool(tools.get('Delete'), { path: 'remove.txt' }, cwd);

    expect(firstText(missingResult)).toBe(`File not found: ${join(cwd, 'remove.txt')}`);
    expect(missingResult.details).toEqual({
      path: join(cwd, 'remove.txt'),
      deleted: false,
    });
  });

  it('renders file tool calls and result states', () => {
    const tools = collectTools(registerFileTools);

    expect(renderToolCall(tools.get('LS'), { path: '.' })).toBe('ls .');
    expect(renderToolCall(tools.get('Write'), { path: 'notes.txt' })).toBe('write notes.txt');
    expect(renderToolCall(tools.get('StrReplace'), { path: 'notes.txt' })).toBe(
      'StrReplace notes.txt',
    );
    expect(renderToolCall(tools.get('Edit'), { path: 'notes.txt' })).toContain('edit notes.txt');
    expect(renderToolCall(tools.get('Delete'), { path: 'notes.txt' })).toBe('Delete notes.txt');
    expect(
      renderToolResult(tools.get('StrReplace'), {
        content: [{ type: 'text', text: 'no replacement' }],
        details: { replacements: 0 },
      }),
    ).toBe('No replacements');
    expect(
      renderToolResult(tools.get('Delete'), {
        content: [{ type: 'text', text: 'not deleted' }],
        details: { deleted: false },
      }),
    ).toBe('Not deleted');
    expect(
      renderToolResult(tools.get('Edit'), {
        content: [{ type: 'text', text: 'edited' }],
        details: undefined,
      }),
    ).toBe('');
    expect(
      renderToolResult(
        tools.get('LS'),
        {
          content: [{ type: 'text', text: 'full listing' }],
          details: { path: '/tmp/project' },
        },
        { expanded: true, isPartial: false },
      ),
    ).toContain('full listing');
    expect(
      renderToolResult(
        tools.get('Write'),
        {
          content: [{ type: 'text', text: 'writing' }],
          details: { bytesWritten: 10 },
        },
        { expanded: false, isPartial: true },
      ),
    ).toBe('');
  });
});

describe('native file adapter contracts', () => {
  it('normalizes Write file_path and contents aliases into native arguments', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const write = collectTools(registerFileTools).get('Write');

    expect(
      prepareToolArguments(write, { file_path: 'nested/note.txt', contents: 'hello' }),
    ).toEqual({ path: 'nested/note.txt', content: 'hello' });
    const result = await executePreparedTool(
      write,
      { file_path: 'nested/note.txt', contents: 'hello' },
      cwd,
    );

    expect(firstText(result)).toBe('Successfully wrote 5 bytes to nested/note.txt');
    expect(result.details).toBeUndefined();
    expect(readFileSync(join(cwd, 'nested', 'note.txt'), 'utf8')).toBe('hello');
  });

  it('prevents an aborted native Write before changing the filesystem', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeToolWithOptions(
        collectTools(registerFileTools).get('Write'),
        { path: 'aborted.txt', content: 'must not exist' },
        cwd,
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/i);
    expect(existsSync(join(cwd, 'aborted.txt'))).toBe(false);
  });

  it('throws delegated Write filesystem failures', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'blocked'), 'not a directory', 'utf8');

    await expect(
      executeTool(
        collectTools(registerFileTools).get('Write'),
        { path: 'blocked/file.txt', content: 'content' },
        cwd,
      ),
    ).rejects.toThrow();
  });

  it('serializes concurrent native Write and Edit mutations in request order', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'ordered.txt'), 'initial', 'utf8');
    const tools = collectTools(registerFileTools);

    await Promise.all([
      executeTool(tools.get('Write'), { path: 'ordered.txt', content: 'first' }, cwd),
      executePreparedTool(
        tools.get('Edit'),
        { path: 'ordered.txt', oldText: 'first', newText: 'second' },
        cwd,
      ),
    ]);

    expect(readFileSync(join(cwd, 'ordered.txt'), 'utf8')).toBe('second');
  });

  it('applies multiple Edit matches against the original content and returns native diffs', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'alpha beta', 'utf8');

    const result = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      {
        path: 'story.txt',
        edits: [
          { oldText: 'alpha', newText: 'beta' },
          { oldText: 'beta', newText: 'gamma' },
        ],
      },
      cwd,
    );

    expect(readFileSync(join(cwd, 'story.txt'), 'utf8')).toBe('beta gamma');
    expect(firstText(result)).toBe('Successfully replaced 2 block(s) in story.txt.');
    expect(result.details).toMatchObject({
      diff: expect.stringContaining('beta gamma'),
      patch: expect.stringContaining('story.txt'),
    });
  });

  it('rejects ambiguous and overlapping native Edit matches without writing', async () => {
    const ambiguousCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(ambiguousCwd, 'story.txt'), 'red red', 'utf8');
    const edit = collectTools(registerFileTools).get('Edit');

    await expect(
      executePreparedTool(
        edit,
        { path: 'story.txt', oldText: 'red', newText: 'green' },
        ambiguousCwd,
      ),
    ).rejects.toThrow(/multiple locations|unique/i);
    expect(readFileSync(join(ambiguousCwd, 'story.txt'), 'utf8')).toBe('red red');

    const overlapCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(overlapCwd, 'story.txt'), 'abcdef', 'utf8');
    await expect(
      executePreparedTool(
        edit,
        {
          path: 'story.txt',
          edits: [
            { oldText: 'abcd', newText: 'one' },
            { oldText: 'cdef', newText: 'two' },
          ],
        },
        overlapCwd,
      ),
    ).rejects.toThrow(/overlap/i);
    expect(readFileSync(join(overlapCwd, 'story.txt'), 'utf8')).toBe('abcdef');
  });

  it('preserves BOM and CRLF through native Edit', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'windows.txt'), '\uFEFFalpha\r\nbeta\r\n', 'utf8');

    await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { file_path: 'windows.txt', old_string: 'beta', new_string: 'gamma' },
      cwd,
    );

    expect(readFileSync(join(cwd, 'windows.txt'), 'utf8')).toBe('\uFEFFalpha\r\ngamma\r\n');
  });

  it('does not advertise unsupported Edit applyPatch input', () => {
    const edit = collectTools(registerFileTools).get('Edit') as unknown as {
      parameters: { properties: Record<string, unknown> };
    };

    expect(edit.parameters.properties).not.toHaveProperty('applyPatch');
  });

  it('throws for empty StrReplace searches and operational failures', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf8');
    mkdirSync(join(cwd, 'directory'));
    const replace = collectTools(registerFileTools).get('StrReplace');

    await expect(
      executeTool(replace, { path: 'story.txt', old_str: '', new_str: 'green' }, cwd),
    ).rejects.toThrow(/must not be empty/i);
    await expect(
      executeTool(replace, { path: 'directory', old_str: 'red', new_str: 'green' }, cwd),
    ).rejects.toThrow();
    expect(readFileSync(join(cwd, 'story.txt'), 'utf8')).toBe('red blue red');
  });

  it('respects cancellation before StrReplace reads or writes', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf8');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeToolWithOptions(
        collectTools(registerFileTools).get('StrReplace'),
        { path: 'story.txt', old_str: 'red', new_str: 'green' },
        cwd,
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/i);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf8')).toBe('red blue red');
  });

  it('cancels StrReplace after asynchronous execution starts without writing', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf8');
    const controller = new AbortController();
    const execution = executeToolWithOptions(
      collectTools(registerFileTools).get('StrReplace'),
      { path: 'story.txt', old_str: 'red', new_str: 'green' },
      cwd,
      { signal: controller.signal },
    );

    queueMicrotask(() => controller.abort());

    await expect(execution).rejects.toThrow(/aborted/i);
    expect(readFileSync(join(cwd, 'story.txt'), 'utf8')).toBe('red blue red');
  });

  it('does not lose updates from concurrent StrReplace mutations', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'alpha beta alpha', 'utf8');
    const replace = collectTools(registerFileTools).get('StrReplace');

    await Promise.all([
      executeTool(replace, { path: 'story.txt', old_str: 'alpha', new_str: 'one' }, cwd),
      executeTool(replace, { path: 'story.txt', old_str: 'beta', new_str: 'two' }, cwd),
    ]);

    expect(readFileSync(join(cwd, 'story.txt'), 'utf8')).toBe('one two one');
  });

  it('stores separate bounded StrReplace hunks for non-contiguous replacements', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(
      join(cwd, 'story.txt'),
      ['target', ...Array.from({ length: 30 }, (_, index) => `middle ${index}`), 'target'].join(
        '\n',
      ),
      'utf8',
    );

    const result = await executeTool(
      collectTools(registerFileTools).get('StrReplace'),
      { path: 'story.txt', old_str: 'target', new_str: 'replacement\nline' },
      cwd,
    );
    const details = result.details as { diff?: string; diffTruncated?: boolean };

    expect(details.diff?.match(/^@@/gm)).toHaveLength(2);
    expect(details.diffTruncated).toBe(false);
    expect(JSON.stringify(result.details).length).toBeLessThan(32_000);
    expect(
      renderToolResult(
        collectTools(registerFileTools).get('StrReplace'),
        result,
        { expanded: true, isPartial: false },
        { path: 'story.txt', old_str: 'target', new_str: 'replacement\nline' },
      ).length,
    ).toBeLessThanOrEqual(32_000);
  });

  it('summarizes very large StrReplace diffs instead of persisting unbounded output', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(
      join(cwd, 'large.txt'),
      Array.from({ length: 1_000 }, (_, index) => `target ${index}`).join('\n'),
      'utf8',
    );

    const result = await executeTool(
      collectTools(registerFileTools).get('StrReplace'),
      { path: 'large.txt', old_str: 'target', new_str: 'replacement with more text' },
      cwd,
    );
    const details = result.details as { diff?: string; diffTruncated?: boolean };

    expect(details.diffTruncated).toBe(true);
    expect(details.diff?.length ?? 0).toBeLessThanOrEqual(30_000);
    expect(JSON.stringify(result.details).length).toBeLessThan(32_000);
    const replace = collectTools(registerFileTools).get('StrReplace');
    const args = {
      path: 'large.txt',
      old_str: 'target',
      new_str: 'replacement with more text',
    };
    const collapsed = renderToolResult(
      replace,
      result,
      { expanded: false, isPartial: false },
      args,
    );
    const expanded = renderToolResult(replace, result, { expanded: true, isPartial: false }, args);
    expect(collapsed).toContain('[Diff preview truncated]');
    expect(collapsed.length).toBeLessThanOrEqual(4_100);
    expect(expanded).toContain('[Diff truncated at 26000 characters]');
    expect(expanded.length).toBeLessThanOrEqual(27_000);
  });

  it('keeps native Write previews bounded and renders delegated errors', () => {
    const write = collectTools(registerFileTools).get('Write');
    const args = {
      file_path: 'notes.txt',
      contents: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
    };

    const collapsed = renderToolCall(write, args);
    const expanded = renderToolCall(write, args, { expanded: true });
    const partial = renderToolCall(write, args, { isPartial: true });
    expect(collapsed).toContain('line 10');
    expect(collapsed).not.toContain('line 11');
    expect(expanded).toContain('line 12');
    expect(partial).toContain('line 1');
    expect(
      renderToolResult(
        write,
        {
          content: [{ type: 'text', text: 'write failed visibly' }],
          details: undefined,
        },
        { expanded: false, isPartial: false },
        args,
        { isError: true },
      ),
    ).toContain('write failed visibly');
  });

  it('renders native Edit diffs in collapsed and expanded result states', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'alpha beta', 'utf8');
    const edit = collectTools(registerFileTools).get('Edit');
    const args = { path: 'story.txt', oldText: 'alpha', newText: 'gamma' };
    const result = await executePreparedTool(edit, args, cwd);

    expect(renderToolResult(edit, result, { expanded: false, isPartial: false }, args)).toContain(
      'gamma beta',
    );
    expect(renderToolResult(edit, result, { expanded: true, isPartial: false }, args)).toContain(
      'gamma beta',
    );
  });

  it('adopts native LS defaults, suffixes, sorting, limits, and errors', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    mkdirSync(join(cwd, 'Folder'));
    writeFileSync(join(cwd, '.hidden'), '', 'utf8');
    writeFileSync(join(cwd, 'alpha'), '', 'utf8');
    writeFileSync(join(cwd, 'Beta'), '', 'utf8');
    const ls = collectTools(registerFileTools).get('LS');

    expect(firstText(await executeTool(ls, {}, cwd)).split('\n')).toEqual([
      '.hidden',
      'alpha',
      'Beta',
      'Folder/',
    ]);
    const limited = await executeTool(ls, { limit: 2 }, cwd);
    expect(firstText(limited)).toContain('2 entries limit reached');
    expect(limited.details).toMatchObject({ entryLimitReached: 2 });
    await expect(executeTool(ls, { path: 'missing' }, cwd)).rejects.toThrow(/Path not found/);

    const empty = tempDir('pi-grok-cli-files-');
    expect(firstText(await executeTool(ls, {}, empty))).toBe('(empty directory)');
  });
});
