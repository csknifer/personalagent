/**
 * Tests for code intelligence tools: glob, grep, edit_file.
 * Uses real filesystem via temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { globTool, grepTool, editFileTool } from './codeIntelligence.js';
import type { SandboxConfig } from './fileSystem.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ci-test-'));
  // Create a small project structure
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'src', 'utils'), { recursive: true });
  await writeFile(join(tempDir, 'src', 'index.ts'), 'export const main = () => console.log("hello");\n');
  await writeFile(join(tempDir, 'src', 'utils', 'helper.ts'), 'export function add(a: number, b: number) { return a + b; }\nexport function subtract(a: number, b: number) { return a - b; }\n');
  await writeFile(join(tempDir, 'src', 'utils', 'helper.test.ts'), 'import { add } from "./helper";\ntest("add", () => expect(add(1,2)).toBe(3));\n');
  await writeFile(join(tempDir, 'README.md'), '# Test Project\nThis is a test.\n');
  await writeFile(join(tempDir, 'package.json'), '{"name": "test"}\n');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  glob                                                               */
/* ------------------------------------------------------------------ */

describe('globTool', () => {
  it('matches TypeScript files', async () => {
    const result = await globTool('**/*.ts', { cwd: tempDir });
    expect(result.success).toBe(true);
    expect(result.data!.count).toBe(3);
    expect(result.data!.matches).toContain('src/index.ts');
    expect(result.data!.matches).toContain('src/utils/helper.ts');
    expect(result.data!.matches).toContain('src/utils/helper.test.ts');
  });

  it('respects ignore patterns', async () => {
    const result = await globTool('**/*.ts', {
      cwd: tempDir,
      ignore: ['**/*.test.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.data!.count).toBe(2);
    expect(result.data!.matches).not.toContain('src/utils/helper.test.ts');
  });

  it('matches specific file patterns', async () => {
    const result = await globTool('*.md', { cwd: tempDir });
    expect(result.success).toBe(true);
    expect(result.data!.matches).toContain('README.md');
  });

  it('returns empty matches for non-matching pattern', async () => {
    const result = await globTool('**/*.py', { cwd: tempDir });
    expect(result.success).toBe(true);
    expect(result.data!.count).toBe(0);
  });

  it('validates cwd against sandbox', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      allowedRoots: ['/allowed-only'],
    };
    const result = await globTool('**/*.ts', { cwd: tempDir, sandbox });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the allowed sandbox roots');
  });
});

/* ------------------------------------------------------------------ */
/*  glob sandbox traversal                                             */
/* ------------------------------------------------------------------ */

describe('globTool sandbox traversal', () => {
  it('blocks patterns with ../ traversal', async () => {
    const result = await globTool('../../../etc/*', {
      cwd: tempDir,
      sandbox: { enabled: true, allowedRoots: [tempDir] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('traversal');
  });

  it('blocks patterns with embedded .. segments', async () => {
    const result = await globTool('src/../../etc/passwd', {
      cwd: tempDir,
      sandbox: { enabled: true, allowedRoots: [tempDir] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('traversal');
  });

  it('allows normal patterns within sandbox', async () => {
    const result = await globTool('**/*.ts', {
      cwd: tempDir,
      sandbox: { enabled: true, allowedRoots: [tempDir] },
    });
    expect(result.success).toBe(true);
  });

  it('allows .. in patterns when sandbox is disabled', async () => {
    const result = await globTool('../*', {
      cwd: tempDir,
    });
    // Should not block — sandbox is not enabled
    expect(result.success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  grep                                                               */
/* ------------------------------------------------------------------ */

describe('grepTool', () => {
  it('finds matches in a directory', async () => {
    const result = await grepTool('export function', tempDir);
    expect(result.success).toBe(true);
    expect(result.data!.matches.length).toBeGreaterThan(0);
    expect(result.data!.matches.some(m => m.content.includes('export function add'))).toBe(true);
  });

  it('supports case-insensitive search', async () => {
    const result = await grepTool('EXPORT FUNCTION', tempDir, { ignoreCase: true });
    expect(result.success).toBe(true);
    expect(result.data!.matches.length).toBeGreaterThan(0);
  });

  it('supports include filter', async () => {
    const result = await grepTool('export', tempDir, { include: '*.test.ts' });
    expect(result.success).toBe(true);
    // Only matches in test files
    expect(result.data!.matches.every(m => m.file.endsWith('.test.ts'))).toBe(true);
  });

  it('returns context lines when requested', async () => {
    const result = await grepTool('function add', tempDir, { contextLines: 1 });
    expect(result.success).toBe(true);
    const match = result.data!.matches.find(m => m.content.includes('function add'));
    expect(match?.context).toBeDefined();
    expect(match!.context!.length).toBeGreaterThan(1);
  });

  it('respects maxResults limit', async () => {
    const result = await grepTool('export', tempDir, { maxResults: 1 });
    expect(result.success).toBe(true);
    expect(result.data!.matches.length).toBe(1);
    expect(result.data!.truncated).toBe(true);
  });

  it('searches a single file', async () => {
    const filePath = join(tempDir, 'src', 'utils', 'helper.ts');
    const result = await grepTool('subtract', filePath);
    expect(result.success).toBe(true);
    expect(result.data!.matches.length).toBe(1);
    expect(result.data!.matches[0].content).toContain('subtract');
  });

  it('returns error for invalid regex', async () => {
    const result = await grepTool('[invalid', tempDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex');
  });

  it('validates path against sandbox', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      allowedRoots: ['/allowed-only'],
    };
    const result = await grepTool('test', tempDir, { sandbox });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the allowed sandbox roots');
  });
});

/* ------------------------------------------------------------------ */
/*  edit_file                                                          */
/* ------------------------------------------------------------------ */

describe('editFileTool', () => {
  it('replaces first occurrence by default', async () => {
    const filePath = join(tempDir, 'src', 'utils', 'helper.ts');
    const result = await editFileTool(filePath, 'export function', 'function');
    expect(result.success).toBe(true);
    expect(result.data!.replacements).toBe(1);

    const content = await readFile(filePath, 'utf-8');
    // First export replaced, second remains
    expect(content.startsWith('function add')).toBe(true);
    expect(content).toContain('export function subtract');
  });

  it('replaces all occurrences with replace_all', async () => {
    const filePath = join(tempDir, 'src', 'utils', 'helper.ts');
    const result = await editFileTool(filePath, 'export function', 'function', { replaceAll: true });
    expect(result.success).toBe(true);
    expect(result.data!.replacements).toBe(2);

    const content = await readFile(filePath, 'utf-8');
    expect(content).not.toContain('export function');
  });

  it('returns error when old_string not found', async () => {
    const filePath = join(tempDir, 'src', 'utils', 'helper.ts');
    const result = await editFileTool(filePath, 'nonexistent string', 'replacement');
    expect(result.success).toBe(false);
    expect(result.error).toContain('old_string not found');
  });

  it('reports old and new file sizes', async () => {
    const filePath = join(tempDir, 'README.md');
    const result = await editFileTool(filePath, 'Test Project', 'My Project');
    expect(result.success).toBe(true);
    expect(result.data!.oldSize).toBeGreaterThan(0);
    expect(result.data!.newSize).toBeGreaterThan(0);
  });

  it('rejects empty old_string', async () => {
    const filePath = join(tempDir, 'README.md');
    const result = await editFileTool(filePath, '', 'anything');
    expect(result.success).toBe(false);
    expect(result.error).toContain('old_string must not be empty');
  });

  it('validates path against sandbox', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      allowedRoots: ['/allowed-only'],
    };
    const filePath = join(tempDir, 'README.md');
    const result = await editFileTool(filePath, 'Test', 'Demo', { sandbox });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the allowed sandbox roots');
  });
});
