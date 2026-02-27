/**
 * File system tools for MCP
 */

import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { join, resolve, dirname, sep } from 'path';

export interface SandboxConfig {
  enabled: boolean;
  allowedRoots: string[];
}

/**
 * Validate that a resolved path is within one of the allowed root directories.
 * Returns the resolved path if valid, throws if outside sandbox.
 */
export function validatePath(inputPath: string, allowedRoots: string[]): string {
  const resolved = resolve(inputPath);

  // If the path exists, resolve symlinks to prevent sandbox escapes.
  // For non-existent paths (e.g. write targets), validate the parent directory.
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    // Path doesn't exist yet — validate the nearest existing ancestor
    const parent = dirname(resolved);
    try {
      realPath = realpathSync(parent);
      // Re-append the final segment so the full path is checked
      realPath = join(realPath, resolved.slice(parent.length));
    } catch {
      // Parent also doesn't exist — use resolved path as-is
      realPath = resolved;
    }
  }

  const isAllowed = allowedRoots.some(root => {
    const resolvedRoot = resolve(root);
    let realRoot: string;
    try {
      realRoot = realpathSync(resolvedRoot);
    } catch {
      realRoot = resolvedRoot;
    }
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    return realPath === realRoot || realPath.startsWith(rootWithSep);
  });

  if (!isAllowed) {
    throw new Error(
      `Path "${resolved}" is outside the allowed sandbox roots`
    );
  }
  return resolved;
}

/**
 * Resolve a path, applying sandbox validation when enabled.
 */
function guardPath(inputPath: string, sandbox?: SandboxConfig): string {
  if (sandbox?.enabled) {
    return validatePath(inputPath, sandbox.allowedRoots);
  }
  return resolve(inputPath);
}

export interface FileSystemToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Read a file's contents
 */
export async function readFileTool(path: string, sandbox?: SandboxConfig): Promise<FileSystemToolResult> {
  try {
    const resolvedPath = guardPath(path, sandbox);
    const content = await readFile(resolvedPath, 'utf-8');
    return {
      success: true,
      data: {
        path: resolvedPath,
        content,
        size: content.length,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to read file: ${err.message}`,
    };
  }
}

/**
 * Write content to a file
 */
export async function writeFileTool(
  path: string,
  content: string,
  createDirs: boolean = true,
  sandbox?: SandboxConfig,
): Promise<FileSystemToolResult> {
  try {
    const resolvedPath = guardPath(path, sandbox);
    
    if (createDirs) {
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
    
    await writeFile(resolvedPath, content, 'utf-8');
    return {
      success: true,
      data: {
        path: resolvedPath,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to write file: ${err.message}`,
    };
  }
}

/**
 * List directory contents
 */
export async function listDirectoryTool(path: string, sandbox?: SandboxConfig): Promise<FileSystemToolResult> {
  try {
    const resolvedPath = guardPath(path, sandbox);
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    
    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(resolvedPath, entry.name);
        try {
          const stats = await stat(fullPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        } catch {
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
          };
        }
      })
    );

    return {
      success: true,
      data: {
        path: resolvedPath,
        items,
        count: items.length,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to list directory: ${err.message}`,
    };
  }
}

/**
 * Check if a file or directory exists
 */
export async function existsTool(path: string, sandbox?: SandboxConfig): Promise<FileSystemToolResult> {
  try {
    const resolvedPath = guardPath(path, sandbox);
    const exists = existsSync(resolvedPath);
    
    let type: 'file' | 'directory' | 'unknown' = 'unknown';
    if (exists) {
      const stats = await stat(resolvedPath);
      type = stats.isDirectory() ? 'directory' : 'file';
    }

    return {
      success: true,
      data: {
        path: resolvedPath,
        exists,
        type: exists ? type : null,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to check existence: ${err.message}`,
    };
  }
}

/**
 * Delete a file
 */
export async function deleteFileTool(path: string, sandbox?: SandboxConfig): Promise<FileSystemToolResult> {
  try {
    const resolvedPath = guardPath(path, sandbox);
    await unlink(resolvedPath);
    return {
      success: true,
      data: {
        path: resolvedPath,
        deleted: true,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to delete file: ${err.message}`,
    };
  }
}

/**
 * Create a directory
 */
export async function createDirectoryTool(path: string, sandbox?: SandboxConfig): Promise<FileSystemToolResult> {
  try {
    const resolvedPath = guardPath(path, sandbox);
    await mkdir(resolvedPath, { recursive: true });
    return {
      success: true,
      data: {
        path: resolvedPath,
        created: true,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: `Failed to create directory: ${err.message}`,
    };
  }
}

/**
 * Get file system tool definitions for MCP
 */
export function getFileSystemToolDefinitions() {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'list_directory',
      description: 'List the contents of a directory',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the directory to list',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'file_exists',
      description: 'Check if a file or directory exists',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to check',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to delete',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'create_directory',
      description: 'Create a directory',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the directory to create',
          },
        },
        required: ['path'],
      },
    },
  ];
}
