/**
 * Pre-Verification Heuristic
 *
 * Cheap checks that run before the expensive LLM verifier.
 * If output is obviously bad, skip verification and go straight
 * to the next iteration — saving one LLM call.
 */

export interface PreCheckInput {
  taskDescription: string;
  successCriteria: string;
  previousOutput?: string;
}

export interface PreCheckResult {
  shouldSkipVerification: boolean;
  reason?: string;
  syntheticFeedback?: string;
}

const FAILURE_INDICATORS = [
  'i was unable to',
  'i could not find',
  'no results found',
  "i don't have access",
  'i could not access',
];

const FAILURE_SHORT_THRESHOLD = 500;

/**
 * Count the number of success criteria by splitting on `;` or newline.
 */
function countCriteria(successCriteria: string): number {
  return successCriteria
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * Run cheap heuristic checks on worker output before sending to the LLM verifier.
 *
 * Returns `shouldSkipVerification: true` when the output is obviously inadequate,
 * along with synthetic feedback to guide the next iteration.
 */
export function preCheckOutput(output: string, input: PreCheckInput): PreCheckResult {
  const outputLower = output.toLowerCase();

  // 1. Failure indicators in short output
  if (output.length < FAILURE_SHORT_THRESHOLD) {
    const matched = FAILURE_INDICATORS.some((indicator) => outputLower.includes(indicator));
    if (matched) {
      return {
        shouldSkipVerification: true,
        reason: 'Output contains failure indicator and is too short to be substantive',
        syntheticFeedback:
          'Previous attempt reported inability to complete. Try a different approach or different tools.',
      };
    }
  }

  // 2. Identical to previous output
  if (input.previousOutput !== undefined && output.trim() === input.previousOutput.trim()) {
    return {
      shouldSkipVerification: true,
      reason: 'Output is identical to previous attempt',
      syntheticFeedback:
        'Output is identical to previous attempt. You MUST try a fundamentally different approach.',
    };
  }

  // 3. Too short for complex task
  const criteriaCount = countCriteria(input.successCriteria);
  if (criteriaCount > 1 && output.length < criteriaCount * 50) {
    return {
      shouldSkipVerification: true,
      reason: `Output is too short for ${criteriaCount} success criteria`,
      syntheticFeedback: `Output is too brief to address all ${criteriaCount} success criteria.`,
    };
  }

  // 4. Allow through
  return { shouldSkipVerification: false };
}
