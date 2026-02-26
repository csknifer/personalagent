/**
 * Tests for SkillTracker in-memory behavior.
 * No disk I/O — we never call save().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillTracker } from './SkillTracker.js';

describe('SkillTracker', () => {
  let tracker: SkillTracker;

  beforeEach(() => {
    tracker = new SkillTracker('/fake/path.json');
    // Reset internal data to avoid shared-reference bleeding between tests.
    // DEFAULT_DATA is assigned by reference, so we need a fresh copy.
    (tracker as unknown as { data: { version: string; usage: unknown[]; unmatchedQueries: unknown[]; suggestedTriggers: Record<string, string[]> } }).data = {
      version: '1.0.0',
      usage: [],
      unmatchedQueries: [],
      suggestedTriggers: {},
    };
  });

  describe('recordInvocation + getAllStats', () => {
    it('tracks total invocations and success/failure counts', () => {
      tracker.recordInvocation('s1', 'Skill One', 'query 1', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'query 2', false, 200);
      tracker.recordInvocation('s1', 'Skill One', 'query 3', true, 150);

      const stats = tracker.getAllStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].skillId).toBe('s1');
      expect(stats[0].totalInvocations).toBe(3);
      expect(stats[0].successfulExecutions).toBe(2);
      expect(stats[0].failedExecutions).toBe(1);
    });

    it('calculates running average execution time', () => {
      tracker.recordInvocation('s1', 'Skill One', 'q1', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q2', true, 200);

      const stats = tracker.getAllStats();
      expect(stats[0].averageExecutionTimeMs).toBe(150);
    });

    it('sorts stats by total invocations (descending)', () => {
      tracker.recordInvocation('s1', 'Skill One', 'q', true, 100);
      tracker.recordInvocation('s2', 'Skill Two', 'q', true, 100);
      tracker.recordInvocation('s2', 'Skill Two', 'q', true, 100);
      tracker.recordInvocation('s2', 'Skill Two', 'q', true, 100);

      const stats = tracker.getAllStats();
      expect(stats[0].skillId).toBe('s2');
      expect(stats[1].skillId).toBe('s1');
    });
  });

  describe('recordUnmatchedQuery', () => {
    it('adds a new unmatched query with count 1', () => {
      tracker.recordUnmatchedQuery('how to deploy');
      const patterns = tracker.getUnmatchedPatterns(1);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].count).toBe(1);
    });

    it('deduplicates normalized queries by incrementing count', () => {
      tracker.recordUnmatchedQuery('How to deploy?');
      tracker.recordUnmatchedQuery('how to deploy');

      const patterns = tracker.getUnmatchedPatterns(1);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].count).toBe(2);
    });
  });

  describe('getSkillImprovements', () => {
    it('returns "No usage data" for unknown skill', () => {
      const result = tracker.getSkillImprovements('unknown');
      expect(result.recommendation).toContain('No usage data');
      expect(result.successRate).toBe(0);
    });

    it('returns low success rate recommendation when <50%', () => {
      tracker.recordInvocation('s1', 'Skill One', 'q1', false, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q2', false, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q3', true, 100);

      const result = tracker.getSkillImprovements('s1');
      expect(result.successRate).toBeCloseTo(33.33, 0);
      expect(result.recommendation).toContain('Low success rate');
    });

    it('returns moderate recommendation when 50-80%', () => {
      tracker.recordInvocation('s1', 'Skill One', 'q1', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q2', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q3', false, 100);

      const result = tracker.getSkillImprovements('s1');
      expect(result.successRate).toBeCloseTo(66.67, 0);
      expect(result.recommendation).toContain('Moderate success rate');
    });

    it('returns good performance recommendation when ≥80%', () => {
      tracker.recordInvocation('s1', 'Skill One', 'q1', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q2', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q3', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q4', true, 100);
      tracker.recordInvocation('s1', 'Skill One', 'q5', false, 100);

      const result = tracker.getSkillImprovements('s1');
      expect(result.successRate).toBe(80);
      // 80% with suggested triggers → "Good performance" or "performing well"
      expect(result.recommendation).toMatch(/Good performance|performing well/);
    });
  });
});
