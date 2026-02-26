/**
 * Shell execution tool for MCP — gives the agent the ability to run arbitrary
 * shell commands (git, npm, builds, tests, linting, etc.).
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import type { SandboxConfig } from './fileSystem.js';
import { validatePath } from './fileSystem.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ShellExecutionConfig {
  enabled: boolean;
  defaultTimeout: number;
  maxTimeout: number;
  blockedPatterns: string[];
  maxOutputLength: number;
}

export interface ExecuteCommandResult {
  success: boolean;
  data?: {
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
  };
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Process tracking for graceful shutdown                             */
/* ------------------------------------------------------------------ */

const trackedProcesses = new Set<ChildProcess>();

/**
 * Kill all tracked child processes. Called by ShutdownManager.
 */
export function killAllTrackedProcesses(): void {
  for (const child of trackedProcesses) {
    try {
      // On Windows, /T kills the entire process tree; on Unix we use negative PID
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else if (child.pid) {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // Process may already be dead — ignore
    }
  }
  trackedProcesses.clear();
}

/* ------------------------------------------------------------------ */
/*  execute_command implementation                                     */
/* ------------------------------------------------------------------ */

/**
 * Execute a shell command with timeout enforcement, output capping,
 * and optional sandbox validation of the working directory.
 */
export async function executeCommandTool(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    shellConfig: ShellExecutionConfig;
    sandbox?: SandboxConfig;
  },
): Promise<ExecuteCommandResult> {
  const { shellConfig, sandbox } = options;

  // --- Validate enabled ---
  if (!shellConfig.enabled) {
    return { success: false, error: 'Shell execution is disabled in configuration.' };
  }

  // --- Validate blocked patterns ---
  if (shellConfig.blockedPatterns.length > 0) {
    const lower = command.toLowerCase();
    for (const pattern of shellConfig.blockedPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return { success: false, error: `Command blocked by pattern: "${pattern}"` };
      }
    }
  }

  // --- Resolve & sandbox-validate working directory ---
  let cwd: string;
  try {
    const rawCwd = options.cwd ?? process.cwd();
    if (sandbox?.enabled) {
      cwd = validatePath(rawCwd, sandbox.allowedRoots);
    } else {
      cwd = resolve(rawCwd);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Invalid working directory: ${msg}` };
  }

  // --- Compute effective timeout ---
  const timeout = Math.min(
    options.timeout ?? shellConfig.defaultTimeout,
    shellConfig.maxTimeout,
  );

  const maxStdout = shellConfig.maxOutputLength;
  const maxStderr = Math.min(shellConfig.maxOutputLength, 10_000);

  return new Promise<ExecuteCommandResult>((resolvePromise) => {
    const startTime = Date.now();
    let timedOut = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    // Platform-aware shell selection
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Unix, create a new process group so we can kill the tree
      detached: !isWin,
    });

    trackedProcesses.add(child);

    // --- Collect stdout ---
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBuf.length < maxStdout) {
        stdoutBuf += chunk.toString('utf-8');
      }
    });

    // --- Collect stderr ---
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < maxStderr) {
        stderrBuf += chunk.toString('utf-8');
      }
    });

    // --- Timeout enforcement ---
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else if (child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);

    // --- Completion ---
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      trackedProcesses.delete(child);

      const durationMs = Date.now() - startTime;

      // Truncation markers (use >= since data collection stops at the limit)
      const stdout = stdoutBuf.length >= maxStdout
        ? stdoutBuf.slice(0, maxStdout) + '\n... (output truncated)'
        : stdoutBuf;
      const stderr = stderrBuf.length >= maxStderr
        ? stderrBuf.slice(0, maxStderr) + '\n... (stderr truncated)'
        : stderrBuf;

      const success = !timedOut && exitCode === 0;
      resolvePromise({
        success,
        data: {
          command,
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs,
        },
        // Always provide an error message when not successful so callers see a meaningful string
        ...(!success ? { error: timedOut
          ? `Command timed out after ${timeout}ms`
          : `Command exited with code ${exitCode}${stderr ? ': ' + stderr.slice(0, 200) : ''}`
        } : {}),
      });
    });

    // --- Spawn error (e.g. shell not found) ---
    child.on('error', (err) => {
      clearTimeout(timer);
      trackedProcesses.delete(child);
      resolvePromise({
        success: false,
        error: `Failed to execute command: ${err.message}`,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Tool definition                                                    */
/* ------------------------------------------------------------------ */

export function getShellExecutionToolDefinitions() {
  return [
    {
      name: 'execute_command',
      description:
        'Execute a shell command. Use this for running git, npm, builds, tests, linting, or any CLI tool. ' +
        'Returns stdout, stderr, exit code, and duration.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (defaults to project root)',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 30000, max: 300000)',
          },
        },
        required: ['command'],
      },
    },
  ];
}
