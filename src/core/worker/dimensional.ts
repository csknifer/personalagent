/**
 * DCL: Dimensional Convergence Loop Components
 *
 * Per-criterion verification, convergence tracking, and reflexion-based
 * strategic guidance for multi-criteria tasks.
 */

import type { Task, TaskResult, Verification, Verifier, CriterionScore, DimensionalVerification, ConvergenceSignal, ConvergenceState, TokenUsage } from '../types.js';
import type { LLMProvider } from '../../providers/index.js';
import { getDebugLogger } from '../DebugLogger.js';

/**
 * Parse success criteria text into individual criterion strings.
 * Handles numbered lists, bullet points, and semicolons.
 */
export function parseSuccessCriteria(criteria: string): string[] {
  if (!criteria || !criteria.trim()) return [];

  // Try numbered list: "1. ..." or "1) ..."
  const numberedPattern = /^\s*\d+[\.\)]\s+(.+)$/gm;
  const numbered = [...criteria.matchAll(numberedPattern)].map(m => m[1].trim());
  if (numbered.length > 1) return numbered;

  // Try bullet points: "- ..." or "* ..."
  const bulletPattern = /^\s*[-*]\s+(.+)$/gm;
  const bullets = [...criteria.matchAll(bulletPattern)].map(m => m[1].trim());
  if (bullets.length > 1) return bullets;

  // Try semicolons (preferred delimiter for inline criteria)
  const semicolonSplit = criteria.split(';').map(s => s.trim()).filter(Boolean);
  if (semicolonSplit.length > 1) return semicolonSplit;

  // Single criterion
  return [criteria.trim()];
}

/**
 * Mask verbose tool/observation outputs in a previous attempt.
 * Preserves reasoning text but truncates JSON blobs and tool results.
 */
export function maskObservations(
  attempt: string,
  maxOutputLength: number = 200,
  retainedIds?: Set<string>,
): string {
  // Truncate ```json code blocks (skip if content contains a retained ID)
  let masked = attempt.replace(
    /```json\n[\s\S]*?```/g,
    (match) => {
      if (match.length <= maxOutputLength) return match;
      // Skip truncation if this block contains a retained ID
      if (retainedIds && retainedIds.size > 0) {
        for (const id of retainedIds) {
          if (match.includes(id)) return match;
        }
      }
      const inner = match.slice(8, maxOutputLength);
      return '```json\n' + inner + '... [truncated]\n```';
    }
  );

  // Truncate large inline JSON objects (200+ chars)
  // Uses brace-matching instead of regex to avoid catastrophic backtracking
  // on unbalanced braces in worker output.
  let result = '';
  let i = 0;
  while (i < masked.length) {
    if (masked[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < masked.length && depth > 0) {
        if (masked[j] === '{') depth++;
        else if (masked[j] === '}') depth--;
        j++;
      }
      if (depth === 0) {
        const block = masked.slice(i, j);
        if (block.length > 200 && block.length > maxOutputLength) {
          let shouldRetain = false;
          if (retainedIds && retainedIds.size > 0) {
            for (const id of retainedIds) {
              if (block.includes(id)) { shouldRetain = true; break; }
            }
          }
          result += shouldRetain ? block : block.slice(0, maxOutputLength) + '... [truncated]}';
        } else {
          result += block;
        }
        i = j;
      } else {
        // Unbalanced brace — just pass through the character
        result += masked[i];
        i++;
      }
    } else {
      result += masked[i];
      i++;
    }
  }

  return result;
}

/**
 * Lightweight single-stream score tracker for universal convergence detection.
 * Usable for any task (single-criterion or aggregated score), unlike
 * ConvergenceTracker which is multi-criterion.
 * Pure data structure — no LLM calls.
 */
export class ScoreTracker {
  private _scores: number[] = [];

  /** Append a score to the history */
  record(score: number): void {
    this._scores.push(score);
  }

  /** Returns the max score seen, or 0 if empty */
  get best(): number {
    if (this._scores.length === 0) return 0;
    return Math.max(...this._scores);
  }

  /**
   * Returns true if the last 3 scores are within `epsilon` of each other.
   * Returns false if fewer than 3 scores have been recorded.
   */
  isPlateau(epsilon: number = 0.03): boolean {
    if (this._scores.length < 3) return false;
    const last3 = this._scores.slice(-3);
    const max = Math.max(...last3);
    const min = Math.min(...last3);
    return (max - min) <= epsilon;
  }

  /**
   * Returns true if the last 3 scores are strictly decreasing.
   * Returns false if fewer than 3 scores have been recorded.
   */
  isRegressing(): boolean {
    if (this._scores.length < 3) return false;
    const last3 = this._scores.slice(-3);
    return last3[2] < last3[1] && last3[1] < last3[0];
  }

  /** Returns the full score history */
  get scores(): readonly number[] {
    return this._scores;
  }
}

/**
 * Tracks per-criterion convergence across Ralph Loop iterations.
 * Pure data structure — no LLM calls.
 */
export class ConvergenceTracker {
  private history: Map<string, number[]> = new Map();
  private stagnationThreshold: number;
  private stagnationWindow: number;

  constructor(options: { stagnationThreshold?: number; stagnationWindow?: number } = {}) {
    this.stagnationThreshold = options.stagnationThreshold ?? 0.05;
    this.stagnationWindow = options.stagnationWindow ?? 2;
  }

  /** Record scores from a dimensional verification result */
  record(dimensions: CriterionScore[]): void {
    for (const dim of dimensions) {
      const scores = this.history.get(dim.name) ?? [];
      scores.push(dim.score);
      this.history.set(dim.name, scores);
    }
  }

  /** Get convergence signal for a single criterion */
  getSignal(name: string): ConvergenceSignal {
    const scores = this.history.get(name);
    if (!scores || scores.length < 2) return 'unknown';

    const window = this.stagnationWindow;

    // Check stagnating: recent deltas all below threshold
    if (scores.length >= window + 1) {
      const recent = scores.slice(-(window + 1));
      const deltas: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        deltas.push(Math.abs(recent[i] - recent[i - 1]));
      }
      if (deltas.every(d => d < this.stagnationThreshold)) {
        return 'stagnating';
      }
    }

    // Check diverging: decreasing for 2+ consecutive iterations
    if (scores.length >= 3) {
      const last3 = scores.slice(-3);
      if (last3[2] < last3[1] && last3[1] < last3[0]) {
        return 'diverging';
      }
    }

    // Default: compare last two
    const last = scores[scores.length - 1];
    const prev = scores[scores.length - 2];
    if (last > prev) return 'converging';
    if (last < prev) return 'diverging';
    return 'stagnating';
  }

  /** Get full convergence state for all tracked criteria */
  getState(): ConvergenceState {
    const signals = new Map<string, ConvergenceSignal>();
    const bestIteration = new Map<string, { iteration: number; score: number }>();

    for (const [name, scores] of this.history) {
      signals.set(name, this.getSignal(name));

      let bestScore = -1;
      let bestIter = 0;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] > bestScore) {
          bestScore = scores[i];
          bestIter = i + 1;
        }
      }
      bestIteration.set(name, { iteration: bestIter, score: bestScore });
    }

    // Overall trend: pessimistic aggregation — any diverging signals the whole trend
    const signalValues = [...signals.values()];
    const counts = { converging: 0, diverging: 0, stagnating: 0, unknown: 0 };
    for (const s of signalValues) counts[s]++;

    let overallTrend: ConvergenceSignal = 'unknown';
    if (counts.diverging > 0) {
      // Any diverging criterion flags the whole trend — needs strategy change
      overallTrend = 'diverging';
    } else if (counts.stagnating > counts.converging) {
      overallTrend = 'stagnating';
    } else if (counts.converging > 0) {
      overallTrend = 'converging';
    } else if (counts.stagnating > 0) {
      overallTrend = 'stagnating';
    }

    return { history: new Map(this.history), signals, bestIteration, overallTrend };
  }

  /** Get only the failing (not-yet-passed) criteria names */
  getFailingCriteria(passingScore: number = 0.8): string[] {
    const failing: string[] = [];
    for (const [name, scores] of this.history) {
      if (scores.length === 0 || scores[scores.length - 1] < passingScore) {
        failing.push(name);
      }
    }
    return failing;
  }

  /** Reset tracker */
  reset(): void {
    this.history.clear();
  }
}

/**
 * Verifier that evaluates each success criterion independently.
 * Returns DimensionalVerification with per-criterion scores.
 */
export class DimensionalVerifier implements Verifier {
  private provider: LLMProvider;
  private criteria: string[];
  private passingScore: number;

  constructor(provider: LLMProvider, criteria: string[], passingScore: number = 0.8) {
    this.provider = provider;
    this.criteria = criteria;
    this.passingScore = passingScore;
  }

  async check(result: TaskResult): Promise<DimensionalVerification> {
    const prompt = this.buildPrompt(result);
    try {
      const response = await this.provider.complete(prompt);
      return this.parseResponse(response);
    } catch {
      return {
        complete: false,
        confidence: 0,
        feedback: 'Dimensional verification failed - retry needed',
        dimensions: this.criteria.map(name => ({
          name, score: 0, passed: false, feedback: 'Verification error',
        })),
      };
    }
  }

  private buildPrompt(result: TaskResult): string {
    const today = new Date().toISOString().split('T')[0];
    const criteriaList = this.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const toolOutputInfo = result.toolOutputSummary
      ? `\n## Tool Output Summary\n${result.toolOutputSummary}\n`
      : '';
    const toolFailureInfo = result.toolFailures && result.toolFailures.length > 0
      ? `\n## ⚠ TOOL FAILURES (programmatically detected — these are facts)\nThe following tools had ALL calls fail (no successful calls):\n${result.toolFailures.map(f => `- **${f.tool}**: ${f.error}`).join('\n')}\nOnly flag data as fabricated if it could ONLY have come from these failed tools. Tools not listed here had at least one successful call.\n`
      : '';
    return `Evaluate this task result against EACH criterion independently.

## Current Date
${today}

## Task Result
${result.output}
${toolOutputInfo}${toolFailureInfo}

## Success Criteria
${criteriaList}

## Scoring Guide
- **0.0**: Not attempted at all
- **0.1-0.3**: Mentioned but largely incomplete or incorrect
- **0.4-0.6**: Partially addressed with significant gaps
- **0.7-0.8**: Mostly complete with minor gaps
- **0.9-1.0**: Fully satisfied with high quality

## Instructions
For EACH criterion, provide a score and specific, actionable feedback.
Mark complete=true ONLY if ALL criteria score >= ${this.passingScore}. Be strict.

IMPORTANT DATA VERIFICATION: Check the Tool Output Summary carefully. If a tool returned actual data (not starting with "Error:"), that data is REAL and came from a live tool call. Only flag data as fabricated if the specific facts do NOT appear in ANY successful tool output above.

IMPORTANT: In the "name" field, use the EXACT criterion text from the numbered list above. Do not paraphrase.

Respond with JSON:
{
  "complete": true/false,
  "feedback": "Overall summary",
  "dimensions": [
    { "name": "exact criterion text", "score": 0.0-1.0, "passed": true/false, "feedback": "what specifically is missing or needs improvement" }
  ]
}`;
  }

  private parseResponse(response: string): DimensionalVerification {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { complete: false, confidence: 0, feedback: 'Could not parse dimensional verification' };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const dimensions: CriterionScore[] = (parsed.dimensions || []).map((d: Record<string, unknown>) => ({
        name: String(d.name || ''),
        score: Number(d.score) || 0,
        passed: Boolean(d.passed),
        feedback: String(d.feedback || ''),
      }));

      // Normalize dimension names to match original criteria
      for (const dim of dimensions) {
        if (!this.criteria.includes(dim.name)) {
          const best = this.findBestMatch(dim.name, this.criteria);
          if (best) dim.name = best;
        }
      }

      // Compute confidence structurally from per-criterion scores rather than
      // trusting the LLM's free-form confidence value.
      const computedConfidence = dimensions.length > 0
        ? Math.min(...dimensions.map(d => d.score))
        : (Number(parsed.confidence) || 0);

      return {
        complete: Boolean(parsed.complete),
        confidence: computedConfidence,
        feedback: String(parsed.feedback || ''),
        dimensions,
      };
    } catch {
      return { complete: false, confidence: 0, feedback: 'Dimensional verification parse error' };
    }
  }

  /**
   * Find the best matching criterion for a potentially paraphrased name.
   * Uses substring matching and word overlap.
   */
  private findBestMatch(name: string, criteria: string[]): string | undefined {
    const lowerName = name.toLowerCase();

    // Try substring match first
    for (const c of criteria) {
      const lowerC = c.toLowerCase();
      if (lowerC.includes(lowerName) || lowerName.includes(lowerC)) {
        return c;
      }
    }

    // Fall back to word overlap
    const nameWords = new Set(lowerName.split(/\s+/).filter(w => w.length > 2));
    let bestMatch: string | undefined;
    let bestScore = 0;
    for (const c of criteria) {
      const cWords = c.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const overlap = cWords.filter(w => nameWords.has(w)).length;
      const score = overlap / Math.max(nameWords.size, cWords.length);
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = c;
      }
    }

    return bestMatch;
  }
}

/**
 * Generate a Reflexion-style self-reflection after a failed verification.
 * One extra LLM call for single-criterion tasks only.
 */
export async function generateReflexion(
  provider: LLMProvider,
  task: Task,
  attempt: string,
  feedback: string
): Promise<{ guidance: string; tokenUsage?: TokenUsage }> {
  const prompt = `Reflect on this failed attempt and produce strategic guidance for the next try. Do NOT re-solve the task.

## Task
${task.description}

## Success Criteria
${task.successCriteria}

## Failed Attempt
${attempt}

## Verifier Feedback
${feedback}

## Instructions
In 2-4 sentences, provide:
1. The root cause of the failure (not just "incomplete" — what specifically was wrong or missing?)
2. A concrete strategy change: different tools to use, different search queries, different response structure
3. What to avoid repeating

Be specific and actionable. "Try harder" is not useful. "Use fetch_url on the top search result to get detailed pricing data" is.`;

  try {
    const response = await provider.chat(
      [{ role: 'user', content: prompt, timestamp: new Date() }],
    );
    return { guidance: response.content, tokenUsage: response.tokenUsage };
  } catch {
    return { guidance: feedback }; // Fall back to raw feedback if reflection fails
  }
}

/**
 * Generate dimensional Reflexion for multi-criteria tasks.
 * Provides strategic guidance considering per-criterion scores and convergence trends.
 */
export async function generateDimensionalReflexion(
  provider: LLMProvider,
  task: Task,
  attempt: string,
  dimensions: CriterionScore[],
  convergenceState?: ConvergenceState,
): Promise<{ guidance: string; tokenUsage?: TokenUsage }> {
  const failingCriteria = dimensions
    .filter(d => !d.passed)
    .map(d => `- ${d.name} (score: ${d.score.toFixed(2)}): ${d.feedback}`)
    .join('\n');

  const convergenceInfo = convergenceState
    ? [...convergenceState.signals.entries()]
        .map(([name, signal]) => `  - ${name}: ${signal}`)
        .join('\n')
    : 'No convergence data yet.';

  const prompt = `Reflect on this partially-successful task attempt. Multiple criteria were evaluated independently.

## Task
${task.description}

## Failing Criteria
${failingCriteria}

## Convergence Trends
${convergenceInfo}

## Instructions
In 3-5 sentences, provide strategic guidance:
1. Which failing criterion should be prioritized first and why (e.g., easiest to fix, or blocking other criteria)
2. Whether any failing criteria are interdependent — fixing one might fix another
3. For any stagnating or diverging criteria, suggest a fundamentally different approach
Be specific and actionable. Reference specific tools or strategies.`;

  try {
    const response = await provider.chat(
      [{ role: 'user', content: prompt, timestamp: new Date() }],
    );
    return { guidance: response.content, tokenUsage: response.tokenUsage };
  } catch {
    // Fall back to a simple summary of failing criteria
    return { guidance: failingCriteria };
  }
}
