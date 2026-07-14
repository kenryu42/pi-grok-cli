import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerSearchTools } from '../../src/tools/search.js';
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

function setupProject() {
  const dir = tempDir('pi-grok-cli-search-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'alpha.ts'), 'needle\nhaystack\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'beta.md'), 'needle in docs\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'gamma.ts'), 'plain text\n', 'utf-8');
  return dir;
}

function expectGrepResult(result: ToolResult) {
  expect(firstText(result)).toContain('alpha.ts:1: needle');
  expect(firstText(result)).not.toContain('beta.md');
  expect(result.details).toBeUndefined();
}

function expectGlobResult(result: ToolResult) {
  expect(firstText(result)).toContain('src/alpha.ts');
  expect(firstText(result)).toContain('src/gamma.ts');
  expect(firstText(result)).not.toContain('beta.md');
  expect(result.details).toBeUndefined();
}

async function withNoSearchBinaries(
  run: (tools: ReturnType<typeof collectTools>) => Promise<void>,
) {
  const oldPath = process.env.PATH;
  process.env.PATH = tempDir('pi-grok-cli-empty-bin-');
  vi.resetModules();
  try {
    await run(collectTools((await import('../../src/tools/search.js')).registerSearchTools));
  } finally {
    process.env.PATH = oldPath;
    vi.resetModules();
  }
}

describe('search tools', () => {
  it('greps matching file contents with include filters', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: 'src', include: '*.ts' },
      cwd,
    );

    expectGrepResult(result);
  });

  it('greps matching file contents with Cursor-style glob filters', async () => {
    const cwd = setupProject();
    const result = await executePreparedTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: 'src', glob_filter: '*.ts' },
      cwd,
    );

    expectGrepResult(result);
  });

  it('greps patterns that start with a dash', async () => {
    const cwd = setupProject();
    writeFileSync(join(cwd, 'src', 'dash.ts'), '-export const value = 1\n', 'utf-8');

    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: '-export', path: 'src/dash.ts' },
      cwd,
    );

    expect(firstText(result)).toBe('dash.ts:1: -export const value = 1');
    expect(result.details).toBeUndefined();
  });

  it('includes file paths when grepping a single file', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: 'src/alpha.ts' },
      cwd,
    );

    expect(firstText(result)).toBe('alpha.ts:1: needle');
    expect(result.details).toBeUndefined();
  });

  it('reports no grep matches as an empty result', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'absent', path: 'src' },
      cwd,
    );

    expect(firstText(result)).toBe('No matches found');
    expect(result.details).toBeUndefined();
  });

  it('reports grep command errors with empty match details', async () => {
    const cwd = setupProject();
    await expect(
      executeTool(
        collectTools(registerSearchTools).get('Grep'),
        { pattern: '[', path: 'src' },
        cwd,
      ),
    ).rejects.toThrow(/regex parse error|Invalid regular expression/);
  });

  it('globs files under the requested path', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expectGlobResult(result);
  });

  it('globs files with Cursor-style glob pattern arguments', async () => {
    const cwd = setupProject();
    const result = await executePreparedTool(
      collectTools(registerSearchTools).get('Glob'),
      { glob_pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expectGlobResult(result);
  });

  it('reports empty glob command results', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.json', path: 'src' },
      cwd,
    );

    expect(firstText(result)).toBe('No files found');
    expect(result.details).toBeUndefined();
  });

  it('reports glob filesystem errors', async () => {
    const cwd = setupProject();
    await expect(
      executeTool(
        collectTools(registerSearchTools).get('Glob'),
        { pattern: '**/*.ts', path: 'missing' },
        cwd,
      ),
    ).rejects.toThrow(/Path not found/);
  });

  it('globs path-containing patterns without external search binaries', async () => {
    const cwd = setupProject();
    await withNoSearchBinaries(async (fallbackTools) => {
      const result = await executeTool(fallbackTools.get('Glob'), { pattern: 'src/**/*.ts' }, cwd);

      expectGlobResult(result);
    });
  });

  it('globs basename-only patterns relative to an explicit root', async () => {
    const cwd = setupProject();
    await withNoSearchBinaries(async (fallbackTools) => {
      const result = await executeTool(
        fallbackTools.get('Glob'),
        { pattern: '*.ts', path: 'src' },
        cwd,
      );

      expectGlobResult(result);
    });
  });

  it('globs files without ripgrep or Unix find on PATH', async () => {
    const cwd = setupProject();
    writeFileSync(join(cwd, '.hidden.ts'), '', 'utf8');
    await withNoSearchBinaries(async (fallbackTools) => {
      const result = await executeTool(
        fallbackTools.get('Glob'),
        { pattern: '**/*.ts', path: '.' },
        cwd,
      );

      expect(firstText(result)).toContain('.hidden.ts');
      expect(firstText(result)).toContain('src/alpha.ts');
    });
  });

  it('greps literal metacharacters through the native engine', async () => {
    const cwd = setupProject();
    writeFileSync(join(cwd, 'src', 'literal.ts'), 'needle.[\n', 'utf8');
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle.[', path: 'src', glob: '*.ts', literal: true },
      cwd,
    );

    expect(firstText(result)).toBe('literal.ts:1: needle.[');
  });

  it('greps with path-containing native glob filters', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: 'src', glob: '**/*.ts' },
      cwd,
    );

    expect(firstText(result)).toBe('alpha.ts:1: needle');
  });

  it('sorts glob results by modification time newest first', async () => {
    const cwd = setupProject();
    const oldTime = new Date('2024-01-01T00:00:00.000Z');
    const newTime = new Date('2024-01-02T00:00:00.000Z');
    utimesSync(join(cwd, 'src', 'alpha.ts'), oldTime, oldTime);
    utimesSync(join(cwd, 'src', 'gamma.ts'), newTime, newTime);
    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expect(firstText(result).split('\n')).toEqual(['src/gamma.ts', 'src/alpha.ts']);
  });

  it('omits glob candidates deleted before traversal', async () => {
    const cwd = setupProject();
    const deleted = join(cwd, 'src', 'deleted.ts');
    writeFileSync(deleted, 'deleted\n', 'utf-8');
    rmSync(deleted);

    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expect(firstText(result)).not.toContain('deleted.ts');
  });

  it('breaks modification time ties with alphabetical ordering', async () => {
    const cwd = setupProject();
    const sameTime = new Date('2024-06-01T00:00:00.000Z');
    utimesSync(join(cwd, 'src', 'gamma.ts'), sameTime, sameTime);
    utimesSync(join(cwd, 'src', 'alpha.ts'), sameTime, sameTime);

    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expect(firstText(result).split('\n')).toEqual(['src/alpha.ts', 'src/gamma.ts']);
  });

  it('renders grep calls and result states', () => {
    const grep = collectTools(registerSearchTools).get('Grep');
    const result = {
      content: [{ type: 'text', text: 'src/alpha.ts:1: needle' }],
      details: undefined,
    };

    expect(renderToolCall(grep, { pattern: 'needle', path: 'src', include: '*.ts' })).toBe(
      'grep /needle/ in src (*.ts)',
    );
    expect(renderToolResult(grep, result)).toContain('src/alpha.ts:1: needle');
    expect(renderToolResult(grep, result, { expanded: true, isPartial: false })).toContain(
      'src/alpha.ts:1: needle',
    );
    expect(
      renderToolResult(grep, {
        content: [{ type: 'text', text: 'No matches found' }],
        details: undefined,
      }),
    ).toContain('No matches found');
    expect(renderToolResult(grep, result, { expanded: false, isPartial: true })).toContain(
      'src/alpha.ts:1: needle',
    );
  });

  it('renders glob calls and result states', () => {
    const glob = collectTools(registerSearchTools).get('Glob');
    const result = {
      content: [{ type: 'text', text: 'src/alpha.ts\nsrc/gamma.ts' }],
      details: undefined,
    };

    expect(renderToolCall(glob, { pattern: '**/*.ts', path: 'src' })).toBe('find **/*.ts in src');
    expect(renderToolResult(glob, result)).toContain('src/alpha.ts');
    expect(
      renderToolResult(glob, {
        content: [{ type: 'text', text: 'No files found' }],
        details: undefined,
      }),
    ).toContain('No files found');
    expect(renderToolResult(glob, result, { expanded: false, isPartial: true })).toContain(
      'src/gamma.ts',
    );
  });
});

describe('native Grep adapter contracts', () => {
  it('normalizes query and all observed glob aliases', () => {
    const grep = collectTools(registerSearchTools).get('Grep');

    expect(
      prepareToolArguments(grep, {
        query: 'needle',
        path: 'src',
        include: '*.ts',
        ignore_case: true,
      }),
    ).toEqual({
      pattern: 'needle',
      path: 'src',
      glob: '*.ts',
      ignoreCase: true,
      literal: undefined,
      context: undefined,
      limit: undefined,
    });
    expect(prepareToolArguments(grep, { pattern: 'x', glob_filter: '**/*.md' })).toMatchObject({
      pattern: 'x',
      glob: '**/*.md',
    });
  });

  it('delegates literal, ignore-case, context, and limit behavior to native grep', async () => {
    const cwd = tempDir('pi-grok-cli-search-');
    writeFileSync(join(cwd, 'sample.txt'), 'before\nNeedle.[\nafter\nneedle.[ again\n', 'utf8');

    const result = await executePreparedTool(
      collectTools(registerSearchTools).get('Grep'),
      {
        query: 'needle.[',
        path: '.',
        include: '*.txt',
        ignoreCase: true,
        literal: true,
        context: 1,
        limit: 1,
      },
      cwd,
    );

    expect(firstText(result)).toContain('sample.txt:2: Needle.[');
    expect(firstText(result)).toContain('sample.txt-1- before');
    expect(firstText(result)).toContain('1 matches limit reached');
    expect(result.details).toMatchObject({ matchLimitReached: 1 });
  });

  it('uses native .gitignore handling', async () => {
    const cwd = tempDir('pi-grok-cli-search-');
    mkdirSync(join(cwd, '.git'));
    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n', 'utf8');
    writeFileSync(join(cwd, 'ignored.txt'), 'needle\n', 'utf8');
    writeFileSync(join(cwd, 'visible.txt'), 'haystack\n', 'utf8');

    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: '.' },
      cwd,
    );

    expect(firstText(result)).toBe('No matches found');
    expect(result.details).toBeUndefined();
  });

  it('reports native long-line and result truncation metadata', async () => {
    const cwd = tempDir('pi-grok-cli-search-');
    writeFileSync(join(cwd, 'long.txt'), `needle ${'x'.repeat(700)}\n`, 'utf8');

    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: '.' },
      cwd,
    );

    expect(firstText(result)).toContain('Some lines truncated');
    expect(result.details).toMatchObject({ linesTruncated: true });
  });

  it('throws native cancellation and invalid-regex errors', async () => {
    const cwd = setupProject();
    const grep = collectTools(registerSearchTools).get('Grep');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeToolWithOptions(grep, { pattern: 'needle', path: 'src' }, cwd, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    await expect(executeTool(grep, { pattern: '[', path: 'src' }, cwd)).rejects.toThrow(
      /regex parse error|invalid regular expression/i,
    );
  });

  it('uses native collapsed and expanded rendering with normalized aliases', async () => {
    const cwd = setupProject();
    const grep = collectTools(registerSearchTools).get('Grep');
    const args = { query: 'needle', path: 'src', include: '*.ts' };
    const result = await executePreparedTool(grep, args, cwd);

    expect(renderToolCall(grep, args)).toBe('grep /needle/ in src (*.ts)');
    expect(renderToolResult(grep, result, { expanded: false, isPartial: false }, args)).toContain(
      'alpha.ts:1: needle',
    );
    expect(renderToolResult(grep, result, { expanded: true, isPartial: false }, args)).toContain(
      'alpha.ts:1: needle',
    );
  });
});
