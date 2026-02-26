import { describe, it, expect } from 'vitest';
import { classifyEscalation } from './EscalationClassifier.js';
import type { TaskResult } from '../types.js';

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: false,
    output: '',
    error: 'test error',
    iterations: 2,
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
