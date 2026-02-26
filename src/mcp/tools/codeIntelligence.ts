/**
 * Code intelligence tools for MCP — glob, grep, and edit_file.
 * Gives the agent the ability to navigate and surgically modify codebases.
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { resolve, relative, join } from 'path';
import fg from 'fast-glob';
import type { SandboxConfig } from './fileSystem.js';
import { validatePath } from './fileSystem.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface GlobResult {
  success: boolean;
  data?: {
    pattern: string;
    cwd: string;
    matches: string[];
    count: number;
  };
  error?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  context?: string[];
}

export interface GrepResult {
  success: boolean;
  data?: {
    pattern: string;
    path: string;
    matches: GrepMatch[];
    totalMatches: number;
    truncated: boolean;
  };
  error?: string;
}

export interface EditFileResult {
  success: boolean;
  data?: {
    path: string;
    replacements: number;
    oldSize: number;
    newSize: number;
  };
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Helper: sandbox-aware path guard                                   */
/* ------------------------------------------------------------------ */

function guardPath(inputPath: string, sandbox?: SandboxConfig): string {
  if (sandbox?.enabled) {
    return validatePath(inputPath, sandbox.allowedRoots);
  }
  return resolve(inputPath);
}

/* ------------------------------------------------------------------ */
/*  glob tool                                                          */
/* ------------------------------------------------------------------ */

export async function globTool(
  pattern: string,
  options: {
    cwd?: string;
    ignore?: string[];
    sandbox?: SandboxConfig;
  } = {},
): Promise<GlobResult> {
  try {
    const rawCwd = options.cwd ?? process.cwd();
    const cwd = guardPath(rawCwd, options.sandbox);

    const defaultIgnore = ['**/node_modules/**', '**/.git/**'];
    const ignore = options.ignore
      ? [...defaultIgnore, ...options.ignore]
      : defaultIgnore;

    const matches = await fg(pattern, {
      cwd,
      ignore,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });

    // Sort by path for deterministic output
    matches.sort();

    return {
      success: true,
      data: {
        pattern,
        cwd,
        matches,
        count: matches.length,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { success: false, error: `Glob failed: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/*  grep tool                                                          */
/* ------------------------------------------------------------------ */

/**
 * Check if a file is likely binary by reading its first 8KB
 * and checking for null bytes.
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    return new Promise((resolve) => {
      const stream = createReadStream(filePath, { start: 0, end: 8192 });
      let binary = false;
      stream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (buf.includes(0)) {
          binary = true;
          stream.destroy();
        }
      });
      stream.on('close', () => resolve(binary));
      stream.on('error', () => resolve(true)); // Treat unreadable as binary
    });
  } catch {
    return true;
  }
}

/**
 * Recursively collect all files under a directory.
 */
async function collectFiles(
  dir: string,
  include?: string,
): Promise<string[]> {
  if (include) {
    return fg(include, {
      cwd: dir,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
      followSymbolicLinks: false,
    });
  }

  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectFiles(fullPath, undefined));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function grepTool(
  pattern: string,
  path: string,
  options: {
    include?: string;
    ignoreCase?: boolean;
    maxResults?: number;
    contextLines?: number;
    sandbox?: SandboxConfig;
  } = {},
): Promise<GrepResult> {
  try {
    const resolvedPath = guardPath(path, options.sandbox);
    const maxResults = options.maxResults ?? 50;
    const contextLines = options.contextLines ?? 0;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, options.ignoreCase ? 'i' : '');
    } catch {
      return { success: false, error: `Invalid regex pattern: "${pattern}"` };
    }

    // Determine target files
    const stats = await stat(resolvedPath);
    let files: string[];
    if (stats.isDirectory()) {
      files = await collectFiles(resolvedPath, options.include);
    } else {
      files = [resolvedPath];
    }

    const matches: GrepMatch[] = [];
    let totalMatches = 0;
    let truncated = false;

    for (const file of files) {
      if (truncated) break;

      // Skip binary files
      if (await isBinaryFile(file)) continue;

      try {
        const content = await readFile(file, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            totalMatches++;

            if (matches.length < maxResults) {
              const match: GrepMatch = {
                file: relative(resolvedPath, file) || file,
                line: i + 1,
                content: lines[i],
              };

              if (contextLines > 0) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length - 1, i + contextLines);
                match.context = lines.slice(start, end + 1);
              }

              matches.push(match);
            } else {
              truncated = true;
            }
          }
        }
      } catch {
        // Skip files we can't read
        continue;
      }
    }

    return {
      success: true,
      data: {
        pattern,
        path: resolvedPath,
        matches,
        totalMatches,
        truncated,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { success: false, error: `Grep failed: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/*  edit_file tool                                                     */
/* ------------------------------------------------------------------ */

export async function editFileTool(
  path: string,
  oldString: string,
  newString: string,
  options: {
    replaceAll?: boolean;
    sandbox?: SandboxConfig;
  } = {},
): Promise<EditFileResult> {
  try {
    if (!oldString) {
      return { success: false, error: 'old_string must not be empty' };
    }

    const resolvedPath = guardPath(path, options.sandbox);

    const content = await readFile(resolvedPath, 'utf-8');
    const oldSize = content.length;

    if (!content.includes(oldString)) {
      return {
        success: false,
        error: `old_string not found in file: ${resolvedPath}`,
      };
    }

    let newContent: string;
    let replacements: number;

    if (options.replaceAll) {
      // Split once, count, and rejoin
      const parts = content.split(oldString);
      replacements = parts.length - 1;
      newContent = parts.join(newString);
    } else {
      // Replace first occurrence only
      replacements = 1;
      const idx = content.indexOf(oldString);
      newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
    }

    await writeFile(resolvedPath, newContent, 'utf-8');

    return {
      success: true,
      data: {
        path: resolvedPath,
        replacements,
        oldSize,
        newSize: newContent.length,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { success: false, error: `Edit file failed: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                   */
/* ------------------------------------------------------------------ */

export function getCodeIntelligenceToolDefinitions() {
  return [
    {
      name: 'glob',
      description:
        'Find files matching a glob pattern. Useful for discovering project structure and locating files by extension or name pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match (e.g., "src/**/*.ts", "*.json")',
          },
          cwd: {
            type: 'string',
            description: 'Base directory for the search (defaults to project root)',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Patterns to exclude (defaults to node_modules and .git)',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'grep',
      description:
        'Search file contents with a regex pattern. Returns matching lines with file paths and line numbers. Use for finding code definitions, usages, or text patterns.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for',
          },
          path: {
            type: 'string',
            description: 'File or directory to search in',
          },
          include: {
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "*.ts", "*.{ts,tsx}")',
          },
          ignoreCase: {
            type: 'boolean',
            description: 'Case-insensitive search (default: false)',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results (default: 50)',
          },
          contextLines: {
            type: 'number',
            description: 'Number of context lines around each match (default: 0)',
          },
        },
        required: ['pattern', 'path'],
      },
    },
    {
      name: 'edit_file',
      description:
        'Make surgical edits to a file by finding and replacing exact text strings. Safer than rewriting entire files. Returns the number of replacements made.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to find in the file',
          },
          new_string: {
            type: 'string',
            description: 'Text to replace with',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: first only)',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  ];
}
