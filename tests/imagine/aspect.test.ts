import { describe, expect, it } from 'vitest';
import { normalizeAspectRatio } from '../../src/imagine/aspect.js';

describe('normalizeAspectRatio', () => {
  it.each([
    'auto',
    '1:1',
    '16:9',
    '9:16',
    '4:3',
    '3:4',
    '3:2',
    '2:3',
    '2:1',
    '1:2',
    '19.5:9',
    '9:19.5',
    '20:9',
    '9:20',
  ])('accepts %s', (value) => expect(normalizeAspectRatio(value)).toBe(value));

  it('defaults to auto and rejects unsupported ratios', () => {
    expect(normalizeAspectRatio()).toBe('auto');
    expect(() => normalizeAspectRatio('5:4')).toThrow('Unsupported aspect ratio');
  });
});
