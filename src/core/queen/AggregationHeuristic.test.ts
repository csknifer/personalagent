import { describe, it, expect } from 'vitest';
import { shouldSynthesizeWithLLM } from './AggregationHeuristic.js';
import { KnowledgeGraph } from '../knowledge/KnowledgeGraph.js';

describe('AggregationHeuristic', () => {
  describe('shouldSynthesizeWithLLM', () => {
    it('returns false for single result', () => {
      const result = shouldSynthesizeWithLLM([
        { description: 'Get weather', output: 'It is sunny in NYC, 72°F', dependencies: [] },
      ]);
      expect(result.shouldSynthesize).toBe(false);
    });

    it('returns false for disjoint topics', () => {
      const result = shouldSynthesizeWithLLM([
        { description: 'Get weather', output: 'The weather in NYC is sunny, 72°F with clear skies. Humidity is at 45%.', dependencies: [] },
        { description: 'Get stock price', output: 'AAPL is trading at $185.50, up 2.3% today. Market cap is $2.9T.', dependencies: [] },
      ]);
      expect(result.shouldSynthesize).toBe(false);
    });

    it('returns true for overlapping topics', () => {
      const result = shouldSynthesizeWithLLM([
        { description: 'Get AAPL price', output: 'Apple stock (AAPL) is trading at $185.50. Revenue was $94.8B last quarter. Tim Cook announced new products.', dependencies: [] },
        { description: 'Get AAPL analyst opinions', output: 'Analysts rate Apple stock (AAPL) as a buy. Goldman Sachs set a price target of $210. Revenue growth expected to continue.', dependencies: [] },
      ]);
      expect(result.shouldSynthesize).toBe(true);
    });

    it('returns true when dependencies exist', () => {
      const result = shouldSynthesizeWithLLM([
        { description: 'Find API docs', output: 'The API endpoint is at /api/v2/users', dependencies: [] },
        { description: 'Write integration code', output: 'Here is the code to call the endpoint', dependencies: ['task-1'] },
      ]);
      expect(result.shouldSynthesize).toBe(true);
      expect(result.reason).toContain('dependencies');
    });

    it('respects custom overlap threshold', () => {
      const results = [
        { description: 'Topic A', output: 'The Python programming language is great for data science and machine learning applications.', dependencies: [] as string[] },
        { description: 'Topic B', output: 'JavaScript is widely used for web development and increasingly for machine learning too.', dependencies: [] as string[] },
      ];

      // With a very high threshold, skip synthesis
      const highThreshold = shouldSynthesizeWithLLM(results, 0.9);
      expect(highThreshold.shouldSynthesize).toBe(false);

      // With a very low threshold, synthesize
      const lowThreshold = shouldSynthesizeWithLLM(results, 0.01);
      expect(lowThreshold.shouldSynthesize).toBe(true);
    });

    it('returns true when graph has cross-entity relationships', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [
          { name: 'Acme', type: 'organization', properties: {}, confidence: 0.8 },
          { name: 'Jane', type: 'person', properties: {}, confidence: 0.9 },
        ],
        [{ source: 'Jane', target: 'Acme', predicate: 'founded', evidence: 'Jane founded Acme', weight: 0.9 }],
        1,
        ['w1-task-1'],
      );

      // Even with disjoint text, graph relationships force synthesis
      const result = shouldSynthesizeWithLLM(
        [
          { description: 'Get weather', output: 'It is sunny', dependencies: [] },
          { description: 'Get stocks', output: 'AAPL is up', dependencies: [] },
        ],
        0.15,
        graph,
      );
      expect(result.shouldSynthesize).toBe(true);
      expect(result.reason).toContain('knowledge graph');
    });
  });
});
