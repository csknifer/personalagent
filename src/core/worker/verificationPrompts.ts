/**
 * Verification prompt templates — the behavior-defining text for task verification.
 *
 * These templates contain placeholder markers (e.g. {{today}}, {{taskDescription}})
 * that are interpolated by UnifiedVerifier at call time with actual values.
 *
 * Corresponding documentation files live in prompts/verification-single.md and
 * prompts/verification-dimensional.md.
 */

/**
 * Single-criterion verification prompt template.
 * Used when a task has one success criterion (or no criteria specified).
 */
export const SINGLE_VERIFICATION_TEMPLATE = `Evaluate this task result AND provide strategic next-step guidance if incomplete.

## Current Date
{{today}}

## Task Description
{{taskDescription}}

## Success Criteria
{{successCriteria}}

## Tool Usage
{{toolInfo}}
{{toolOutputInfo}}{{toolFailureInfo}}
## Task Result
{{taskResult}}

## Instructions
Evaluate the result against EACH criterion in the success criteria. If ANY criterion is not met, mark as incomplete.

If the result is incomplete, also determine the single most impactful next action the worker should take to improve the result. This should be specific and actionable (e.g., "Search for AAPL stock price using a financial data URL" not "try harder").

Respond with JSON:
{
  "complete": true/false,
  "confidence": 0.0-1.0,
  "feedback": "If not complete, specifically state which criteria failed and what needs to change",
  "nextAction": "If not complete, the single most impactful next action to take (omit if complete)"
}

The "confidence" field represents HOW WELL the result meets the criteria (0.0 = completely fails, 1.0 = perfectly meets all criteria).
- complete=false with confidence=0.1 means "very far from meeting criteria"
- complete=false with confidence=0.7 means "close but not quite there"
- complete=true with confidence=0.95 means "fully meets criteria with high quality"

Rules:
- For code execution, data retrieval, or factual tasks: Be strict — only mark complete if ALL criteria are fully satisfied.
- For research, analysis, or information-gathering tasks: Mark complete=true if the result provides substantive, well-sourced findings covering the main aspects of the criteria, even if not exhaustive. Good research with real data is better than endless searching for perfection.
- If the result says "I cannot" or refuses to attempt the task despite having tools, mark INCOMPLETE with LOW confidence.
- CRITICAL: Check the Tool Output Summary above carefully. If a tool returned actual data (not an error), that data is REAL. Only flag data as fabricated if the specific numbers/facts do NOT appear anywhere in any successful tool output.
- If a tool output starts with "Error:" that tool call failed. If it starts with data (JSON, text), that tool call SUCCEEDED and its data is valid.
- Do NOT reject results because dates seem futuristic — check the current date above.
- Evaluate against the SUCCESS CRITERIA, not your own expectations.
- Provide specific, actionable feedback — "needs more detail" is not helpful. "Missing price comparison data for competitor B" is.
- For nextAction: focus on the highest-leverage change. What single thing would most improve the result?
`;

/**
 * Dimensional (multi-criteria) verification prompt template.
 * Used when a task has multiple success criteria separated by semicolons.
 */
export const DIMENSIONAL_VERIFICATION_TEMPLATE = `Evaluate this task result against EACH criterion independently.

## Current Date
{{today}}

## Task Description
{{taskDescription}}

## Task Result
{{taskResult}}
{{toolOutputInfo}}{{toolFailureInfo}}

## Success Criteria
{{criteriaList}}

## Scoring Guide
- **0.0**: Not attempted at all
- **0.1-0.3**: Mentioned but largely incomplete or incorrect
- **0.4-0.6**: Partially addressed with significant gaps
- **0.7-0.8**: Mostly complete with minor gaps
- **0.9-1.0**: Fully satisfied with high quality

## Instructions
For EACH criterion, provide a score and specific, actionable feedback.
Mark complete=true ONLY if ALL criteria score >= 0.8. Be strict.

IMPORTANT: In the "name" field, use the EXACT criterion text from the numbered list above.

Respond with JSON:
{
  "complete": true/false,
  "feedback": "Overall summary",
  "dimensions": [
    { "name": "exact criterion text", "score": 0.0-1.0, "passed": true/false, "feedback": "what specifically is missing or needs improvement" }
  ]
}`;

/**
 * Interpolate a template with values. Replaces {{key}} markers.
 */
export function interpolateTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
