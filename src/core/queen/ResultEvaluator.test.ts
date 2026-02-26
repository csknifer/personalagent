import { describe, it, expect } from 'vitest';
import { buildEvaluatorPrompt, parseEvaluationResult } from './ResultEvaluator.js';
import type { CompletedTaskSummary } from '../types.js';

describe('ResultEvaluator', () => {
  describe('buildEvaluatorPrompt', () => {
    it('includes the original request', () => {
      const prompt = buildEvaluatorPrompt({
        originalRequest: 'What is quantum computing?',
        aggregatedResult: 'Quantum computing uses qubits...',
        taskSummaries: [],
      });
      expect(prompt).toContain('What is quantum computing?');
    });

    it('includes the aggregated result', () => {
      const prompt = buildEvaluatorPrompt({
        originalRequest: 'Test request',
        aggregatedResult: 'Here is the detailed result about the topic.',
        taskSummaries: [],
      });
      expect(prompt).toContain('Here is the detailed result about the topic.');
    });

    it('includes task summaries when provided', () => {
      const summaries: CompletedTaskSummary[] = [
        {
          taskId: 'task-1',
          description: 'Research quantum computing basics',
          success: true,
          outputSummary: 'Found info about qubits',
          findings: ['Qubits can be in superposition', 'Entanglement enables parallelism'],
        },
        {
          taskId: 'task-2',
          description: 'Find recent breakthroughs',
          success: false,
          outputSummary: 'Search failed',
        },
      ];

      const prompt = buildEvaluatorPrompt({
        originalRequest: 'Test',
        aggregatedResult: 'Result text',
        taskSummaries: summaries,
      });

      expect(prompt).toContain('Research quantum computing basics');
      expect(prompt).toContain('succeeded');
      expect(prompt).toContain('Find recent breakthroughs');
      expect(prompt).toContain('failed');
      expect(prompt).toContain('Qubits can be in superposition');
    });

    it('truncates very long results', () => {
      const longResult = 'A'.repeat(5000);
      const prompt = buildEvaluatorPrompt({
        originalRequest: 'Test',
        aggregatedResult: longResult,
        taskSummaries: [],
      });

      expect(prompt).toContain('[truncated]');
      // Should be significantly shorter than the input
      expect(prompt.length).toBeLessThan(longResult.length);
    });
  });

  describe('parseEvaluationResult', () => {
    it('parses valid JSON response', () => {
      const response = JSON.stringify({
        pass: true,
        score: 0.85,
        feedback: 'Good comprehensive answer',
        missingAspects: [],
      });

      const result = parseEvaluationResult(response, 0.7);
      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.85);
      expect(result.feedback).toBe('Good comprehensive answer');
      expect(result.missingAspects).toEqual([]);
    });

    it('parses JSON in markdown code fences', () => {
      const response = `Here's my evaluation:

\`\`\`json
{
  "pass": false,
  "score": 0.4,
  "feedback": "Missing key details about pricing",
  "missingAspects": ["pricing data", "competitor comparison"]
}
\`\`\`

The response needs more data.`;

      const result = parseEvaluationResult(response, 0.7);
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.4);
      expect(result.feedback).toBe('Missing key details about pricing');
      expect(result.missingAspects).toEqual(['pricing data', 'competitor comparison']);
    });

    it('clamps out-of-range scores', () => {
      const response = JSON.stringify({
        pass: true,
        score: 1.5,
        feedback: 'Great',
        missingAspects: [],
      });

      const result = parseEvaluationResult(response, 0.7);
      expect(result.score).toBe(1.0);
    });

    it('clamps negative scores to 0', () => {
      const response = JSON.stringify({
        pass: false,
        score: -0.5,
        feedback: 'Bad',
        missingAspects: ['everything'],
      });

      const result = parseEvaluationResult(response, 0.7);
      expect(result.score).toBe(0);
    });

    it('derives pass from threshold when pass is not boolean', () => {
      const response = JSON.stringify({
        score: 0.8,
        feedback: 'Pretty good',
        missingAspects: [],
      });

      const result = parseEvaluationResult(response, 0.7);
      expect(result.pass).toBe(true); // 0.8 >= 0.7

      const result2 = parseEvaluationResult(response, 0.9);
      expect(result2.pass).toBe(false); // 0.8 < 0.9
    });

    it('fails open on malformed JSON', () => {
      const result = parseEvaluationResult('this is not json at all', 0.7);
      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.75);
      expect(result.missingAspects).toEqual([]);
    });

    it('fails open on empty response', () => {
      const result = parseEvaluationResult('', 0.7);
      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.75);
    });

    it('handles missing fields gracefully', () => {
      const response = JSON.stringify({ score: 0.6 });
      const result = parseEvaluationResult(response, 0.7);
      expect(result.pass).toBe(false); // 0.6 < 0.7, derived from threshold
      expect(result.score).toBe(0.6);
      expect(result.feedback).toBe('');
      expect(result.missingAspects).toEqual([]);
    });

    it('filters non-string items from missingAspects', () => {
      const response = JSON.stringify({
        pass: false,
        score: 0.5,
        feedback: 'Issues',
        missingAspects: ['valid', 123, null, 'also valid'],
      });

      const result = parseEvaluationResult(response, 0.7);
      expect(result.missingAspects).toEqual(['valid', 'also valid']);
    });
  });
});
