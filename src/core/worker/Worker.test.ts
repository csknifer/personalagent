/**
 * Worker unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Worker, createWorker } from './Worker.js';
import { MockProvider, AlwaysPassVerifier, AlwaysFailVerifier, createTask } from '../../test/helpers.js';
import type { WorkerState } from '../types.js';

describe('Worker', () => {
  let provider: MockProvider;
  let worker: Worker;

  beforeEach(() => {
    provider = new MockProvider({ defaultResponse: 'Task completed successfully' });
    worker = createWorker('worker-1', provider, {
      maxIterations: 3,
      timeout: 10000,
      verifier: new AlwaysPassVerifier(),
    });
  });

  describe('execute()', () => {
    it('should execute a task successfully with AlwaysPassVerifier', async () => {
      const task = createTask({ description: 'Write a greeting' });

      const result = await worker.execute(task);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Task completed successfully');
      expect(result.iterations).toBe(1);
    });

    it('should return failure when provider always throws', async () => {
      // Create a worker WITHOUT AlwaysPassVerifier — let it use default LLMVerifier.
      // Both chat() calls (execution + verification) will throw, causing
      // the iteration to fail. After max iterations, ralphLoop returns failure.
      const errorProvider = new MockProvider();
      errorProvider.errorToThrow = new Error('API rate limit exceeded');
      const errorWorker = createWorker('err-worker', errorProvider, {
        maxIterations: 1,
        timeout: 5000,
      });
      const task = createTask();

      const result = await errorWorker.execute(task);

      // ralphLoop catches the provider error, returns success: false from
      // executeIterationWithTools. LLMVerifier also fails (same provider),
      // so verification returns incomplete. After 1 iteration → failure.
      expect(result.success).toBe(false);
    });

    it('should iterate when verifier returns incomplete', async () => {
      // Use a verifier that fails first, then passes
      let callCount = 0;
      const conditionalVerifier = {
        async check() {
          callCount++;
          if (callCount >= 2) {
            return { complete: true, confidence: 1.0 };
          }
          return { complete: false, confidence: 0.3, feedback: 'Needs more detail' };
        },
      };

      worker.setVerifier(conditionalVerifier);
      provider.responses = ['First attempt', 'Second attempt'];

      const task = createTask();
      const result = await worker.execute(task);

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(2);
    });

    it('should fail after max iterations with AlwaysFailVerifier', async () => {
      worker.setVerifier(new AlwaysFailVerifier());
      const task = createTask();

      const result = await worker.execute(task);

      expect(result.success).toBe(false);
      // May exit via stall detection (identical outputs) or max iterations
      expect(result.error).toBeDefined();
    });
  });

  describe('state management', () => {
    it('should start in idle state', () => {
      const state = worker.getState();
      expect(state.status).toBe('idle');
      expect(state.id).toBe('worker-1');
      expect(state.iteration).toBe(0);
    });

    it('should transition to completed after successful execution', async () => {
      const task = createTask();
      await worker.execute(task);

      const state = worker.getState();
      expect(state.status).toBe('completed');
    });

    it('should transition to failed after max iterations exhausted', async () => {
      // Use AlwaysFailVerifier to force failure after all iterations
      worker.setVerifier(new AlwaysFailVerifier());
      const task = createTask();
      await worker.execute(task);

      const state = worker.getState();
      expect(state.status).toBe('failed');
    });

    it('should fire onStateChange callback', async () => {
      const stateChanges: WorkerState[] = [];
      const tracked = createWorker('worker-2', provider, {
        maxIterations: 3,
        timeout: 10000,
        verifier: new AlwaysPassVerifier(),
        onStateChange: (state) => stateChanges.push({ ...state }),
      });

      const task = createTask();
      await tracked.execute(task);

      // Should have at least: working, then completed
      expect(stateChanges.length).toBeGreaterThanOrEqual(2);
      expect(stateChanges[0].status).toBe('working');
      expect(stateChanges[stateChanges.length - 1].status).toBe('completed');
    });

    it('should reset to idle', async () => {
      const task = createTask();
      await worker.execute(task);
      expect(worker.getState().status).toBe('completed');

      worker.reset();
      const state = worker.getState();
      expect(state.status).toBe('idle');
      expect(state.iteration).toBe(0);
      expect(state.currentTask).toBeUndefined();
    });
  });

  describe('getStats()', () => {
    it('should return stats with elapsed time after execution', async () => {
      const task = createTask();
      await worker.execute(task);

      const stats = worker.getStats();
      expect(stats.id).toBe('worker-1');
      expect(stats.status).toBe('completed');
    });
  });
});
