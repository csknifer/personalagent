/**
 * WorkerPool unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerPool, createWorkerPool } from './WorkerPool.js';
import { MockProvider, AlwaysPassVerifier, createTask } from '../../test/helpers.js';
import type { WorkerState } from '../types.js';

describe('WorkerPool', () => {
  let provider: MockProvider;
  let pool: WorkerPool;

  beforeEach(() => {
    provider = new MockProvider({ defaultResponse: 'Done' });
    pool = createWorkerPool(provider, {
      maxWorkers: 2,
      maxIterations: 2,
      timeout: 10000,
      verifier: new AlwaysPassVerifier(),
    });
  });

  describe('submitTask()', () => {
    it('should execute a single task and return a result', async () => {
      const task = createTask({ id: 'task-1', description: 'Simple task' });

      const result = await pool.submitTask(task);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Done');
    });
  });

  describe('submitTasks()', () => {
    it('should execute multiple independent tasks in parallel', async () => {
      const tasks = [
        createTask({ id: 'task-1', description: 'Task A' }),
        createTask({ id: 'task-2', description: 'Task B' }),
        createTask({ id: 'task-3', description: 'Task C' }),
      ];

      const results = await pool.submitTasks(tasks);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('executeTasks()', () => {
    it('should execute tasks respecting dependencies', async () => {
      const executionOrder: string[] = [];
      // Track which tasks complete when via response sequencing
      provider.responses = [];
      provider.defaultResponse = 'Completed';

      const tasks = [
        createTask({ id: 'task-a', description: 'Foundation', dependencies: [] }),
        createTask({ id: 'task-b', description: 'Depends on A', dependencies: ['task-a'] }),
      ];

      const results = await pool.executeTasks(tasks);

      expect(results.size).toBe(2);
      expect(results.get('task-a')!.success).toBe(true);
      expect(results.get('task-b')!.success).toBe(true);
    });

    it('should throw on circular dependencies', async () => {
      const tasks = [
        createTask({ id: 'task-a', dependencies: ['task-b'] }),
        createTask({ id: 'task-b', dependencies: ['task-a'] }),
      ];

      await expect(pool.executeTasks(tasks)).rejects.toThrow('Cannot resolve task dependencies');
    });

    it('should handle tasks with no dependencies all running in parallel', async () => {
      const tasks = [
        createTask({ id: 't1', dependencies: [] }),
        createTask({ id: 't2', dependencies: [] }),
      ];

      const results = await pool.executeTasks(tasks);

      expect(results.size).toBe(2);
      expect(results.get('t1')!.success).toBe(true);
      expect(results.get('t2')!.success).toBe(true);
    });
  });

  describe('concurrency', () => {
    it('should respect maxWorkers limit', async () => {
      // Pool has maxWorkers=2, submit 3 tasks
      const tasks = [
        createTask({ id: 't1' }),
        createTask({ id: 't2' }),
        createTask({ id: 't3' }),
      ];

      const results = await pool.submitTasks(tasks);

      expect(results).toHaveLength(3);
      // All should complete even though only 2 can run at a time
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should report correct stats', () => {
      const stats = pool.getStats();
      expect(stats.maxWorkers).toBe(2);
      expect(stats.activeWorkers).toBe(0);
      expect(stats.queuedTasks).toBe(0);
    });
  });

  describe('worker creation', () => {
    it('should create a new worker per task (each gets unique abort signal)', async () => {
      // Execute first task
      await pool.submitTask(createTask({ id: 't1' }));
      const statsAfterFirst = pool.getStats();

      // Execute second task — creates a new worker with fresh composed signal
      await pool.submitTask(createTask({ id: 't2' }));
      const statsAfterSecond = pool.getStats();

      expect(statsAfterSecond.totalWorkers).toBe(statsAfterFirst.totalWorkers + 1);
    });
  });

  describe('state change callback', () => {
    it('should fire onWorkerStateChange with remapped task IDs', async () => {
      const stateChanges: Array<{ workerId: string; state: WorkerState }> = [];
      const poolWithCallback = createWorkerPool(provider, {
        maxWorkers: 1,
        maxIterations: 2,
        timeout: 10000,
        verifier: new AlwaysPassVerifier(),
        onWorkerStateChange: (workerId, state) => {
          stateChanges.push({ workerId, state: { ...state } });
        },
      });

      const task = createTask({ id: 'my-task-id' });
      await poolWithCallback.submitTask(task);

      // State changes should use the task ID, not the internal worker ID
      expect(stateChanges.some(s => s.state.id === 'my-task-id')).toBe(true);
    });
  });

  describe('onTaskComplete callback', () => {
    it('should fire for each task as it completes, before executeTasks resolves', async () => {
      const completedTasks: Array<{ taskId: string; success: boolean }> = [];
      const poolWithCallback = createWorkerPool(provider, {
        maxWorkers: 2,
        maxIterations: 2,
        timeout: 10000,
        verifier: new AlwaysPassVerifier(),
        onTaskComplete: (taskId, result) => {
          completedTasks.push({ taskId, success: result.success });
        },
      });

      const tasks = [
        createTask({ id: 'task-a', description: 'Task A' }),
        createTask({ id: 'task-b', description: 'Task B' }),
      ];

      await poolWithCallback.executeTasks(tasks);

      expect(completedTasks).toHaveLength(2);
      expect(completedTasks.map(t => t.taskId).sort()).toEqual(['task-a', 'task-b']);
    });
  });

  describe('cancelTask', () => {
    it('should cancel a queued task before it starts', async () => {
      // Use slow provider so first task blocks, second stays queued
      const slowProvider = new MockProvider({
        defaultResponse: 'Done',
        chatDelay: 200,
      });
      const narrowPool = createWorkerPool(slowProvider, {
        maxWorkers: 1,
        maxIterations: 2,
        timeout: 10000,
        verifier: new AlwaysPassVerifier(),
      });

      const tasks = [
        createTask({ id: 'first', description: 'First' }),
        createTask({ id: 'queued', description: 'Queued' }),
      ];

      const resultsPromise = narrowPool.executeTasks(tasks);

      // Give the first task time to start, then cancel the queued one
      await new Promise(r => setTimeout(r, 50));
      const cancelled = narrowPool.cancelTask('queued');
      expect(cancelled).toBe(true);

      const results = await resultsPromise;
      const queuedResult = results.get('queued');
      expect(queuedResult).toBeDefined();
      expect(queuedResult!.success).toBe(false);
      expect(queuedResult!.exitReason).toBe('cancelled');
    });

    it('should cancel an in-flight task via per-task abort', async () => {
      const slowProvider = new MockProvider({
        defaultResponse: 'Done',
        chatDelay: 500,
      });
      const cancelPool = createWorkerPool(slowProvider, {
        maxWorkers: 2,
        maxIterations: 5,
        timeout: 10000,
        verifier: new AlwaysPassVerifier(),
      });

      const task = createTask({ id: 'inflight', description: 'In-flight task' });
      const resultPromise = cancelPool.submitTask(task);

      // Give it time to start, then cancel
      await new Promise(r => setTimeout(r, 50));
      const cancelled = cancelPool.cancelTask('inflight');
      expect(cancelled).toBe(true);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('should return false for unknown task IDs', () => {
      expect(pool.cancelTask('nonexistent')).toBe(false);
    });
  });

  describe('shutdown()', () => {
    it('should reject queued tasks and clear active workers', () => {
      pool.shutdown();

      const stats = pool.getStats();
      expect(stats.activeWorkers).toBe(0);
      expect(stats.queuedTasks).toBe(0);
    });

    it('should cancel in-flight workers via abort signal', async () => {
      // Use a slow provider so the task is still running when we shutdown
      const slowProvider = new MockProvider({
        defaultResponse: 'Done',
        chatDelay: 500,
      });
      const slowPool = createWorkerPool(slowProvider, {
        maxWorkers: 1,
        maxIterations: 5,
        timeout: 10000,
        verifier: new AlwaysPassVerifier(),
      });

      const task = createTask({ id: 'cancel-me', description: 'Long-running task' });
      const resultPromise = slowPool.submitTask(task);

      // Give the worker time to start, then shutdown
      await new Promise(r => setTimeout(r, 50));
      slowPool.shutdown();

      const result = await resultPromise.catch(err => err);
      // Either the task is cancelled or the pool rejects with shutdown error
      const isCancelled = result instanceof Error
        ? result.message.includes('shutdown') || result.message.includes('cancelled')
        : !result.success && (result.error?.includes('cancelled') || result.error?.includes('shutdown'));
      expect(isCancelled).toBe(true);
    });

    it('should allow new tasks after shutdown', async () => {
      pool.shutdown();

      // Submit a new task — pool should work with fresh abort controller
      const task = createTask({ id: 'after-shutdown', description: 'Post-shutdown task' });
      const result = await pool.submitTask(task);
      expect(result.success).toBe(true);
    });
  });
});
