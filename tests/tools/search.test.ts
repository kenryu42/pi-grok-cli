import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerSearchTools, sortByModifiedNewest } from '../../src/tools/search.js';
import {
  collectTools,
  executePreparedTool,
  executeTool,
  firstText,
  plainTheme,
  renderText,
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

function expectGrepResult(cwd: string, result: ToolResult) {
  expect(firstText(result)).toContain(`${join(cwd, 'src', 'alpha.ts')}:1:needle`);
  expect(firstText(result)).not.toContain('beta.md');
  expect(result.details).toEqual({ matchCount: 1 });
}

function expectGlobResult(cwd: string, result: ToolResult) {
  expect(firstText(result)).toContain(join(cwd, 'src', 'alpha.ts'));
  expect(firstText(result)).toContain(join(cwd, 'src', 'gamma.ts'));
  expect(firstText(result)).not.toContain('beta.md');
  expect(result.details).toEqual({ fileCount: 2 });
}

async function withFindFallbackTools(
  run: (tools: ReturnType<typeof collectTools>) => Promise<void>,
) {
  const bin = tempDir('pi-grok-cli-search-bin-');
  symlinkSync('/usr/bin/find', join(bin, 'find'));
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  vi.resetModules();
  try {
    await run(collectTools((await import('../../src/tools/search.js')).registerSearchTools));
  } finally {
    process.env.PATH = oldPath;
    vi.resetModules();
  }
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

    expectGrepResult(cwd, result);
  });

  it('greps matching file contents with Cursor-style glob filters', async () => {
    const cwd = setupProject();
    const result = await executePreparedTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: 'src', glob_filter: '*.ts' },
      cwd,
    );

    expectGrepResult(cwd, result);
  });

  it('greps patterns that start with a dash', async () => {
    const cwd = setupProject();
    writeFileSync(join(cwd, 'src', 'dash.ts'), '-export const value = 1\n', 'utf-8');

    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: '-export', path: 'src/dash.ts' },
      cwd,
    );

    expect(firstText(result)).toBe(`${join(cwd, 'src', 'dash.ts')}:1:-export const value = 1`);
    expect(result.details).toEqual({ matchCount: 1 });
  });

  it('includes file paths when grepping a single file', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'needle', path: 'src/alpha.ts' },
      cwd,
    );

    expect(firstText(result)).toBe(`${join(cwd, 'src', 'alpha.ts')}:1:needle`);
    expect(result.details).toEqual({ matchCount: 1 });
  });

  it('reports no grep matches as an empty result', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: 'absent', path: 'src' },
      cwd,
    );

    expect(firstText(result)).toBe('No matches found');
    expect(result.details).toEqual({ matchCount: 0 });
  });

  it('reports grep command errors with empty match details', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Grep'),
      { pattern: '[', path: 'src' },
      cwd,
    );

    expect(firstText(result).startsWith('Grep error:')).toBe(true);
    expect(result.details).toEqual({
      matchCount: 0,
      failed: true,
      error: expect.stringMatching(/regex parse error|Invalid regular expression/),
    });
  });

  it('globs files under the requested path', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expectGlobResult(cwd, result);
  });

  it('globs files with Cursor-style glob pattern arguments', async () => {
    const cwd = setupProject();
    const result = await executePreparedTool(
      collectTools(registerSearchTools).get('Glob'),
      { glob_pattern: '**/*.ts', path: 'src' },
      cwd,
    );

    expectGlobResult(cwd, result);
  });

  it('reports empty glob command results', async () => {
    const cwd = setupProject();
    const result = await executeTool(
      collectTools(registerSearchTools).get('Glob'),
      { pattern: '**/*.json', path: 'src' },
      cwd,
    );

    expect(firstText(result)).toBe('No files found');
    expect(result.details).toEqual({ fileCount: 0 });
  });

  it('globs path-containing patterns through the find fallback', async () => {
    const cwd = setupProject();
    await withFindFallbackTools(async (fallbackTools) => {
      const result = await executeTool(fallbackTools.get('Glob'), { pattern: 'src/**/*.ts' }, cwd);

      expectGlobResult(cwd, result);
    });
  });

  it('globs basename-only patterns through the find fallback', async () => {
    const cwd = setupProject();
    await withFindFallbackTools(async (fallbackTools) => {
      const result = await executeTool(fallbackTools.get('Glob'), { pattern: '*.ts' }, cwd);

      expectGlobResult(cwd, result);
    });
  });

  it('globs files without ripgrep or Unix find on PATH', async () => {
    const cwd = setupProject();
    await withNoSearchBinaries(async (fallbackTools) => {
      const result = await executeTool(fallbackTools.get('Glob'), { pattern: 'src/**/*.ts' }, cwd);

      expectGlobResult(cwd, result);
    });
  });

  it('greps files without ripgrep or Unix grep on PATH', async () => {
    const cwd = setupProject();
    await withNoSearchBinaries(async (fallbackTools) => {
      const result = await executeTool(
        fallbackTools.get('Grep'),
        { pattern: 'needle', path: 'src', include: '*.ts' },
        cwd,
      );

      expectGrepResult(cwd, result);
    });
  });

  it('greps with path-containing include patterns through the fallback', async () => {
    const cwd = setupProject();
    await withNoSearchBinaries(async (fallbackTools) => {
      const result = await executeTool(
        fallbackTools.get('Grep'),
        { pattern: 'needle', path: 'src', include: 'src/**/*.ts' },
        cwd,
      );

      expectGrepResult(cwd, result);
    });
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

    expect(firstText(result).split('\n')).toEqual([
      join(cwd, 'src', 'gamma.ts'),
      join(cwd, 'src', 'alpha.ts'),
    ]);
  });

  it('sorts existing glob results when another match is deleted before stat', () => {
    const cwd = setupProject();
    const deleted = join(cwd, 'src', 'deleted.ts');
    writeFileSync(deleted, 'deleted\n', 'utf-8');
    rmSync(deleted);

    expect(sortByModifiedNewest([deleted, join(cwd, 'src', 'alpha.ts')])).toEqual([
      join(cwd, 'src', 'alpha.ts'),
      deleted,
    ]);
  });

  it('breaks modification time ties with alphabetical ordering', () => {
    const cwd = setupProject();
    const sameTime = new Date('2024-06-01T00:00:00.000Z');
    utimesSync(join(cwd, 'src', 'gamma.ts'), sameTime, sameTime);
    utimesSync(join(cwd, 'src', 'alpha.ts'), sameTime, sameTime);

    expect(
      sortByModifiedNewest([join(cwd, 'src', 'gamma.ts'), join(cwd, 'src', 'alpha.ts')]),
    ).toEqual([join(cwd, 'src', 'alpha.ts'), join(cwd, 'src', 'gamma.ts')]);
  });

  it('renders grep calls and result states', () => {
    const grep = collectTools(registerSearchTools).get('Grep');
    const result = {
      content: [{ type: 'text', text: 'src/alpha.ts:1:needle' }],
      details: { matchCount: 1 },
    };

    expect(
      renderText(
        grep?.renderCall?.({ pattern: 'needle', path: 'src', include: '*.ts' }, plainTheme) ?? {
          render: () => [],
        },
      ),
    ).toBe('Grep "needle" in src [*.ts]');
    expect(
      renderText(
        grep?.renderResult?.(result, { expanded: false, isPartial: false }, plainTheme, {}) ?? {
          render: () => [],
        },
      ),
    ).toBe('1 match(es)');
    expect(
      renderText(
        grep?.renderResult?.(result, { expanded: true, isPartial: false }, plainTheme, {}) ?? {
          render: () => [],
        },
      ),
    ).toBe('src/alpha.ts:1:needle');
    expect(
      renderText(
        grep?.renderResult?.(
          {
            content: [{ type: 'text', text: 'No matches found' }],
            details: {},
          },
          { expanded: false, isPartial: false },
          plainTheme,
          {},
        ) ?? { render: () => [] },
      ),
    ).toBe('No matches');
    expect(
      renderText(
        grep?.renderResult?.(result, { expanded: false, isPartial: true }, plainTheme, {}) ?? {
          render: () => [],
        },
      ),
    ).toBe('Running...');
  });

  it('renders glob calls and result states', () => {
    const glob = collectTools(registerSearchTools).get('Glob');
    const result = {
      content: [{ type: 'text', text: 'src/alpha.ts\nsrc/gamma.ts' }],
      details: { fileCount: 2 },
    };

    expect(
      renderText(
        glob?.renderCall?.({ pattern: '**/*.ts', path: 'src' }, plainTheme) ?? {
          render: () => [],
        },
      ),
    ).toBe('Glob **/*.ts in src');
    expect(
      renderText(
        glob?.renderResult?.(result, { expanded: false, isPartial: false }, plainTheme, {}) ?? {
          render: () => [],
        },
      ),
    ).toBe('2 file(s)');
    expect(
      renderText(
        glob?.renderResult?.(
          { content: [{ type: 'text', text: 'No files found' }], details: {} },
          { expanded: false, isPartial: false },
          plainTheme,
          {},
        ) ?? { render: () => [] },
      ),
    ).toBe('No files');
    expect(
      renderText(
        glob?.renderResult?.(result, { expanded: false, isPartial: true }, plainTheme, {}) ?? {
          render: () => [],
        },
      ),
    ).toBe('Running...');
  });
});
