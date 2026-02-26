/**
 * Fast Heuristic Classifier — System 1/System 2 approach.
 * Skips the planning LLM call for messages that are obviously direct.
 * Falls through to the LLM planner only when uncertain.
 */

import { estimateTokenCount } from '../utils.js';

export type ClassificationResult =
  | { decision: 'direct'; confidence: number; reason: string }
  | { decision: 'uncertain'; reason: string };

export interface FastClassifierConfig {
  enabled: boolean;
  maxTokensForDirect: number;
  maxTokensForUncertain: number;
}

const GREETING_PATTERN = /^(hi|hello|hey|thanks|thank you|good\s*(morning|evening|afternoon|night)|howdy|sup|yo|cheers|bye|goodbye|see you|ttyl)\b/i;

const SINGLE_QUESTION_STARTERS = /^(what|how|why|when|where|who|which|is|does|do|can|will|should|would|could|has|have|did|are|was|were|tell me|explain|describe|show me|find|search|look up|get)\b/i;

const MULTI_TOPIC_CONJUNCTIONS = /\b(and also|as well as|plus also|in addition|additionally|furthermore|moreover)\b/i;

const ENUMERATION_MARKERS = /(?:^|\n)\s*(?:\d+[\.\)]\s|[-*]\s)/m;

const COMPARISON_MARKERS = /\b(compare|versus|vs\.?|difference between|similarities between|contrast)\b/i;

/**
 * Classify a user message as definitely-direct or uncertain using fast heuristics.
 * Returns 'uncertain' to fall through to the LLM-based planner.
 */
export function classifyFast(
  userMessage: string,
  _conversationContext: string | undefined,
  options: FastClassifierConfig,
): ClassificationResult {
  const trimmed = userMessage.trim();
  if (!trimmed) {
    return { decision: 'direct', confidence: 0.99, reason: 'empty message' };
  }

  const tokenCount = estimateTokenCount(trimmed);

  // Rule 1: Greetings and farewells
  if (GREETING_PATTERN.test(trimmed)) {
    return { decision: 'direct', confidence: 0.99, reason: 'greeting/farewell' };
  }

  // Count question marks (distinct questions indicator)
  const questionMarks = (trimmed.match(/\?/g) || []).length;

  // Rule 2: Explicit multi-topic markers → uncertain
  if (MULTI_TOPIC_CONJUNCTIONS.test(trimmed)) {
    return { decision: 'uncertain', reason: 'multi-topic conjunction detected' };
  }

  // Rule 3: Multiple question marks → uncertain (likely multi-part)
  if (questionMarks >= 2) {
    return { decision: 'uncertain', reason: 'multiple questions detected' };
  }

  // Rule 4: Enumeration markers (numbered or bulleted lists) → uncertain
  if (ENUMERATION_MARKERS.test(trimmed)) {
    return { decision: 'uncertain', reason: 'enumerated list detected' };
  }

  // Rule 5: Comparison requests → uncertain
  if (COMPARISON_MARKERS.test(trimmed)) {
    return { decision: 'uncertain', reason: 'comparison request detected' };
  }

  // Rule 6: Short, simple messages → direct
  if (tokenCount <= options.maxTokensForDirect) {
    return { decision: 'direct', confidence: 0.95, reason: 'short simple message' };
  }

  // Rule 7: Single-question pattern without topic-splitting "and"
  if (SINGLE_QUESTION_STARTERS.test(trimmed) && !hasTopicSplittingAnd(trimmed)) {
    return { decision: 'direct', confidence: 0.90, reason: 'single-question pattern' };
  }

  // Rule 8: Long messages → uncertain (may need decomposition)
  if (tokenCount > options.maxTokensForUncertain) {
    return { decision: 'uncertain', reason: 'long message, may need decomposition' };
  }

  // Default: uncertain — let the LLM planner decide
  return { decision: 'uncertain', reason: 'no strong heuristic signal' };
}

/**
 * Detect whether "and" in a message joins distinct topics vs. is part of a compound noun/phrase.
 * Conservative: returns true only when "and" appears to separate distinct clauses or requests.
 */
function hasTopicSplittingAnd(message: string): boolean {
  // Common compound phrases where "and" doesn't split topics
  const COMPOUND_PHRASES = [
    'pros and cons', 'bread and butter', 'back and forth', 'trial and error',
    'rock and roll', 'salt and pepper', 'up and running', 'null and void',
    'dos and don\'ts', 'ins and outs', 'ifs and buts', 'bits and pieces',
    'give and take', 'wear and tear', 'arts and crafts', 'research and development',
    'supply and demand', 'terms and conditions', 'rules and regulations',
    'strengths and weaknesses', 'advantages and disadvantages',
    'how and why', 'what and how', 'when and where',
  ];

  const lower = message.toLowerCase();

  // Remove known compound phrases before checking
  let cleaned = lower;
  for (const phrase of COMPOUND_PHRASES) {
    cleaned = cleaned.replace(phrase, '');
  }

  // Check if remaining "and" connects what look like distinct topic clauses
  // Pattern: "X and Y" where X and Y contain different action verbs or question words
  const andParts = cleaned.split(/\band\b/);
  if (andParts.length < 2) return false;

  // If both parts contain verb-like patterns suggesting separate actions → splitting
  const ACTION_PATTERNS = /\b(search|find|get|fetch|look up|what is|tell me|show me|check|analyze|explain|compare)\b/i;
  const partsWithActions = andParts.filter(part => ACTION_PATTERNS.test(part.trim()));

  return partsWithActions.length >= 2;
}
