/**
 * Skill Tracker - Track skill usage, success rates, and learn from interactions
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

export interface SkillUsageRecord {
  skillId: string;
  skillName: string;
  timestamp: Date;
  query: string;
  success: boolean;
  executionTimeMs: number;
  feedback?: 'helpful' | 'not_helpful';
}

export interface SkillStats {
  skillId: string;
  skillName: string;
  totalInvocations: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTimeMs: number;
  helpfulCount: number;
  notHelpfulCount: number;
  lastUsed: Date | null;
  commonTriggers: string[];
}

export interface UnmatchedQuery {
  query: string;
  timestamp: Date;
  count: number;
}

export interface SkillTrackerData {
  version: string;
  usage: SkillUsageRecord[];
  unmatchedQueries: UnmatchedQuery[];
  suggestedTriggers: Record<string, string[]>; // skillId -> new triggers
}

const DEFAULT_DATA: SkillTrackerData = {
  version: '1.0.0',
  usage: [],
  unmatchedQueries: [],
  suggestedTriggers: {},
};

export class SkillTracker {
  private data: SkillTrackerData = DEFAULT_DATA;
  private dataPath: string;
  private isDirty: boolean = false;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(dataPath?: string) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    this.dataPath = dataPath || join(home, '.personalagent', 'skill-tracker.json');
  }

  /**
   * Load tracking data from disk
   */
  async load(): Promise<void> {
    try {
      if (existsSync(this.dataPath)) {
        const content = await readFile(this.dataPath, 'utf-8');
        const parsed = JSON.parse(content);
        this.data = {
          ...DEFAULT_DATA,
          ...parsed,
          usage: (parsed.usage || []).map((u: SkillUsageRecord) => ({
            ...u,
            timestamp: new Date(u.timestamp),
          })),
          unmatchedQueries: (parsed.unmatchedQueries || []).map((q: UnmatchedQuery) => ({
            ...q,
            timestamp: new Date(q.timestamp),
          })),
        };
      }
    } catch (error) {
      // Start fresh if file is corrupted
      this.data = DEFAULT_DATA;
    }
  }

  /**
   * Save tracking data to disk (debounced)
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.isDirty = true;
    this.saveDebounceTimer = setTimeout(() => this.save(), 5000);
  }

  /**
   * Force save to disk
   */
  async save(): Promise<void> {
    if (!this.isDirty) return;
    
    try {
      const dir = dirname(this.dataPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.isDirty = false;
    } catch (error) {
      console.error('Failed to save skill tracking data:', error);
    }
  }

  /**
   * Record a skill invocation
   */
  recordInvocation(
    skillId: string,
    skillName: string,
    query: string,
    success: boolean,
    executionTimeMs: number
  ): void {
    const record: SkillUsageRecord = {
      skillId,
      skillName,
      timestamp: new Date(),
      query,
      success,
      executionTimeMs,
    };

    this.data.usage.push(record);

    // Keep only last 1000 records
    if (this.data.usage.length > 1000) {
      this.data.usage = this.data.usage.slice(-1000);
    }

    // Analyze query for potential new triggers
    this.analyzeQueryForTriggers(skillId, query);

    this.scheduleSave();
  }

  /**
   * Record user feedback for the last skill invocation
   */
  recordFeedback(skillId: string, feedback: 'helpful' | 'not_helpful'): void {
    // Find the most recent invocation for this skill
    for (let i = this.data.usage.length - 1; i >= 0; i--) {
      if (this.data.usage[i].skillId === skillId && !this.data.usage[i].feedback) {
        this.data.usage[i].feedback = feedback;
        this.scheduleSave();
        break;
      }
    }
  }

  /**
   * Record an unmatched query (no skill triggered)
   */
  recordUnmatchedQuery(query: string): void {
    // Check if this query pattern already exists
    const normalized = this.normalizeQuery(query);
    const existing = this.data.unmatchedQueries.find(
      q => this.normalizeQuery(q.query) === normalized
    );

    if (existing) {
      existing.count++;
      existing.timestamp = new Date();
    } else {
      this.data.unmatchedQueries.push({
        query,
        timestamp: new Date(),
        count: 1,
      });
    }

    // Keep only top 100 unmatched queries
    this.data.unmatchedQueries.sort((a, b) => b.count - a.count);
    this.data.unmatchedQueries = this.data.unmatchedQueries.slice(0, 100);

    this.scheduleSave();
  }

  /**
   * Get statistics for all skills
   */
  getAllStats(): SkillStats[] {
    const statsMap = new Map<string, SkillStats>();

    for (const record of this.data.usage) {
      let stats = statsMap.get(record.skillId);
      
      if (!stats) {
        stats = {
          skillId: record.skillId,
          skillName: record.skillName,
          totalInvocations: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          averageExecutionTimeMs: 0,
          helpfulCount: 0,
          notHelpfulCount: 0,
          lastUsed: null,
          commonTriggers: [],
        };
        statsMap.set(record.skillId, stats);
      }

      stats.totalInvocations++;
      if (record.success) {
        stats.successfulExecutions++;
      } else {
        stats.failedExecutions++;
      }
      if (record.feedback === 'helpful') {
        stats.helpfulCount++;
      } else if (record.feedback === 'not_helpful') {
        stats.notHelpfulCount++;
      }
      
      // Update average execution time (running average)
      stats.averageExecutionTimeMs = 
        (stats.averageExecutionTimeMs * (stats.totalInvocations - 1) + record.executionTimeMs) / 
        stats.totalInvocations;
      
      // Update last used
      if (!stats.lastUsed || record.timestamp > stats.lastUsed) {
        stats.lastUsed = record.timestamp;
      }
    }

    // Add common triggers from analysis
    for (const [skillId, triggers] of Object.entries(this.data.suggestedTriggers)) {
      const stats = statsMap.get(skillId);
      if (stats) {
        stats.commonTriggers = triggers.slice(0, 5);
      }
    }

    return Array.from(statsMap.values()).sort(
      (a, b) => b.totalInvocations - a.totalInvocations
    );
  }

  /**
   * Get statistics for a specific skill
   */
  getSkillStats(skillId: string): SkillStats | null {
    const allStats = this.getAllStats();
    return allStats.find(s => s.skillId === skillId) || null;
  }

  /**
   * Get frequently unmatched queries (potential new skill opportunities)
   */
  getUnmatchedPatterns(minCount: number = 3): UnmatchedQuery[] {
    return this.data.unmatchedQueries
      .filter(q => q.count >= minCount)
      .slice(0, 10);
  }

  /**
   * Get suggested new triggers for a skill
   */
  getSuggestedTriggers(skillId: string): string[] {
    return this.data.suggestedTriggers[skillId] || [];
  }

  /**
   * Clear all tracking data
   */
  async clearAll(): Promise<void> {
    this.data = DEFAULT_DATA;
    await this.save();
  }

  /**
   * Get skill improvement suggestions based on usage patterns
   */
  getSkillImprovements(skillId: string): {
    suggestedTriggers: string[];
    successRate: number;
    commonFailurePatterns: string[];
    recommendation: string;
  } {
    const stats = this.getSkillStats(skillId);
    const suggestedTriggers = this.getSuggestedTriggers(skillId);

    if (!stats) {
      return {
        suggestedTriggers: [],
        successRate: 0,
        commonFailurePatterns: [],
        recommendation: 'No usage data available for this skill.',
      };
    }

    const successRate = stats.totalInvocations > 0 
      ? (stats.successfulExecutions / stats.totalInvocations) * 100 
      : 0;

    // Find common failure patterns
    const failedQueries = this.data.usage
      .filter(u => u.skillId === skillId && !u.success)
      .map(u => u.query);
    
    const commonFailurePatterns = this.extractPatterns(failedQueries);

    // Generate recommendation
    let recommendation = '';
    if (successRate < 50) {
      recommendation = 'Low success rate. Consider reviewing skill instructions and success criteria.';
    } else if (successRate < 80) {
      recommendation = 'Moderate success rate. Add more specific instructions for edge cases.';
    } else if (suggestedTriggers.length > 0) {
      recommendation = `Good performance! Consider adding these triggers: ${suggestedTriggers.slice(0, 3).join(', ')}`;
    } else {
      recommendation = 'Skill is performing well. No immediate improvements needed.';
    }

    return {
      suggestedTriggers,
      successRate,
      commonFailurePatterns,
      recommendation,
    };
  }

  /**
   * Suggest new skills based on unmatched query patterns
   */
  suggestNewSkills(): Array<{
    name: string;
    description: string;
    suggestedTriggers: string[];
    queryCount: number;
  }> {
    const suggestions: Array<{
      name: string;
      description: string;
      suggestedTriggers: string[];
      queryCount: number;
    }> = [];

    // Group unmatched queries by theme
    const patterns = this.clusterUnmatchedQueries();

    for (const [theme, queries] of Object.entries(patterns)) {
      if (queries.length >= 2) {
        suggestions.push({
          name: this.generateSkillName(theme),
          description: `Handle queries related to: ${theme}`,
          suggestedTriggers: queries.slice(0, 5),
          queryCount: queries.length,
        });
      }
    }

    return suggestions.sort((a, b) => b.queryCount - a.queryCount).slice(0, 5);
  }

  /**
   * Learn from user feedback to improve skill matching
   */
  learnFromFeedback(): {
    skillsWithIssues: Array<{ skillId: string; skillName: string; notHelpfulRate: number }>;
    suggestedRemovals: string[];
    suggestedAdditions: Array<{ trigger: string; skillId: string }>;
  } {
    const skillsWithIssues: Array<{ skillId: string; skillName: string; notHelpfulRate: number }> = [];
    const suggestedRemovals: string[] = [];
    const suggestedAdditions: Array<{ trigger: string; skillId: string }> = [];

    // Analyze skills with high "not helpful" feedback
    for (const stats of this.getAllStats()) {
      const totalFeedback = stats.helpfulCount + stats.notHelpfulCount;
      if (totalFeedback >= 3) {
        const notHelpfulRate = stats.notHelpfulCount / totalFeedback;
        if (notHelpfulRate > 0.3) {
          skillsWithIssues.push({
            skillId: stats.skillId,
            skillName: stats.skillName,
            notHelpfulRate: notHelpfulRate * 100,
          });
        }
      }

      // Suggest new triggers from successful invocations
      const triggers = this.getSuggestedTriggers(stats.skillId);
      for (const trigger of triggers) {
        suggestedAdditions.push({ trigger, skillId: stats.skillId });
      }
    }

    return {
      skillsWithIssues,
      suggestedRemovals,
      suggestedAdditions: suggestedAdditions.slice(0, 10),
    };
  }

  /**
   * Get a summary for display
   */
  getSummary(): {
    totalInvocations: number;
    uniqueSkillsUsed: number;
    successRate: number;
    topSkills: Array<{ name: string; count: number }>;
    unmatchedCount: number;
  } {
    const stats = this.getAllStats();
    const totalInvocations = stats.reduce((sum, s) => sum + s.totalInvocations, 0);
    const successfulInvocations = stats.reduce((sum, s) => sum + s.successfulExecutions, 0);

    return {
      totalInvocations,
      uniqueSkillsUsed: stats.length,
      successRate: totalInvocations > 0 ? (successfulInvocations / totalInvocations) * 100 : 0,
      topSkills: stats.slice(0, 5).map(s => ({ name: s.skillName, count: s.totalInvocations })),
      unmatchedCount: this.data.unmatchedQueries.reduce((sum, q) => sum + q.count, 0),
    };
  }

  // ============ Private Helper Methods ============

  private normalizeQuery(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private analyzeQueryForTriggers(skillId: string, query: string): void {
    // Extract potential trigger phrases (2-4 word combinations)
    const words = this.normalizeQuery(query).split(' ');
    const phrases: string[] = [];

    for (let len = 2; len <= 4 && len <= words.length; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        if (phrase.length >= 5 && phrase.length <= 30) {
          phrases.push(phrase);
        }
      }
    }

    // Add to suggested triggers (dedup and keep top 10)
    if (!this.data.suggestedTriggers[skillId]) {
      this.data.suggestedTriggers[skillId] = [];
    }

    const existing = new Set(this.data.suggestedTriggers[skillId]);
    for (const phrase of phrases) {
      existing.add(phrase);
    }

    this.data.suggestedTriggers[skillId] = Array.from(existing).slice(0, 10);
  }

  /**
   * Extract common patterns from a list of queries
   */
  private extractPatterns(queries: string[]): string[] {
    if (queries.length === 0) return [];

    // Simple word frequency analysis
    const wordFreq = new Map<string, number>();
    
    for (const query of queries) {
      const words = this.normalizeQuery(query).split(' ');
      for (const word of words) {
        if (word.length > 3) {
          wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        }
      }
    }

    // Return words that appear in multiple queries
    return Array.from(wordFreq.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Cluster unmatched queries by theme
   */
  private clusterUnmatchedQueries(): Record<string, string[]> {
    const clusters: Record<string, string[]> = {};
    
    // Simple keyword-based clustering
    const keywords = [
      'code', 'file', 'git', 'test', 'debug', 'api', 'database', 'deploy',
      'write', 'read', 'create', 'delete', 'update', 'search', 'find',
      'help', 'explain', 'how', 'what', 'why', 'email', 'message', 'document'
    ];

    for (const unmatched of this.data.unmatchedQueries) {
      const normalized = this.normalizeQuery(unmatched.query);
      
      for (const keyword of keywords) {
        if (normalized.includes(keyword)) {
          if (!clusters[keyword]) {
            clusters[keyword] = [];
          }
          clusters[keyword].push(unmatched.query);
          break; // Only add to first matching cluster
        }
      }
    }

    return clusters;
  }

  /**
   * Generate a skill name from a theme
   */
  private generateSkillName(theme: string): string {
    const nameMap: Record<string, string> = {
      code: 'Code Helper',
      file: 'File Assistant',
      git: 'Git Helper',
      test: 'Test Assistant',
      debug: 'Debug Helper',
      api: 'API Assistant',
      database: 'Database Helper',
      deploy: 'Deployment Assistant',
      email: 'Email Composer',
      document: 'Document Helper',
    };

    return nameMap[theme] || `${theme.charAt(0).toUpperCase()}${theme.slice(1)} Assistant`;
  }
}

/**
 * Create a skill tracker instance
 */
export function createSkillTracker(dataPath?: string): SkillTracker {
  return new SkillTracker(dataPath);
}
