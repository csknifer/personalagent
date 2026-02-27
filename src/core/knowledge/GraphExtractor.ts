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
        .filter((e: Record<string, unknown>) => e?.name && typeof e.type === 'string' && VALID_ENTITY_TYPES.has(e.type))
        .map((e: Record<string, unknown>) => ({
          name: String(e.name),
          type: e.type as EntityType,
          properties: e.properties && typeof e.properties === 'object' ? e.properties as Record<string, string> : {},
          confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.5,
        }));

      const relationships: ExtractedRelationship[] = (parsed.relationships ?? [])
        .filter((r: Record<string, unknown>) => r?.source && r?.target && r?.predicate)
        .map((r: Record<string, unknown>) => ({
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
