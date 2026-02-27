import { describe, it, expect, vi } from 'vitest';
import { GraphExtractor, formatExtractionInput } from './GraphExtractor.js';
import type { ExtractedEntity, ExtractedRelationship } from './KnowledgeGraph.js';

// Mock provider
function createMockProvider(response: string) {
  return {
    name: 'mock',
    model: 'mock-model',
    chat: vi.fn(async () => ({ content: response })),
    chatStream: vi.fn(),
    complete: vi.fn(),
    supportsTools: () => false,
    getAvailableModels: () => ['mock-model'],
  };
}

describe('GraphExtractor', () => {
  describe('extract', () => {
    it('parses valid JSON response into entities and relationships', async () => {
      const response = JSON.stringify({
        entities: [
          { name: 'Acme Corp', type: 'organization', properties: { founded: '2019' }, confidence: 0.8 },
          { name: 'Jane Doe', type: 'person', properties: { role: 'CEO' }, confidence: 0.9 },
        ],
        relationships: [
          { source: 'Jane Doe', target: 'Acme Corp', predicate: 'founded', evidence: 'Jane founded Acme', weight: 0.9 },
        ],
      });

      const extractor = new GraphExtractor(createMockProvider(response) as any);
      const result = await extractor.extract([
        { workerId: 'w1-task-1', findings: ['Acme Corp was founded by Jane Doe in 2019'], scratchpad: [] },
      ]);

      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].name).toBe('Acme Corp');
      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].predicate).toBe('founded');
    });

    it('handles JSON wrapped in markdown code blocks', async () => {
      const response = '```json\n' + JSON.stringify({
        entities: [{ name: 'Test', type: 'concept', properties: {}, confidence: 0.5 }],
        relationships: [],
      }) + '\n```';

      const extractor = new GraphExtractor(createMockProvider(response) as any);
      const result = await extractor.extract([
        { workerId: 'w1-task-1', findings: ['Test is a concept'], scratchpad: [] },
      ]);

      expect(result.entities).toHaveLength(1);
    });

    it('returns empty results on invalid JSON', async () => {
      const extractor = new GraphExtractor(createMockProvider('not json at all') as any);
      const result = await extractor.extract([
        { workerId: 'w1-task-1', findings: ['Something'], scratchpad: [] },
      ]);

      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('returns empty results on LLM error', async () => {
      const provider = createMockProvider('');
      provider.chat = vi.fn(async () => { throw new Error('LLM API error'); });

      const extractor = new GraphExtractor(provider as any);
      const result = await extractor.extract([
        { workerId: 'w1-task-1', findings: ['Something'], scratchpad: [] },
      ]);

      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('skips extraction when no findings provided', async () => {
      const provider = createMockProvider('{}');
      const extractor = new GraphExtractor(provider as any);
      const result = await extractor.extract([
        { workerId: 'w1-task-1', findings: [], scratchpad: [] },
      ]);

      expect(result.entities).toHaveLength(0);
      expect(provider.chat).not.toHaveBeenCalled(); // no LLM call needed
    });

    it('filters out entities with invalid types', async () => {
      const response = JSON.stringify({
        entities: [
          { name: 'Valid', type: 'person', properties: {}, confidence: 0.8 },
          { name: 'Invalid', type: 'banana', properties: {}, confidence: 0.8 },
        ],
        relationships: [],
      });

      const extractor = new GraphExtractor(createMockProvider(response) as any);
      const result = await extractor.extract([
        { workerId: 'w1-task-1', findings: ['Valid is a person'], scratchpad: [] },
      ]);

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Valid');
    });
  });

  describe('formatExtractionInput', () => {
    it('formats findings and scratchpad into labeled sections', () => {
      const input = formatExtractionInput([
        {
          workerId: 'w1-task-1',
          findings: ['Finding A', 'Finding B'],
          scratchpad: ['Hypothesis X'],
        },
        {
          workerId: 'w1-task-2',
          findings: ['Finding C'],
          scratchpad: [],
        },
      ]);

      expect(input).toContain('--- Worker w1-task-1 ---');
      expect(input).toContain('Finding A');
      expect(input).toContain('Hypothesis X');
      expect(input).toContain('--- Worker w1-task-2 ---');
      expect(input).toContain('Finding C');
    });
  });
});
