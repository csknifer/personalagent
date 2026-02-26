/**
 * Tests for shell execution tool.
 * Uses real child_process.spawn for integration-style tests.
 */

import { describe, it, expect } from 'vitest';
import { executeCommandTool, killAllTrackedProcesses } from './shellExecution.js';
import type { ShellExecutionConfig } from './shellExecution.js';
import type { SandboxConfig } from './fileSystem.js';
import { resolve } from 'path';

const defaultShellConfig: ShellExecutionConfig = {
  enabled: true,
  defaultTimeout: 30000,
  maxTimeout: 300000,
  blockedPatterns: [],
  maxOutputLength: 50000,
};

describe('executeCommandTool', () => {
  it('runs a simple echo command and captures stdout', async () => {
    const result = await executeCommandTool('echo hello', {
      shellConfig: defaultShellConfig,
    });
    expect(result.success).toBe(true);
    expect(result.data?.stdout.trim()).toBe('hello');
    expect(result.data?.exitCode).toBe(0);
    expect(result.data?.timedOut).toBe(false);
    expect(result.data?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures non-zero exit codes', async () => {
    const cmd = process.platform === 'win32' ? 'exit /b 42' : 'exit 42';
    const result = await executeCommandTool(cmd, {
      shellConfig: defaultShellConfig,
    });
    expect(result.success).toBe(false);
    expect(result.data?.exitCode).toBe(42);
  });

  it('captures stderr output', async () => {
    const cmd = process.platform === 'win32'
      ? 'echo error message >&2'
      : 'echo "error message" >&2';
    const result = await executeCommandTool(cmd, {
      shellConfig: defaultShellConfig,
    });
    expect(result.data?.stderr.trim()).toContain('error message');
  });

  it('enforces timeout and marks timedOut', async () => {
    const cmd = process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const result = await executeCommandTool(cmd, {
      timeout: 500,
      shellConfig: { ...defaultShellConfig, maxTimeout: 1000 },
    });
    expect(result.success).toBe(false);
    expect(result.data?.timedOut).toBe(true);
  }, 10000);

  it('rejects blocked command patterns', async () => {
    const result = await executeCommandTool('rm -rf /', {
      shellConfig: { ...defaultShellConfig, blockedPatterns: ['rm -rf'] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked by pattern');
  });

  it('returns error when shell execution is disabled', async () => {
    const result = await executeCommandTool('echo test', {
      shellConfig: { ...defaultShellConfig, enabled: false },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('validates cwd against sandbox', async () => {
    const sandbox: SandboxConfig = {
      enabled: true,
      allowedRoots: ['/sandbox'],
    };
    const result = await executeCommandTool('echo test', {
      cwd: '/outside/sandbox',
      shellConfig: defaultShellConfig,
      sandbox,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the allowed sandbox roots');
  });

  it('truncates stdout exceeding maxOutputLength', async () => {
    // Generate output longer than a small limit
    const cmd = process.platform === 'win32'
      ? 'for /L %i in (1,1,1000) do @echo line%i'
      : 'for i in $(seq 1 1000); do echo "line$i"; done';
    const result = await executeCommandTool(cmd, {
      shellConfig: { ...defaultShellConfig, maxOutputLength: 200 },
    });
    expect(result.data?.stdout).toContain('... (output truncated)');
    // Truncated output should be roughly maxOutputLength + truncation marker
    expect(result.data!.stdout.length).toBeLessThan(300);
  }, 15000);

  it('caps timeout to maxTimeout', async () => {
    const cmd = process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const result = await executeCommandTool(cmd, {
      timeout: 999999, // Exceeds maxTimeout
      shellConfig: { ...defaultShellConfig, maxTimeout: 500 },
    });
    expect(result.success).toBe(false);
    expect(result.data?.timedOut).toBe(true);
  }, 10000);
});

describe('killAllTrackedProcesses', () => {
  it('does not throw when no processes are tracked', () => {
    expect(() => killAllTrackedProcesses()).not.toThrow();
  });
});
