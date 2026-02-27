/// <reference types="vitest/globals" />

import { TaskPlanner } from './TaskPlanner.js';
import type { Task, TaskStatus, TaskPlan, ReplanContext, EvaluationReplanContext } from '../types.js';

vi.mock('../DebugLogger.js', () => ({
  getDebugLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Test task',
    successCriteria: 'Done',
    dependencies: [],
    priority: 1,
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMockProvider(completeReturn: string = '{}') {
  return {
    complete: vi.fn().mockResolvedValue(completeReturn),
    chat: vi.fn(),
    chatStream: vi.fn(),
    name: 'mock',
    model: 'mock-model',
  } as any;
}

function makeDirectJson(reasoning = 'Simple request') {
  return JSON.stringify({
    type: 'direct',
    reasoning,
  });
}

function makeDecomposedJson(
  tasks: Array<{
    description: string;
    successCriteria?: string;
    dependencies?: string[];
    priority?: number;
    estimatedComplexity?: string;
  }> = [],
  reasoning = 'Complex request',
  discoveryMode = false,
) {
  return JSON.stringify({
    type: 'decomposed',
    reasoning,
    discoveryMode,
    tasks: tasks.map((t, i) => ({
      description: t.description,
      successCriteria: t.successCriteria ?? 'Done',
      dependencies: t.dependencies ?? [],
      priority: t.priority ?? i + 1,
      estimatedComplexity: t.estimatedComplexity,
    })),
  });
}

describe('TaskPlanner', () => {
  // ─── getReadyTasks ───────────────────────────────────────────────

  describe('getReadyTasks', () => {
    let planner: TaskPlanner;

    beforeEach(() => {
      planner = new TaskPlanner(makeMockProvider());
    });

    it('returns pending tasks with no dependencies', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'pending', dependencies: [] }),
        makeTask({ id: 'b', status: 'pending', dependencies: [] }),
      ];
      const ready = planner.getReadyTasks(tasks);
      expect(ready).toHaveLength(2);
      expect(ready.map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('returns pending tasks whose dependencies are all completed', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed', dependencies: [] }),
        makeTask({ id: 'b', status: 'pending', dependencies: ['a'] }),
      ];
      const ready = planner.getReadyTasks(tasks);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('b');
    });

    it('excludes tasks with in_progress status', () => {
      const tasks = [makeTask({ id: 'a', status: 'in_progress', dependencies: [] })];
      expect(planner.getReadyTasks(tasks)).toHaveLength(0);
    });

    it('excludes tasks with failed status', () => {
      const tasks = [makeTask({ id: 'a', status: 'failed', dependencies: [] })];
      expect(planner.getReadyTasks(tasks)).toHaveLength(0);
    });

    it('excludes tasks with cancelled status', () => {
      const tasks = [makeTask({ id: 'a', status: 'cancelled', dependencies: [] })];
      expect(planner.getReadyTasks(tasks)).toHaveLength(0);
    });

    it('excludes pending tasks with uncompleted dependencies', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'pending', dependencies: [] }),
        makeTask({ id: 'b', status: 'pending', dependencies: ['a'] }),
      ];
      const ready = planner.getReadyTasks(tasks);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('a');
    });

    it('handles empty task list', () => {
      expect(planner.getReadyTasks([])).toEqual([]);
    });
  });

  // ─── allTasksComplete ────────────────────────────────────────────

  describe('allTasksComplete', () => {
    let planner: TaskPlanner;

    beforeEach(() => {
      planner = new TaskPlanner(makeMockProvider());
    });

    it('returns true when all tasks are completed', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'completed' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(true);
    });

    it('returns true when mix of completed and cancelled', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'cancelled' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(true);
    });

    it('returns false when any task is pending', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'pending' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(false);
    });

    it('returns false when any task is in_progress', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'in_progress' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(false);
    });

    it('returns false when any task is failed', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'failed' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(false);
    });

    it('returns true for empty list (vacuous truth)', () => {
      expect(planner.allTasksComplete([])).toBe(true);
    });
  });

  // ─── hasFailedTasks ──────────────────────────────────────────────

  describe('hasFailedTasks', () => {
    let planner: TaskPlanner;

    beforeEach(() => {
      planner = new TaskPlanner(makeMockProvider());
    });

    it('returns true when at least one task has failed', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'failed' }),
      ];
      expect(planner.hasFailedTasks(tasks)).toBe(true);
    });

    it('returns false when no tasks have failed', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'completed' }),
        makeTask({ id: 'b', status: 'pending' }),
      ];
      expect(planner.hasFailedTasks(tasks)).toBe(false);
    });

    it('returns false for empty list', () => {
      expect(planner.hasFailedTasks([])).toBe(false);
    });
  });

  // ─── getTask ─────────────────────────────────────────────────────

  describe('getTask', () => {
    let planner: TaskPlanner;

    beforeEach(() => {
      planner = new TaskPlanner(makeMockProvider());
    });

    it('finds task by ID', () => {
      const tasks = [
        makeTask({ id: 'alpha' }),
        makeTask({ id: 'beta' }),
      ];
      const found = planner.getTask(tasks, 'beta');
      expect(found).toBeDefined();
      expect(found!.id).toBe('beta');
    });

    it('returns undefined for non-existent ID', () => {
      const tasks = [makeTask({ id: 'alpha' })];
      expect(planner.getTask(tasks, 'missing')).toBeUndefined();
    });
  });

  // ─── updateTaskStatus ────────────────────────────────────────────

  describe('updateTaskStatus', () => {
    let planner: TaskPlanner;

    beforeEach(() => {
      planner = new TaskPlanner(makeMockProvider());
    });

    it('updates status of matching task', () => {
      const tasks = [makeTask({ id: 'a', status: 'pending' })];
      const updated = planner.updateTaskStatus(tasks, 'a', 'in_progress');
      expect(updated[0].status).toBe('in_progress');
    });

    it('sets completedAt when status is completed', () => {
      const tasks = [makeTask({ id: 'a', status: 'in_progress' })];
      const updated = planner.updateTaskStatus(tasks, 'a', 'completed');
      expect(updated[0].status).toBe('completed');
      expect(updated[0].completedAt).toBeInstanceOf(Date);
    });

    it('does not set completedAt for non-completed statuses', () => {
      const tasks = [makeTask({ id: 'a', status: 'pending' })];
      const updated = planner.updateTaskStatus(tasks, 'a', 'failed');
      expect(updated[0].status).toBe('failed');
      expect(updated[0].completedAt).toBeUndefined();
    });

    it('returns a new array (immutability)', () => {
      const tasks = [makeTask({ id: 'a', status: 'pending' })];
      const updated = planner.updateTaskStatus(tasks, 'a', 'in_progress');
      expect(updated).not.toBe(tasks);
      // Original should be unchanged
      expect(tasks[0].status).toBe('pending');
    });

    it('leaves other tasks unchanged', () => {
      const tasks = [
        makeTask({ id: 'a', status: 'pending' }),
        makeTask({ id: 'b', status: 'completed' }),
      ];
      const updated = planner.updateTaskStatus(tasks, 'a', 'in_progress');
      expect(updated[1].status).toBe('completed');
      expect(updated[1].id).toBe('b');
    });
  });

  // ─── plan ────────────────────────────────────────────────────────

  describe('plan', () => {
    it('parses a direct plan from JSON response', async () => {
      const provider = makeMockProvider(makeDirectJson('Simple enough'));
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Hello world');
      expect(plan.type).toBe('direct');
      expect(plan.reasoning).toBe('Simple enough');
      expect(plan.tasks).toBeUndefined();
    });

    it('parses a decomposed plan with tasks from JSON response', async () => {
      const json = makeDecomposedJson([
        { description: 'Step 1', successCriteria: 'Step 1 done' },
        { description: 'Step 2', successCriteria: 'Step 2 done', dependencies: ['task-1'] },
      ]);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Do complex work');
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks![0].description).toBe('Step 1');
      expect(plan.tasks![1].dependencies).toContain('task-1');
      // Tasks should have proper fields
      expect(plan.tasks![0].status).toBe('pending');
      expect(plan.tasks![0].id).toBeDefined();
      expect(plan.tasks![0].createdAt).toBeInstanceOf(Date);
    });

    it('parses JSON wrapped in a markdown code block', async () => {
      const innerJson = makeDecomposedJson([{ description: 'Wrapped task' }]);
      const response = '```json\n' + innerJson + '\n```';
      const provider = makeMockProvider(response);
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Wrapped request');
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks![0].description).toBe('Wrapped task');
    });

    it('falls back to direct plan on invalid JSON', async () => {
      const provider = makeMockProvider('this is not json at all');
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Something');
      expect(plan.type).toBe('direct');
    });

    it('falls back to direct plan on provider error', async () => {
      const provider = makeMockProvider();
      provider.complete.mockRejectedValue(new Error('LLM unavailable'));
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Something');
      expect(plan.type).toBe('direct');
    });

    it('enforces maxTasksPerPlan limit', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        description: `Task ${i + 1}`,
        successCriteria: `Task ${i + 1} done`,
      }));
      const json = makeDecomposedJson(tasks);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider, { maxTasksPerPlan: 3 });

      const plan = await planner.plan('Big request');
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks!.length).toBeLessThanOrEqual(3);
    });

    it('includes tool context in prompt when provided', async () => {
      const provider = makeMockProvider(makeDirectJson());
      const planner = new TaskPlanner(provider);

      await planner.plan('Request', undefined, {
        toolNames: ['read_file', 'write_file'],
        toolDescriptions: ['Read a file', 'Write a file'],
      });

      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('read_file');
      expect(prompt).toContain('write_file');
    });

    it('includes skill context in prompt when provided', async () => {
      const provider = makeMockProvider(makeDirectJson());
      const planner = new TaskPlanner(provider);

      await planner.plan('Request', undefined, {
        skillContext: 'You are a specialized research assistant with web search capabilities.',
      });

      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('research assistant');
    });

    it('includes conversation context in prompt when provided', async () => {
      const provider = makeMockProvider(makeDirectJson());
      const planner = new TaskPlanner(provider);

      await planner.plan('Follow up question', 'Previously we discussed TypeScript generics.');

      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('TypeScript generics');
    });

    it('parses discoveryMode flag', async () => {
      const json = makeDecomposedJson(
        [{ description: 'Explore files' }],
        'Need to discover structure first',
        true,
      );
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('What files are in this project?');
      expect(plan.discoveryMode).toBe(true);
    });

    it('defaults discoveryMode to falsy when not present', async () => {
      const json = makeDecomposedJson(
        [{ description: 'Simple task' }],
        'Simple decomposition',
        false,
      );
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Search for X and Y');
      expect(plan.discoveryMode).toBeFalsy();
    });

    it('maps estimatedComplexity to task field', async () => {
      const json = makeDecomposedJson([
        { description: 'Easy task', estimatedComplexity: 'low' },
        { description: 'Hard task', estimatedComplexity: 'high' },
      ]);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('Multi-complexity request');
      expect(plan.tasks![0].estimatedComplexity).toBe('low');
      expect(plan.tasks![1].estimatedComplexity).toBe('high');
    });

    it('parses discoveryMode false for direct plans', async () => {
      const provider = makeMockProvider(makeDirectJson('Simple question'));
      const planner = new TaskPlanner(provider);

      const plan = await planner.plan('What is the weather?');
      expect(plan.type).toBe('direct');
      expect(plan.discoveryMode).toBeFalsy();
    });
  });

  // ─── replan ──────────────────────────────────────────────────────

  describe('replan', () => {
    it('sends replanning context to provider and returns plan', async () => {
      const json = makeDecomposedJson([
        { description: 'Retry with different approach' },
      ]);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const ctx: ReplanContext = {
        originalRequest: 'Original task',
        failureReason: 'Worker timed out',
        completedTasks: [],
        failedTasks: [
          {
            taskId: 'task-1',
            description: 'Failed task',
            success: false,
            outputSummary: 'Timed out after 30s',
          },
        ],
        cancelledTaskIds: [],
        replanNumber: 1,
      };

      const plan = await planner.replan(ctx);
      expect(provider.complete).toHaveBeenCalledOnce();
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(1);

      // Prompt should contain context
      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('Original task');
      expect(prompt).toContain('Worker timed out');
    });

    it('includes tool and skill context when provided', async () => {
      const json = makeDecomposedJson([{ description: 'Retry task' }]);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const ctx: ReplanContext = {
        originalRequest: 'Original request',
        failureReason: 'Tool not found',
        completedTasks: [],
        failedTasks: [],
        cancelledTaskIds: [],
        replanNumber: 1,
        toolNames: ['web_search'],
        skillContext: 'Research skill active',
      };

      await planner.replan(ctx);
      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('web_search');
    });

    it('falls back to direct plan on provider error', async () => {
      const provider = makeMockProvider();
      provider.complete.mockRejectedValue(new Error('LLM unavailable'));
      const planner = new TaskPlanner(provider);

      const ctx: ReplanContext = {
        originalRequest: 'Original task',
        failureReason: 'Something failed',
        completedTasks: [],
        failedTasks: [],
        cancelledTaskIds: [],
        replanNumber: 1,
      };

      const plan = await planner.replan(ctx);
      expect(plan.type).toBe('direct');
    });
  });

  // ─── evaluationReplan ────────────────────────────────────────────

  describe('evaluationReplan', () => {
    it('sends evaluation context to provider and returns plan', async () => {
      const json = makeDecomposedJson([
        { description: 'Address missing aspects' },
      ]);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const ctx: EvaluationReplanContext = {
        originalRequest: 'Write a comprehensive report',
        priorResult: 'Here is a short report...',
        evaluation: {
          pass: false,
          score: 0.4,
          feedback: 'Missing depth on topic X',
          missingAspects: ['Topic X analysis', 'Data sources'],
        },
        cycleNumber: 2,
        priorTaskSummaries: [],
      };

      const plan = await planner.evaluationReplan(ctx);
      expect(provider.complete).toHaveBeenCalledOnce();
      expect(plan.type).toBe('decomposed');

      // Prompt should contain evaluation feedback
      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('comprehensive report');
      expect(prompt).toContain('Missing depth on topic X');
    });

    it('includes missing aspects in the prompt', async () => {
      const json = makeDecomposedJson([{ description: 'Fix gaps' }]);
      const provider = makeMockProvider(json);
      const planner = new TaskPlanner(provider);

      const ctx: EvaluationReplanContext = {
        originalRequest: 'Analyze the dataset',
        priorResult: 'Partial analysis',
        evaluation: {
          pass: false,
          score: 0.5,
          feedback: 'Incomplete',
          missingAspects: ['Statistical significance testing', 'Outlier analysis'],
        },
        cycleNumber: 1,
        priorTaskSummaries: [],
      };

      await planner.evaluationReplan(ctx);
      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('Statistical significance testing');
    });

    it('falls back to direct plan on provider error', async () => {
      const provider = makeMockProvider();
      provider.complete.mockRejectedValue(new Error('LLM unavailable'));
      const planner = new TaskPlanner(provider);

      const ctx: EvaluationReplanContext = {
        originalRequest: 'Write a report',
        priorResult: 'Prior output',
        evaluation: {
          pass: false,
          score: 0.3,
          feedback: 'Needs improvement',
          missingAspects: [],
        },
        cycleNumber: 1,
        priorTaskSummaries: [],
      };

      const plan = await planner.evaluationReplan(ctx);
      expect(plan.type).toBe('direct');
    });
  });

  // ─── setCustomPrompt ─────────────────────────────────────────────

  describe('setCustomPrompt', () => {
    it('custom prompt is used in plan() calls', async () => {
      const provider = makeMockProvider(makeDirectJson());
      const planner = new TaskPlanner(provider);
      planner.setCustomPrompt('You are a specialized coding assistant.');

      await planner.plan('Help me code');

      const prompt = provider.complete.mock.calls[0][0] as string;
      expect(prompt).toContain('specialized coding assistant');
    });
  });
});
