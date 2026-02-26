/**
 * Failure Taxonomy — structured classification of worker/task failures.
 *
 * This module provides types and a classifier function for categorizing
 * failures so the system can make informed recovery decisions.
 */

export enum FailureCategory {
  Infrastructure = 'Infrastructure',
  Strategy = 'Strategy',
  TaskDefinition = 'TaskDefinition',
  ModelCapability = 'ModelCapability',
  Coordination = 'Coordination',
}

export enum RecoveryAction {
  RetryWithBackoff = 'RetryWithBackoff',
  RetrySameModel = 'RetrySameModel',
  EscalateModel = 'EscalateModel',
  Replan = 'Replan',
  ReportHonestly = 'ReportHonestly',
  SkipAndContinue = 'SkipAndContinue',
}

export interface ClassifiedFailure {
  category: FailureCategory;
  subcategory: string;
  isTransient: boolean;
  suggestedRecovery: RecoveryAction;
  confidence: number;
  context: string;
  partialOutput?: string;
  partialScore?: number;
}

export interface ToolFailure {
  tool: string;
  error: string;
  category?: string;
}

export interface FailureInput {
  exitReason: string;
  toolFailures: ToolFailure[];
  bestScore: number;
  iterations: number;
  output?: string;
}

export function classifyFailure(input: FailureInput): ClassifiedFailure {
  const { exitReason, toolFailures, bestScore, iterations, output } = input;

  const base = {
    partialOutput: output,
    partialScore: bestScore > 0 ? bestScore : undefined,
  };

  switch (exitReason) {
    case 'total_tool_failure':
      return { ...base, ...classifyToolFailure(toolFailures) };

    case 'stall':
      return {
        ...base,
        category: FailureCategory.Strategy,
        subcategory: 'approach_exhausted',
        isTransient: false,
        suggestedRecovery: bestScore > 0.5 ? RecoveryAction.Replan : RecoveryAction.EscalateModel,
        confidence: 0.7,
        context: `Stalled after ${iterations} iterations with best score ${bestScore}`,
      };

    case 'hopelessness':
      return {
        ...base,
        category: FailureCategory.TaskDefinition,
        subcategory: 'likely_impossible',
        isTransient: false,
        suggestedRecovery: RecoveryAction.ReportHonestly,
        confidence: 0.8,
        context: `Worker signaled hopelessness after ${iterations} iterations`,
      };

    case 'divergence':
      return {
        ...base,
        category: FailureCategory.Strategy,
        subcategory: 'quality_degrading',
        isTransient: false,
        suggestedRecovery: RecoveryAction.Replan,
        confidence: 0.75,
        context: `Quality diverging after ${iterations} iterations, best score ${bestScore}`,
      };

    case 'max_iterations':
      if (bestScore > 0.4) {
        return {
          ...base,
          category: FailureCategory.ModelCapability,
          subcategory: 'insufficient_reasoning',
          isTransient: false,
          suggestedRecovery: RecoveryAction.EscalateModel,
          confidence: 0.6,
          context: `Hit max iterations with partial progress (score ${bestScore})`,
        };
      }
      return {
        ...base,
        category: FailureCategory.Strategy,
        subcategory: 'approach_exhausted',
        isTransient: false,
        suggestedRecovery: RecoveryAction.Replan,
        confidence: 0.6,
        context: `Hit max iterations with low progress (score ${bestScore})`,
      };

    case 'timeout':
      return {
        ...base,
        category: FailureCategory.Infrastructure,
        subcategory: 'timeout',
        isTransient: true,
        suggestedRecovery: RecoveryAction.RetryWithBackoff,
        confidence: 0.7,
        context: `Timed out after ${iterations} iterations`,
      };

    case 'budget_exhausted':
      return {
        ...base,
        category: FailureCategory.Infrastructure,
        subcategory: 'budget_exhausted',
        isTransient: false,
        suggestedRecovery: bestScore > 0.5 ? RecoveryAction.SkipAndContinue : RecoveryAction.ReportHonestly,
        confidence: 1.0,
        context: `Budget exhausted after ${iterations} iterations (best: ${bestScore})`,
      };

    case 'cancelled':
      return {
        ...base,
        category: FailureCategory.Coordination,
        subcategory: 'cancelled_by_queen',
        isTransient: false,
        suggestedRecovery: RecoveryAction.SkipAndContinue,
        confidence: 1.0,
        context: 'Task cancelled by orchestrator',
      };

    default:
      return {
        ...base,
        category: FailureCategory.Strategy,
        subcategory: 'unknown',
        isTransient: false,
        suggestedRecovery: RecoveryAction.ReportHonestly,
        confidence: 0.3,
        context: `Unrecognized exit reason: ${exitReason}`,
      };
  }
}

function classifyToolFailure(toolFailures: ToolFailure[]): Omit<ClassifiedFailure, 'partialOutput' | 'partialScore'> {
  const categories = toolFailures.map((f) => f.category);
  const allQuota = categories.length > 0 && categories.every((c) => c === 'quota');
  const allNetwork = categories.length > 0 && categories.every((c) => c === 'network');

  if (allQuota) {
    return {
      category: FailureCategory.Infrastructure,
      subcategory: 'quota_exhausted',
      isTransient: false,
      suggestedRecovery: RecoveryAction.ReportHonestly,
      confidence: 0.9,
      context: `All ${toolFailures.length} tool failures are quota-related`,
    };
  }

  if (allNetwork) {
    return {
      category: FailureCategory.Infrastructure,
      subcategory: 'tool_unavailable',
      isTransient: true,
      suggestedRecovery: RecoveryAction.RetryWithBackoff,
      confidence: 0.85,
      context: `All ${toolFailures.length} tool failures are network-related`,
    };
  }

  return {
    category: FailureCategory.Infrastructure,
    subcategory: 'tool_error',
    isTransient: false,
    suggestedRecovery: RecoveryAction.ReportHonestly,
    confidence: 0.5,
    context: `Mixed tool failures: ${toolFailures.map((f) => `${f.tool}(${f.error})`).join(', ')}`,
  };
}
