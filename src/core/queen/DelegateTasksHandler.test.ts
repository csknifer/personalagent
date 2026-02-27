import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegateTasksHandler } from './DelegateTasksHandler.js';
import type { Task, TaskResult, AgentEvent } from '../types.js';
import type { WorkerPool } from '../worker/WorkerPool.js';

function createMockWorkerPool(results: Map<string, TaskResult>) {
  return {
    executeTasks: vi.fn(async (tasks: Task[]) => {
      // Map results by the task IDs that were actually passed in
      const mapped = new Map<string, TaskResult>();
      for (const task of tasks) {
        const result = results.get(task.id);
        if (result) mapped.set(task.id, result);
      }
      return mapped;
    }),
    setOnTaskComplete: vi.fn(),
    cancelTask: vi.fn(),
    submitTask: vi.fn(),
  } as unknown as WorkerPool;
}

function makeResult(output: string, findings: string[] = []): TaskResult {
  return { success: true, output, findings, iterations: 2 };
}

function makeFailedResult(error: string): TaskResult {
  return { success: false, output: '', error, iterations: 1 };
}

describe('DelegateTasksHandler', () => {
  let events: AgentEvent[];

  beforeEach(() => {
    events = [];
  });

  describe('execute', () => {
    it('dispatches tasks to worker pool and returns structured results', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Found social media profiles', ['LinkedIn: Senior Engineer at Acme']));
      results.set('task-1', makeResult('Found public records', ['Property in Tampa, FL']));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      const result = await handler.execute({
        tasks: [
          { description: 'Search social media', successCriteria: 'Find profiles' },
          { description: 'Search public records', successCriteria: 'Find records' },
        ],
      });

      expect(pool.executeTasks).toHaveBeenCalledTimes(1);
      expect(result).toContain('Search social media');
      expect(result).toContain('completed');
      expect(result).toContain('LinkedIn: Senior Engineer at Acme');
      expect(result).toContain('Search public records');
      expect(result).toContain('Property in Tampa, FL');
    });

    it('reports failed tasks in results', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Found info', ['Some finding']));
      results.set('task-1', makeFailedResult('Search API rate limited'));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      const result = await handler.execute({
        tasks: [
          { description: 'Task A', successCriteria: 'Do A' },
          { description: 'Task B', successCriteria: 'Do B' },
        ],
      });

      expect(result).toContain('1 succeeded');
      expect(result).toContain('1 failed');
      expect(result).toContain('rate limited');
    });

    it('rejects empty task list', async () => {
      const pool = createMockWorkerPool(new Map());
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      const result = await handler.execute({ tasks: [] });

      expect(result).toContain('Error');
      expect(pool.executeTasks).not.toHaveBeenCalled();
    });

    it('emits worker_spawned and worker_completed events', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Done', []));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      await handler.execute({
        tasks: [{ description: 'Do something', successCriteria: 'Done' }],
      });

      expect(events.some(e => e.type === 'worker_spawned')).toBe(true);
      expect(events.some(e => e.type === 'worker_completed')).toBe(true);
    });

    it('injects skill context into tasks when provided', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Done', []));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      await handler.execute(
        {
          tasks: [{ description: 'Do research', successCriteria: 'Find info' }],
        },
        { skillContext: { name: 'research', instructions: 'Use academic sources' } },
      );

      const calledTasks = (pool.executeTasks as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task[];
      expect(calledTasks[0].skillContext).toBeDefined();
      expect(calledTasks[0].skillContext!.name).toBe('research');
    });
  });

  describe('formatResults', () => {
    it('formats all-success results', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Output A', ['Finding 1']));
      results.set('task-1', makeResult('Output B', ['Finding 2', 'Finding 3']));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      const result = await handler.execute({
        tasks: [
          { description: 'Task A', successCriteria: 'Do A' },
          { description: 'Task B', successCriteria: 'Do B' },
        ],
      });

      expect(result).toContain('2 succeeded');
      expect(result).toContain('0 failed');
      expect(result).not.toContain('Status: failed');
    });

    it('includes truncated output when no findings present', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Some long output content', []));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      const result = await handler.execute({
        tasks: [{ description: 'Task A', successCriteria: 'Do A' }],
      });

      expect(result).toContain('Output:');
      expect(result).toContain('Some long output content');
    });
  });

  describe('background execution', () => {
    it('returns immediately with delegation ID when background is true', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Done', ['Finding']));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      const result = await handler.execute({
        tasks: [{ description: 'Background work', successCriteria: 'Done' }],
        background: true,
      });

      // Should return immediately with delegation ID
      expect(result).toContain('Delegated');
      expect(result).toContain('background');
      expect(result).toMatch(/d-[a-z0-9]+/); // delegation ID pattern
    });

    it('stores results that can be retrieved later', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Done', ['Finding']));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      await handler.execute({
        tasks: [{ description: 'Background work', successCriteria: 'Done' }],
        background: true,
      });

      // Wait for background execution to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const pending = handler.collectCompletedResults();
      expect(pending.length).toBe(1);
      expect(pending[0]).toContain('Background work');
      expect(pending[0]).toContain('Finding');
    });

    it('returns empty array when no background results pending', () => {
      const pool = createMockWorkerPool(new Map());
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      expect(handler.collectCompletedResults()).toEqual([]);
    });

    it('tracks pending delegation count', async () => {
      // Use a slow mock pool that takes time to complete
      const pool = {
        executeTasks: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return new Map<string, TaskResult>();
        }),
      } as unknown as WorkerPool;

      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      expect(handler.hasPendingDelegations).toBe(false);

      await handler.execute({
        tasks: [{ description: 'Slow task', successCriteria: 'Done' }],
        background: true,
      });

      expect(handler.hasPendingDelegations).toBe(true);

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(handler.hasPendingDelegations).toBe(false);
    });
  });
});
