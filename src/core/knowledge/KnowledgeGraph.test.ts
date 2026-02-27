import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from './KnowledgeGraph.js';

describe('KnowledgeGraph', () => {
  describe('merge', () => {
    it('adds new entities and relationships', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [{ name: 'Acme Corp', type: 'organization', properties: { founded: '2019' }, confidence: 0.8 }],
        [{ source: 'Acme Corp', target: 'Jane Doe', predicate: 'founded_by', evidence: 'Jane founded Acme', weight: 0.9 }],
        1, // wave
        ['w1-task-1'],
      );

      const stats = graph.getStats();
      expect(stats.entityCount).toBe(2); // Acme Corp + Jane Doe (auto-created from relationship)
      expect(stats.relationshipCount).toBe(1);
    });

    it('reinforces confidence on re-extraction of same entity', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [{ name: 'Acme Corp', type: 'organization', properties: {}, confidence: 0.6 }],
        [], 1, ['w1-task-1'],
      );
      graph.merge(
        [{ name: 'Acme Corp', type: 'organization', properties: { ceo: 'Jane' }, confidence: 0.9 }],
        [], 2, ['w2-task-1'],
      );

      const entity = graph.getEntity('acme-corp');
      expect(entity).toBeDefined();
      expect(entity!.mentions).toBe(2);
      expect(entity!.confidence).toBeGreaterThan(0.6); // reinforced
      expect(entity!.properties.get('ceo')).toBe('Jane');
      expect(entity!.properties.get('founded')).toBeUndefined(); // wasn't in either merge
      expect(entity!.firstSeen).toBe(1);
      expect(entity!.lastSeen).toBe(2);
      expect(entity!.sourceWorkers).toEqual(['w1-task-1', 'w2-task-1']);
    });

    it('merges properties additively', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [{ name: 'Acme Corp', type: 'organization', properties: { founded: '2019' }, confidence: 0.8 }],
        [], 1, ['w1-task-1'],
      );
      graph.merge(
        [{ name: 'Acme Corp', type: 'organization', properties: { hq: 'Berlin' }, confidence: 0.8 }],
        [], 2, ['w2-task-1'],
      );

      const entity = graph.getEntity('acme-corp');
      expect(entity!.properties.get('founded')).toBe('2019');
      expect(entity!.properties.get('hq')).toBe('Berlin');
    });

    it('strengthens relationship weight on re-extraction', () => {
      const graph = new KnowledgeGraph();
      const rel = { source: 'Acme Corp', target: 'Jane Doe', predicate: 'founded_by', evidence: 'Jane founded Acme', weight: 0.7 };
      graph.merge([], [rel], 1, ['w1-task-1']);
      graph.merge([], [{ ...rel, weight: 0.9 }], 2, ['w2-task-1']);

      const stats = graph.getStats();
      expect(stats.relationshipCount).toBe(1); // not duplicated
    });
  });

  describe('getContext', () => {
    it('returns formatted context string with entities and relationships', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [
          { name: 'Acme Corp', type: 'organization', properties: { founded: '2019' }, confidence: 0.8 },
          { name: 'Jane Doe', type: 'person', properties: { role: 'CEO' }, confidence: 0.9 },
        ],
        [{ source: 'Jane Doe', target: 'Acme Corp', predicate: 'founded', evidence: 'Jane founded Acme in 2019', weight: 0.9 }],
        1, ['w1-task-1'],
      );

      const context = graph.getContext('Tell me about Acme Corp');
      expect(context).toContain('Acme Corp');
      expect(context).toContain('Jane Doe');
      expect(context).toContain('founded');
    });

    it('prioritizes entities relevant to the task description', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [
          { name: 'Acme Corp', type: 'organization', properties: {}, confidence: 0.8 },
          { name: 'Unrelated Thing', type: 'concept', properties: {}, confidence: 0.8 },
        ],
        [], 1, ['w1-task-1'],
      );

      const context = graph.getContext('Research Acme Corp competitors');
      // Acme Corp should appear before Unrelated Thing
      const acmePos = context.indexOf('Acme Corp');
      const unrelatedPos = context.indexOf('Unrelated Thing');
      expect(acmePos).toBeLessThan(unrelatedPos);
    });

    it('returns empty string for empty graph', () => {
      const graph = new KnowledgeGraph();
      expect(graph.getContext('anything')).toBe('');
    });
  });

  describe('getSynthesisView', () => {
    it('groups entities by type', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [
          { name: 'Acme Corp', type: 'organization', properties: {}, confidence: 0.8 },
          { name: 'Jane Doe', type: 'person', properties: {}, confidence: 0.9 },
        ],
        [], 1, ['w1-task-1'],
      );

      const view = graph.getSynthesisView();
      expect(view).toContain('### People');
      expect(view).toContain('### Organizations');
    });

    it('flags single-source claims', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [{ name: 'Acme Corp', type: 'organization', properties: {}, confidence: 0.5 }],
        [], 1, ['w1-task-1'],
      );

      const view = graph.getSynthesisView();
      expect(view).toContain('single source');
    });

    it('returns empty string for empty graph', () => {
      const graph = new KnowledgeGraph();
      expect(graph.getSynthesisView()).toBe('');
    });
  });

  describe('getStats', () => {
    it('returns zero counts for empty graph', () => {
      const graph = new KnowledgeGraph();
      const stats = graph.getStats();
      expect(stats.entityCount).toBe(0);
      expect(stats.relationshipCount).toBe(0);
      expect(stats.topEntities).toEqual([]);
    });
  });

  describe('slugify', () => {
    it('generates deterministic IDs from names', () => {
      const graph = new KnowledgeGraph();
      graph.merge(
        [{ name: 'José Ibarra Jr.', type: 'person', properties: {}, confidence: 0.8 }],
        [], 1, ['w1-task-1'],
      );
      // Should be accessible via slugified ID
      const entity = graph.getEntity('jose-ibarra-jr');
      expect(entity).toBeDefined();
      expect(entity!.name).toBe('José Ibarra Jr.');
    });
  });
});
