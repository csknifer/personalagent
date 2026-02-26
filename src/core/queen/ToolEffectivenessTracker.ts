/**
 * Tool Effectiveness Tracker — per-session Voyager-style procedural memory.
 * Tracks which tools work for which task patterns within a session.
 * Provides hints to workers about tool reliability.
 */

interface ToolStats {
  successes: number;
  failures: number;
}

const TASK_PATTERN_KEYWORDS: Record<string, string[]> = {
  research: ['search', 'find', 'look up', 'research', 'what is', 'who is', 'latest', 'current', 'news', 'stock', 'price', 'weather'],
  file: ['file', 'read', 'write', 'create', 'edit', 'modify', 'delete', 'directory', 'folder', 'path'],
  code: ['code', 'function', 'class', 'bug', 'fix', 'implement', 'refactor', 'test', 'build', 'compile', 'lint'],
};

export class ToolEffectivenessTracker {
  /** Outer key: task pattern, Inner key: tool name */
  private data: Map<string, Map<string, ToolStats>> = new Map();

  /**
   * Record the outcome of a task execution.
   */
  recordResult(
    taskPattern: string,
    toolsUsed: string[],
    toolFailures: Array<{ tool: string }>,
    _iterations: number,
  ): void {
    const failedTools = new Set(toolFailures.map(f => f.tool));

    if (!this.data.has(taskPattern)) {
      this.data.set(taskPattern, new Map());
    }
    const patternMap = this.data.get(taskPattern)!;

    for (const tool of toolsUsed) {
      if (!patternMap.has(tool)) {
        patternMap.set(tool, { successes: 0, failures: 0 });
      }
      const stats = patternMap.get(tool)!;
      if (failedTools.has(tool)) {
        stats.failures++;
      } else {
        stats.successes++;
      }
    }
  }

  /**
   * Get formatted hints for a given task pattern.
   * Returns empty string if no data is available.
   */
  getHints(taskPattern: string): string {
    const patternMap = this.data.get(taskPattern);
    if (!patternMap || patternMap.size === 0) return '';

    const hints: string[] = [];

    for (const [tool, stats] of patternMap) {
      const total = stats.successes + stats.failures;
      if (total < 1) continue;

      const rate = stats.successes / total;
      if (rate < 0.3) {
        hints.push(`- **${tool}**: Low reliability (${(rate * 100).toFixed(0)}% success) — consider alternatives`);
      } else if (rate < 0.7 && stats.failures > 0) {
        hints.push(`- **${tool}**: Mixed results (${(rate * 100).toFixed(0)}% success) — may need different parameters`);
      }
      // Don't mention high-reliability tools — they don't need hints
    }

    return hints.length > 0 ? hints.join('\n') : '';
  }

  /**
   * Classify a task description into a pattern category.
   */
  classifyTaskPattern(description: string): string {
    const lower = description.toLowerCase();
    let bestMatch = 'general';
    let bestScore = 0;

    for (const [pattern, keywords] of Object.entries(TASK_PATTERN_KEYWORDS)) {
      const matches = keywords.filter(kw => lower.includes(kw)).length;
      if (matches > bestScore) {
        bestScore = matches;
        bestMatch = pattern;
      }
    }

    return bestMatch;
  }

  /**
   * Get all accumulated data (for persistence to StrategyStore).
   */
  getAllData(): Map<string, Map<string, ToolStats>> {
    return this.data;
  }
}
