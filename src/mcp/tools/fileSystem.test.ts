/**
 * Tests for MCP filesystem sandbox validation.
 */

import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'path';
import { validatePath } from './fileSystem.js';

describe('validatePath', () => {
  const root = resolve('/sandbox');

  it('allows exact root match', () => {
    expect(validatePath('/sandbox', ['/sandbox'])).toBe(resolve('/sandbox'));
  });

  it('allows a direct child of the root', () => {
    const result = validatePath('/sandbox/file.txt', ['/sandbox']);
    expect(result).toBe(resolve('/sandbox/file.txt'));
  });

  it('allows a nested child of the root', () => {
    const result = validatePath('/sandbox/sub/deep/file.txt', ['/sandbox']);
    expect(result).toBe(resolve('/sandbox/sub/deep/file.txt'));
  });

  it('rejects path traversal with ../', () => {
    expect(() => validatePath('/sandbox/../etc/passwd', ['/sandbox'])).toThrow(
      'outside the allowed sandbox roots'
    );
  });

  it('rejects root sibling attack (/sandboxevil vs /sandbox)', () => {
    expect(() => validatePath('/sandboxevil/file.txt', ['/sandbox'])).toThrow(
      'outside the allowed sandbox roots'
    );
  });

  it('allows paths under a second allowed root', () => {
    const roots = ['/sandbox', '/tmp/work'];
    const result = validatePath('/tmp/work/data.json', roots);
    expect(result).toBe(resolve('/tmp/work/data.json'));
  });

  it('rejects path outside all allowed roots', () => {
    const roots = ['/sandbox', '/tmp/work'];
    expect(() => validatePath('/home/user/secret', roots)).toThrow(
      'outside the allowed sandbox roots'
    );
  });
});
