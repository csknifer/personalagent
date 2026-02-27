# Session-Scoped Knowledge Graph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a session-scoped knowledge graph to DiscoveryCoordinator that extracts entities/relationships from worker findings at wave boundaries and uses them for structured context injection and graph-aware aggregation.

**Architecture:** New `src/core/knowledge/` module with `KnowledgeGraph` (in-memory graph data structure) and `GraphExtractor` (LLM-based extraction). Wired into `DiscoveryCoordinator` at wave boundaries. `AggregationHeuristic` gets an optional graph parameter.

**Tech Stack:** TypeScript, Vitest, existing LLMProvider abstraction, existing `extractFindings()`/`extractScratchpad()` from `ralphUtils.ts`.

---

### Task 1: KnowledgeGraph data types and class

**Files:**
- Create: `src/core/knowledge/KnowledgeGraph.ts`
- Test: `src/core/knowledge/KnowledgeGraph.test.ts`

**Step 1: Write the failing tests**

Create `src/core/knowledge/KnowledgeGraph.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from './KnowledgeGraph.js';
import type { ExtractedEntity, ExtractedRelationship } from './KnowledgeGraph.js';

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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/knowledge/KnowledgeGraph.test.ts`
Expected: FAIL — module `./KnowledgeGraph.js` not found

**Step 3: Write the implementation**

Create `src/core/knowledge/KnowledgeGraph.ts`:

```typescript
/**
 * KnowledgeGraph — session-scoped in-memory entity/relationship graph.
 *
 * Extracted from worker findings at wave boundaries by GraphExtractor.
 * Provides structured context for subsequent workers and aggregation.
 */

export type EntityType = 'person' | 'organization' | 'place' | 'event'
                       | 'concept' | 'technology' | 'claim';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  properties: Map<string, string>;
  mentions: number;
  firstSeen: number;
  lastSeen: number;
  confidence: number;
  sourceWorkers: string[];
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  predicate: string;
  weight: number;
  evidence: string;
  wave: number;
}

/** Input format from LLM extraction (before merge into graph). */
export interface ExtractedEntity {
  name: string;
  type: EntityType;
  properties: Record<string, string>;
  confidence: number;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  predicate: string;
  evidence: string;
  weight: number;
}

export interface GraphStats {
  entityCount: number;
  relationshipCount: number;
  topEntities: Array<{ name: string; mentions: number; relationshipCount: number }>;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s-]/g, '')    // remove non-alphanumeric
    .trim()
    .replace(/\s+/g, '-')            // spaces to hyphens
    .replace(/-+/g, '-');             // collapse multiple hyphens
}

/** Pluralized display labels for entity types in synthesis view. */
const TYPE_LABELS: Record<EntityType, string> = {
  person: 'People',
  organization: 'Organizations',
  place: 'Places',
  event: 'Events',
  concept: 'Concepts',
  technology: 'Technologies',
  claim: 'Claims',
};

export class KnowledgeGraph {
  private entities = new Map<string, Entity>();
  private relationships = new Map<string, Relationship>();

  /**
   * Merge extracted entities and relationships into the graph.
   * Upserts entities (bumps mentions, averages confidence, merges properties).
   * Auto-creates stub entities referenced in relationships but not in entities list.
   */
  merge(
    extractedEntities: ExtractedEntity[],
    extractedRelationships: ExtractedRelationship[],
    wave: number,
    sourceWorkers: string[],
  ): void {
    // Merge entities
    for (const ext of extractedEntities) {
      const id = slugify(ext.name);
      if (!id) continue;

      const existing = this.entities.get(id);
      if (existing) {
        // Reinforce: average confidence, bump mentions, merge properties
        existing.confidence = (existing.confidence + ext.confidence) / 2;
        existing.mentions += 1;
        existing.lastSeen = wave;
        for (const [k, v] of Object.entries(ext.properties)) {
          existing.properties.set(k, v);
        }
        for (const w of sourceWorkers) {
          if (!existing.sourceWorkers.includes(w)) {
            existing.sourceWorkers.push(w);
          }
        }
      } else {
        this.entities.set(id, {
          id,
          name: ext.name,
          type: ext.type,
          properties: new Map(Object.entries(ext.properties)),
          mentions: 1,
          firstSeen: wave,
          lastSeen: wave,
          confidence: ext.confidence,
          sourceWorkers: [...sourceWorkers],
        });
      }
    }

    // Merge relationships (auto-create stub entities if needed)
    for (const ext of extractedRelationships) {
      const sourceId = slugify(ext.source);
      const targetId = slugify(ext.target);
      if (!sourceId || !targetId) continue;

      // Auto-create stub entities for relationship endpoints not in entities list
      for (const [id, name] of [[sourceId, ext.source], [targetId, ext.target]] as const) {
        if (!this.entities.has(id)) {
          this.entities.set(id, {
            id,
            name,
            type: 'concept', // default type for auto-created stubs
            properties: new Map(),
            mentions: 0,
            firstSeen: wave,
            lastSeen: wave,
            confidence: 0.3, // low confidence for stubs
            sourceWorkers: [...sourceWorkers],
          });
        }
      }

      const predSlug = ext.predicate.toLowerCase().replace(/\s+/g, '_');
      const relId = `${sourceId}--${predSlug}--${targetId}`;

      const existing = this.relationships.get(relId);
      if (existing) {
        // Strengthen weight
        existing.weight = Math.min(1.0, (existing.weight + ext.weight) / 2 + 0.1);
        if (ext.evidence) existing.evidence = ext.evidence;
      } else {
        this.relationships.set(relId, {
          id: relId,
          sourceId,
          targetId,
          predicate: ext.predicate,
          weight: ext.weight,
          evidence: ext.evidence,
          wave,
        });
      }
    }
  }

  /** Look up an entity by its slug ID. */
  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * Get relevance-filtered context string for worker prompt injection.
   * Keyword-matches task description against entity names/properties.
   */
  getContext(taskDescription: string, maxTokens: number = 2000): string {
    if (this.entities.size === 0) return '';

    const keywords = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length >= 3);

    // Score entities by relevance to task description
    const scored = [...this.entities.values()].map(entity => {
      let relevance = 0;
      const entityText = [
        entity.name,
        ...entity.properties.values(),
      ].join(' ').toLowerCase();

      for (const kw of keywords) {
        if (entityText.includes(kw)) relevance += 1;
      }
      // Boost by confidence and mentions
      const score = relevance * 2 + entity.confidence + entity.mentions * 0.2;
      return { entity, score };
    }).sort((a, b) => b.score - a.score);

    const parts: string[] = [];
    parts.push(`## Knowledge Graph Context`);
    parts.push('');
    parts.push('### Key Entities');

    let approxTokens = 30; // header overhead
    let includedCount = 0;

    for (const { entity } of scored) {
      const entityLines: string[] = [];
      entityLines.push(`- **${entity.name}** (${entity.type}, confidence: ${entity.confidence.toFixed(2)}, seen ${entity.mentions}×)`);

      for (const [k, v] of entity.properties) {
        entityLines.push(`  - ${k}: ${v}`);
      }

      // Find relationships involving this entity
      const rels = [...this.relationships.values()].filter(
        r => r.sourceId === entity.id || r.targetId === entity.id
      );
      if (rels.length > 0) {
        const relStrs = rels.map(r => {
          const other = r.sourceId === entity.id
            ? this.entities.get(r.targetId)?.name ?? r.targetId
            : this.entities.get(r.sourceId)?.name ?? r.sourceId;
          return `${r.predicate} ${other}`;
        });
        entityLines.push(`  - Relations: ${relStrs.join(', ')}`);
      }

      const block = entityLines.join('\n');
      const blockTokens = Math.ceil(block.length / 4); // rough estimate

      if (approxTokens + blockTokens > maxTokens) {
        const remaining = scored.length - includedCount;
        if (remaining > 0) {
          parts.push(`\n_(and ${remaining} more entities...)_`);
        }
        break;
      }

      parts.push(block);
      approxTokens += blockTokens;
      includedCount++;
    }

    // Flag single-source entities as open questions
    const singleSource = [...this.entities.values()].filter(
      e => e.sourceWorkers.length === 1 && e.mentions === 1
    );
    if (singleSource.length > 0) {
      parts.push('');
      parts.push('### Open Questions');
      parts.push(`- Single-source claims (need corroboration): ${singleSource.map(e => e.name).join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Get full graph view for aggregation synthesis.
   * Groups by entity type, flags contradictions and gaps.
   */
  getSynthesisView(): string {
    if (this.entities.size === 0) return '';

    const parts: string[] = [];
    const stats = this.getStats();
    parts.push(`## Knowledge Graph (${stats.entityCount} entities, ${stats.relationshipCount} relationships)`);

    // Group entities by type
    const byType = new Map<EntityType, Entity[]>();
    for (const entity of this.entities.values()) {
      const list = byType.get(entity.type) ?? [];
      list.push(entity);
      byType.set(entity.type, list);
    }

    for (const [type, entities] of byType) {
      parts.push('');
      parts.push(`### ${TYPE_LABELS[type]}`);

      for (const entity of entities) {
        const corroborated = entity.sourceWorkers.length > 1
          ? `, corroborated across ${entity.sourceWorkers.length} workers`
          : ', single source';
        parts.push(`- **${entity.name}** (confidence: ${entity.confidence.toFixed(2)}${corroborated})`);

        for (const [k, v] of entity.properties) {
          parts.push(`  - ${k}: ${v}`);
        }

        const rels = [...this.relationships.values()].filter(
          r => r.sourceId === entity.id || r.targetId === entity.id
        );
        for (const rel of rels) {
          const other = rel.sourceId === entity.id
            ? this.entities.get(rel.targetId)?.name ?? rel.targetId
            : this.entities.get(rel.sourceId)?.name ?? rel.sourceId;
          parts.push(`  -> ${rel.predicate} ${other}${rel.evidence ? ` (${rel.evidence})` : ''}`);
        }
      }
    }

    // Flag low-confidence / single-source claims
    const lowConfidence = [...this.entities.values()].filter(
      e => e.sourceWorkers.length === 1 && e.mentions === 1
    );
    if (lowConfidence.length > 0) {
      parts.push('');
      parts.push('### Low-Confidence Claims (single source)');
      for (const e of lowConfidence) {
        parts.push(`- "${e.name}" — only from ${e.sourceWorkers[0]}`);
      }
    }

    return parts.join('\n');
  }

  /** Get graph statistics. */
  getStats(): GraphStats {
    // Count relationships per entity
    const relCounts = new Map<string, number>();
    for (const rel of this.relationships.values()) {
      relCounts.set(rel.sourceId, (relCounts.get(rel.sourceId) ?? 0) + 1);
      relCounts.set(rel.targetId, (relCounts.get(rel.targetId) ?? 0) + 1);
    }

    const topEntities = [...this.entities.values()]
      .map(e => ({
        name: e.name,
        mentions: e.mentions,
        relationshipCount: relCounts.get(e.id) ?? 0,
      }))
      .sort((a, b) => (b.relationshipCount + b.mentions) - (a.relationshipCount + a.mentions))
      .slice(0, 5);

    return {
      entityCount: this.entities.size,
      relationshipCount: this.relationships.size,
      topEntities,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/knowledge/KnowledgeGraph.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/knowledge/KnowledgeGraph.ts src/core/knowledge/KnowledgeGraph.test.ts
git commit -m "feat: add KnowledgeGraph data structure with merge, context, and synthesis"
```

---

### Task 2: GraphExtractor — LLM-based entity/relationship extraction

**Files:**
- Create: `src/core/knowledge/GraphExtractor.ts`
- Test: `src/core/knowledge/GraphExtractor.test.ts`
- Reference: `src/core/worker/ralphUtils.ts:121-161` (extractFindings, extractScratchpad)
- Reference: `src/providers/Provider.ts` (LLMProvider interface)

**Step 1: Write the failing tests**

Create `src/core/knowledge/GraphExtractor.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/knowledge/GraphExtractor.test.ts`
Expected: FAIL — module `./GraphExtractor.js` not found

**Step 3: Write the implementation**

Create `src/core/knowledge/GraphExtractor.ts`:

```typescript
/**
 * GraphExtractor — LLM-based entity/relationship extraction from worker findings.
 *
 * Takes findings and scratchpad entries from a completed wave and uses an LLM
 * to extract structured entities and relationships for the KnowledgeGraph.
 */

import type { LLMProvider, ChatOptions } from '../../providers/Provider.js';
import type { Message } from '../types.js';
import type { ExtractedEntity, ExtractedRelationship, EntityType } from './KnowledgeGraph.js';

const VALID_ENTITY_TYPES: Set<string> = new Set([
  'person', 'organization', 'place', 'event', 'concept', 'technology', 'claim',
]);

export interface WorkerExtractionInput {
  workerId: string;
  findings: string[];
  scratchpad: string[];
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction system. Extract entities and relationships from research findings. Return ONLY valid JSON.

Entity types: person, organization, place, event, concept, technology, claim

Return JSON in this exact format:
{
  "entities": [
    { "name": "display name", "type": "person|organization|place|event|concept|technology|claim", "properties": {"key": "value"}, "confidence": 0.0-1.0 }
  ],
  "relationships": [
    { "source": "entity name", "target": "entity name", "predicate": "verb phrase", "evidence": "brief quote", "weight": 0.0-1.0 }
  ]
}

Rules:
- Extract ALL entities mentioned (people, organizations, concepts, etc.)
- Use specific predicate verbs (founded, acquired, located_in, works_at, etc.)
- Set confidence based on how strongly the findings support the entity
- Properties should capture key attributes (role, date, location, etc.)
- Evidence should be a brief phrase from the findings, not a full sentence`;

/**
 * Format worker findings and scratchpad into extraction input.
 */
export function formatExtractionInput(workers: WorkerExtractionInput[]): string {
  return workers.map(w => {
    const parts: string[] = [`--- Worker ${w.workerId} ---`];

    if (w.findings.length > 0) {
      parts.push('Findings:');
      for (const f of w.findings) {
        parts.push(`- ${f}`);
      }
    }

    if (w.scratchpad.length > 0) {
      parts.push('Scratchpad:');
      for (const s of w.scratchpad) {
        parts.push(`- ${s}`);
      }
    }

    return parts.join('\n');
  }).join('\n\n');
}

export class GraphExtractor {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  /**
   * Extract entities and relationships from wave worker outputs.
   * Fail-safe: returns empty results on any error.
   */
  async extract(workers: WorkerExtractionInput[]): Promise<ExtractionResult> {
    const empty: ExtractionResult = { entities: [], relationships: [] };

    // Skip if no findings to extract from
    const totalFindings = workers.reduce((sum, w) => sum + w.findings.length, 0);
    if (totalFindings === 0) return empty;

    const input = formatExtractionInput(workers);

    const messages: Message[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT, timestamp: new Date() },
      { role: 'user', content: `Extract entities and relationships from these worker results:\n\n${input}`, timestamp: new Date() },
    ];

    try {
      const response = await this.provider.chat(messages, { temperature: 0.2 } as ChatOptions);
      return this.parseResponse(response.content);
    } catch {
      // Fail-safe: graph extraction is additive, never blocking
      return empty;
    }
  }

  private parseResponse(response: string): ExtractionResult {
    const empty: ExtractionResult = { entities: [], relationships: [] };

    try {
      // Handle markdown code blocks
      let jsonStr = response.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      const entities: ExtractedEntity[] = (parsed.entities ?? [])
        .filter((e: any) => e?.name && VALID_ENTITY_TYPES.has(e.type))
        .map((e: any) => ({
          name: String(e.name),
          type: e.type as EntityType,
          properties: e.properties && typeof e.properties === 'object' ? e.properties : {},
          confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.5,
        }));

      const relationships: ExtractedRelationship[] = (parsed.relationships ?? [])
        .filter((r: any) => r?.source && r?.target && r?.predicate)
        .map((r: any) => ({
          source: String(r.source),
          target: String(r.target),
          predicate: String(r.predicate),
          evidence: r.evidence ? String(r.evidence) : '',
          weight: typeof r.weight === 'number' ? Math.max(0, Math.min(1, r.weight)) : 0.5,
        }));

      return { entities, relationships };
    } catch {
      return empty;
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/knowledge/GraphExtractor.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/knowledge/GraphExtractor.ts src/core/knowledge/GraphExtractor.test.ts
git commit -m "feat: add GraphExtractor for LLM-based entity/relationship extraction"
```

---

### Task 3: Wire KnowledgeGraph into DiscoveryCoordinator

**Files:**
- Modify: `src/core/queen/DiscoveryCoordinator.ts:9-10` (imports), `57-193` (execute method), `274-302` (formatDiscoveryContext), `432-483` (aggregate)
- Reference: `src/core/worker/ralphUtils.ts:149-161` (extractScratchpad)

**Step 1: Write the failing test**

Add to `src/core/queen/DiscoveryCoordinator.test.ts`:

```typescript
// Add at the end of the describe('DiscoveryCoordinator') block:

it('builds knowledge graph across waves and uses it for context injection', async () => {
  const wave1Results = new Map<string, TaskResult>();
  wave1Results.set('w1-t1', makeTaskResult(
    'Found info\n## KEY FINDINGS\n- Acme Corp was founded by Jane Doe\n- Acme is based in Berlin',
    ['Acme Corp was founded by Jane Doe', 'Acme is based in Berlin'],
  ));

  const wave2Results = new Map<string, TaskResult>();
  wave2Results.set('w2-follow-1', makeTaskResult(
    'More details\n## KEY FINDINGS\n- Acme raised $50M',
    ['Acme raised $50M'],
  ));

  const mockPool = createMockWorkerPool([wave1Results, wave2Results]);

  const mockProvider = createMockProvider([
    // Graph extraction after wave 1
    {
      content: JSON.stringify({
        entities: [
          { name: 'Acme Corp', type: 'organization', properties: { hq: 'Berlin' }, confidence: 0.8 },
          { name: 'Jane Doe', type: 'person', properties: { role: 'founder' }, confidence: 0.9 },
        ],
        relationships: [
          { source: 'Jane Doe', target: 'Acme Corp', predicate: 'founded', evidence: 'Jane Doe founded Acme', weight: 0.9 },
        ],
      }),
    },
    // planNextWave after wave 1: continue
    {
      content: JSON.stringify({
        action: 'continue',
        reasoning: 'Need funding details',
        tasks: [{ id: 'follow-1', description: 'Research Acme funding', successCriteria: 'Find funding rounds' }],
      }),
    },
    // Graph extraction after wave 2
    {
      content: JSON.stringify({
        entities: [
          { name: 'Acme Corp', type: 'organization', properties: { funding: '$50M' }, confidence: 0.85 },
        ],
        relationships: [],
      }),
    },
    // planNextWave after wave 2: sufficient
    {
      content: JSON.stringify({ action: 'sufficient', reasoning: 'Have enough info' }),
    },
    // Aggregation
    {
      content: 'Comprehensive synthesis of Acme Corp findings.',
    },
  ]);

  const coordinator = new DiscoveryCoordinator({
    provider: mockProvider as any,
    workerPool: mockPool as any,
    config: defaultConfig(),
  });

  const plan: TaskPlan = {
    type: 'decomposed',
    reasoning: 'Investigate Acme Corp',
    tasks: [makeTask('t1', 'Research Acme Corp')],
    discoveryMode: true,
  };

  const result = await coordinator.execute('Tell me about Acme Corp', plan, { eventHandler });

  expect(result.waveCount).toBe(2);
  expect(result.findings).toHaveLength(3);

  // Verify graph extraction was called (LLM calls: extraction1, planWave1, extraction2, planWave2, aggregate)
  expect(mockProvider.chat).toHaveBeenCalledTimes(5);

  // Verify wave 2 tasks received graph context via dependencyResults
  const wave2Call = mockPool.executeTasks.mock.calls[1][0] as Task[];
  const discoveryContext = wave2Call[0].dependencyResults?.get('discovery-context') ?? '';
  expect(discoveryContext).toContain('Acme Corp');
  expect(discoveryContext).toContain('Jane Doe');
  expect(discoveryContext).toContain('Knowledge Graph');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/DiscoveryCoordinator.test.ts`
Expected: FAIL — the new test fails because DiscoveryCoordinator doesn't have graph extraction yet

**Step 3: Modify DiscoveryCoordinator**

In `src/core/queen/DiscoveryCoordinator.ts`, make these changes:

1. **Add imports** (after line 7):
```typescript
import { KnowledgeGraph } from '../knowledge/KnowledgeGraph.js';
import { GraphExtractor } from '../knowledge/GraphExtractor.js';
import type { WorkerExtractionInput } from '../knowledge/GraphExtractor.js';
import { extractScratchpad } from '../worker/ralphUtils.js';
```

2. **Add graph + extractor to execute()** (after line 65, `const totalStart = Date.now();`):
```typescript
    const graph = new KnowledgeGraph();
    const extractor = new GraphExtractor(this.provider);
```

3. **After deduplication (after line 125), add graph extraction:**
```typescript
      // --- Knowledge graph extraction ---
      const extractionInputs: WorkerExtractionInput[] = [];
      for (const task of currentTasks) {
        const result = results.get(task.id);
        if (result?.success) {
          extractionInputs.push({
            workerId: task.id,
            findings: result.findings ?? [],
            scratchpad: extractScratchpad(result.output),
          });
        }
      }
      const extracted = await extractor.extract(extractionInputs);
      const workerIds = extractionInputs.map(i => i.workerId);
      graph.merge(extracted.entities, extracted.relationships, wave, workerIds);
```

4. **Replace formatDiscoveryContext call** (line 94) with graph-aware version:
```typescript
      if (wave > 1) {
        const discoveryContext = graph.getStats().entityCount > 0
          ? this.formatGraphContext(graph, abandonedDirections)
          : this.formatDiscoveryContext(allFindings, waveHistory, abandonedDirections);
        for (const task of currentTasks) {
          if (!task.dependencyResults) {
            task.dependencyResults = new Map();
          }
          task.dependencyResults.set('discovery-context', discoveryContext);
        }
      }
```

5. **Update aggregate call** (line 186) to pass graph:
```typescript
    const content = await this.aggregate(request, allFindings, waveHistory, graph);
```

6. **Add formatGraphContext method** (after formatDiscoveryContext):
```typescript
  /**
   * Build structured graph context for next wave's workers.
   */
  private formatGraphContext(
    graph: KnowledgeGraph,
    abandonedDirections: string[],
  ): string {
    const parts: string[] = [];

    parts.push(graph.getContext(''));

    if (abandonedDirections.length > 0) {
      parts.push('\n### Abandoned Directions (do not revisit)');
      for (const d of abandonedDirections) {
        parts.push(`- ${d}`);
      }
    }

    parts.push('\n### Instructions');
    parts.push('Build on previous findings. Do NOT repeat what has already been discovered.');
    parts.push('Focus on deepening understanding and cross-referencing across sources.');

    return parts.join('\n');
  }
```

7. **Update aggregate signature and body** to accept graph:
```typescript
  private async aggregate(
    request: string,
    findings: Finding[],
    waveHistory: WaveResult[],
    graph?: KnowledgeGraph,
  ): Promise<string> {
    // Single wave, single successful result — pass through directly
    if (waveHistory.length === 1) {
      const results = waveHistory[0].results;
      const successResults = Array.from(results.values()).filter(r => r.success);
      if (successResults.length === 1) {
        return successResults[0].output;
      }
    }

    // Use graph synthesis view if available, otherwise fall back to wave-based findings
    const graphView = graph?.getSynthesisView();
    const hasGraph = graphView && graphView.length > 0;

    const systemMessage = hasGraph
      ? `You are synthesizing findings from a multi-wave investigation.
You have access to a structured knowledge graph extracted from the research.

Produce a structured profile:
- Use the knowledge graph structure to organize your response
- Note confidence levels and corroboration status
- Flag contradictions and single-source claims explicitly
- Acknowledge gaps where information is missing
- Be comprehensive but concise`
      : `You are synthesizing findings from a multi-wave investigation.

Produce a structured profile of what was discovered:
- Group findings by category
- Note confidence levels (high/medium/low)
- Flag any contradictions between findings
- Acknowledge gaps where information is missing
- Be comprehensive but concise`;

    const contentSection = hasGraph
      ? graphView
      : waveHistory.map(w => {
          const waveFindingsList = w.findings
            .map(f => `  - [confidence: ${f.confidence.toFixed(1)}] ${f.content}`)
            .join('\n');
          return `Wave ${w.waveNumber} (${w.findings.length} new findings):\n${waveFindingsList}`;
        }).join('\n\n');

    const userMessage = `Original request: ${request}

Investigation spanned ${waveHistory.length} waves with ${findings.length} total findings.

${contentSection}

Synthesize these findings into a comprehensive response.`;

    const messages: Message[] = [
      { role: 'system', content: systemMessage, timestamp: new Date() },
      { role: 'user', content: userMessage, timestamp: new Date() },
    ];

    try {
      const response = await this.provider.chat(messages, { temperature: 0.3 } as ChatOptions);
      return response.content;
    } catch {
      // Fallback: return raw findings
      return findings.map(f => `- ${f.content}`).join('\n');
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/DiscoveryCoordinator.test.ts`
Expected: All tests PASS (existing tests + new graph test)

**Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: Clean — no type errors

**Step 6: Commit**

```bash
git add src/core/queen/DiscoveryCoordinator.ts src/core/queen/DiscoveryCoordinator.test.ts
git commit -m "feat: wire KnowledgeGraph into DiscoveryCoordinator at wave boundaries"
```

---

### Task 4: Update AggregationHeuristic with graph awareness

**Files:**
- Modify: `src/core/queen/AggregationHeuristic.ts:41-44` (shouldSynthesizeWithLLM signature)
- Modify: `src/core/queen/AggregationHeuristic.test.ts`

**Step 1: Write the failing test**

Add to `src/core/queen/AggregationHeuristic.test.ts`:

```typescript
// Add import at top:
import { KnowledgeGraph } from '../knowledge/KnowledgeGraph.js';

// Add inside describe('shouldSynthesizeWithLLM'):

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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/AggregationHeuristic.test.ts`
Expected: FAIL — `shouldSynthesizeWithLLM` doesn't accept graph parameter

**Step 3: Modify AggregationHeuristic**

In `src/core/queen/AggregationHeuristic.ts`:

1. **Add import** (top of file):
```typescript
import type { KnowledgeGraph } from '../knowledge/KnowledgeGraph.js';
```

2. **Update function signature** (line 41-44):
```typescript
export function shouldSynthesizeWithLLM(
  taskResults: TaskResultForAggregation[],
  overlapThreshold: number = 0.15,
  graph?: KnowledgeGraph,
): AggregationDecision {
```

3. **Add graph check** (after the `taskResults.length < 2` early return, before dependencies check):
```typescript
  // If knowledge graph has cross-entity relationships, always synthesize
  if (graph) {
    const stats = graph.getStats();
    if (stats.relationshipCount > 0) {
      return { shouldSynthesize: true, reason: `knowledge graph has ${stats.relationshipCount} cross-entity relationships` };
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/AggregationHeuristic.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/queen/AggregationHeuristic.ts src/core/queen/AggregationHeuristic.test.ts
git commit -m "feat: add optional graph parameter to AggregationHeuristic"
```

---

### Task 5: Export types from types.ts and final verification

**Files:**
- Modify: `src/core/types.ts` (add re-exports)
- Reference: all test files

**Step 1: Add re-exports**

In `src/core/types.ts`, add at the end of the file:

```typescript
// Knowledge graph types (re-exported for convenience)
export type { Entity, Relationship, EntityType, ExtractedEntity, ExtractedRelationship, GraphStats } from './knowledge/KnowledgeGraph.js';
```

**Step 2: Run full typecheck**

Run: `npm run typecheck`
Expected: Clean — no errors

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing 605+ tests + new knowledge graph tests)

**Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: re-export knowledge graph types from core/types"
```

---

### Task 6: Final integration test and cleanup

**Step 1: Run the full test suite one more time**

Run: `npm test`
Expected: All tests pass

**Step 2: Run lint**

Run: `npm run lint`
Expected: Clean

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

**Step 4: Review diff**

Run: `git diff master --stat`
Verify only expected files changed.
