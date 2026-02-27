# Session-Scoped Knowledge Graph — Design

**Date:** 2026-02-27
**Status:** Approved
**Approach:** Graph Layer on Findings (Approach A — wave-boundary extraction)

## Problem

The current discovery system accumulates findings as flat strings:

```typescript
interface Finding {
  content: string;    // unstructured text
  source: string;
  confidence: number;
  wave: number;
  tags: string[];     // always empty in practice
}
```

This causes three problems:

1. **Context injection is a wall of text.** Wave 2+ workers get a flat bullet list of prior findings with no structure. They can't see that "Jose Ibarra", "TechCo", and "Google" are connected entities with a timeline.

2. **Aggregation is blind to structure.** The synthesis LLM call receives findings grouped by wave, not by topic or entity. It must independently notice contradictions, gaps, and cross-references buried in prose.

3. **Deduplication is surface-level.** Bigram Sorensen-Dice similarity (>0.85) catches near-identical strings but misses semantic duplicates — two findings about the same entity phrased differently both survive.

## Solution

Add a `KnowledgeGraph` that sits alongside the existing `Finding[]` accumulator in `DiscoveryCoordinator`. After each wave, an LLM extraction call converts findings + scratchpad entries into entities and relationships. The graph powers structured context injection and graph-aware aggregation.

## Data Model

```typescript
type EntityType = 'person' | 'organization' | 'place' | 'event'
               | 'concept' | 'technology' | 'claim';

interface Entity {
  id: string;                      // deterministic slug from name
  name: string;                    // canonical display name
  type: EntityType;
  properties: Map<string, string>; // freeform k/v
  mentions: number;                // extraction count across waves
  firstSeen: number;               // wave number
  lastSeen: number;                // wave number
  confidence: number;              // 0.0-1.0, reinforced on re-extraction
  sourceWorkers: string[];         // contributing worker IDs
}

interface Relationship {
  id: string;                      // `${sourceId}--${predicate}--${targetId}`
  sourceId: string;
  targetId: string;
  predicate: string;               // verb phrase, e.g. "founded", "contradicts"
  weight: number;                  // 0.0-1.0, strengthened on re-extraction
  evidence: string;                // brief backing quote/summary
  wave: number;
}
```

### KnowledgeGraph API

- `merge(entities, relationships)` — upsert with confidence reinforcement. Re-seeing an entity bumps mentions, averages confidence, merges new properties.
- `getContext(taskDescription, maxTokens?)` — relevance-filtered entity/relationship summary for worker prompt injection. Keyword match between task description and entity names/properties.
- `getSynthesisView()` — full graph grouped by entity type, with contradictions, single-source claims, and gaps auto-detected. Used at aggregation time.
- `getStats()` — entity count, relationship count, most-connected entities.

No persistence. Scoped to a single `DiscoveryCoordinator.execute()` call.

## Extraction Pipeline

**Trigger:** After `collectFindings()` and `deduplicateFindings()` at each wave boundary.

**Input:** Already-extracted findings and scratchpad entries from the completed wave's workers (via `extractFindings()` and `extractScratchpad()` in `ralphUtils.ts`). NOT raw worker output — no truncation needed, workers already distilled the signal.

**LLM call:**

```
System: You are a knowledge extraction system. Extract entities and
relationships from research findings. Return ONLY valid JSON.

User: Extract entities and relationships from these worker results:

--- Worker w1-task-1 ---
Findings:
- Finding 1
- Finding 2
Scratchpad:
- Hypothesis about X

--- Worker w1-task-2 ---
Findings:
- Finding 3
...

Return JSON:
{
  "entities": [
    { "name": "...", "type": "person|organization|...",
      "properties": {"key": "value"}, "confidence": 0.0-1.0 }
  ],
  "relationships": [
    { "source": "entity name", "target": "entity name",
      "predicate": "verb phrase", "evidence": "brief quote",
      "weight": 0.0-1.0 }
  ]
}
```

**Design decisions:**

- One LLM call per wave (batches all workers), not per worker
- Low temperature (0.2) — extraction should be deterministic
- Confidence comes from the LLM based on source quality
- Fail-safe: if extraction call fails or returns bad JSON, wave proceeds normally with flat findings only. Graph is additive, never blocking.

## Context Injection

Replaces the current `formatDiscoveryContext()` flat bullet list with structured graph context:

```
## Knowledge Graph Context (1 waves completed)

### Key Entities
- **Jose Ibarra** (person, confidence: 0.85, seen 3x)
  - role: founder/CEO
  - previously: engineer at Google
  - Relations: founded TechCo, worked_at Google

- **TechCo** (organization, confidence: 0.80, seen 2x)
  - founded: 2019
  - Relations: raised Series B ($50M), founded_by Jose Ibarra

### Open Questions
- No information yet on: TechCo's product, current employee count
- Single-source claims: Series B amount (only wave 1)

### Abandoned Directions (do not revisit)
- ...
```

**Relevance filtering:** `getContext(taskDescription)` keyword-matches the task description against entity names/properties. Workers investigating "TechCo's competitors" get TechCo front and center.

**Open questions auto-detected:** Entities with few relationships or low confidence flagged as gaps, steering workers toward unexplored areas.

**Single-source claims flagged:** Entities/relationships from only one worker marked as needing corroboration.

**Budget-aware:** `maxTokens` parameter (default ~2000) caps context size. Entities ranked by relevance x confidence; lower-ranked omitted with "and N more entities..." note.

## Graph-Aware Aggregation

The `AggregationHeuristic` Jaccard keyword gate stays as-is (cheap fast check). But the synthesis LLM call gets structured graph input:

```
System: You are synthesizing findings from a multi-wave investigation.

User: Original request: {request}

## Knowledge Graph ({N} entities, {M} relationships)

### People
- **Jose Ibarra** (confidence: 0.9, corroborated across 3 waves)
  -> founded TechCo (2019)
  -> worked_at Google (prior)

### Contradictions
- Wave 1 says founding year 2019, Wave 3 says 2018

### Low-Confidence Claims (single source)
- "TechCo planning IPO in 2026" — only from wave 2, task w2-task-3

### Gaps
- No information found on: revenue, employee count

Synthesize into a comprehensive response. Flag contradictions
and low-confidence claims explicitly.
```

`shouldSynthesizeWithLLM()` gets an optional graph parameter: if cross-entity relationships exist, always recommend synthesis (connected findings need narrative, not concatenation).

## File Layout

**New files:**
```
src/core/knowledge/KnowledgeGraph.ts      — types + KnowledgeGraph class
src/core/knowledge/GraphExtractor.ts      — LLM extraction, JSON parsing, input formatting
src/core/knowledge/KnowledgeGraph.test.ts — merge, dedup, relevance, getSynthesisView
src/core/knowledge/GraphExtractor.test.ts — JSON parsing, fail-safe, input formatting
```

**Modified files:**
```
src/core/queen/DiscoveryCoordinator.ts    — wire extractor + graph at wave boundaries,
                                            formatGraphContext replaces formatDiscoveryContext,
                                            pass graph to aggregate()
src/core/queen/AggregationHeuristic.ts    — optional graph param on shouldSynthesizeWithLLM()
src/core/types.ts                         — export KnowledgeGraph-related types
```

**NOT touched:**
- RalphLoop.ts, Worker.ts, WorkerPool.ts — no worker-level changes
- ralphUtils.ts — extractFindings/extractScratchpad used as-is
- Queen.ts — DiscoveryCoordinator is the integration point
- Finding interface — unchanged, graph is additive
- Config — no new config keys for v1

## Execution Flow

```
Wave completes
  -> collectFindings()                              (existing)
  -> deduplicateFindings()                          (existing)
  -> GraphExtractor.extract(findings + scratchpad)  (NEW)
  -> KnowledgeGraph.merge(entities, relationships)  (NEW)
  -> planNextWave() gets graph context              (enhanced)
  -> formatGraphContext() for next wave's workers    (NEW, replaces formatDiscoveryContext)

All waves done
  -> aggregate() receives graph.getSynthesisView()  (enhanced)
```
