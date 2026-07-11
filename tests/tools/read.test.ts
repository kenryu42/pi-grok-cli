import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReadShim } from '../../src/tools/read.js';
import {
  executePreparedTool,
  executeTool,
  firstText,
  prepareToolArguments,
  type ToolResult,
  tempDir,
} from './toolTestHelpers.js';

type LooseTool = Parameters<typeof executeTool>[0];

const readShim = (() => createReadShim())() as unknown as LooseTool;

describe('Read shim (native read alias)', () => {
  it('registers under the capital-Read name Cursor-trained models call', () => {
    const shim = createReadShim();
    expect(shim.name).toBe('Read');
    expect(shim.label).toBe('Read');
    // Delegates the native definition's execute, parameters, and description.
    expect(typeof shim.execute).toBe('function');
    expect(shim.description).toMatch(/Read the contents of a file/i);
  });

  it('reads a text file via the native read tool with line numbers', async () => {
    const cwd = tempDir('pi-grok-cli-read-');
    writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma', 'utf-8');

    const result = (await executeTool(readShim, { path: 'notes.txt' }, cwd)) as ToolResult;

    // Native read renders each line (1-indexed).
    expect(firstText(result)).toContain('alpha');
    expect(firstText(result)).toContain('beta');
    expect(firstText(result)).toContain('gamma');
  });

  it('normalizes Cursor file_path onto the native path parameter', () => {
    const prepared = prepareToolArguments(readShim, { file_path: 'src/app.ts', offset: 10 });
    expect(prepared).toEqual({ path: 'src/app.ts', offset: 10, limit: undefined });
  });

  it('passes path through unchanged when already in native shape', () => {
    const prepared = prepareToolArguments(readShim, { path: 'README.md', limit: 50 });
    expect(prepared).toEqual({ path: 'README.md', offset: undefined, limit: 50 });
  });

  it('normalizes missing and invalid arguments to safe defaults', () => {
    const shim = createReadShim();

    expect(shim.prepareArguments(null)).toEqual({ path: '' });
    expect(shim.prepareArguments({ path: 42, offset: '10', limit: false })).toEqual({
      path: '',
      offset: undefined,
      limit: undefined,
    });
  });

  it('executes through the prepared Cursor-style arguments', async () => {
    const cwd = tempDir('pi-grok-cli-read-');
    writeFileSync(join(cwd, 'story.txt'), 'once upon a time', 'utf-8');

    const result = (await executePreparedTool(
      readShim,
      { file_path: 'story.txt' },
      cwd,
    )) as ToolResult;
    expect(firstText(result)).toContain('once upon a time');
  });
});
