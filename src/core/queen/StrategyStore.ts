/**
 * Cross-Session Strategy Store — Voyager-inspired persistent procedural memory.
 * Accumulates operational knowledge (tool strategies, user preferences, failure patterns)
 * that persists across sessions via a JSON file.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { homedir } from 'os';
import { getDebugLogger } from '../DebugLogger.js';

const log = getDebugLogger();

interface ToolStrategy {
  pattern: string;
  toolName: string;
  strategy: string;
  successRate: number;
  sampleSize: number;
  lastUpdated: string;
}

interface UserPreference {
  key: string;
  value: string;
  source: 'explicit' | 'inferred';
  lastSeen: string;
}

interface FailurePattern {
  pattern: string;
  description: string;
  avoidanceStrategy: string;
  occurrences: number;
  lastOccurred: string;
}

interface StrategyStoreData {
  version: 1;
  toolStrategies: ToolStrategy[];
  userPreferences: UserPreference[];
  failurePatterns: FailurePattern[];
}

const MAX_TOOL_STRATEGIES = 50;
const MAX_USER_PREFERENCES = 20;
const MAX_FAILURE_PATTERNS = 30;
const DEFAULT_MAX_AGE_DAYS = 30;

function defaultFilePath(): string {
  return `${homedir()}/.personalagent/strategy-store.json`;
}

function emptyData(): StrategyStoreData {
  return { version: 1, toolStrategies: [], userPreferences: [], failurePatterns: [] };
}

export class StrategyStore {
  private filePath: string;
  private data: StrategyStoreData = emptyData();
  private dirty = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultFilePath();
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.version === 1) {
        this.data = parsed as StrategyStoreData;
        this.prune();
      } else {
        log.warn('StrategyStore', `Unknown version ${parsed.version}, starting fresh`);
        this.data = emptyData();
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.debug('StrategyStore', 'No existing store found, starting fresh');
      } else {
        log.warn('StrategyStore', `Failed to load: ${e.message}, starting fresh`);
      }
      this.data = emptyData();
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
      log.debug('StrategyStore', 'Saved strategy store');
    } catch (err) {
      log.warn('StrategyStore', `Failed to save: ${(err as Error).message}`);
    }
  }

  /**
   * Record the outcome of a tool usage for a given task pattern.
   */
  recordToolOutcome(pattern: string, toolName: string, success: boolean, note?: string): void {
    const existing = this.data.toolStrategies.find(
      s => s.pattern === pattern && s.toolName === toolName
    );
    if (existing) {
      const total = existing.sampleSize;
      existing.successRate = (existing.successRate * total + (success ? 1 : 0)) / (total + 1);
      existing.sampleSize++;
      existing.lastUpdated = new Date().toISOString();
      if (note) existing.strategy = note;
    } else {
      this.data.toolStrategies.push({
        pattern,
        toolName,
        strategy: note || (success ? 'Worked well' : 'Failed'),
        successRate: success ? 1 : 0,
        sampleSize: 1,
        lastUpdated: new Date().toISOString(),
      });
    }
    this.enforceCapToolStrategies();
    this.dirty = true;
  }

  /**
   * Set a user preference.
   */
  setPreference(key: string, value: string, source: 'explicit' | 'inferred'): void {
    const existing = this.data.userPreferences.find(p => p.key === key);
    if (existing) {
      existing.value = value;
      existing.source = source;
      existing.lastSeen = new Date().toISOString();
    } else {
      this.data.userPreferences.push({
        key,
        value,
        source,
        lastSeen: new Date().toISOString(),
      });
    }
    this.enforceCapPreferences();
    this.dirty = true;
  }

  /**
   * Record a failure pattern with an avoidance strategy.
   */
  recordFailure(pattern: string, description: string, avoidance: string): void {
    const existing = this.data.failurePatterns.find(
      f => f.pattern === pattern && f.description === description
    );
    if (existing) {
      existing.occurrences++;
      existing.avoidanceStrategy = avoidance;
      existing.lastOccurred = new Date().toISOString();
    } else {
      this.data.failurePatterns.push({
        pattern,
        description,
        avoidanceStrategy: avoidance,
        occurrences: 1,
        lastOccurred: new Date().toISOString(),
      });
    }
    this.enforceCapFailures();
    this.dirty = true;
  }

  /**
   * Build formatted strategy hints for injection into worker prompts.
   */
  buildStrategyHints(taskPattern: string): string {
    const hints: string[] = [];

    // Tool strategies for this pattern
    const relevant = this.data.toolStrategies.filter(s => s.pattern === taskPattern);
    for (const s of relevant) {
      if (s.successRate < 0.3 && s.sampleSize >= 2) {
        hints.push(`- **${s.toolName}**: Low reliability (${(s.successRate * 100).toFixed(0)}% over ${s.sampleSize} uses) — ${s.strategy}`);
      } else if (s.successRate < 0.7 && s.sampleSize >= 2) {
        hints.push(`- **${s.toolName}**: Mixed (${(s.successRate * 100).toFixed(0)}% over ${s.sampleSize} uses) — ${s.strategy}`);
      }
    }

    // Failure patterns
    const failures = this.data.failurePatterns.filter(f => f.pattern === taskPattern);
    for (const f of failures) {
      hints.push(`- **Avoid**: ${f.description} — ${f.avoidanceStrategy} (seen ${f.occurrences}×)`);
    }

    // User preferences (always include regardless of pattern)
    for (const p of this.data.userPreferences) {
      hints.push(`- **Preference** (${p.source}): ${p.key} = ${p.value}`);
    }

    return hints.length > 0 ? hints.join('\n') : '';
  }

  /**
   * Remove entries older than maxAgeDays.
   */
  prune(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const beforeTools = this.data.toolStrategies.length;
    this.data.toolStrategies = this.data.toolStrategies.filter(
      s => new Date(s.lastUpdated).getTime() > cutoff
    );

    const beforeFailures = this.data.failurePatterns.length;
    this.data.failurePatterns = this.data.failurePatterns.filter(
      f => new Date(f.lastOccurred).getTime() > cutoff
    );

    const beforePrefs = this.data.userPreferences.length;
    this.data.userPreferences = this.data.userPreferences.filter(
      p => new Date(p.lastSeen).getTime() > cutoff
    );

    const pruned = (beforeTools - this.data.toolStrategies.length)
      + (beforeFailures - this.data.failurePatterns.length)
      + (beforePrefs - this.data.userPreferences.length);

    if (pruned > 0) {
      log.debug('StrategyStore', `Pruned ${pruned} stale entries`);
      this.dirty = true;
    }
  }

  /**
   * Ingest session data from ToolEffectivenessTracker at session end.
   */
  ingestSessionData(data: Map<string, Map<string, { successes: number; failures: number }>>): void {
    for (const [pattern, toolMap] of data) {
      for (const [toolName, stats] of toolMap) {
        const total = stats.successes + stats.failures;
        if (total < 1) continue;
        for (let i = 0; i < stats.successes; i++) {
          this.recordToolOutcome(pattern, toolName, true);
        }
        for (let i = 0; i < stats.failures; i++) {
          this.recordToolOutcome(pattern, toolName, false);
        }
      }
    }
  }

  private enforceCapToolStrategies(): void {
    if (this.data.toolStrategies.length > MAX_TOOL_STRATEGIES) {
      // Keep most recently updated
      this.data.toolStrategies.sort((a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
      );
      this.data.toolStrategies = this.data.toolStrategies.slice(0, MAX_TOOL_STRATEGIES);
    }
  }

  private enforceCapPreferences(): void {
    if (this.data.userPreferences.length > MAX_USER_PREFERENCES) {
      this.data.userPreferences.sort((a, b) =>
        new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
      );
      this.data.userPreferences = this.data.userPreferences.slice(0, MAX_USER_PREFERENCES);
    }
  }

  private enforceCapFailures(): void {
    if (this.data.failurePatterns.length > MAX_FAILURE_PATTERNS) {
      this.data.failurePatterns.sort((a, b) =>
        new Date(b.lastOccurred).getTime() - new Date(a.lastOccurred).getTime()
      );
      this.data.failurePatterns = this.data.failurePatterns.slice(0, MAX_FAILURE_PATTERNS);
    }
  }
}
