import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveToolDisplayConfig } from '../../src/tools/displayConfig.js';
import { createReadShim } from '../../src/tools/read.js';
import {
  executePreparedTool,
  executeTool,
  firstText,
  prepareToolArguments,
  renderToolResult,
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

  it('summarizes collapsed results with path, range, and optional preview', () => {
    const result = {
      content: [{ type: 'text', text: 'line 1\nline 2\nline 3' }],
      details: {},
    };

    expect(
      renderToolResult(
        readShim,
        result,
        { expanded: false, isPartial: false },
        {
          args: { path: 'notes.txt' },
        },
      ),
    ).toBe('Read notes.txt');

    expect(
      renderToolResult(
        readShim,
        result,
        { expanded: false, isPartial: false },
        {
          args: { file_path: 'src/app.ts', offset: 10, limit: 20 },
        },
      ),
    ).toBe('Read src/app.ts (offset=10, limit=20)');

    expect(renderToolResult(readShim, result, { expanded: false, isPartial: false }, {})).toBe(
      'Read complete',
    );

    expect(
      renderToolResult(
        readShim,
        result,
        { expanded: false, isPartial: true },
        {
          args: { path: 'notes.txt' },
        },
      ),
    ).toBe('Running...');

    const previousConfigPath = process.env.PI_GROK_CLI_TOOLS_CONFIG;
    process.env.PI_GROK_CLI_TOOLS_CONFIG = join(tempDir('pi-grok-cli-read-config-'), 'tools.json');
    try {
      saveToolDisplayConfig({
        toolDisplay: 'preview',
        grepPreviewMatches: 10,
        globPreviewFiles: 20,
        lsPreviewEntries: 20,
        shellTailLines: 20,
        readPreviewLines: 2,
        writeCallPreviewLines: 10,
        webSearchPreviewChars: 500,
      });

      expect(
        renderToolResult(
          readShim,
          result,
          { expanded: false, isPartial: false },
          {
            args: { path: 'notes.txt' },
          },
        ),
      ).toBe('Read notes.txt\nline 1\nline 2\n[Showing first 2 of 3 lines.]');
    } finally {
      process.env.PI_GROK_CLI_TOOLS_CONFIG = previousConfigPath;
    }
  });

  it('delegates expanded results to the native read renderer', () => {
    const result = {
      content: [{ type: 'text', text: 'alpha\nbeta' }],
      details: {},
    };

    expect(
      renderToolResult(
        readShim,
        result,
        { expanded: true, isPartial: false },
        {
          args: { path: 'notes.txt' },
        },
      ),
    ).toContain('alpha');
  });
});
