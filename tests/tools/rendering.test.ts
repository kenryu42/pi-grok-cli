import { describe, expect, it } from 'vitest';
import {
  argsFromRenderContext,
  booleanDetail,
  detailRecord,
  fileError,
  fileNotFound,
  globToRegExp,
  MAX_LINES,
  MAX_OUTPUT_CHARS,
  numberDetail,
  previewChars,
  previewLines,
  renderResultSummary,
  renderResultText,
  renderResultWithPreview,
  renderRunning,
  stringDetail,
  text,
  toolError,
  truncateChars,
  truncateLines,
} from '../../src/tools/rendering.js';
import { plainTheme, renderText } from './toolTestHelpers.js';

describe('tool rendering helpers', () => {
  it('truncates long result lists and large output', () => {
    expect(truncateLines(['one', 'two'])).toBe('one\ntwo');
    expect(
      truncateLines(Array.from({ length: MAX_LINES + 1 }, String)).endsWith(
        `\n\n[Showing first ${MAX_LINES} of ${MAX_LINES + 1} results. Refine your pattern to narrow results.]`,
      ),
    ).toBe(true);
    expect(truncateChars('short')).toBe('short');
    expect(truncateChars('x'.repeat(MAX_OUTPUT_CHARS + 1))).toBe(
      `${'x'.repeat(MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`,
    );
  });

  it('renders summaries, expanded text, missing text fallback, and partial state', () => {
    const result = {
      content: [{ type: 'text', text: 'full output' }],
      details: {},
    };

    expect(renderText(text('plain'))).toBe('plain');
    expect(renderText(renderResultText(result, false, 'summary'))).toBe('summary');
    expect(renderText(renderResultText(result, true, 'summary'))).toBe('full output');
    expect(
      renderText(
        renderResultText(
          { content: [{ type: 'image' }] } as Parameters<typeof renderResultText>[0],
          true,
          'summary',
        ),
      ),
    ).toBe('summary');
    expect(renderText(renderRunning(true) ?? text(''))).toBe('Running...');
    expect(renderRunning(false)).toBeUndefined();
    expect(renderText(renderResultSummary(result, false, true, 'summary'))).toBe('Running...');
  });

  it('extracts args from render contexts and builds previews', () => {
    expect(argsFromRenderContext({ args: { path: 'a.txt' } })).toEqual({ path: 'a.txt' });
    expect(argsFromRenderContext({ path: 'b.txt' })).toEqual({ path: 'b.txt' });
    expect(argsFromRenderContext(null)).toEqual({});

    expect(previewLines('one\ntwo\nthree', 0)).toEqual([]);
    expect(previewLines('one\ntwo\nthree', 10)).toEqual(['one', 'two', 'three']);
    expect(previewLines('one\ntwo\nthree\nfour', 2)).toEqual([
      'one',
      'two',
      '[Showing first 2 of 4 lines.]',
    ]);
    expect(previewLines('one\ntwo\nthree\nfour', 2, 'tail')).toEqual([
      'three',
      'four',
      '[Showing last 2 of 4 lines.]',
    ]);

    expect(previewChars('short', 0)).toBe('');
    expect(previewChars('short', 10)).toBe('short');
    expect(previewChars('abcdefghij', 4)).toBe('abcd\n[Preview truncated at 4 characters.]');

    const result = {
      content: [{ type: 'text', text: 'full output' }],
      details: {},
    };
    expect(
      renderText(
        renderResultWithPreview(
          result,
          { expanded: false, isPartial: true },
          'summary',
          ['preview'],
          plainTheme,
        ),
      ),
    ).toBe('Running...');
    expect(
      renderText(
        renderResultWithPreview(
          result,
          { expanded: true, isPartial: false },
          'summary',
          ['preview'],
          plainTheme,
        ),
      ),
    ).toBe('full output');
    expect(
      renderText(
        renderResultWithPreview(
          result,
          { expanded: false, isPartial: false },
          'summary',
          [],
          plainTheme,
        ),
      ),
    ).toBe('summary');
    expect(
      renderText(
        renderResultWithPreview(
          result,
          { expanded: false, isPartial: false },
          'summary',
          ['line a', 'line b'],
          plainTheme,
        ),
      ),
    ).toBe('summary\nline a\nline b');
    expect(
      renderText(
        renderResultWithPreview(
          result,
          { expanded: false, isPartial: false },
          'summary',
          'string preview',
          plainTheme,
        ),
      ),
    ).toBe('summary\nstring preview');
  });

  it('reads typed detail values with defaults for absent or invalid details', () => {
    const result = {
      content: [{ type: 'text', text: '' }],
      details: { count: 2, path: 'file.txt', deleted: true, invalid: null },
    };

    expect(detailRecord(result)).toEqual(result.details);
    expect(detailRecord({ details: null })).toEqual({});
    expect(numberDetail(result, 'count')).toBe(2);
    expect(numberDetail(result, 'path')).toBe(0);
    expect(stringDetail(result, 'path')).toBe('file.txt');
    expect(stringDetail(result, 'count')).toBe('');
    expect(booleanDetail(result, 'deleted')).toBe(true);
    expect(booleanDetail(result, 'invalid')).toBe(false);
  });

  it('converts glob patterns to regular expressions', () => {
    expect(globToRegExp('a**b').test('aXYb')).toBe(true);
    expect(globToRegExp('a**b').test('a/b')).toBe(true);
    expect(globToRegExp('a?b').test('aXb')).toBe(true);
    expect(globToRegExp('a?b').test('a/b')).toBe(false);
    expect(globToRegExp('a**/b').test('a/x/y/b')).toBe(true);
    expect(globToRegExp('a**/b').test('a/x/y/z/b')).toBe(true);
  });

  it('formats file and command errors with stable empty details', () => {
    expect(fileNotFound('/tmp/missing.txt', { deleted: false })).toEqual({
      content: [{ type: 'text', text: 'File not found: /tmp/missing.txt' }],
      details: { path: '/tmp/missing.txt', deleted: false },
    });
    expect(fileError({}, 'Read', '/tmp/file.txt', { totalLines: 0 })).toEqual({
      content: [{ type: 'text', text: 'Read error: Unknown error' }],
      details: { path: '/tmp/file.txt', totalLines: 0, failed: true, error: 'Unknown error' },
    });
    expect(toolError({ code: 1 }, 'Grep', { matchCount: 0 })).toEqual({
      content: [{ type: 'text', text: 'No matches found' }],
      details: { matchCount: 0 },
    });
    expect(
      toolError({ code: 1, message: 'find: missing: No such file' }, 'Glob', { fileCount: 0 }),
    ).toEqual({
      content: [{ type: 'text', text: 'Glob error: find: missing: No such file' }],
      details: { fileCount: 0, failed: true, error: 'find: missing: No such file' },
    });
    expect(toolError({}, 'Grep', { matchCount: 0 })).toEqual({
      content: [{ type: 'text', text: 'Grep error: Unknown error' }],
      details: { matchCount: 0, failed: true, error: 'Unknown error' },
    });
  });
});
