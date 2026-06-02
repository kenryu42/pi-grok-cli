import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerFileTools } from '../../src/tools/files.js';
import {
  collectTools,
  executePreparedTool,
  executeTool,
  firstText,
  renderToolCall,
  renderToolResult,
  type ToolResult,
  tempDir,
} from './toolTestHelpers.js';

function expectStoryState(result: ToolResult, cwd: string, replacements: number, content: string) {
  expect(result.details).toEqual({
    path: expectedPath(cwd, 'story.txt'),
    replacements,
  });
  expect(readFileSync(join(cwd, 'story.txt'), 'utf-8')).toBe(content);
}

function expectedPath(cwd: string, ...parts: string[]) {
  return join(realpathSync(cwd), ...parts);
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
    expect(result.details).toEqual({ path: realpathSync(cwd) });
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
      expect(result.details).toEqual({ path: realpathSync(cwd) });
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

    const lsResult = await executeTool(tools.get('LS'), { path: 'missing-dir' }, cwd);
    const readResult = await executeTool(tools.get('Read'), { path: 'dir' }, cwd);
    const writeResult = await executeTool(
      tools.get('Write'),
      { path: 'blocked/file.txt', content: 'content' },
      cwd,
    );
    const replaceResult = await executeTool(
      tools.get('StrReplace'),
      { path: 'dir', old_str: 'old', new_str: 'new' },
      cwd,
    );
    const deleteResult = await executeTool(tools.get('Delete'), { path: 'dir' }, cwd);

    expect(firstText(lsResult).startsWith('LS error:')).toBe(true);
    expect(firstText(readResult).startsWith('Read error:')).toBe(true);
    expect(firstText(writeResult).startsWith('Write error:')).toBe(true);
    expect(firstText(replaceResult).startsWith('StrReplace error:')).toBe(true);
    expect(firstText(deleteResult).startsWith('Delete error:')).toBe(true);
    expect(writeResult.details).toEqual({
      path: join(cwd, 'blocked', 'file.txt'),
      bytesWritten: 0,
      failed: true,
      error: expect.stringContaining('EEXIST: file already exists, mkdir'),
    });
    expect(replaceResult.details).toEqual({
      path: join(cwd, 'dir'),
      replacements: 0,
      failed: true,
      error: expect.stringContaining('EISDIR: illegal operation on a directory, read'),
    });
    expect(deleteResult.details).toEqual({
      path: join(cwd, 'dir'),
      deleted: false,
      failed: true,
      error: expect.stringMatching(
        /EISDIR: illegal operation on a directory|operation not permitted/,
      ),
    });
  });

  it('writes a nested file and reads a requested line window', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const tools = collectTools(registerFileTools);

    const writeResult = await executeTool(
      tools.get('Write'),
      { path: 'nested/notes.txt', content: 'alpha\nbeta\ngamma\ndelta' },
      cwd,
    );

    expect(firstText(writeResult)).toBe('Successfully wrote 22 bytes to nested/notes.txt');
    expect(writeResult.details).toEqual({
      path: expectedPath(cwd, 'nested/notes.txt'),
      bytesWritten: 22,
    });

    const readResult = await executeTool(
      tools.get('Read'),
      { path: 'nested/notes.txt', offset: 1, limit: 2 },
      cwd,
    );

    expect(firstText(readResult)).toBe(
      '2\tbeta\n3\tgamma\n\n[Showing lines 2-3 of 4 total lines. Use offset to see more.]',
    );
    expect(readResult.details).toEqual({
      path: expectedPath(cwd, 'nested/notes.txt'),
      totalLines: 4,
    });
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
    expect(result.details).toEqual({
      path: expectedPath(cwd, 'nested/notes.txt'),
      bytesWritten: 10,
    });
  });

  it('reports UTF-8 bytes written for multibyte content', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const result = await executeTool(
      collectTools(registerFileTools).get('Write'),
      { path: 'emoji.txt', content: 'a🙂漢' },
      cwd,
    );

    expect(firstText(result)).toBe('Successfully wrote 8 bytes to emoji.txt');
    expect(result.details).toEqual({
      path: expectedPath(cwd, 'emoji.txt'),
      bytesWritten: 8,
    });
  });

  it('honors a zero read limit', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta', 'utf-8');
    const result = await executeTool(
      collectTools(registerFileTools).get('Read'),
      { path: 'notes.txt', limit: 0 },
      cwd,
    );

    expect(firstText(result)).toBe(
      '\n\n[Showing lines 1-0 of 2 total lines. Use offset to see more.]',
    );
    expect(result.details).toEqual({
      path: expectedPath(cwd, 'notes.txt'),
      totalLines: 2,
    });
  });

  it('does not add a blank numbered line for files ending with a newline', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta\n', 'utf-8');
    const result = await executeTool(
      collectTools(registerFileTools).get('Read'),
      { path: 'notes.txt' },
      cwd,
    );

    expect(firstText(result)).toBe('1\talpha\n2\tbeta');
    expect(result.details).toEqual({
      path: expectedPath(cwd, 'notes.txt'),
      totalLines: 2,
    });
  });

  it('reports missing files without throwing', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const result = await executeTool(
      collectTools(registerFileTools).get('Read'),
      { path: 'missing.txt' },
      cwd,
    );

    expect(firstText(result)).toBe(`File not found: ${join(cwd, 'missing.txt')}`);
    expect(result.details).toEqual({
      path: join(cwd, 'missing.txt'),
      exists: false,
      totalLines: 0,
    });
  });

  it('rejects paths that escape the workspace', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    const outside = tempDir('pi-grok-cli-files-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf-8');
    symlinkSync(outside, join(cwd, 'outside'));

    const readResult = await executeTool(
      collectTools(registerFileTools).get('Read'),
      { path: 'outside/secret.txt' },
      cwd,
    );
    const writeResult = await executeTool(
      collectTools(registerFileTools).get('Write'),
      { path: '../escape.txt', content: 'escape' },
      cwd,
    );

    expect(firstText(readResult)).toBe('Read error: Path is outside the workspace');
    expect(readResult.details).toEqual({
      path: join(cwd, 'outside', 'secret.txt'),
      exists: true,
      totalLines: 0,
      failed: true,
      error: 'Path is outside the workspace',
    });
    expect(firstText(writeResult)).toBe('Write error: Path is outside the workspace');
    expect(writeResult.details).toEqual({
      path: join(cwd, '..', 'escape.txt'),
      bytesWritten: 0,
      failed: true,
      error: 'Path is outside the workspace',
    });
    expect(existsSync(join(cwd, '..', 'escape.txt'))).toBe(false);
  });

  it('renders read errors for existing paths without claiming the file is missing', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    mkdirSync(join(cwd, 'dir'));
    const tools = collectTools(registerFileTools);
    const result = await executeTool(tools.get('Read'), { path: 'dir' }, cwd);

    expect(firstText(result).startsWith('Read error:')).toBe(true);
    expect(result.details).toEqual({
      path: join(cwd, 'dir'),
      exists: true,
      totalLines: 0,
      failed: true,
      error: expect.stringContaining('EISDIR: illegal operation on a directory, read'),
    });
    expect(renderToolResult(tools.get('Read'), result)).toBe('0 line(s)');
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

    const result = await strReplace(cwd, '', 'green');

    expect(firstText(result)).toBe('StrReplace error: old_str must not be empty');
    expectStoryState(result, cwd, 0, 'red blue red');
  });

  it('treats replacement text as a literal string', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'abc', 'utf-8');

    const result = await strReplace(cwd, 'a', '$&');

    expect(firstText(result)).toBe('Replaced 1 occurrence(s) in story.txt');
    expectStoryState(result, cwd, 1, '$&bc');
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
    writeFileSync(join(singleCwd, 'story.txt'), 'red blue red', 'utf-8');

    const singleResult = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { path: 'story.txt', oldText: 'red', newText: 'green' },
      singleCwd,
    );

    expect(firstText(singleResult)).toBe('Applied 2 replacement(s) in story.txt');
    expectStoryState(singleResult, singleCwd, 2, 'green blue green');

    const multipleCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(multipleCwd, 'story.txt'), 'red blue red', 'utf-8');

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

    expect(firstText(multipleResult)).toBe('Applied 3 replacement(s) in story.txt');
    expectStoryState(multipleResult, multipleCwd, 3, 'green yellow green');

    const stringifiedCwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(stringifiedCwd, 'story.txt'), 'red blue red', 'utf-8');

    const stringifiedResult = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      {
        path: 'story.txt',
        edits: JSON.stringify([{ oldText: 'red', newText: 'green' }]),
      },
      stringifiedCwd,
    );

    expect(firstText(stringifiedResult)).toBe('Applied 2 replacement(s) in story.txt');
    expectStoryState(stringifiedResult, stringifiedCwd, 2, 'green blue green');
  });

  it('edits files with literal replacement text', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'abc', 'utf-8');

    const result = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { path: 'story.txt', oldText: 'a', newText: '$&' },
      cwd,
    );

    expect(firstText(result)).toBe('Applied 1 replacement(s) in story.txt');
    expectStoryState(result, cwd, 1, '$&bc');
  });

  it('rejects empty edit search strings without changing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    const result = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { path: 'story.txt', oldText: '', newText: 'green' },
      cwd,
    );

    expect(firstText(result)).toBe('Edit error: oldText must not be empty');
    expectStoryState(result, cwd, 0, 'red blue red');
  });

  it('reports unsupported edit strategies without changing files', async () => {
    const cwd = tempDir('pi-grok-cli-files-');
    writeFileSync(join(cwd, 'story.txt'), 'red blue red', 'utf-8');

    const result = await executePreparedTool(
      collectTools(registerFileTools).get('Edit'),
      { path: 'story.txt', applyPatch: { patchContent: 'patch' } },
      cwd,
    );

    expect(firstText(result)).toBe(
      'Edit error: applyPatch is not supported by this Grok tool shim',
    );
    expectStoryState(result, cwd, 0, 'red blue red');
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

    expect(renderToolCall(tools.get('LS'), { path: '.' })).toBe('LS .');
    expect(
      renderToolCall(tools.get('Read'), {
        path: 'notes.txt',
        offset: 5,
        limit: 10,
      }),
    ).toBe('Read notes.txt (from 5, 10 lines)');
    expect(renderToolCall(tools.get('StrReplace'), { path: 'notes.txt' })).toBe(
      'StrReplace notes.txt',
    );
    expect(renderToolCall(tools.get('Delete'), { path: 'notes.txt' })).toBe('Delete notes.txt');
    expect(
      renderToolResult(tools.get('Read'), {
        content: [{ type: 'text', text: 'missing' }],
        details: { exists: false, totalLines: 0 },
      }),
    ).toBe('File not found');
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
      renderToolResult(
        tools.get('LS'),
        {
          content: [{ type: 'text', text: 'full listing' }],
          details: { path: '/tmp/project' },
        },
        { expanded: true, isPartial: false },
      ),
    ).toBe('full listing');
    expect(
      renderToolResult(
        tools.get('Write'),
        {
          content: [{ type: 'text', text: 'writing' }],
          details: { bytesWritten: 10 },
        },
        { expanded: false, isPartial: true },
      ),
    ).toBe('Running...');
  });
});
