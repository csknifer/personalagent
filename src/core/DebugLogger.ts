/**
 * Debug Logger — provides structured debug output when --debug flag is active.
 *
 * Writes to a log file (~/.personalagent/debug.log) so output is never
 * swallowed by the Ink terminal UI. Also writes to stderr as a fallback.
 *
 * Singleton that gates all output on `enabled`. Components call the logger
 * without caring whether debug mode is on; when disabled, calls are no-ops.
 */

import { appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class DebugLogger {
  private enabled: boolean = false;
  private minLevel: LogLevel = 'debug';
  private logFile: string;

  constructor() {
    const dir = join(homedir(), '.personalagent');
    this.logFile = join(dir, 'debug.log');
  }

  enable(level: LogLevel = 'debug'): void {
    this.enabled = true;
    this.minLevel = level;

    // Ensure directory exists and clear previous log
    try {
      mkdirSync(join(homedir(), '.personalagent'), { recursive: true });
      writeFileSync(this.logFile, `=== Debug session started at ${new Date().toISOString()} ===\n`);
    } catch {
      // Silently ignore if we can't write the log file
    }
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLogFile(): string {
    return this.logFile;
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('error', component, message, data);
  }

  private log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return;
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const timestamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    let line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${component}] ${message}`;

    if (data && Object.keys(data).length > 0) {
      // Compact data: truncate long values
      const compactData = Object.fromEntries(
        Object.entries(data).map(([k, v]) => {
          if (typeof v === 'string' && v.length > 200) {
            return [k, v.slice(0, 197) + '...'];
          }
          return [k, v];
        })
      );
      line += ' ' + JSON.stringify(compactData);
    }

    line += '\n';

    // Write to file (primary — always works, not affected by Ink UI)
    try {
      appendFileSync(this.logFile, line);
    } catch {
      // Silently ignore
    }
  }
}

// Singleton
let instance: DebugLogger | null = null;

export function getDebugLogger(): DebugLogger {
  if (!instance) {
    instance = new DebugLogger();
  }
  return instance;
}
