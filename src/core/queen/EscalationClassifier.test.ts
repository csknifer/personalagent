import { describe, it, expect } from 'vitest';
import { classifyEscalation } from './EscalationClassifier.js';
import type { TaskResult } from '../types.js';
import { FailureCategory, RecoveryAction, type ClassifiedFailure } from '../failures.js';

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: false,
    output: '',
    error: 'test error',
    iterations: 2,
    ...overrides,
  };
}

function makeFailure(overrides: Partial<ClassifiedFailure> = {}): ClassifiedFailure {
  return {
    category: FailureCategory.Infrastructure,
    subcategory: 'tool_unavailable',
    isTransient: true,
    suggestedRecovery: RecoveryAction.RetryWithBackoff,
    confidence: 0.8,
    context: 'Test failure',
    ...overrides,
  };
}

describe('classifyEscalation', () => {
  it('passes through successful tasks', () => {
    const decision = classifyEscalation({
      result: makeResult({ success: true }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('pass');
  });

  it('passes when replan budget exhausted', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'total_tool_failure' }),
      replanCount: 2,
      maxReplans: 2,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('pass');
    expect(decision.reason).toContain('limit');
  });

  it('replans on total_tool_failure', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'total_tool_failure' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('replan');
    expect(decision.reason).toContain('tools failed');
  });

  it('replans on auth tool failures', () => {
    const decision = classifyEscalation({
      result: makeResult({
        exitReason: 'max_iterations',
        toolFailures: [{ tool: 'web_search', error: '403 Forbidden', category: 'auth' }],
      }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('replan');
    expect(decision.reason).toContain('authentication');
  });

  it('replans on quota tool failures', () => {
    const decision = classifyEscalation({
      result: makeResult({
        exitReason: 'max_iterations',
        toolFailures: [{ tool: 'web_search', error: '429 rate limit', category: 'quota' }],
      }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('replan');
    expect(decision.reason).toContain('quota');
  });

  it('replans on hopelessness with dependents', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'hopelessness', bestScore: 0.1 }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('replan');
    expect(decision.reason).toContain('dependents');
  });

  it('passes on hopelessness without dependents', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'hopelessness', bestScore: 0.1 }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('pass');
  });

  it('replans on stall', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'stall' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('replan');
    expect(decision.reason).toContain('stalled');
  });

  it('passes on divergence', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'divergence', bestScore: 0.5 }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('pass');
    expect(decision.reason).toContain('diverging');
  });

  it('replans on timeout with dependents and no output', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'timeout', output: '' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('replan');
  });

  it('passes on timeout with output', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'timeout', output: 'partial data here' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('pass');
  });

  it('passes on max_iterations without dependents', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'max_iterations', output: '' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('pass');
  });

  it('replans on max_iterations with dependents and empty output', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'max_iterations', output: '' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('replan');
  });

  it('passes on cancelled tasks', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'cancelled' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('pass');
  });

  it('replans on execution_error with dependents', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'execution_error' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: ['dep-1'],
    });
    expect(decision.action).toBe('replan');
  });

  it('passes on execution_error without dependents', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'execution_error' }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('pass');
  });

  it('passes on unknown exit reason', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: undefined }),
      replanCount: 0,
      maxReplans: 1,
      dependentTaskIds: [],
    });
    expect(decision.action).toBe('pass');
  });
});

describe('budget-aware escalation', () => {
  it('should prefer accept_partial over replan when budget nearly exhausted (taxonomy path)', () => {
    const decision = classifyEscalation({
      result: makeResult({
        exitReason: 'stall',
        failure: makeFailure({
          category: FailureCategory.Strategy,
          suggestedRecovery: RecoveryAction.Replan,
        }),
      }),
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: ['task-2'],
      remainingBudgetPercent: 10,
    });

    expect(decision.action).toBe('accept_partial');
    expect(decision.reason).toContain('Budget');
  });

  it('should prefer accept_partial over replan when budget nearly exhausted (legacy path)', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'stall' }),
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: [],
      remainingBudgetPercent: 5,
    });

    expect(decision.action).toBe('accept_partial');
    expect(decision.reason).toContain('Budget');
  });

  it('should allow replan when budget is sufficient', () => {
    const decision = classifyEscalation({
      result: makeResult({
        exitReason: 'stall',
        failure: makeFailure({
          category: FailureCategory.Strategy,
          suggestedRecovery: RecoveryAction.Replan,
        }),
      }),
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: ['task-2'],
      remainingBudgetPercent: 80,
    });

    expect(decision.action).toBe('replan');
  });

  it('should not suppress when budget percent is undefined', () => {
    const decision = classifyEscalation({
      result: makeResult({ exitReason: 'stall' }),
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: [],
    });

    expect(decision.action).toBe('replan');
  });

  it('should pass through successful tasks regardless of low budget', () => {
    const decision = classifyEscalation({
      result: makeResult({ success: true }),
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: [],
      remainingBudgetPercent: 5,
    });

    expect(decision.action).toBe('pass');
  });
});

describe('failure-taxonomy-driven escalation', () => {
  it('should retry with backoff for transient infrastructure failures', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.RetryWithBackoff }),
    });
    const decision = classifyEscalation({ result, replanCount: 0, maxReplans: 2, dependentTaskIds: [] });
    expect(decision.action).toBe('retry');
    expect((decision as any).delay).toBeGreaterThan(0);
  });

  it('should replan for strategy failures when disruption is low', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.Replan }),
    });
    const decision = classifyEscalation({
      result, replanCount: 0, maxReplans: 2, dependentTaskIds: [],
      completedTaskCount: 1, totalTaskCount: 4,
    });
    expect(decision.action).toBe('replan');
  });

  it('should accept partial when disruption is high', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.Replan }),
    });
    const decision = classifyEscalation({
      result, replanCount: 0, maxReplans: 2, dependentTaskIds: [],
      completedTaskCount: 3, totalTaskCount: 4,
    });
    expect(decision.action).toBe('accept_partial');
  });

  it('should report honestly for impossible tasks', () => {
    const result = makeResult({
      failure: makeFailure({
        category: FailureCategory.TaskDefinition,
        suggestedRecovery: RecoveryAction.ReportHonestly,
      }),
    });
    const decision = classifyEscalation({ result, replanCount: 0, maxReplans: 2, dependentTaskIds: [] });
    expect(decision.action).toBe('accept_failure');
  });

  it('should escalate model for model capability issues', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.EscalateModel }),
    });
    const decision = classifyEscalation({ result, replanCount: 0, maxReplans: 2, dependentTaskIds: [] });
    expect(decision.action).toBe('retry_stronger_model');
  });

  it('should accept partial for skip-and-continue recovery', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.SkipAndContinue }),
    });
    const decision = classifyEscalation({ result, replanCount: 0, maxReplans: 2, dependentTaskIds: [] });
    expect(decision.action).toBe('accept_partial');
  });

  it('should replan for retry-same-model recovery', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.RetrySameModel }),
    });
    const decision = classifyEscalation({ result, replanCount: 0, maxReplans: 2, dependentTaskIds: [] });
    expect(decision.action).toBe('replan');
  });

  it('should accept failure for replan when max replans reached', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.Replan }),
    });
    const decision = classifyEscalation({
      result, replanCount: 2, maxReplans: 2, dependentTaskIds: [],
      completedTaskCount: 0, totalTaskCount: 4,
    });
    // replanCount >= maxReplans is checked before failure taxonomy, so this returns 'pass'
    expect(decision.action).toBe('pass');
  });

  it('should scale retry delay based on replan count', () => {
    const result = makeResult({
      failure: makeFailure({ suggestedRecovery: RecoveryAction.RetryWithBackoff }),
    });
    const d0 = classifyEscalation({ result, replanCount: 0, maxReplans: 5, dependentTaskIds: [] });
    const d2 = classifyEscalation({ result, replanCount: 2, maxReplans: 5, dependentTaskIds: [] });
    expect((d0 as any).delay).toBe(2000);
    expect((d2 as any).delay).toBe(6000);
  });

  it('should still pass through successful tasks even with failure field', () => {
    const result = makeResult({
      success: true,
      failure: makeFailure(), // shouldn't matter
    });
    const decision = classifyEscalation({ result, replanCount: 0, maxReplans: 2, dependentTaskIds: [] });
    expect(decision.action).toBe('pass');
  });
});
