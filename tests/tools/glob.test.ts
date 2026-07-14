import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerSearchTools } from '../../src/tools/search.js';
import {
  collectTools,
  executePreparedTool,
  executeTool,
  executeToolWithOptions,
  firstText,
  tempDir,
} from './toolTestHelpers.js';

function globTool() {
  return collectTools(registerSearchTools).get('Glob');
}

function writeAt(path: string, contents: string, timestamp: string) {
  writeFileSync(path, contents, 'utf8');
  const time = new Date(timestamp);
  utimesSync(path, time, time);
}

describe('Glob compatibility contract', () => {
  it('returns files only in globally newest-first order with a deterministic path tie-break', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'src', 'directory.ts'));
    writeAt(join(cwd, 'src', 'older.ts'), 'old', '2026-01-01T00:00:00Z');
    writeAt(join(cwd, 'src', 'z-tied.ts'), 'z', '2026-01-02T00:00:00Z');
    writeAt(join(cwd, 'src', 'a-tied.ts'), 'a', '2026-01-02T00:00:00Z');

    const result = await executeTool(globTool(), { pattern: '**/*.ts', path: 'src' }, cwd);

    expect(firstText(result).split('\n')).toEqual([
      'src/a-tied.ts',
      'src/z-tied.ts',
      'src/older.ts',
    ]);
  });

  it('supports both Cursor path and pattern alias pairs', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    mkdirSync(join(cwd, 'nested'));
    writeFileSync(join(cwd, 'nested', 'match.ts'), '', 'utf8');

    const nativeNames = await executePreparedTool(
      globTool(),
      { pattern: '*.ts', path: 'nested' },
      cwd,
    );
    const cursorNames = await executePreparedTool(
      globTool(),
      { glob_pattern: '*.ts', target_directory: 'nested' },
      cwd,
    );

    expect(firstText(nativeNames)).toBe('nested/match.ts');
    expect(firstText(cursorNames)).toBe('nested/match.ts');
  });

  it('includes hidden files while honoring root and nested gitignore rules', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'ignored'));
    writeFileSync(join(cwd, '.gitignore'), 'ignored/\nroot-skip.ts\n', 'utf8');
    writeFileSync(join(cwd, 'src', '.gitignore'), 'nested-skip.ts\n', 'utf8');
    writeFileSync(join(cwd, '.hidden.ts'), '', 'utf8');
    writeFileSync(join(cwd, 'root-skip.ts'), '', 'utf8');
    writeFileSync(join(cwd, 'src', 'keep.ts'), '', 'utf8');
    writeFileSync(join(cwd, 'src', 'nested-skip.ts'), '', 'utf8');
    writeFileSync(join(cwd, 'ignored', 'ignored.ts'), '', 'utf8');

    const result = await executeTool(globTool(), { pattern: '**/*.ts' }, cwd);

    expect(firstText(result).split('\n').sort()).toEqual(['.hidden.ts', 'src/keep.ts']);
  });

  it('traverses an explicitly selected ignored root but applies rules inside it', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    mkdirSync(join(cwd, 'ignored'));
    writeFileSync(join(cwd, '.gitignore'), 'ignored/\n', 'utf8');
    writeFileSync(join(cwd, 'ignored', '.gitignore'), 'inside-skip.ts\n', 'utf8');
    writeFileSync(join(cwd, 'ignored', 'keep.ts'), '', 'utf8');
    writeFileSync(join(cwd, 'ignored', 'inside-skip.ts'), '', 'utf8');

    const result = await executeTool(globTool(), { pattern: '*.ts', path: 'ignored' }, cwd);

    expect(firstText(result)).toBe('ignored/keep.ts');
  });

  it('never traverses .git, node_modules, or symlinked directories', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    const outside = tempDir('pi-grok-cli-glob-outside-');
    mkdirSync(join(cwd, '.git'));
    mkdirSync(join(cwd, 'node_modules'));
    writeFileSync(join(cwd, '.git', 'config.ts'), '', 'utf8');
    writeFileSync(join(cwd, 'node_modules', 'package.ts'), '', 'utf8');
    writeFileSync(join(outside, 'escaped.ts'), '', 'utf8');
    symlinkSync(outside, join(cwd, 'linked'));
    writeFileSync(join(cwd, 'visible.ts'), '', 'utf8');

    const result = await executeTool(globTool(), { pattern: '**/*.ts' }, cwd);

    expect(firstText(result)).toBe('visible.ts');
  });

  it('keeps outside-workspace results absolute and valid for follow-up reads', async () => {
    const cwd = tempDir('pi-grok-cli-glob-workspace-');
    const outside = tempDir('pi-grok-cli-glob-outside-');
    writeFileSync(join(outside, 'external.ts'), '', 'utf8');

    const result = await executeTool(globTool(), { pattern: '*.ts', path: outside }, cwd);

    expect(firstText(result)).toBe(join(outside, 'external.ts'));
  });

  it('applies the result limit after global sorting and reports explicit bounded truncation', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    for (let index = 0; index < 200; index++) {
      writeAt(
        join(cwd, `${String(index).padStart(3, '0')}.ts`),
        '',
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      );
    }

    const result = await executeTool(globTool(), { pattern: '*.ts', limit: 2 }, cwd);

    expect(firstText(result).split('\n').slice(0, 2)).toEqual(['199.ts', '198.ts']);
    expect(firstText(result)).toContain('2 results limit reached');
    expect(result.details).toMatchObject({ resultLimitReached: 2 });
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  it('throws for missing roots and cancellation', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeTool(globTool(), { pattern: '*.ts', path: 'missing' }, cwd),
    ).rejects.toThrow(/not found/i);
    await expect(
      executeToolWithOptions(globTool(), { pattern: '**/*' }, cwd, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it('cancels after asynchronous traversal has started', async () => {
    const cwd = tempDir('pi-grok-cli-glob-');
    mkdirSync(join(cwd, 'nested'));
    writeFileSync(join(cwd, 'nested', 'match.ts'), '', 'utf8');
    const controller = new AbortController();
    const result = executeToolWithOptions(globTool(), { pattern: '**/*.ts' }, cwd, {
      signal: controller.signal,
    });

    queueMicrotask(() => controller.abort());

    await expect(result).rejects.toThrow(/aborted/i);
  });
});
