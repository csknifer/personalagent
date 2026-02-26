import { describe, it, expect } from 'vitest';
import { classifyToolError, summarizeIteration } from './ralphUtils.js';

describe('classifyToolError', () => {
  it('classifies 401/403/forbidden as auth', () => {
    expect(classifyToolError('Error: HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyToolError('Error: HTTP 403 Forbidden')).toBe('auth');
    expect(classifyToolError('Access forbidden for this resource')).toBe('auth');
    expect(classifyToolError('Unauthorized request')).toBe('auth');
  });

  it('classifies 429/rate limit/quota as quota', () => {
    expect(classifyToolError('Error: HTTP 429 Too Many Requests')).toBe('quota');
    expect(classifyToolError('API rate limit exceeded')).toBe('quota');
    expect(classifyToolError('Error: quota exceeded for this API key')).toBe('quota');
    expect(classifyToolError('Rate-limit hit, please retry later')).toBe('quota');
  });

  it('classifies network errors as network', () => {
    expect(classifyToolError('Error: ECONNREFUSED 127.0.0.1:3000')).toBe('network');
    expect(classifyToolError('Error: ENOTFOUND api.example.com')).toBe('network');
    expect(classifyToolError('DNS resolution failed')).toBe('network');
    expect(classifyToolError('Network error: ECONNRESET')).toBe('network');
  });

  it('classifies 404/not found as not_found', () => {
    expect(classifyToolError('Error: HTTP 404 Not Found')).toBe('not_found');
    expect(classifyToolError('Resource not found')).toBe('not_found');
  });

  it('classifies timeout errors as timeout', () => {
    expect(classifyToolError('Error: Tool: web_search timed out after 30s')).toBe('timeout');
    expect(classifyToolError('ETIMEDOUT connecting to server')).toBe('timeout');
    expect(classifyToolError('Request timeout after 60000ms')).toBe('timeout');
  });

  it('classifies unknown errors as unknown', () => {
    expect(classifyToolError('Error: Something unexpected happened')).toBe('unknown');
    expect(classifyToolError('Error: Internal server error')).toBe('unknown');
    expect(classifyToolError('')).toBe('unknown');
  });
});

describe('summarizeIteration', () => {
  it('should extract key information from verbose output', () => {
    const rawOutput = `
I'll search for AAPL stock information.

Tool call: web_search("AAPL stock price 2026")
Result: {"title": "Apple Inc", "url": "https://finance.yahoo.com/quote/AAPL", "snippet": "AAPL trading at $182.50, up 2.3%..."}

The current price is $182.50.

Tool call: web_search("AAPL analyst opinions")
Result: {"error": "Rate limit exceeded"}

Unable to find analyst opinions due to rate limit.

## KEY FINDINGS
- AAPL current price: $182.50 (up 2.3%)
- Analyst opinions: UNAVAILABLE (rate limit)
    `;
    const summary = summarizeIteration(rawOutput);
    expect(summary.length).toBeLessThan(rawOutput.length * 0.5);
    expect(summary).toContain('$182.50');
    expect(summary).toContain('rate limit');
    expect(summary).not.toContain('"title"');
  });

  it('should preserve findings section', () => {
    const output = 'Some reasoning...\n## KEY FINDINGS\n- Finding 1\n- Finding 2';
    const summary = summarizeIteration(output);
    expect(summary).toContain('Finding 1');
    expect(summary).toContain('Finding 2');
  });

  it('should handle output with no structured sections', () => {
    const output = 'Just a plain text response with some analysis about the topic at hand. '.repeat(10);
    const summary = summarizeIteration(output);
    expect(summary.length).toBeLessThan(output.length);
    expect(summary.length).toBeGreaterThan(0);
  });

  it('should extract scratchpad if present', () => {
    const output = 'Work done.\n## SCRATCHPAD\nNeed to try different search terms next time.';
    const summary = summarizeIteration(output);
    expect(summary).toContain('different search terms');
  });

  it('should return input unchanged when already short', () => {
    const output = 'Short output.';
    const summary = summarizeIteration(output);
    expect(summary).toBe(output);
  });

  it('should handle empty input', () => {
    expect(summarizeIteration('')).toBe('');
  });

  it('should strip code blocks and large JSON in fallback mode', () => {
    const codeBlock = '```javascript\nconst x = 1;\nconst y = 2;\n```';
    const json = '{"key": "value", "nested": {"a": 1, "b": 2, "c": 3}}';
    const output = `Some analysis here. ${codeBlock} More text. ${json} ` + 'Padding text. '.repeat(30);
    const summary = summarizeIteration(output);
    expect(summary).not.toContain('const x = 1');
    expect(summary.length).toBeLessThan(output.length);
  });
});
