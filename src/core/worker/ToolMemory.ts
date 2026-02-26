/**
 * Tracks tool call outcomes across Ralph Loop iterations.
 * Blocks tools after 2+ consecutive failures to prevent wasted iterations.
 */

export interface ToolResult {
  success: boolean;
  error?: string;
  category?: string;
}

interface ToolRecord {
  consecutiveFailures: number;
  lastError?: string;
  lastCategory?: string;
}

export class ToolMemory {
  private tools = new Map<string, ToolRecord>();

  recordResult(toolName: string, result: ToolResult): void {
    if (result.success) {
      this.tools.set(toolName, { consecutiveFailures: 0 });
    } else {
      const existing = this.tools.get(toolName);
      this.tools.set(toolName, {
        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
        lastError: result.error,
        lastCategory: result.category,
      });
    }
  }

  isBlocked(toolName: string): boolean {
    const record = this.tools.get(toolName);
    return record !== undefined && record.consecutiveFailures >= 2;
  }

  renderForPrompt(): string {
    const blocked: string[] = [];
    for (const [name, record] of this.tools) {
      if (record.consecutiveFailures >= 2) {
        const reason = record.lastCategory ?? record.lastError ?? 'unknown';
        blocked.push(`- ${name}: UNAVAILABLE (${reason}, ${record.consecutiveFailures} consecutive failures)`);
      }
    }
    if (blocked.length === 0) return '';
    return `## Blocked Tools\n${blocked.join('\n')}`;
  }
}
