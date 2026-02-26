/**
 * ResultEvaluator — pure-function module for evaluating the quality of
 * aggregated results against the original user request.
 *
 * Same pattern as EscalationClassifier.ts: no side effects, no LLM calls,
 * easy to test. The caller is responsible for making the LLM call.
 *
 * **Fail-open design**: parsing errors always return { pass: true } to
 * never block a response from reaching the user.
 */

import type { CompletedTaskSummary, EvaluationResult } from '../types.js';

export interface EvaluatorPromptInput {
  originalRequest: string;
  aggregatedResult: string;
  taskSummaries: CompletedTaskSummary[];
}

/**
 * Build the evaluator prompt that will be sent to the LLM.
 * The LLM must return JSON with { pass, score, feedback, missingAspects }.
 */
export function buildEvaluatorPrompt(input: EvaluatorPromptInput): string {
  const { originalRequest, aggregatedResult, taskSummaries } = input;

  // Truncate the result to control token usage
  const maxResultLen = 3000;
  const truncatedResult = aggregatedResult.length > maxResultLen
    ? aggregatedResult.slice(0, maxResultLen) + '\n... [truncated]'
    : aggregatedResult;

  let prompt = `You are an evaluation agent. Your job is to assess whether a response adequately answers the user's original request.

## Original User Request
${originalRequest}

## Response to Evaluate
${truncatedResult}
`;

  if (taskSummaries.length > 0) {
    prompt += `\n## Tasks That Were Executed\n`;
    for (const t of taskSummaries) {
      prompt += `- **${t.description}**: ${t.success ? 'succeeded' : 'failed'}`;
      if (t.findings && t.findings.length > 0) {
        prompt += ` — findings: ${t.findings.slice(0, 3).join('; ')}`;
      }
      prompt += '\n';
    }
  }

  prompt += `
## Instructions

Evaluate the response against the original request. Consider:
1. **Completeness**: Does it address all parts of the request?
2. **Accuracy**: Is the information factually consistent with what was found?
3. **Specificity**: Does it provide concrete details rather than vague statements?

Return your evaluation as JSON (inside a markdown code fence):

\`\`\`json
{
  "pass": true/false,
  "score": 0.0-1.0,
  "feedback": "Brief actionable feedback if failing, or confirmation if passing",
  "missingAspects": ["aspect1", "aspect2"]
}
\`\`\`

Rules:
- Score 0.0 = completely missed the request, 1.0 = perfectly addressed
- "pass" should be true if the response reasonably addresses the core request
- "missingAspects" should list specific gaps (empty array if passing)
- "feedback" should be actionable — tell what needs to be added or improved
- Be pragmatic: if most of the request is answered, pass it even with minor gaps
`;

  return prompt;
}

/**
 * Parse the LLM's evaluation response into a structured EvaluationResult.
 *
 * **Fail-open**: on any parse error, returns { pass: true, score: 0.75 }
 * so the response is never blocked.
 */
export function parseEvaluationResult(
  response: string,
  threshold: number,
): EvaluationResult {
  const failOpen: EvaluationResult = {
    pass: true,
    score: 0.75,
    feedback: 'Evaluation parse failed — passing by default',
    missingAspects: [],
  };

  try {
    // Extract JSON from markdown fences, or try the raw response
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    const parsed = JSON.parse(jsonStr.trim());

    // Validate and clamp score
    let score = typeof parsed.score === 'number' ? parsed.score : 0.75;
    score = Math.max(0, Math.min(1, score));

    // Derive pass from threshold if not explicitly set
    const pass = typeof parsed.pass === 'boolean'
      ? parsed.pass
      : score >= threshold;

    const feedback = typeof parsed.feedback === 'string'
      ? parsed.feedback
      : '';

    const missingAspects = Array.isArray(parsed.missingAspects)
      ? parsed.missingAspects.filter((a: unknown): a is string => typeof a === 'string')
      : [];

    return { pass, score, feedback, missingAspects };
  } catch {
    return failOpen;
  }
}
