import { describe, it, expect } from 'vitest';
import { preCheckOutput } from './PreCheck.js';

describe('preCheckOutput', () => {
  it('should reject obviously incomplete output', () => {
    const result = preCheckOutput('I was unable to find any information.', {
      taskDescription: 'Research current AAPL stock price',
      successCriteria: 'Price obtained; analyst opinions found',
    });
    expect(result.shouldSkipVerification).toBe(true);
    expect(result.reason).toContain('failure indicator');
  });

  it('should reject output identical to previous attempt', () => {
    const result = preCheckOutput('The stock price is approximately...', {
      taskDescription: 'Research AAPL',
      successCriteria: 'Price obtained',
      previousOutput: 'The stock price is approximately...',
    });
    expect(result.shouldSkipVerification).toBe(true);
    expect(result.reason).toContain('identical');
  });

  it('should reject very short output for complex task', () => {
    const result = preCheckOutput('Yes.', {
      taskDescription: 'Research AAPL stock price and analyst opinions',
      successCriteria: 'Price obtained; at least 3 analyst opinions; recent news',
    });
    expect(result.shouldSkipVerification).toBe(true);
    expect(result.reason).toContain('too short');
  });

  it('should allow reasonable output through to verification', () => {
    const result = preCheckOutput(
      'Based on my research, AAPL is trading at $182.50. Analysts from Goldman Sachs, Morgan Stanley, and JP Morgan rate it as Buy.',
      { taskDescription: 'Research AAPL', successCriteria: 'Price obtained; analyst opinions found' },
    );
    expect(result.shouldSkipVerification).toBe(false);
  });

  it('should not flag failure indicators in long detailed output', () => {
    const longOutput = 'I was unable to find the exact figure, but based on extensive research across multiple sources, here is what I found: ' + 'x'.repeat(500);
    const result = preCheckOutput(longOutput, {
      taskDescription: 'Research something',
      successCriteria: 'Find the data',
    });
    expect(result.shouldSkipVerification).toBe(false);
  });

  it('should provide synthetic feedback when skipping', () => {
    const result = preCheckOutput('I could not access the data.', {
      taskDescription: 'Get data',
      successCriteria: 'Data obtained',
    });
    expect(result.syntheticFeedback).toBeDefined();
    expect(result.syntheticFeedback!.length).toBeGreaterThan(0);
  });
});
