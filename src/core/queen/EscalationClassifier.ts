/**
 * Escalation Classifier — pure decision function that determines whether
 * a worker failure requires replanning or can be passed through.
 *
 * No side effects, no LLM calls, easy to test.
 */

import type { TaskResult, ToolErrorCategory } from '../types.js';

export type EscalationDecision =
  | { action: 'replan'; urgency: 'immediate'; reason: string }
  | { action: 'pass'; reason: string };

export interface EscalationContext {
  result: TaskResult;
  replanCount: number;
  maxReplans: number;
  dependentTaskIds: string[];
}

/**
 * Classify whether a worker's failure result requires replanning.
 *
 * Decision matrix:
 * | Exit Reason         | Tool Error Category | Has Dependents | Decision |
 * |---------------------|---------------------|----------------|----------|
 * | success             | —                   | —              | pass     |
 * | replanCount >= max  | any                 | any            | pass     |
 * | total_tool_failure  | any                 | any            | replan   |
 * | any                 | auth or quota       | any            | replan   |
 * | hopelessness        | —                   | yes            | replan   |
 * | hopelessness        | —                   | no             | pass     |
 * | stall               | —                   | any            | replan   |
 * | divergence          | —                   | any            | pass     |
 * | timeout/max_iter    | —                   | yes + no output| replan   |
 * | timeout/max_iter    | —                   | no or has output| pass    |
 */
export function classifyEscalation(ctx: EscalationContext): EscalationDecision {
  const { result, replanCount, maxReplans, dependentTaskIds } = ctx;
  const hasDependents = dependentTaskIds.length > 0;

  // Successful tasks never trigger replan
  if (result.success) {
    return { action: 'pass', reason: 'Task succeeded' };
  }

  // Replan budget exhausted — always pass
  if (replanCount >= maxReplans) {
    return { action: 'pass', reason: `Replan limit reached (${replanCount}/${maxReplans})` };
  }

  // Total tool failure — infrastructure broken
  if (result.exitReason === 'total_tool_failure') {
    return {
      action: 'replan',
      urgency: 'immediate',
      reason: 'All tools failed — infrastructure failure requires different strategy',
    };
  }

  // Auth or quota failures across any tools — infrastructure issue
  if (result.toolFailures && result.toolFailures.length > 0) {
    const categories = new Set<ToolErrorCategory>(
      result.toolFailures
        .map(f => f.category)
        .filter((c): c is ToolErrorCategory => c !== undefined)
    );
    if (categories.has('auth') || categories.has('quota')) {
      return {
        action: 'replan',
        urgency: 'immediate',
        reason: `Tool infrastructure failure: ${categories.has('auth') ? 'authentication' : 'quota'} error`,
      };
    }
  }

  // Hopelessness — task appears unachievable
  if (result.exitReason === 'hopelessness') {
    if (hasDependents) {
      return {
        action: 'replan',
        urgency: 'immediate',
        reason: 'Task unachievable and has dependents — need alternative approach',
      };
    }
    return { action: 'pass', reason: 'Task unachievable but no dependents — best output captured' };
  }

  // Stall — worker stuck in a loop
  if (result.exitReason === 'stall') {
    return {
      action: 'replan',
      urgency: 'immediate',
      reason: 'Worker stalled — needs different strategy',
    };
  }

  // Divergence — quality declining, best output already captured
  if (result.exitReason === 'divergence') {
    return { action: 'pass', reason: 'Quality diverging — best output already captured' };
  }

  // Timeout or max iterations — depends on whether there are dependents and output
  if (result.exitReason === 'timeout' || result.exitReason === 'max_iterations') {
    const hasOutput = result.output && result.output.trim().length > 0;
    if (hasDependents && !hasOutput) {
      return {
        action: 'replan',
        urgency: 'immediate',
        reason: `${result.exitReason === 'timeout' ? 'Timeout' : 'Max iterations'} with no output — dependents would fail`,
      };
    }
    return {
      action: 'pass',
      reason: `${result.exitReason === 'timeout' ? 'Timeout' : 'Max iterations'} — partial result usable`,
    };
  }

  // Cancelled — pass through (was already handled by replan flow)
  if (result.exitReason === 'cancelled') {
    return { action: 'pass', reason: 'Task was cancelled' };
  }

  // Execution error — check if it has dependents
  if (result.exitReason === 'execution_error') {
    if (hasDependents) {
      return {
        action: 'replan',
        urgency: 'immediate',
        reason: 'Execution error with dependents — need alternative approach',
      };
    }
    return { action: 'pass', reason: 'Execution error — no dependents to impact' };
  }

  // Unknown exit reason — default to pass
  return { action: 'pass', reason: 'Unknown failure — partial result preserved' };
}
