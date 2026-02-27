/**
 * ShutdownManager - Graceful shutdown handling
 *
 * Manages cleanup functions that run in priority order when the process
 * is shutting down. Supports SIGINT/SIGTERM signal handling with
 * force-exit on second signal.
 */

interface CleanupEntry {
  name: string;
  fn: () => void | Promise<void>;
  priority: number;
}

export class ShutdownManager {
  private cleanups: CleanupEntry[] = [];
  private isShuttingDown = false;
  private signalsAttached = false;

  /**
   * Register a cleanup function to run during shutdown.
   * Higher priority runs first.
   */
  register(name: string, fn: () => void | Promise<void>, priority: number = 0): void {
    this.cleanups.push({ name, fn, priority });
  }

  /**
   * Remove all cleanup entries with the given name.
   */
  unregister(name: string): void {
    this.cleanups = this.cleanups.filter(entry => entry.name !== name);
  }

  /**
   * Attach SIGINT/SIGTERM handlers.
   * Second signal forces immediate exit.
   */
  attachSignalHandlers(): void {
    if (this.signalsAttached) return;
    this.signalsAttached = true;

    const handler = (signal: string) => {
      if (this.isShuttingDown) {
        // Second signal: force exit
        process.exit(1);
      }
      this.shutdown(`signal_${signal}`);
    };

    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  }

  /**
   * Run all registered cleanups in priority order (highest first).
   * Each cleanup has a 5-second timeout. One failing cleanup does
   * not prevent others from running.
   */
  async shutdown(reason: string = 'unknown'): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    // Sort by priority descending (highest first)
    const sorted = [...this.cleanups].sort((a, b) => b.priority - a.priority);

    for (const entry of sorted) {
      try {
        const result = entry.fn();
        if (result && typeof result === 'object' && 'then' in result) {
          await Promise.race([
            result,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`Cleanup "${entry.name}" timed out`)), 5000)
            ),
          ]);
        }
      } catch {
        // Continue with remaining cleanups
      }
    }
  }

  /**
   * Check if shutdown is in progress
   */
  getIsShuttingDown(): boolean {
    return this.isShuttingDown;
  }
}

// Singleton instance
let globalManager: ShutdownManager | null = null;

/**
 * Get the global ShutdownManager instance
 */
export function getShutdownManager(): ShutdownManager {
  if (!globalManager) {
    globalManager = new ShutdownManager();
  }
  return globalManager;
}

/**
 * Create a new ShutdownManager (for testing)
 */
export function createShutdownManager(): ShutdownManager {
  return new ShutdownManager();
}
