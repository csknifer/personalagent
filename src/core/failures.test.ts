import { classifyFailure, FailureCategory, RecoveryAction } from './failures.js';

describe('classifyFailure', () => {
  it('should classify tool infrastructure failure (network)', () => {
    const result = classifyFailure({
      exitReason: 'total_tool_failure',
      toolFailures: [
        { tool: 'web_search', error: 'ECONNREFUSED', category: 'network' },
        { tool: 'web_search', error: 'ECONNREFUSED', category: 'network' },
      ],
      bestScore: 0,
      iterations: 2,
    });
    expect(result.category).toBe(FailureCategory.Infrastructure);
    expect(result.subcategory).toBe('tool_unavailable');
    expect(result.isTransient).toBe(true);
    expect(result.suggestedRecovery).toBe(RecoveryAction.RetryWithBackoff);
  });

  it('should classify strategy exhaustion (stall with low score)', () => {
    const result = classifyFailure({
      exitReason: 'stall',
      toolFailures: [],
      bestScore: 0.45,
      iterations: 5,
    });
    expect(result.category).toBe(FailureCategory.Strategy);
    expect(result.subcategory).toBe('approach_exhausted');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.Replan);
  });

  it('should escalate model on stall with high score', () => {
    const result = classifyFailure({
      exitReason: 'stall',
      toolFailures: [],
      bestScore: 0.7,
      iterations: 5,
    });
    expect(result.category).toBe(FailureCategory.Strategy);
    expect(result.subcategory).toBe('approach_exhausted');
    expect(result.suggestedRecovery).toBe(RecoveryAction.EscalateModel);
  });

  it('should classify impossible task', () => {
    const result = classifyFailure({
      exitReason: 'hopelessness',
      toolFailures: [],
      bestScore: 0.05,
      iterations: 6,
    });
    expect(result.category).toBe(FailureCategory.TaskDefinition);
    expect(result.subcategory).toBe('likely_impossible');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.ReportHonestly);
  });

  it('should classify quota exhaustion as non-transient infrastructure', () => {
    const result = classifyFailure({
      exitReason: 'total_tool_failure',
      toolFailures: [
        { tool: 'web_search', error: 'Rate limit exceeded', category: 'quota' },
      ],
      bestScore: 0,
      iterations: 1,
    });
    expect(result.category).toBe(FailureCategory.Infrastructure);
    expect(result.subcategory).toBe('quota_exhausted');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.ReportHonestly);
  });

  it('should classify partial progress with model limitation', () => {
    const result = classifyFailure({
      exitReason: 'max_iterations',
      toolFailures: [],
      bestScore: 0.65,
      iterations: 5,
    });
    expect(result.category).toBe(FailureCategory.ModelCapability);
    expect(result.subcategory).toBe('insufficient_reasoning');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.EscalateModel);
  });

  it('should classify max_iterations with low score as strategy failure', () => {
    const result = classifyFailure({
      exitReason: 'max_iterations',
      toolFailures: [],
      bestScore: 0.2,
      iterations: 5,
    });
    expect(result.category).toBe(FailureCategory.Strategy);
    expect(result.subcategory).toBe('approach_exhausted');
    expect(result.suggestedRecovery).toBe(RecoveryAction.Replan);
  });

  it('should classify divergence as quality degrading', () => {
    const result = classifyFailure({
      exitReason: 'divergence',
      toolFailures: [],
      bestScore: 0.6,
      iterations: 4,
    });
    expect(result.category).toBe(FailureCategory.Strategy);
    expect(result.subcategory).toBe('quality_degrading');
    expect(result.suggestedRecovery).toBe(RecoveryAction.Replan);
  });

  it('should classify timeout as transient infrastructure', () => {
    const result = classifyFailure({
      exitReason: 'timeout',
      toolFailures: [],
      bestScore: 0.3,
      iterations: 3,
    });
    expect(result.category).toBe(FailureCategory.Infrastructure);
    expect(result.subcategory).toBe('timeout');
    expect(result.isTransient).toBe(true);
  });

  it('should classify cancelled as coordination', () => {
    const result = classifyFailure({
      exitReason: 'cancelled',
      toolFailures: [],
      bestScore: 0,
      iterations: 1,
    });
    expect(result.category).toBe(FailureCategory.Coordination);
    expect(result.subcategory).toBe('cancelled_by_queen');
    expect(result.suggestedRecovery).toBe(RecoveryAction.SkipAndContinue);
  });

  it('should classify mixed tool failures as tool_error', () => {
    const result = classifyFailure({
      exitReason: 'total_tool_failure',
      toolFailures: [
        { tool: 'web_search', error: 'ECONNREFUSED', category: 'network' },
        { tool: 'read_file', error: 'Permission denied' },
      ],
      bestScore: 0,
      iterations: 2,
    });
    expect(result.category).toBe(FailureCategory.Infrastructure);
    expect(result.subcategory).toBe('tool_error');
  });

  it('should fall back to unknown for unrecognized exit reasons', () => {
    const result = classifyFailure({
      exitReason: 'something_new',
      toolFailures: [],
      bestScore: 0,
      iterations: 1,
    });
    expect(result.category).toBe(FailureCategory.Strategy);
    expect(result.subcategory).toBe('unknown');
    expect(result.suggestedRecovery).toBe(RecoveryAction.ReportHonestly);
  });

  it('should preserve partial output and score', () => {
    const result = classifyFailure({
      exitReason: 'max_iterations',
      toolFailures: [],
      bestScore: 0.65,
      iterations: 5,
      output: 'Some partial work done',
    });
    expect(result.partialOutput).toBe('Some partial work done');
    expect(result.partialScore).toBe(0.65);
  });

  it('should include confidence between 0 and 1', () => {
    const result = classifyFailure({
      exitReason: 'hopelessness',
      toolFailures: [],
      bestScore: 0.05,
      iterations: 6,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
