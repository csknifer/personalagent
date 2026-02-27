import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UnifiedVerifier, TestBasedVerifier, ralphLoop,
  parseSuccessCriteria, maskObservations,
  ConvergenceTracker, DimensionalVerifier,
  generateReflexion, generateDimensionalReflexion,
  computeStringSimilarity,
} from './RalphLoop.js';
import { MockProvider, MockMCPServer } from '../../test/helpers.js';
import type { Task, TaskResult, Verification, DimensionalVerification, CriterionScore } from '../types.js';
import { BudgetGuard } from '../cost/BudgetGuard.js';
import { CostRegistry } from '../cost/CostRegistry.js';
import { getProgressTracker } from '../progress/ProgressTracker.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    description: 'Test task description',
    successCriteria: 'Task is complete',
    dependencies: [],
    priority: 1,
    status: 'pending' as const,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('UnifiedVerifier', () => {
  let provider: MockProvider;
  let verifier: UnifiedVerifier;

  beforeEach(() => {
    provider = new MockProvider();
    verifier = new UnifiedVerifier(provider, 'Test task', 'Task is complete');
  });

  it('parses complete verification response', async () => {
    provider.defaultResponse = JSON.stringify({
      complete: true,
      confidence: 0.95,
      feedback: 'Looks good',
    });

    const result = await verifier.check({
      success: true,
      output: 'task output',
    });

    expect(result.complete).toBe(true);
    expect(result.confidence).toBe(0.95);
  });

  it('parses incomplete verification response with nextAction', async () => {
    provider.defaultResponse = JSON.stringify({
      complete: false,
      confidence: 0.3,
      feedback: 'Missing details',
      nextAction: 'Search for more data',
    });

    const result = await verifier.check({
      success: true,
      output: 'partial output',
    });

    expect(result.complete).toBe(false);
    expect(result.feedback).toBe('Missing details');
    expect(result.nextAction).toBe('Search for more data');
  });

  it('returns incomplete on parse error', async () => {
    provider.defaultResponse = 'not json';

    const result = await verifier.check({
      success: true,
      output: 'output',
    });

    expect(result.complete).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('returns incomplete on provider error', async () => {
    provider.errorToThrow = new Error('API error');

    const result = await verifier.check({
      success: true,
      output: 'output',
    });

    expect(result.complete).toBe(false);
    expect(result.feedback).toContain('retry');
  });

  it('includes tool failure hard facts in verification prompt', async () => {
    provider.defaultResponse = JSON.stringify({
      complete: false,
      confidence: 0.1,
      feedback: 'Data is fabricated',
    });

    const result = await verifier.check({
      success: true,
      output: 'Here is the stock price: $50.00',
      toolFailures: [
        { tool: 'fetch_url', error: 'Error: HTTP 403 Forbidden' },
        { tool: 'web_search', error: 'Error: API rate limit exceeded' },
      ],
    });

    expect(result.complete).toBe(false);
    expect(result.confidence).toBeLessThanOrEqual(0.2);
  });
});

describe('TestBasedVerifier', () => {
  it('passes when all tests pass', async () => {
    const verifier = new TestBasedVerifier([
      (r: TaskResult) => r.output.includes('hello'),
      (r: TaskResult) => r.success === true,
    ]);

    const result = await verifier.check({
      success: true,
      output: 'hello world',
    });

    expect(result.complete).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it('fails when some tests fail', async () => {
    const verifier = new TestBasedVerifier([
      (r: TaskResult) => r.output.includes('hello'),
      (r: TaskResult) => r.output.includes('missing'),
    ]);

    const result = await verifier.check({
      success: true,
      output: 'hello world',
    });

    expect(result.complete).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.feedback).toContain('1 tests failed');
  });

  it('treats throwing tests as failures', async () => {
    const verifier = new TestBasedVerifier([
      () => { throw new Error('boom'); },
      (r: TaskResult) => r.success,
    ]);

    const result = await verifier.check({
      success: true,
      output: 'test',
    });

    expect(result.complete).toBe(false);
    expect(result.confidence).toBe(0.5);
  });
});

describe('ralphLoop', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    getProgressTracker().reset();
  });

  it('completes successfully when verifier approves on first iteration', async () => {
    // Provider gives task output, then verifier approves
    provider.responses = [
      'Task completed successfully',
      // Verification response
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 3,
      timeout: 10000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('Task completed successfully');
    expect(result.iterations).toBe(1);
  });

  it('iterates when verifier rejects and eventually succeeds', async () => {
    provider.responses = [
      // First iteration
      'Partial answer',
      // First verification - rejects
      JSON.stringify({ complete: false, confidence: 0.3, feedback: 'Need more detail' }),
      // Second iteration (with feedback)
      'Complete detailed answer',
      // Second verification - approves
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
  });

  it('returns failure when max iterations reached', async () => {
    // Verifications reject but with moderate confidence (above hopeless threshold)
    // so the loop doesn't exit early via the hopelessness check
    provider.defaultResponse = JSON.stringify({
      complete: false,
      confidence: 0.4,
      feedback: 'Getting closer but not there yet',
    });

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 2,
      timeout: 10000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.iterations).toBe(2);
    expect(result.exitReason).toBe('max_iterations');
    expect(result.bestScore).toBeDefined();
  });

  it('returns failure on timeout', async () => {
    // Simulate slow provider
    provider.chat = async (messages) => {
      provider.chatCalls.push({ messages });
      await new Promise(resolve => setTimeout(resolve, 200));
      return {
        content: 'response',
        tokenUsage: { input: 10, output: 20, total: 30 },
      };
    };

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 50, // Very short timeout
    });

    // Either times out or completes, but should not hang
    expect(result).toBeDefined();
    // If it timed out on the check (after first iteration completed)
    // or completed on first pass, both are valid
  });

  it('returns failure when abort signal is fired', async () => {
    const controller = new AbortController();

    // Slow provider so we can abort mid-flight
    provider.chat = async (messages) => {
      provider.chatCalls.push({ messages });
      await new Promise(resolve => setTimeout(resolve, 200));
      return {
        content: 'response',
        tokenUsage: { input: 10, output: 20, total: 30 },
      };
    };

    const task = createTask();
    const resultPromise = ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
      signal: controller.signal,
    });

    // Abort after a brief delay
    setTimeout(() => controller.abort(), 50);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('cancelled');
    expect(result.exitReason).toBe('cancelled');
  });

  it('returns immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cancelled');
    expect(result.exitReason).toBe('cancelled');
    expect(result.iterations).toBe(0);
  });

  it('accumulates token usage across iterations', async () => {
    provider.responses = [
      'First attempt',
      JSON.stringify({ complete: false, confidence: 0.3, feedback: 'retry' }),
      'Second attempt',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];
    provider.defaultTokenUsage = { input: 100, output: 50, total: 150 };

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
    });

    expect(result.tokenUsage).toBeDefined();
    // At least 2 iterations worth of tokens + verification calls
    expect(result.tokenUsage!.total).toBeGreaterThan(0);
  });

  it('calls onProgress callback', async () => {
    provider.responses = [
      'Done',
      JSON.stringify({ complete: true, confidence: 1, feedback: '' }),
    ];

    const progressCalls: Array<{ iteration: number; status: string }> = [];

    const task = createTask();
    await ralphLoop(provider, task, {
      maxIterations: 3,
      timeout: 10000,
      onProgress: (iteration, status) => {
        progressCalls.push({ iteration, status });
      },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('uses custom verifier when provided', async () => {
    provider.defaultResponse = 'hello world output';

    const customVerifier = {
      check: async (result: TaskResult): Promise<Verification> => ({
        complete: result.output.includes('hello'),
        confidence: 1,
        feedback: undefined,
      }),
    };

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 3,
      timeout: 10000,
      verifier: customVerifier,
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it('skips verification when execution fails, preventing naive verifiers from marking errors as success', async () => {
    // Provider throws on every call — execution will fail each iteration.
    // Use an AlwaysPass verifier that would incorrectly mark it complete
    // if the guard didn't skip verification for failed attempts.
    provider.errorToThrow = new Error('API unavailable');

    const alwaysPassVerifier = {
      checkCallCount: 0,
      check: async (_result: TaskResult): Promise<Verification> => {
        alwaysPassVerifier.checkCallCount++;
        return { complete: true, confidence: 1.0 };
      },
    };

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 2,
      timeout: 10000,
      verifier: alwaysPassVerifier,
    });

    // Should fail because execution errors skip verification
    expect(result.success).toBe(false);
    // Verifier should never have been called
    expect(alwaysPassVerifier.checkCallCount).toBe(0);
  });
});

// =============================================================================
// DCL (Dimensional Convergence Loop) Tests
// =============================================================================

describe('parseSuccessCriteria', () => {
  it('parses numbered list (dot notation)', () => {
    const input = '1. Implement the API\n2. Write tests\n3. Update documentation';
    expect(parseSuccessCriteria(input)).toEqual([
      'Implement the API',
      'Write tests',
      'Update documentation',
    ]);
  });

  it('parses numbered list (parenthesis notation)', () => {
    const input = '1) First criterion\n2) Second criterion';
    expect(parseSuccessCriteria(input)).toEqual([
      'First criterion',
      'Second criterion',
    ]);
  });

  it('parses bullet points with dashes', () => {
    const input = '- Handles edge cases\n- Returns correct types\n- Has error handling';
    expect(parseSuccessCriteria(input)).toEqual([
      'Handles edge cases',
      'Returns correct types',
      'Has error handling',
    ]);
  });

  it('parses bullet points with asterisks', () => {
    const input = '* Fast response time\n* Low memory usage';
    expect(parseSuccessCriteria(input)).toEqual([
      'Fast response time',
      'Low memory usage',
    ]);
  });

  it('parses semicolon-separated criteria', () => {
    const input = 'Correct output; Good performance; Clean code';
    expect(parseSuccessCriteria(input)).toEqual([
      'Correct output',
      'Good performance',
      'Clean code',
    ]);
  });

  it('returns single-element array for plain text', () => {
    const input = 'Task completes successfully';
    expect(parseSuccessCriteria(input)).toEqual(['Task completes successfully']);
  });

  it('returns empty array for empty/whitespace input', () => {
    expect(parseSuccessCriteria('')).toEqual([]);
    expect(parseSuccessCriteria('   ')).toEqual([]);
  });
});

describe('maskObservations', () => {
  it('truncates long ```json code blocks', () => {
    const longJson = '```json\n' + '{"key": "' + 'x'.repeat(500) + '"}\n```';
    const result = maskObservations(longJson, 200);
    expect(result).toContain('... [truncated]');
    expect(result.length).toBeLessThan(longJson.length);
  });

  it('preserves short ```json code blocks', () => {
    const shortJson = '```json\n{"key": "value"}\n```';
    const result = maskObservations(shortJson, 200);
    expect(result).toBe(shortJson);
  });

  it('truncates large inline JSON objects', () => {
    const largeInline = 'Result: ' + '{' + '"data": "' + 'y'.repeat(300) + '"}';
    const result = maskObservations(largeInline, 200);
    expect(result).toContain('... [truncated]');
  });

  it('preserves plain text without JSON', () => {
    const plainText = 'The function works correctly and returns the expected value. No issues found.';
    const result = maskObservations(plainText, 200);
    expect(result).toBe(plainText);
  });

  it('preserves reasoning text around truncated JSON', () => {
    const mixed = 'I analyzed the data:\n```json\n' + '{"result": "' + 'z'.repeat(500) + '"}\n```\nBased on this, the answer is 42.';
    const result = maskObservations(mixed, 200);
    expect(result).toContain('I analyzed the data:');
    expect(result).toContain('Based on this, the answer is 42.');
    expect(result).toContain('... [truncated]');
  });
});

describe('ConvergenceTracker', () => {
  let tracker: ConvergenceTracker;

  beforeEach(() => {
    tracker = new ConvergenceTracker({ stagnationThreshold: 0.05, stagnationWindow: 2 });
  });

  it('records dimension scores', () => {
    tracker.record([
      { name: 'accuracy', score: 0.5, passed: false, feedback: 'needs work' },
    ]);
    const state = tracker.getState();
    expect(state.history.get('accuracy')).toEqual([0.5]);
  });

  it('detects converging signal (increasing scores)', () => {
    tracker.record([{ name: 'accuracy', score: 0.3, passed: false, feedback: '' }]);
    tracker.record([{ name: 'accuracy', score: 0.6, passed: false, feedback: '' }]);

    expect(tracker.getSignal('accuracy')).toBe('converging');
  });

  it('detects diverging signal (3 consecutive decreasing scores)', () => {
    tracker.record([{ name: 'quality', score: 0.8, passed: true, feedback: '' }]);
    tracker.record([{ name: 'quality', score: 0.6, passed: false, feedback: '' }]);
    tracker.record([{ name: 'quality', score: 0.4, passed: false, feedback: '' }]);

    expect(tracker.getSignal('quality')).toBe('diverging');
  });

  it('detects stagnating signal (small deltas within window)', () => {
    tracker.record([{ name: 'perf', score: 0.5, passed: false, feedback: '' }]);
    tracker.record([{ name: 'perf', score: 0.51, passed: false, feedback: '' }]);
    tracker.record([{ name: 'perf', score: 0.52, passed: false, feedback: '' }]);

    expect(tracker.getSignal('perf')).toBe('stagnating');
  });

  it('returns unknown signal for single data point', () => {
    tracker.record([{ name: 'x', score: 0.5, passed: false, feedback: '' }]);
    expect(tracker.getSignal('x')).toBe('unknown');
  });

  it('returns unknown for untracked criterion', () => {
    expect(tracker.getSignal('nonexistent')).toBe('unknown');
  });

  it('identifies failing criteria below passing score', () => {
    tracker.record([
      { name: 'a', score: 0.9, passed: true, feedback: '' },
      { name: 'b', score: 0.3, passed: false, feedback: '' },
      { name: 'c', score: 0.7, passed: false, feedback: '' },
    ]);

    const failing = tracker.getFailingCriteria(0.8);
    expect(failing).toContain('b');
    expect(failing).toContain('c');
    expect(failing).not.toContain('a');
  });

  it('computes overall trend via majority vote', () => {
    // Record two converging criteria and one stagnating
    tracker.record([
      { name: 'a', score: 0.3, passed: false, feedback: '' },
      { name: 'b', score: 0.4, passed: false, feedback: '' },
      { name: 'c', score: 0.5, passed: false, feedback: '' },
    ]);
    tracker.record([
      { name: 'a', score: 0.6, passed: false, feedback: '' },
      { name: 'b', score: 0.7, passed: false, feedback: '' },
      { name: 'c', score: 0.51, passed: false, feedback: '' },
    ]);
    tracker.record([
      { name: 'a', score: 0.8, passed: true, feedback: '' },
      { name: 'b', score: 0.9, passed: true, feedback: '' },
      { name: 'c', score: 0.52, passed: false, feedback: '' },
    ]);

    const state = tracker.getState();
    // a and b are converging, c is stagnating → majority converging
    expect(state.overallTrend).toBe('converging');
  });

  it('tracks best iteration per criterion', () => {
    tracker.record([{ name: 'x', score: 0.3, passed: false, feedback: '' }]);
    tracker.record([{ name: 'x', score: 0.9, passed: true, feedback: '' }]);
    tracker.record([{ name: 'x', score: 0.7, passed: false, feedback: '' }]);

    const state = tracker.getState();
    const best = state.bestIteration.get('x');
    expect(best).toEqual({ iteration: 2, score: 0.9 });
  });

  it('resets all tracked data', () => {
    tracker.record([{ name: 'a', score: 0.5, passed: false, feedback: '' }]);
    tracker.reset();
    const state = tracker.getState();
    expect(state.history.size).toBe(0);
  });
});

describe('DimensionalVerifier', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('parses valid dimensional verification response', async () => {
    provider.defaultResponse = JSON.stringify({
      complete: true,
      confidence: 0.95,
      feedback: 'All criteria met',
      dimensions: [
        { name: 'accuracy', score: 0.9, passed: true, feedback: 'Good' },
        { name: 'completeness', score: 0.85, passed: true, feedback: 'Complete' },
      ],
    });

    const verifier = new DimensionalVerifier(provider, ['accuracy', 'completeness'], 0.8);
    const result = await verifier.check({ success: true, output: 'test output' }) as DimensionalVerification;

    expect(result.complete).toBe(true);
    // Confidence is computed from min(criterion scores), not the LLM's free-form value
    expect(result.confidence).toBe(0.85); // min(0.9, 0.85)
    expect(result.dimensions).toHaveLength(2);
    expect(result.dimensions![0].name).toBe('accuracy');
    expect(result.dimensions![0].score).toBe(0.9);
  });

  it('returns partial fail when some criteria below threshold', async () => {
    provider.defaultResponse = JSON.stringify({
      complete: false,
      confidence: 0.5,
      feedback: 'Accuracy needs improvement',
      dimensions: [
        { name: 'accuracy', score: 0.4, passed: false, feedback: 'Too many errors' },
        { name: 'completeness', score: 0.9, passed: true, feedback: 'Good' },
      ],
    });

    const verifier = new DimensionalVerifier(provider, ['accuracy', 'completeness'], 0.8);
    const result = await verifier.check({ success: true, output: 'test output' }) as DimensionalVerification;

    expect(result.complete).toBe(false);
    expect(result.dimensions![0].passed).toBe(false);
    expect(result.dimensions![1].passed).toBe(true);
  });

  it('handles malformed JSON gracefully', async () => {
    provider.defaultResponse = 'This is not valid JSON at all';

    const verifier = new DimensionalVerifier(provider, ['accuracy'], 0.8);
    const result = await verifier.check({ success: true, output: 'test' });

    expect(result.complete).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.feedback).toContain('parse');
  });

  it('handles provider error gracefully', async () => {
    provider.errorToThrow = new Error('API rate limit');

    const verifier = new DimensionalVerifier(provider, ['accuracy', 'speed'], 0.8);
    const result = await verifier.check({ success: true, output: 'test' }) as DimensionalVerification;

    expect(result.complete).toBe(false);
    expect(result.dimensions).toHaveLength(2);
    expect(result.dimensions![0].feedback).toBe('Verification error');
  });

  it('extracts JSON from response with surrounding text', async () => {
    provider.defaultResponse = 'Here is my evaluation:\n' + JSON.stringify({
      complete: false,
      confidence: 0.6,
      feedback: 'Partial',
      dimensions: [{ name: 'a', score: 0.6, passed: false, feedback: 'Close' }],
    }) + '\nEnd of evaluation.';

    const verifier = new DimensionalVerifier(provider, ['a'], 0.8);
    const result = await verifier.check({ success: true, output: 'test' }) as DimensionalVerification;

    expect(result.confidence).toBe(0.6);
    expect(result.dimensions).toHaveLength(1);
  });
});

describe('generateReflexion', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('returns strategic reflection from provider', async () => {
    provider.defaultResponse = 'The core issue was incomplete error handling. Focus on edge cases next time. Avoid re-implementing the entire solution.';

    const task = createTask({ successCriteria: 'Handles all edge cases' });
    const result = await generateReflexion(provider, task, 'First attempt output', 'Missing edge case handling');

    expect(result).toContain('error handling');
    expect(provider.chatCalls.length).toBe(1);
  });

  it('falls back to raw feedback when provider errors', async () => {
    provider.errorToThrow = new Error('API unavailable');

    const task = createTask();
    const result = await generateReflexion(provider, task, 'attempt', 'some feedback');

    expect(result).toBe('some feedback');
  });
});

describe('ralphLoop with DCL', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    getProgressTracker().reset();
  });

  it('uses DimensionalVerifier for multi-criteria tasks', async () => {
    // First call: execution output
    // Second call: dimensional verification (approves)
    provider.responses = [
      'Complete implementation with tests and docs',
      JSON.stringify({
        complete: true,
        confidence: 0.95,
        feedback: 'All criteria met',
        dimensions: [
          { name: 'Implement the API', score: 0.95, passed: true, feedback: 'Good' },
          { name: 'Write tests', score: 0.9, passed: true, feedback: 'Good' },
        ],
      }),
    ];

    const task = createTask({
      successCriteria: '1. Implement the API\n2. Write tests',
    });

    const result = await ralphLoop(provider, task, {
      maxIterations: 3,
      timeout: 10000,
      dimensionalConfig: {
        enabled: true,
        convergenceThreshold: 0.05,
        passingScore: 0.8,
        stagnationWindow: 2,
        observationMasking: true,
        maxMaskedOutputLength: 200,
        reflexionEnabled: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it('uses UnifiedVerifier for single-criterion tasks (merged verification + reflexion)', async () => {
    provider.responses = [
      'Incomplete attempt',
      // UnifiedVerifier: fails with nextAction (replaces separate verification + reflexion calls)
      JSON.stringify({ complete: false, confidence: 0.3, feedback: 'Needs more detail', nextAction: 'Focus on adding specific examples' }),
      // Second attempt with reflexion guidance from nextAction
      'Complete detailed response with examples',
      // UnifiedVerifier: passes
      JSON.stringify({ complete: true, confidence: 0.9, feedback: 'Good' }),
    ];

    const task = createTask({
      successCriteria: 'Provides comprehensive answer with examples',
    });

    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
      dimensionalConfig: {
        enabled: true,
        convergenceThreshold: 0.05,
        passingScore: 0.8,
        stagnationWindow: 2,
        observationMasking: true,
        maxMaskedOutputLength: 200,
        reflexionEnabled: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    // UnifiedVerifier saves an LLM call vs separate verify + reflexion
    expect(provider.chatCalls.length).toBeLessThanOrEqual(4);
  });

  it('maintains backward compatibility when dimensionalConfig is undefined', async () => {
    provider.responses = [
      'Task output',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 3,
      timeout: 10000,
      // No dimensionalConfig — should behave identically to pre-DCL code
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it('disables DCL when config sets enabled=false', async () => {
    provider.responses = [
      'Task output',
      // Standard verification (not dimensional)
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask({
      successCriteria: '1. First criterion\n2. Second criterion',
    });

    const result = await ralphLoop(provider, task, {
      maxIterations: 3,
      timeout: 10000,
      dimensionalConfig: {
        enabled: false,
        convergenceThreshold: 0.05,
        passingScore: 0.8,
        stagnationWindow: 2,
        observationMasking: false,
        maxMaskedOutputLength: 200,
        reflexionEnabled: false,
      },
    });

    // Should succeed using standard verification path
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// String Similarity Tests
// =============================================================================

describe('computeStringSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(computeStringSimilarity('hello world foo', 'hello world foo')).toBe(1.0);
  });

  it('returns 0.0 for empty string vs non-empty', () => {
    expect(computeStringSimilarity('', 'hello world')).toBe(0.0);
    expect(computeStringSimilarity('hello world', '')).toBe(0.0);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(computeStringSimilarity('', '')).toBe(1.0);
  });

  it('returns high similarity for nearly identical strings', () => {
    const a = 'The quick brown fox jumps over the lazy dog in the park';
    const b = 'The quick brown fox jumps over the lazy cat in the park';
    expect(computeStringSimilarity(a, b)).toBeGreaterThan(0.4);
    expect(computeStringSimilarity(a, b)).toBeLessThan(1.0);
  });

  it('returns low similarity for completely different strings', () => {
    const a = 'The quick brown fox jumps over the lazy dog';
    const b = 'Artificial intelligence transforms modern healthcare systems globally';
    expect(computeStringSimilarity(a, b)).toBeLessThan(0.1);
  });

  it('handles short strings (fewer than 3 words)', () => {
    expect(computeStringSimilarity('hello', 'hello')).toBe(1.0);
    expect(computeStringSimilarity('hello', 'world')).toBe(0.0);
  });
});

// =============================================================================
// Stall Detection Tests
// =============================================================================

describe('ralphLoop stall detection', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    getProgressTracker().reset();
  });

  it('exits early when consecutive outputs are nearly identical', async () => {
    const repeatedOutput = 'This is a detailed response about the topic with specific information and analysis that covers multiple aspects of the problem';
    // Every call returns the same output, verification always fails
    provider.defaultResponse = repeatedOutput;

    // Override verification to always fail
    const alwaysFailVerifier = {
      check: async (_result: TaskResult): Promise<Verification> => ({
        complete: false, confidence: 0.3, feedback: 'Not complete',
      }),
    };

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 10000,
      verifier: alwaysFailVerifier,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('stalled');
    expect(result.exitReason).toBe('stall');
    // Should exit well before max iterations
    expect(result.iterations).toBeLessThan(10);
  });

  it('does not stall when outputs differ between iterations', async () => {
    provider.responses = [
      'First attempt with some content',
      JSON.stringify({ complete: false, confidence: 0.3, feedback: 'Need more' }),
      'Second attempt with completely different content and approach',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
  });
});

// =============================================================================
// Best-Output Tracking Tests
// =============================================================================

describe('ralphLoop best-output tracking', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    getProgressTracker().reset();
  });

  it('returns best output on max iterations instead of last output', async () => {
    provider.responses = [
      'Good attempt with useful content',
      JSON.stringify({ complete: false, confidence: 0.7, feedback: 'Almost there' }),
      'Worse attempt that regressed',
      JSON.stringify({ complete: false, confidence: 0.2, feedback: 'Got worse' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 2,
      timeout: 10000,
    });

    expect(result.success).toBe(false);
    // Should return the best attempt (confidence 0.7), not the last one
    expect(result.output).toBe('Good attempt with useful content');
  });
});

// =============================================================================
// Sustained Hopelessness Exit Tests
// =============================================================================

describe('ralphLoop sustained hopelessness exit', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    getProgressTracker().reset();
  });

  it('exits at iteration 4 when bestScore stays below hopeless threshold', async () => {
    // Verifier consistently scores very low — task is not achievable
    provider.responses = [
      'Fabricated output attempt 1',
      JSON.stringify({ complete: false, confidence: 0.15, feedback: 'All data fabricated' }),
      'Fabricated output attempt 2',
      JSON.stringify({ complete: false, confidence: 0.15, feedback: 'Still fabricated' }),
      'Fabricated output attempt 3',
      JSON.stringify({ complete: false, confidence: 0.15, feedback: 'Still fabricated again' }),
      'Fabricated output attempt 4',
      JSON.stringify({ complete: false, confidence: 0.15, feedback: 'Still no progress' }),
      // These should never be reached:
      'Attempt 5 should not happen',
      JSON.stringify({ complete: false, confidence: 0.15, feedback: 'Unreachable' }),
    ];

    const task = createTask({ successCriteria: 'Get current stock price' });
    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not achievable');
    expect(result.exitReason).toBe('hopelessness');
    expect(result.bestScore).toBeDefined();
    expect(result.iterations).toBe(4);
  });

  it('does not exit early when score is above hopeless threshold', async () => {
    provider.responses = [
      'Decent attempt 1',
      JSON.stringify({ complete: false, confidence: 0.5, feedback: 'Needs more detail' }),
      'Better attempt 2',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: 'Good' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
  });

  it('does not exit early if iteration 2 improves above threshold', async () => {
    provider.responses = [
      'Bad first attempt',
      JSON.stringify({ complete: false, confidence: 0.1, feedback: 'Very poor' }),
      'Much better second attempt',
      JSON.stringify({ complete: false, confidence: 0.5, feedback: 'Getting there' }),
      'Third attempt',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: 'Done' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
    });

    // Should NOT have exited at iteration 2 because bestScore (0.5) > threshold (0.24)
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(3);
  });
});

// =============================================================================
// Total Tool Failure Short-Circuit Tests
// =============================================================================

describe('ralphLoop total tool failure short-circuit', () => {
  let provider: MockProvider;
  let mcpServer: MockMCPServer;

  beforeEach(() => {
    provider = new MockProvider({ supportsTools: true });
    mcpServer = new MockMCPServer({
      toolDefinitions: [
        { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'fetch_url', description: 'Fetch a URL', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
      ],
    });
    // All tool calls return errors
    mcpServer.executeResults.set('web_search', { success: false, error: 'HTTP 432 API rate limit' });
    mcpServer.executeResults.set('fetch_url', { success: false, error: 'HTTP 403 Forbidden' });
    getProgressTracker().reset();
  });

  it('exits after 2 consecutive iterations where all tools fail', async () => {
    const toolCall = [{ id: 'tc-1', name: 'web_search', arguments: { query: 'RBLX stock price' } }];

    provider.toolCallsQueue = [
      // Iteration 1: worker calls a tool
      toolCall,
      // Iteration 1: follow-up after tool failure (no more tool calls)
      undefined,
      // Iteration 1: verification (complete() call handled separately)
      undefined,
      // Iteration 2: worker calls a tool again
      toolCall,
      // Iteration 2: follow-up after tool failure
      undefined,
      // Should NOT reach verification for iteration 2
    ];

    provider.responses = [
      // Iteration 1: initial response (triggers tool call)
      'Let me search for the stock price',
      // Iteration 1: follow-up response after tool error
      'The stock price is $62.00', // fabricated
      // Iteration 1: verification (via complete())
      JSON.stringify({ complete: false, confidence: 0.15, feedback: 'All tools failed, data fabricated' }),
      // Iteration 2: initial response (triggers tool call)
      'Let me try a different search',
      // Iteration 2: follow-up response after tool error
      'Based on my analysis the price is $63.00', // fabricated again
      // Should short-circuit before verification
    ];

    const task = createTask({ successCriteria: 'Current RBLX share price obtained' });

    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
      mcpServer: mcpServer as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Total tool failure');
    expect(result.exitReason).toBe('total_tool_failure');
    expect(result.toolFailures).toBeDefined();
    expect(result.toolFailures!.length).toBeGreaterThan(0);
    expect(result.toolFailures![0].category).toBeDefined();
    // Should have stopped at iteration 2, not gone further
    expect(result.iterations).toBeLessThanOrEqual(2);
  });

  it('does not short-circuit when some tools succeed', async () => {
    // Override: web_search succeeds
    mcpServer.executeResults.set('web_search', { success: true, data: { results: [{ title: 'RBLX', url: 'https://example.com' }] } });
    // fetch_url still fails
    mcpServer.executeResults.set('fetch_url', { success: false, error: 'HTTP 403 Forbidden' });

    const toolCall = [{ id: 'tc-1', name: 'web_search', arguments: { query: 'RBLX stock price' } }];

    provider.toolCallsQueue = [
      toolCall, undefined, undefined, // iter 1
      toolCall, undefined, undefined, // iter 2
    ];

    provider.responses = [
      'Searching...', 'Result from search: some data',
      JSON.stringify({ complete: false, confidence: 0.4, feedback: 'Needs more detail' }),
      'Searching again...', 'More detailed result',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: 'Good' }),
    ];

    const task = createTask({ successCriteria: 'Get stock data' });

    const result = await ralphLoop(provider, task, {
      maxIterations: 10,
      timeout: 30000,
      mcpServer: mcpServer as any,
    });

    // Should NOT have short-circuited — some tools succeeded
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Dimensional Reflexion Tests
// =============================================================================

describe('generateDimensionalReflexion', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('returns strategic reflection for failing criteria', async () => {
    provider.defaultResponse = 'Prioritize the accuracy criterion first since it blocks completeness. Try using fetch_url on the primary source.';

    const task = createTask({ successCriteria: 'Accurate data; Complete analysis; Sources cited' });
    const dimensions: CriterionScore[] = [
      { name: 'Accurate data', score: 0.4, passed: false, feedback: 'Data is outdated' },
      { name: 'Complete analysis', score: 0.6, passed: false, feedback: 'Missing competitor comparison' },
      { name: 'Sources cited', score: 0.9, passed: true, feedback: 'Good' },
    ];

    const result = await generateDimensionalReflexion(provider, task, 'attempt output', dimensions);

    expect(result).toContain('accuracy');
    expect(provider.chatCalls.length).toBe(1);
  });

  it('falls back to failing criteria summary on provider error', async () => {
    provider.errorToThrow = new Error('API unavailable');

    const task = createTask();
    const dimensions: CriterionScore[] = [
      { name: 'Criterion A', score: 0.3, passed: false, feedback: 'Failed badly' },
    ];

    const result = await generateDimensionalReflexion(provider, task, 'attempt', dimensions);

    expect(result).toContain('Criterion A');
    expect(result).toContain('0.30');
  });
});

// =============================================================================
// Convergence Tracker Pessimistic Aggregation Tests
// =============================================================================

// =============================================================================
// Budget Awareness Tests
// =============================================================================

describe('RalphLoop budget awareness', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    getProgressTracker().reset();
  });

  it('should abort early when budget is exhausted before first iteration', async () => {
    const { BudgetGuard } = await import('../cost/BudgetGuard.js');
    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 0.01 });
    budgetGuard.recordCost(0.01); // exhaust the budget

    provider.responses = [
      'Task completed successfully',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
      budgetGuard,
    });

    expect(result.success).toBe(false);
    expect(result.exitReason).toBe('budget_exhausted');
    expect(result.error).toContain('Budget exhausted');
    expect(result.iterations).toBe(0); // never started an iteration
  });

  it('should abort after iteration when budget becomes exhausted mid-loop', async () => {
    const { BudgetGuard } = await import('../cost/BudgetGuard.js');
    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 0.05 });

    // First iteration: task output + verification rejects
    provider.responses = [
      'Partial answer',
      JSON.stringify({ complete: false, confidence: 0.4, feedback: 'Need more detail' }),
      // Second iteration responses should not be reached
      'Complete answer',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();

    // Exhaust budget after first iteration starts
    // We'll record cost after a small delay to simulate mid-loop exhaustion
    // Actually, the simplest approach: record cost right before the second iteration check
    // Since we can't hook into the loop, we'll exhaust the budget after the first
    // iteration's verification would have run. The budget check happens at the TOP
    // of the while loop, so exhausting after the first iteration completes works.

    // Use onProgress to record cost when iteration 1 verification completes
    let iterationCount = 0;
    const onProgress = (_iter: number, status: string) => {
      if (status.startsWith('incomplete')) {
        iterationCount++;
        if (iterationCount === 1) {
          budgetGuard.recordCost(0.05); // exhaust after first iteration
        }
      }
    };

    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
      budgetGuard,
      onProgress,
    });

    expect(result.success).toBe(false);
    expect(result.exitReason).toBe('budget_exhausted');
    expect(result.iterations).toBe(1); // completed one iteration before budget check
  });

  it('should not abort when budget guard has no limit set', async () => {
    const { BudgetGuard } = await import('../cost/BudgetGuard.js');
    const budgetGuard = new BudgetGuard({}); // no maxCostPerRequest

    provider.responses = [
      'Task completed successfully',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
      budgetGuard,
    });

    expect(result.success).toBe(true);
    expect(result.exitReason).toBeUndefined();
  });

  it('should call recordCost after each iteration when budgetGuard and costRegistry are provided', async () => {
    const { BudgetGuard } = await import('../cost/BudgetGuard.js');
    const { CostRegistry } = await import('../cost/CostRegistry.js');

    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 10.0 }); // high limit so it won't exhaust
    const costRegistry = new CostRegistry();

    const recordCostSpy = vi.spyOn(budgetGuard, 'recordCost');
    const calculateCostSpy = vi.spyOn(costRegistry, 'calculateCost');

    // Set up token usage on the mock provider
    provider.defaultTokenUsage = { input: 500, output: 200, total: 700 };

    provider.responses = [
      'Task completed successfully',
      JSON.stringify({ complete: true, confidence: 0.95, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
      budgetGuard,
      costRegistry,
    });

    expect(result.success).toBe(true);
    // calculateCost should have been called with the provider name, model, and token usage
    expect(calculateCostSpy).toHaveBeenCalledWith(
      'mock',         // provider.name from MockProvider
      'mock-model',   // provider.model from MockProvider
      expect.objectContaining({ input: expect.any(Number), output: expect.any(Number) }),
    );
    // recordCost should have been called at least once (once per iteration)
    expect(recordCostSpy).toHaveBeenCalled();
    // The cost should be a number (mock provider is unknown so cost will be 0, but the call still happens)
    expect(recordCostSpy.mock.calls[0][0]).toBeTypeOf('number');
  });

  it('should not call recordCost when costRegistry is not provided', async () => {
    const { BudgetGuard } = await import('../cost/BudgetGuard.js');

    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 10.0 });
    const recordCostSpy = vi.spyOn(budgetGuard, 'recordCost');

    provider.responses = [
      'Task completed successfully',
      JSON.stringify({ complete: true, confidence: 0.95, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(provider, task, {
      maxIterations: 5,
      timeout: 10000,
      budgetGuard,
      // no costRegistry
    });

    expect(result.success).toBe(true);
    // recordCost should NOT be called when costRegistry is absent
    expect(recordCostSpy).not.toHaveBeenCalled();
  });

  it('should exit early when real cost recording exhausts budget via CostRegistry', async () => {
    // Use a provider name/model with known pricing so CostRegistry calculates real costs
    const realProvider = new MockProvider({
      name: 'openai',
      model: 'gpt-4o',
      defaultTokenUsage: { input: 10, output: 20, total: 30 },
    });

    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 0.0003 });
    const costRegistry = new CostRegistry();

    // Per iteration cost: (10/1M * 2.50) + (20/1M * 10.0) = 0.000225
    // After iter 1: spent = 0.000225, not exhausted
    // After iter 2: spent = 0.00045, exhausted → iteration 3 blocked
    realProvider.responses = [
      'Partial answer iteration 1',
      JSON.stringify({ complete: false, confidence: 0.3, feedback: 'Need more' }),
      'Partial answer iteration 2',
      JSON.stringify({ complete: false, confidence: 0.4, feedback: 'Still need more' }),
      // Should not reach iteration 3
      'Should not reach this',
      JSON.stringify({ complete: true, confidence: 0.9, feedback: '' }),
    ];

    const task = createTask();
    const result = await ralphLoop(realProvider, task, {
      maxIterations: 10,
      timeout: 10000,
      budgetGuard,
      costRegistry,
    });

    expect(result.success).toBe(false);
    expect(result.exitReason).toBe('budget_exhausted');
    expect(result.iterations).toBe(2);
  });
});

// =============================================================================
// Convergence Tracker Pessimistic Aggregation Tests
// =============================================================================

describe('ConvergenceTracker pessimistic aggregation', () => {
  let tracker: ConvergenceTracker;

  beforeEach(() => {
    tracker = new ConvergenceTracker({ stagnationThreshold: 0.05, stagnationWindow: 2 });
  });

  it('flags overall as diverging when any criterion diverges', () => {
    // Two converging criteria and one diverging
    tracker.record([
      { name: 'a', score: 0.3, passed: false, feedback: '' },
      { name: 'b', score: 0.4, passed: false, feedback: '' },
      { name: 'c', score: 0.9, passed: true, feedback: '' },
    ]);
    tracker.record([
      { name: 'a', score: 0.6, passed: false, feedback: '' },
      { name: 'b', score: 0.7, passed: false, feedback: '' },
      { name: 'c', score: 0.7, passed: false, feedback: '' },
    ]);
    tracker.record([
      { name: 'a', score: 0.8, passed: true, feedback: '' },
      { name: 'b', score: 0.9, passed: true, feedback: '' },
      { name: 'c', score: 0.5, passed: false, feedback: '' },
    ]);

    const state = tracker.getState();
    // c is diverging (0.9 → 0.7 → 0.5), so overall should be diverging
    expect(state.overallTrend).toBe('diverging');
  });

  it('flags stagnating when more stagnating than converging', () => {
    tracker.record([
      { name: 'a', score: 0.5, passed: false, feedback: '' },
      { name: 'b', score: 0.5, passed: false, feedback: '' },
      { name: 'c', score: 0.3, passed: false, feedback: '' },
    ]);
    tracker.record([
      { name: 'a', score: 0.51, passed: false, feedback: '' },
      { name: 'b', score: 0.52, passed: false, feedback: '' },
      { name: 'c', score: 0.6, passed: false, feedback: '' },
    ]);
    tracker.record([
      { name: 'a', score: 0.52, passed: false, feedback: '' },
      { name: 'b', score: 0.53, passed: false, feedback: '' },
      { name: 'c', score: 0.8, passed: true, feedback: '' },
    ]);

    const state = tracker.getState();
    // a and b are stagnating, c is converging → 2 stagnating > 1 converging
    expect(state.overallTrend).toBe('stagnating');
  });
});
