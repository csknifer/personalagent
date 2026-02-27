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
