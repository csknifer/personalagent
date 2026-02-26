import { describe, it, expect } from 'vitest';
import { estimateTokenCount } from './utils.js';

describe('estimateTokenCount', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokenCount('hello world')).toBe(3); // 11 chars / 4 = 2.75 → ceil → 3
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('rounds up', () => {
    expect(estimateTokenCount('a')).toBe(1); // 1/4 = 0.25 → ceil → 1
  });

  it('handles long text', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokenCount(text)).toBe(100);
  });

  it('handles exact multiples', () => {
    expect(estimateTokenCount('abcd')).toBe(1); // 4/4 = 1
    expect(estimateTokenCount('abcdefgh')).toBe(2); // 8/4 = 2
  });
});
