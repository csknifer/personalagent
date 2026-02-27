/**
 * Ralph Loop verifiers — LLM-based and test-based verification of task results.
 */

import type { Message, Task, TaskResult, Verification, Verifier, TokenUsage, AgentEventHandler, ToolExecutionEvent, ConvergenceSignal, ConvergenceState } from '../types.js';
import type { DimensionalConfig } from '../../config/types.js';
import type { LLMProvider, ToolDefinition, ToolCall, TrackedChatOptions } from '../../providers/index.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { BudgetGuard } from '../cost/BudgetGuard.js';
import type { CostRegistry } from '../cost/CostRegistry.js';
import { getDebugLogger } from '../DebugLogger.js';
import { callWithTimeout } from './ralphUtils.js';
import { parseSuccessCriteria } from './dimensional.js';
import type { CriterionScore } from '../types.js';

export interface RalphLoopOptions {
  maxIterations: number;
  timeout: number;
  verifier?: Verifier;
  mcpServer?: MCPServer;
  /** Progress callback for iteration/status updates */
  onProgress?: (iteration: number, status: string) => void;
  /** Enhanced event handler for granular progress tracking */
  onEvent?: AgentEventHandler;
  /** Worker ID for tracking purposes */
  workerId?: string;
  /** Per-API-call timeout in ms (default: 60000) */
  callTimeout?: number;
  /** Per-tool-call timeout in ms (default: 30000) */
  toolTimeout?: number;
  /** DCL dimensional convergence config */
  dimensionalConfig?: DimensionalConfig;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
  /** Budget guard for cost-aware early termination */
  budgetGuard?: BudgetGuard;
  /** Cost registry for calculating LLM call costs from token usage */
  costRegistry?: CostRegistry;
}

export interface RalphLoopContext {
  task: Task;
  iteration: number;
  previousAttempts: string[];
  feedback: string[];
  /** Accumulated key findings across iterations (deduplicated) */
  findings: string[];
  workerId?: string;
  toolCalls: number;
  llmCalls: number;
  // DCL additions
  convergenceState?: ConvergenceState;
  failingCriteria?: string[];
  reflexionGuidance?: string;
  observationMaskingEnabled?: boolean;
  maxMaskedOutputLength?: number;
  // Loop intelligence
  bestOutput?: string;
  bestScore?: number;
  stallCount?: number;
  stallDetected?: boolean;
  // Structural tool failure tracking
  lastToolFailures?: Array<{ tool: string; error: string }>;
  consecutiveAllToolFailures: number;
  // Worker scratchpad: persistent reasoning state across iterations
  scratchpad: string[];
  // Selective observation retention: critical tool results that survive masking
  retainedToolResults: Map<string, string>;
  maxRetainedTokens: number;
  // Budget awareness
  budgetStatus?: { percentUsed: number; remaining: number };
}

/**
 * Default verifier that uses the LLM to assess completion
 */
/**
 * Unified verification result — extends Verification with strategic guidance
 * so that verification + reflexion happen in a single LLM call.
 */
export interface UnifiedVerificationResult extends Verification {
  nextAction?: string;
  dimensions?: CriterionScore[];
}

/**
 * Unified Verifier — merges verification and reflexion into a single LLM call.
 * Replaces LLMVerifier as the default for non-DCL tasks.
 * Instead of: verify (1 call) → fail → reflexion (1 call) = 2 calls,
 * this does: unified verify+reflect (1 call) = 1 call, saving an LLM round-trip.
 */
export class UnifiedVerifier implements Verifier {
  private provider: LLMProvider;
  private taskDescription: string;
  private successCriteria: string;

  constructor(provider: LLMProvider, taskDescription: string = '', successCriteria: string = '') {
    this.provider = provider;
    this.taskDescription = taskDescription;
    this.successCriteria = successCriteria;
  }

  async check(result: TaskResult): Promise<UnifiedVerificationResult> {
    const criteria = parseSuccessCriteria(this.successCriteria);
    if (criteria.length > 1) {
      return this.checkDimensional(result, criteria);
    }
    return this.checkSingle(result);
  }

  private async checkSingle(result: TaskResult): Promise<UnifiedVerificationResult> {
    const today = new Date().toISOString().split('T')[0];
    const toolInfo = result.toolsUsed && result.toolsUsed.length > 0
      ? `Tools used during execution: ${result.toolsUsed.join(', ')}`
      : 'No tools were used during execution.';
    const toolOutputInfo = result.toolOutputSummary
      ? `\n## Tool Output Summary\n${result.toolOutputSummary}\n`
      : '';
    const toolFailureInfo = result.toolFailures && result.toolFailures.length > 0
      ? `\n## ⚠ TOOL FAILURES (programmatically detected — these are facts, not claims)\nThe following tools had ALL calls fail during execution (no successful calls):\n${result.toolFailures.map(f => `- **${f.tool}**: ${f.error}`).join('\n')}\n\nNote: Tools NOT listed here had at least one successful call and may have produced valid data. Only flag data as fabricated if it could ONLY have come from the failed tools listed above.\n`
      : '';

    const prompt = `Evaluate this task result AND provide strategic next-step guidance if incomplete.

## Current Date
${today}

## Task Description
${this.taskDescription || '(not provided)'}

## Success Criteria
${this.successCriteria || '(not provided)'}

## Tool Usage
${toolInfo}
${toolOutputInfo}${toolFailureInfo}
## Task Result
${result.output}

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
- Be strict — only mark complete if ALL criteria are fully satisfied.
- If the result says "I cannot" or refuses to attempt the task despite having tools, mark INCOMPLETE with LOW confidence.
- CRITICAL: Check the Tool Output Summary above carefully. If a tool returned actual data (not an error), that data is REAL. Only flag data as fabricated if the specific numbers/facts do NOT appear anywhere in any successful tool output.
- If a tool output starts with "Error:" that tool call failed. If it starts with data (JSON, text), that tool call SUCCEEDED and its data is valid.
- Do NOT reject results because dates seem futuristic — check the current date above.
- Evaluate against the SUCCESS CRITERIA, not your own expectations.
- Provide specific, actionable feedback — "needs more detail" is not helpful. "Missing price comparison data for competitor B" is.
- For nextAction: focus on the highest-leverage change. What single thing would most improve the result?
`;

    const log = getDebugLogger();
    log.debug('UnifiedVerifier', 'Checking result', { resultLength: result.output.length });

    try {
      const response = await this.provider.complete(prompt);
      log.debug('UnifiedVerifier', 'Raw response', { response: response.slice(0, 300) });
      const parsed = this.parseUnifiedVerification(response);
      log.info('UnifiedVerifier', `Verdict: ${parsed.complete ? 'PASS' : 'FAIL'}`, {
        complete: parsed.complete,
        confidence: parsed.confidence,
        feedback: parsed.feedback?.slice(0, 200),
        hasNextAction: !!parsed.nextAction,
      });
      return parsed;
    } catch (err) {
      log.error('UnifiedVerifier', 'Verification call failed', { error: String(err) });
      return {
        complete: false,
        confidence: 0,
        feedback: 'Verification failed - retry needed',
      };
    }
  }

  private async checkDimensional(result: TaskResult, criteria: string[]): Promise<UnifiedVerificationResult> {
    const today = new Date().toISOString().split('T')[0];
    const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const toolOutputInfo = result.toolOutputSummary
      ? `\n## Tool Output Summary\n${result.toolOutputSummary}\n`
      : '';
    const toolFailureInfo = result.toolFailures && result.toolFailures.length > 0
      ? `\n## ⚠ TOOL FAILURES (programmatically detected — these are facts)\nThe following tools had ALL calls fail (no successful calls):\n${result.toolFailures.map(f => `- **${f.tool}**: ${f.error}`).join('\n')}\nOnly flag data as fabricated if it could ONLY have come from these failed tools. Tools not listed here had at least one successful call.\n`
      : '';

    const prompt = `Evaluate this task result against EACH criterion independently.

## Current Date
${today}

## Task Description
${this.taskDescription || '(not provided)'}

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

    const log = getDebugLogger();
    log.debug('UnifiedVerifier', 'Checking result (dimensional)', { resultLength: result.output.length, criteria: criteria.length });

    try {
      const response = await this.provider.complete(prompt);
      log.debug('UnifiedVerifier', 'Raw dimensional response', { response: response.slice(0, 300) });
      return this.parseDimensionalVerification(response, criteria);
    } catch (err) {
      log.error('UnifiedVerifier', 'Dimensional verification failed', { error: String(err) });
      return {
        complete: false,
        confidence: 0,
        feedback: 'Verification failed - retry needed',
        dimensions: criteria.map(name => ({
          name, score: 0, passed: false, feedback: 'Verification error',
        })),
      };
    }
  }

  private parseDimensionalVerification(response: string, criteria: string[]): UnifiedVerificationResult {
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
        if (!criteria.includes(dim.name)) {
          const best = this.findBestMatch(dim.name, criteria);
          if (best) dim.name = best;
        }
      }

      // Compute confidence as pessimistic min of scores
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

  private findBestMatch(name: string, criteria: string[]): string | undefined {
    const lowerName = name.toLowerCase();
    for (const c of criteria) {
      const lowerC = c.toLowerCase();
      if (lowerC.includes(lowerName) || lowerName.includes(lowerC)) {
        return c;
      }
    }
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

  private parseUnifiedVerification(response: string): UnifiedVerificationResult {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { complete: false, confidence: 0, feedback: 'Could not parse verification' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        complete: Boolean(parsed.complete),
        confidence: Number(parsed.confidence) || 0,
        feedback: String(parsed.feedback || ''),
        nextAction: parsed.nextAction ? String(parsed.nextAction) : undefined,
      };
    } catch {
      return { complete: false, confidence: 0, feedback: 'Verification parse error' };
    }
  }
}

/**
 * Test-based verifier that checks objective criteria
 */
export class TestBasedVerifier implements Verifier {
  private tests: Array<(result: TaskResult) => boolean>;

  constructor(tests: Array<(result: TaskResult) => boolean>) {
    this.tests = tests;
  }

  async check(result: TaskResult): Promise<Verification> {
    const passedTests = this.tests.filter(test => {
      try {
        return test(result);
      } catch {
        return false;
      }
    });

    const allPassed = passedTests.length === this.tests.length;

    return {
      complete: allPassed,
      confidence: passedTests.length / this.tests.length,
      feedback: allPassed
        ? undefined
        : `${this.tests.length - passedTests.length} tests failed`,
    };
  }
}
