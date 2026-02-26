import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { interpolateEnvVars, interpolateConfig, expandPath, expandConfigPaths } from './interpolate.js';

describe('interpolateEnvVars', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('replaces ${VAR} with environment variable value', () => {
    process.env.TEST_VAR = 'hello';
    expect(interpolateEnvVars('${TEST_VAR}')).toBe('hello');
  });

  it('replaces multiple variables in one string', () => {
    process.env.A = 'foo';
    process.env.B = 'bar';
    expect(interpolateEnvVars('${A}-${B}')).toBe('foo-bar');
  });

  it('returns empty string for undefined env var', () => {
    delete process.env.NONEXISTENT_VAR;
    expect(interpolateEnvVars('${NONEXISTENT_VAR}')).toBe('');
  });

  it('leaves non-variable text unchanged', () => {
    expect(interpolateEnvVars('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(interpolateEnvVars('')).toBe('');
  });
});

describe('interpolateConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('recursively interpolates strings in objects', () => {
    process.env.KEY = 'secret';
    const config = { api: { key: '${KEY}' }, name: 'test' };
    const result = interpolateConfig(config);
    expect(result.api.key).toBe('secret');
    expect(result.name).toBe('test');
  });

  it('interpolates strings in arrays', () => {
    process.env.ITEM = 'value';
    const config = ['${ITEM}', 'static'];
    const result = interpolateConfig(config);
    expect(result).toEqual(['value', 'static']);
  });

  it('passes through numbers and booleans unchanged', () => {
    const config = { num: 42, bool: true, str: 'text' };
    const result = interpolateConfig(config);
    expect(result.num).toBe(42);
    expect(result.bool).toBe(true);
  });

  it('handles null values', () => {
    const config = { value: null };
    const result = interpolateConfig(config);
    expect(result.value).toBeNull();
  });

  it('handles deeply nested objects', () => {
    process.env.DEEP = 'found';
    const config = { a: { b: { c: '${DEEP}' } } };
    const result = interpolateConfig(config);
    expect(result.a.b.c).toBe('found');
  });
});

describe('expandPath', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('expands ~ to home directory', () => {
    process.env.HOME = '/home/user';
    process.env.USERPROFILE = undefined as unknown as string;
    expect(expandPath('~/documents')).toBe('/home/user/documents');
  });

  it('expands standalone ~', () => {
    process.env.HOME = '/home/user';
    expect(expandPath('~')).toBe('/home/user');
  });

  it('uses USERPROFILE when HOME is not set', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\user';
    expect(expandPath('~/docs')).toBe('C:\\Users\\user/docs');
  });

  it('does not expand ~ in the middle of a path', () => {
    expect(expandPath('/some/~path')).toBe('/some/~path');
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandPath('/absolute/path')).toBe('/absolute/path');
  });
});

describe('expandConfigPaths', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('expands paths in configured path keys', () => {
    process.env.HOME = '/home/user';
    const config = { file: '~/config.yaml', name: '~/not-a-path' };
    const result = expandConfigPaths(config);
    expect(result.file).toBe('/home/user/config.yaml');
    // 'name' is not a path key, so it stays unchanged
    expect(result.name).toBe('~/not-a-path');
  });

  it('expands array path values', () => {
    process.env.HOME = '/home/user';
    const config = { paths: ['~/a', '~/b'] };
    const result = expandConfigPaths(config);
    expect(result.paths).toEqual(['/home/user/a', '/home/user/b']);
  });

  it('recursively processes nested objects', () => {
    process.env.HOME = '/home/user';
    const config = { nested: { file: '~/nested.log' } };
    const result = expandConfigPaths(config);
    expect(result.nested.file).toBe('/home/user/nested.log');
  });

  it('accepts custom path keys', () => {
    process.env.HOME = '/home/user';
    const config = { custom: '~/custom' };
    const result = expandConfigPaths(config, new Set(['custom']));
    expect(result.custom).toBe('/home/user/custom');
  });
});
