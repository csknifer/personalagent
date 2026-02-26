import { describe, it, expect } from 'vitest';
import { estimateTokenCount, formatErrorMessage } from './utils.js';

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

describe('formatErrorMessage', () => {
  it('extracts message from nested Gemini-style JSON error', () => {
    const raw = '{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 503,\\n \\"message\\": \\"This model is currently experiencing high demand.\\",\\n \\"status\\": \\"UNAVAILABLE\\"\\n }\\n}\\n","code":503,"status":"Service Unavailable"}}';
    expect(formatErrorMessage(new Error(raw))).toBe(
      'This model is currently experiencing high demand.'
    );
  });

  it('extracts message from simple { error: { message } } structure', () => {
    const raw = '{"error":{"message":"Rate limit exceeded","code":429}}';
    expect(formatErrorMessage(new Error(raw))).toBe('Rate limit exceeded');
  });

  it('returns plain string errors as-is', () => {
    expect(formatErrorMessage(new Error('Connection refused'))).toBe('Connection refused');
  });

  it('handles non-Error values', () => {
    expect(formatErrorMessage('something broke')).toBe('something broke');
  });

  it('strips redundant Error: prefix', () => {
    expect(formatErrorMessage(new Error('Error: duplicate prefix'))).toBe('duplicate prefix');
  });

  it('handles embedded JSON in a larger string', () => {
    const raw = 'Request failed: {"error":{"message":"Invalid API key"}}';
    expect(formatErrorMessage(new Error(raw))).toBe('Invalid API key');
  });
});
