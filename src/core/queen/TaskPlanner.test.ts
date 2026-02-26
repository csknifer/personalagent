import { describe, it, expect, beforeEach } from 'vitest';
import { TaskPlanner } from './TaskPlanner.js';
import { MockProvider } from '../../test/helpers.js';
import type { Task, TaskStatus, ReplanContext } from '../types.js';
import { FailureCategory, RecoveryAction } from '../failures.js';
import type { ClassifiedFailure } from '../failures.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    description: overrides.description ?? 'Test task',
    successCriteria: overrides.successCriteria ?? 'Done',
    dependencies: overrides.dependencies ?? [],
    priority: overrides.priority ?? 1,
    status: overrides.status ?? 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('TaskPlanner', () => {
  let provider: MockProvider;
  let planner: TaskPlanner;

  beforeEach(() => {
    provider = new MockProvider();
    planner = new TaskPlanner(provider);
  });

  describe('getReadyTasks', () => {
    it('returns pending tasks with no dependencies', () => {
      const tasks = [
        createTask({ id: 'a', status: 'pending', dependencies: [] }),
        createTask({ id: 'b', status: 'pending', dependencies: [] }),
      ];
      expect(planner.getReadyTasks(tasks)).toHaveLength(2);
    });

    it('excludes tasks with unmet dependencies', () => {
      const tasks = [
        createTask({ id: 'a', status: 'pending', dependencies: ['b'] }),
        createTask({ id: 'b', status: 'pending', dependencies: [] }),
      ];
      const ready = planner.getReadyTasks(tasks);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('b');
    });

    it('includes tasks whose dependencies are completed', () => {
      const tasks = [
        createTask({ id: 'a', status: 'pending', dependencies: ['b'] }),
        createTask({ id: 'b', status: 'completed', dependencies: [] }),
      ];
      const ready = planner.getReadyTasks(tasks);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('a');
    });

    it('excludes non-pending tasks', () => {
      const tasks = [
        createTask({ id: 'a', status: 'in_progress', dependencies: [] }),
        createTask({ id: 'b', status: 'completed', dependencies: [] }),
        createTask({ id: 'c', status: 'pending', dependencies: [] }),
      ];
      const ready = planner.getReadyTasks(tasks);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('c');
    });
  });

  describe('allTasksComplete', () => {
    it('returns true when all tasks are completed', () => {
      const tasks = [
        createTask({ status: 'completed' }),
        createTask({ status: 'completed' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(true);
    });

    it('returns true when tasks are completed or cancelled', () => {
      const tasks = [
        createTask({ status: 'completed' }),
        createTask({ status: 'cancelled' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(true);
    });

    it('returns false when any task is pending', () => {
      const tasks = [
        createTask({ status: 'completed' }),
        createTask({ status: 'pending' }),
      ];
      expect(planner.allTasksComplete(tasks)).toBe(false);
    });

    it('returns true for empty array', () => {
      expect(planner.allTasksComplete([])).toBe(true);
    });
  });

  describe('hasFailedTasks', () => {
    it('returns true when any task failed', () => {
      const tasks = [
        createTask({ status: 'completed' }),
        createTask({ status: 'failed' }),
      ];
      expect(planner.hasFailedTasks(tasks)).toBe(true);
    });

    it('returns false when no tasks failed', () => {
      const tasks = [
        createTask({ status: 'completed' }),
        createTask({ status: 'pending' }),
      ];
      expect(planner.hasFailedTasks(tasks)).toBe(false);
    });
  });

  describe('getTask', () => {
    it('finds task by ID', () => {
      const tasks = [
        createTask({ id: 'a' }),
        createTask({ id: 'b' }),
      ];
      expect(planner.getTask(tasks, 'b')?.id).toBe('b');
    });

    it('returns undefined for missing ID', () => {
      const tasks = [createTask({ id: 'a' })];
      expect(planner.getTask(tasks, 'missing')).toBeUndefined();
    });
  });

  describe('updateTaskStatus', () => {
    it('updates status of specified task', () => {
      const tasks = [
        createTask({ id: 'a', status: 'pending' }),
        createTask({ id: 'b', status: 'pending' }),
      ];
      const updated = planner.updateTaskStatus(tasks, 'a', 'completed');
      expect(updated[0].status).toBe('completed');
      expect(updated[0].completedAt).toBeDefined();
      expect(updated[1].status).toBe('pending');
    });

    it('does not mutate original array', () => {
      const tasks = [createTask({ id: 'a', status: 'pending' })];
      const updated = planner.updateTaskStatus(tasks, 'a', 'completed');
      expect(tasks[0].status).toBe('pending');
      expect(updated[0].status).toBe('completed');
    });
  });

  describe('plan()', () => {
    it('returns direct plan for simple response', async () => {
      provider.defaultResponse = JSON.stringify({
        type: 'direct',
        reasoning: 'Simple greeting',
      });
      const plan = await planner.plan('hello');
      expect(plan.type).toBe('direct');
    });

    it('returns decomposed plan with tasks', async () => {
      provider.defaultResponse = '```json\n' + JSON.stringify({
        type: 'decomposed',
        reasoning: 'Complex task',
        tasks: [
          {
            id: 'task-1',
            description: 'Search the web',
            successCriteria: 'Found info',
            dependencies: [],
            priority: 1,
          },
          {
            id: 'task-2',
            description: 'Synthesize results',
            successCriteria: 'Summary ready',
            dependencies: ['task-1'],
            priority: 2,
          },
        ],
      }) + '\n```';

      const plan = await planner.plan('research quantum computing');
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks![0].status).toBe('pending');
      expect(plan.tasks![1].dependencies).toContain('task-1');
    });

    it('defaults to direct on parse error', async () => {
      provider.defaultResponse = 'not valid json at all';
      const plan = await planner.plan('anything');
      expect(plan.type).toBe('direct');
    });

    it('defaults to direct on provider error', async () => {
      provider.errorToThrow = new Error('API error');
      const plan = await planner.plan('anything');
      expect(plan.type).toBe('direct');
      expect(plan.reasoning).toContain('failed');
    });

    it('limits tasks to maxTasksPerPlan', async () => {
      const planner2 = new TaskPlanner(provider, { maxTasksPerPlan: 2 });
      provider.defaultResponse = JSON.stringify({
        type: 'decomposed',
        reasoning: 'Many tasks',
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: `task-${i}`,
          description: `Task ${i}`,
          successCriteria: 'Done',
          dependencies: [],
          priority: i + 1,
        })),
      });

      const plan = await planner2.plan('complex');
      expect(plan.tasks).toHaveLength(2);
    });

    it('uses custom prompt when set', async () => {
      planner.setCustomPrompt('Custom: ');
      provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });
      await planner.plan('test');
      const lastCall = provider.chatCalls[0];
      expect(lastCall.messages[0].content).toContain('Custom: ');
      expect(lastCall.messages[0].content).toContain('test');
    });

    it('includes tool context in prompt when provided', async () => {
      provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'simple' });
      await planner.plan('search for something', undefined, {
        toolNames: ['web_search', 'fetch_url'],
        toolDescriptions: ['Search the web', 'Fetch a URL'],
      });
      const prompt = provider.chatCalls[0].messages[0].content;
      expect(prompt).toContain('web_search');
      expect(prompt).toContain('fetch_url');
      expect(prompt).toContain('Available Worker Tools');
    });

    it('includes skill context in prompt when provided', async () => {
      provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'simple' });
      await planner.plan('research something', undefined, {
        skillContext: 'Skill: research\nUse web search for all queries',
      });
      const prompt = provider.chatCalls[0].messages[0].content;
      expect(prompt).toContain('Active Skill');
      expect(prompt).toContain('research');
    });

    it('defaults to direct for unknown plan type', async () => {
      provider.defaultResponse = JSON.stringify({
        type: 'something_invalid',
        reasoning: 'Bad type',
      });
      const plan = await planner.plan('anything');
      expect(plan.type).toBe('direct');
      expect(plan.reasoning).toContain('Unknown plan type');
    });

    it('handles decomposed plan with missing task fields gracefully', async () => {
      provider.defaultResponse = JSON.stringify({
        type: 'decomposed',
        reasoning: 'Test',
        tasks: [
          { description: 'Valid task', successCriteria: 'Done' },
          { id: 'task-2' },
        ],
      });
      const plan = await planner.plan('test');
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(2);
      // Missing id gets default
      expect(plan.tasks![0].id).toBe('task-1');
      // Missing description gets empty string
      expect(plan.tasks![1].description).toBe('');
      // Missing successCriteria gets default
      expect(plan.tasks![1].successCriteria).toBe('Task completed');
    });

    it('works without options (backward compatible)', async () => {
      provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'simple' });
      const plan = await planner.plan('hello');
      expect(plan.type).toBe('direct');
    });
  });

  describe('replan()', () => {
    function makeReplanContext(overrides: Partial<ReplanContext> = {}): ReplanContext {
      return {
        originalRequest: 'Get RBLX stock price and analyst opinions',
        failureReason: 'All tools failed — infrastructure failure',
        completedTasks: [],
        failedTasks: [{
          taskId: 'task-1',
          description: 'Get current RBLX stock price',
          success: false,
          outputSummary: 'Unable to complete: all tools failed',
          exitReason: 'total_tool_failure',
          bestScore: 0.1,
          failedTools: ['web_search', 'fetch_url'],
        }],
        cancelledTaskIds: ['task-2'],
        replanNumber: 1,
        ...overrides,
      };
    }

    it('sends prompt with completed and failed task sections', async () => {
      provider.defaultResponse = JSON.stringify({
        type: 'decomposed',
        reasoning: 'Revised approach',
        tasks: [{
          id: 'task-r1',
          description: 'Use file-based approach',
          successCriteria: 'Data retrieved',
          dependencies: [],
          priority: 1,
        }],
      });

      const ctx = makeReplanContext({
        completedTasks: [{
          taskId: 'task-0',
          description: 'Get company profile',
          success: true,
          outputSummary: 'RBLX is a gaming company...',
        }],
      });

      const plan = await planner.replan(ctx);
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(1);

      // Verify the prompt contained replanning context
      const prompt = provider.chatCalls[0].messages[0].content;
      expect(prompt).toContain('REPLANNING CONTEXT');
      expect(prompt).toContain('Already Completed Tasks');
      expect(prompt).toContain('Get company profile');
      expect(prompt).toContain('Failed Tasks');
      expect(prompt).toContain('total_tool_failure');
      expect(prompt).toContain('DO NOT redo');
    });

    it('returns direct plan on provider error', async () => {
      provider.errorToThrow = new Error('API error');
      const plan = await planner.replan(makeReplanContext());
      expect(plan.type).toBe('direct');
      expect(plan.reasoning).toContain('failed');
    });

    it('reuses parseTaskPlan — decomposed plans accepted', async () => {
      provider.defaultResponse = '```json\n' + JSON.stringify({
        type: 'decomposed',
        reasoning: 'Alternative strategy',
        tasks: [
          { id: 'r1-1', description: 'Try alternative data source', successCriteria: 'Price found', dependencies: [], priority: 1 },
          { id: 'r1-2', description: 'Summarize findings', successCriteria: 'Summary done', dependencies: ['r1-1'], priority: 2 },
        ],
      }) + '\n```';

      const plan = await planner.replan(makeReplanContext());
      expect(plan.type).toBe('decomposed');
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks![1].dependencies).toContain('r1-1');
    });

    it('includes tool and skill context when provided', async () => {
      provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'Give up' });

      const plan = await planner.replan(makeReplanContext({
        toolNames: ['read_file', 'list_directory'],
        toolDescriptions: ['Read a file', 'List directory contents'],
        skillContext: 'Research skill active',
      }));

      const prompt = provider.chatCalls[0].messages[0].content;
      expect(prompt).toContain('read_file');
      expect(prompt).toContain('Research skill active');
    });

    describe('partial progress preservation', () => {
      it('should include partial output for tasks with decent progress (bestScore > 0.3)', async () => {
        provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });

        await planner.replan(makeReplanContext({
          failedTasks: [{
            taskId: 'task-1',
            description: 'Research AAPL stock',
            success: false,
            outputSummary: 'Found current price $182.50 and P/E ratio of 28.3',
            exitReason: 'stall',
            bestScore: 0.65,
          }],
        }));

        const prompt = provider.chatCalls[0].messages[0].content;
        expect(prompt).toContain('$182.50');
        expect(prompt).toContain('build on');
        expect(prompt).toContain('do NOT restart from scratch');
        expect(prompt).toContain('65% complete');
      });

      it('should not include partial output for low-score tasks (bestScore <= 0.3)', async () => {
        provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });

        await planner.replan(makeReplanContext({
          failedTasks: [{
            taskId: 'task-2',
            description: 'Research GOOGL stock',
            success: false,
            outputSummary: 'Could not find anything',
            exitReason: 'hopelessness',
            bestScore: 0.1,
          }],
        }));

        const prompt = provider.chatCalls[0].messages[0].content;
        expect(prompt).not.toContain('build on');
        expect(prompt).toContain('hopelessness');
        expect(prompt).toContain('10%');
      });

      it('should include failure classification details when available', async () => {
        provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });

        const failure: ClassifiedFailure = {
          category: FailureCategory.Strategy,
          subcategory: 'stall_no_progress',
          isTransient: false,
          suggestedRecovery: RecoveryAction.Replan,
          confidence: 0.9,
          context: 'Worker stalled after 3 iterations',
        };

        await planner.replan(makeReplanContext({
          failedTasks: [{
            taskId: 'task-3',
            description: 'Analyze market trends',
            success: false,
            outputSummary: 'Identified 3 key trends in semiconductor sector',
            exitReason: 'stall',
            bestScore: 0.5,
            failure,
          }],
        }));

        const prompt = provider.chatCalls[0].messages[0].content;
        expect(prompt).toContain('stall_no_progress (Strategy)');
        expect(prompt).toContain('Recovery suggestion: Replan');
        expect(prompt).toContain('50% complete');
        expect(prompt).toContain('semiconductor sector');
        expect(prompt).toContain('build on');
      });

      it('should truncate partial output to 1500 chars', async () => {
        provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });

        const longOutput = 'A'.repeat(2000);

        await planner.replan(makeReplanContext({
          failedTasks: [{
            taskId: 'task-4',
            description: 'Long output task',
            success: false,
            outputSummary: longOutput,
            exitReason: 'stall',
            bestScore: 0.6,
          }],
        }));

        const prompt = provider.chatCalls[0].messages[0].content;
        expect(prompt).toContain('build on');
        expect(prompt).toContain('[truncated]');
        // Should not contain the full 2000 chars
        expect(prompt).not.toContain('A'.repeat(2000));
      });

      it('should use standard format when bestScore > 0.3 but no output', async () => {
        provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });

        await planner.replan(makeReplanContext({
          failedTasks: [{
            taskId: 'task-5',
            description: 'Empty output task',
            success: false,
            outputSummary: '',
            exitReason: 'timeout',
            bestScore: 0.5,
          }],
        }));

        const prompt = provider.chatCalls[0].messages[0].content;
        // No output means standard format, even with decent score
        expect(prompt).not.toContain('build on');
        expect(prompt).toContain('timeout');
      });

      it('should use standard format at exactly bestScore 0.3', async () => {
        provider.defaultResponse = JSON.stringify({ type: 'direct', reasoning: 'ok' });

        await planner.replan(makeReplanContext({
          failedTasks: [{
            taskId: 'task-6',
            description: 'Boundary score task',
            success: false,
            outputSummary: 'Some partial work',
            exitReason: 'stall',
            bestScore: 0.3,
          }],
        }));

        const prompt = provider.chatCalls[0].messages[0].content;
        // Exactly 0.3 should NOT trigger enriched format (> 0.3, not >=)
        expect(prompt).not.toContain('build on');
      });
    });
  });
});
