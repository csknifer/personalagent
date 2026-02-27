/**
 * Aggregation Heuristic — determines whether multi-worker results need
 * LLM synthesis or can be simply concatenated.
 *
 * Concept: Tree of Thought pruning. If outputs are about disjoint topics
 * with no overlap, synthesis is just concatenation with headers.
 */

import type { KnowledgeGraph } from '../knowledge/KnowledgeGraph.js';

// Common English stopwords to filter out when comparing content
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these',
  'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'she', 'they', 'them', 'their', 'what', 'which', 'who', 'whom',
  'about', 'up', 'also', 'like', 'still', 'since', 'until', 'much',
]);

export interface AggregationDecision {
  shouldSynthesize: boolean;
  reason: string;
}

export interface TaskResultForAggregation {
  description: string;
  output: string;
  dependencies: string[];
}

/**
 * Determine whether worker results need LLM synthesis or can be concatenated.
 * @param overlapThreshold Jaccard similarity threshold (default 0.15)
 */
export function shouldSynthesizeWithLLM(
  taskResults: TaskResultForAggregation[],
  overlapThreshold: number = 0.15,
  graph?: KnowledgeGraph,
): AggregationDecision {
  if (taskResults.length < 2) {
    return { shouldSynthesize: false, reason: 'single result' };
  }

  // If knowledge graph has cross-entity relationships, always synthesize
  if (graph) {
    const stats = graph.getStats();
    if (stats.relationshipCount > 0) {
      return { shouldSynthesize: true, reason: `knowledge graph has ${stats.relationshipCount} cross-entity relationships` };
    }
  }

  // If any task has dependencies on another, results are interrelated → always synthesize
  for (const t of taskResults) {
    if (t.dependencies.length > 0) {
      return { shouldSynthesize: true, reason: 'task dependencies exist' };
    }
  }

  // Extract content keywords for each result
  const keywordSets = taskResults.map(t => extractContentWords(t.output));

  // Compute max pairwise Jaccard similarity
  let maxSimilarity = 0;
  for (let i = 0; i < keywordSets.length; i++) {
    for (let j = i + 1; j < keywordSets.length; j++) {
      const similarity = jaccardSimilarity(keywordSets[i], keywordSets[j]);
      maxSimilarity = Math.max(maxSimilarity, similarity);
    }
  }

  if (maxSimilarity < overlapThreshold) {
    return {
      shouldSynthesize: false,
      reason: `low content overlap (${(maxSimilarity * 100).toFixed(1)}% < ${(overlapThreshold * 100).toFixed(1)}% threshold)`,
    };
  }

  return {
    shouldSynthesize: true,
    reason: `content overlap detected (${(maxSimilarity * 100).toFixed(1)}%)`,
  };
}

/**
 * Extract top content words from text, filtering stopwords and short tokens.
 * Returns a Set of the most frequent 20 content words.
 */
function extractContentWords(text: string, maxWords: number = 20): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));

  // Count frequencies
  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  // Take top N by frequency
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords)
    .map(([word]) => word);

  return new Set(sorted);
}

/**
 * Compute Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
