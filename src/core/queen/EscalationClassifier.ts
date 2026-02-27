/**
 * Escalation Classifier — pure decision function that determines whether
 * a worker failure requires replanning or can be passed through.
 *
 * No side effects, no LLM calls, easy to test.
 */

import type { TaskResult, ToolErrorCategory } from '../types.js';
import { RecoveryAction } from '../failures.js';

export type EscalationDecision =
  | { action: 'retry'; delay: number; reason: string }
  | { action: 'retry_stronger_model'; reason: string }
  | { action: 'replan'; urgency: 'immediate'; reason: string }
  | { action: 'accept_partial'; reason: string }
  | { action: 'accept_failure'; reason: string }
  | { action: 'pass'; reason: string };

export interface EscalationContext {
  result: TaskResult;
  replanCount: number;
  maxReplans: number;
  dependentTaskIds: string[];
  completedTaskCount?: number;
  totalTaskCount?: number;
  remainingBudgetPercent?: number;
}

/**
 * Classify whether a worker's failure result requires replanning.
 *
 * When `result.failure` (ClassifiedFailure) is present, the failure taxonomy
 * drives richer recovery decisions. Otherwise, falls back to the legacy
 * decision matrix below.
 *
 * Legacy decision matrix:
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

  // Budget nearly exhausted — suppress replanning to avoid wasting remaining budget on LLM calls
  if (ctx.remainingBudgetPercent !== undefined && ctx.remainingBudgetPercent < 15) {
    return {
      action: 'accept_partial',
      reason: `Budget nearly exhausted (${ctx.remainingBudgetPercent.toFixed(0)}% remaining) — using best partial result`,
    };
  }

  // If failure taxonomy is available, use it for richer decisions
  if (result.failure) {
    const completionRatio = (ctx.completedTaskCount ?? 0) / (ctx.totalTaskCount ?? 1);
    const highDisruption = completionRatio > 0.6;

    switch (result.failure.suggestedRecovery) {
      case RecoveryAction.RetryWithBackoff:
        return { action: 'retry', delay: 2000 * (replanCount + 1), reason: result.failure.context };
      case RecoveryAction.EscalateModel:
        return { action: 'retry_stronger_model', reason: result.failure.context };
      case RecoveryAction.Replan:
        if (highDisruption) {
          return { action: 'accept_partial', reason: `${result.failure.context}. Not replanning — ${ctx.completedTaskCount}/${ctx.totalTaskCount} tasks complete.` };
        }
        if (replanCount >= maxReplans) {
          return { action: 'accept_failure', reason: `${result.failure.context}. Max replans reached.` };
        }
        return { action: 'replan', urgency: 'immediate' as const, reason: result.failure.context };
      case RecoveryAction.ReportHonestly:
        return { action: 'accept_failure', reason: result.failure.context };
      case RecoveryAction.SkipAndContinue:
        return { action: 'accept_partial', reason: result.failure.context };
      case RecoveryAction.RetrySameModel:
        return { action: 'replan', urgency: 'immediate' as const, reason: result.failure.context };
    }
  }

  // === Legacy fallback (when result.failure is not present) ===

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
