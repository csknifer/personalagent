import { describe, it, expect } from 'vitest';
import { classifyToolError } from './ralphUtils.js';

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
