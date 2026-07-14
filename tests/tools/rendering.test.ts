import { describe, expect, it } from 'vitest';
import {
  booleanDetail,
  fileError,
  fileNotFound,
  nativeRenderContext,
  numberDetail,
  renderResultSummary,
  renderRunning,
  text,
} from '../../src/tools/rendering.js';
import { renderText } from './toolTestHelpers.js';

describe('tool rendering helpers', () => {
  it('clones native render contexts with normalized args and preserves renderer state', () => {
    const state = { startedAt: 1 };
    const lastComponent = text('existing');
    const context = {
      args: { file_path: 'raw.txt' },
      toolCallId: 'call-1',
      invalidate: () => {},
      lastComponent,
      state,
      cwd: '/project',
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: true,
      isError: false,
    };

    const normalized = nativeRenderContext(context, { path: 'raw.txt' });

    expect(normalized).toEqual({ ...context, args: { path: 'raw.txt' } });
    expect(normalized).not.toBe(context);
    expect(normalized.state).toBe(state);
    expect(normalized.lastComponent).toBe(lastComponent);
    expect(context.args).toEqual({ file_path: 'raw.txt' });
  });

  it('renders summaries, expanded text, missing text fallback, and partial state', () => {
    const result = {
      content: [{ type: 'text', text: 'full output' }],
      details: {},
    };

    expect(renderText(text('plain'))).toBe('plain');
    expect(renderText(renderResultSummary(result, false, false, 'summary'))).toBe('summary');
    expect(renderText(renderResultSummary(result, true, false, 'summary'))).toBe('full output');
    expect(renderText(renderRunning(true) ?? text(''))).toBe('Running...');
    expect(renderRunning(false)).toBeUndefined();
    expect(renderText(renderResultSummary(result, false, true, 'summary'))).toBe('Running...');
  });

  it('reads typed detail values with defaults for absent or invalid details', () => {
    const result = {
      content: [{ type: 'text', text: '' }],
      details: { count: 2, deleted: true, invalid: null },
    };

    expect(numberDetail(result, 'count')).toBe(2);
    expect(numberDetail(result, 'deleted')).toBe(0);
    expect(numberDetail({ details: undefined }, 'count')).toBe(0);
    expect(booleanDetail(result, 'deleted')).toBe(true);
    expect(booleanDetail(result, 'invalid')).toBe(false);
  });

  it('formats retained Delete errors with stable details', () => {
    expect(fileNotFound('/tmp/missing.txt', { deleted: false })).toEqual({
      content: [{ type: 'text', text: 'File not found: /tmp/missing.txt' }],
      details: { path: '/tmp/missing.txt', deleted: false },
    });
    expect(fileError({}, 'Delete', '/tmp/file.txt', { deleted: false })).toEqual({
      content: [{ type: 'text', text: 'Delete error: Unknown error' }],
      details: {
        path: '/tmp/file.txt',
        deleted: false,
        failed: true,
        error: 'Unknown error',
      },
    });
  });
});
