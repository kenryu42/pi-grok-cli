import { describe, expect, it } from 'vitest';
import { parseImagineArgs } from '../../src/imagine/parseArgs.js';

describe('parseImagineArgs', () => {
  it('parses prompt, aspect, output, and resolution', () => {
    expect(
      parseImagineArgs('--aspect 16:9 --out "./my cat.jpg" --resolution 1k a fluffy cat'),
    ).toEqual({
      prompt: 'a fluffy cat',
      aspectRatio: '16:9',
      outPath: './my cat.jpg',
      resolution: '1k',
    });
  });

  it('supports aliases and defaults', () => {
    expect(parseImagineArgs('-o cat.jpg --aspect-ratio 1:1 cat')).toEqual({
      prompt: 'cat',
      aspectRatio: '1:1',
      outPath: 'cat.jpg',
      resolution: '1k',
    });
    expect(parseImagineArgs('cat')).toEqual({
      prompt: 'cat',
      aspectRatio: 'auto',
      resolution: '1k',
    });
  });

  it('rejects empty prompts, unknown flags, missing values, and unsupported resolution', () => {
    expect(() => parseImagineArgs('')).toThrow('Prompt is required');
    expect(() => parseImagineArgs('--wat cat')).toThrow('Unknown option');
    expect(() => parseImagineArgs('--out')).toThrow('requires a value');
    expect(() => parseImagineArgs('--resolution 2k cat')).toThrow('Unsupported resolution');
  });
});
