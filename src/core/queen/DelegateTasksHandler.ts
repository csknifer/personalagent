/**
 * DelegateTasksHandler — executes the delegate_tasks internal tool.
 *
 * Spawns parallel workers via WorkerPool, optionally delegates to
 * DiscoveryCoordinator for multi-wave investigative tasks. Returns
 * structured result summaries to the Queen's tool-call loop.
 */

import type { WorkerPool } from '../worker/WorkerPool.js';
import type { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { Task, TaskResult, TaskPlan, AgentEventHandler, SkillContext } from '../types.js';

export interface DelegateTasksInput {
  tasks: Array<{ description: string; successCriteria: string }>;
  discoveryMode?: boolean;
  background?: boolean;
}

export interface DelegateTasksContext {
  skillContext?: SkillContext;
  toolEffectivenessHints?: (description: string) => string | undefined;
  strategyHints?: (description: string) => string | undefined;
}

export interface DelegateTasksHandlerOptions {
  workerPool: WorkerPool;
  discoveryCoordinator?: DiscoveryCoordinator;
  eventHandler: AgentEventHandler;
}

export class DelegateTasksHandler {
  private workerPool: WorkerPool;
  private discoveryCoordinator?: DiscoveryCoordinator;
  private eventHandler: AgentEventHandler;
  private completedBackgroundResults: string[] = [];
  private pendingCount = 0;

  constructor(options: DelegateTasksHandlerOptions) {
    this.workerPool = options.workerPool;
    this.discoveryCoordinator = options.discoveryCoordinator;
    this.eventHandler = options.eventHandler;
  }

  get hasPendingDelegations(): boolean {
    return this.pendingCount > 0;
  }

  /**
   * Collect and clear completed background delegation results.
   * Called by Queen before each LLM call to inject results.
   */
  collectCompletedResults(): string[] {
    const results = [...this.completedBackgroundResults];
    this.completedBackgroundResults = [];
    return results;
  }

  /**
   * Execute the delegate_tasks tool call.
   * Returns a structured result string for the Queen's context.
   */
  async execute(input: DelegateTasksInput, context?: DelegateTasksContext): Promise<string> {
    if (!input.tasks || input.tasks.length === 0) {
      return 'Error: delegate_tasks requires at least one task.';
    }

    // Build Task objects
    const tasks: Task[] = input.tasks.map((t, i) => ({
      id: `task-${i}`,
      description: t.description,
      successCriteria: t.successCriteria,
      dependencies: [],
      priority: 1,
      status: 'pending' as const,
      createdAt: new Date(),
    }));

    // Inject skill context if available
    if (context?.skillContext) {
      for (const task of tasks) {
        task.skillContext = {
          name: context.skillContext.name,
          instructions: context.skillContext.instructions,
          resources: context.skillContext.resources,
        };
      }
    }

    // Inject tool effectiveness and strategy hints
    if (context?.toolEffectivenessHints || context?.strategyHints) {
      for (const task of tasks) {
        if (context?.toolEffectivenessHints) {
          const hints = context.toolEffectivenessHints(task.description);
          if (hints) task.toolEffectivenessHints = hints;
        }
        if (context?.strategyHints) {
          const hints = context.strategyHints(task.description);
          if (hints) task.strategyHints = hints;
        }
      }
    }

    // Emit worker_spawned events
    for (const task of tasks) {
      this.eventHandler({ type: 'worker_spawned', workerId: task.id, task });
    }

    // Background mode: fire-and-forget
    if (input.background) {
      const delegationId = `d-${Date.now().toString(36)}`;
      this.pendingCount++;

      this.executeWorkers(tasks, input, context).then(result => {
        this.completedBackgroundResults.push(
          `[Background delegation ${delegationId} completed]\n${result}`
        );
        this.pendingCount--;
      }).catch(() => {
        this.completedBackgroundResults.push(
          `[Background delegation ${delegationId} failed]`
        );
        this.pendingCount--;
      });

      return `Delegated ${tasks.length} task(s) in background (id: "${delegationId}"). Workers are executing. Results will be provided when ready. You can continue with other work.`;
    }

    // Foreground mode: wait for results
    return this.executeWorkers(tasks, input, context);
  }

  /**
   * Execute workers and return formatted results.
   * Used by both foreground and background paths.
   */
  private async executeWorkers(
    tasks: Task[],
    input: DelegateTasksInput,
    context?: DelegateTasksContext,
  ): Promise<string> {
    // Discovery mode: delegate to DiscoveryCoordinator
    if (input.discoveryMode && this.discoveryCoordinator) {
      const plan: TaskPlan = {
        type: 'decomposed',
        reasoning: 'Delegated discovery task',
        tasks,
        discoveryMode: true,
      };
      const discoveryResult = await this.discoveryCoordinator.execute(
        tasks.map(t => t.description).join('; '),
        plan,
        {
          eventHandler: this.eventHandler,
          skillContext: context?.skillContext,
        },
      );
      return discoveryResult.content;
    }

    // Normal mode: dispatch to worker pool
    const resultsMap = await this.workerPool.executeTasks(tasks);

    // Emit worker_completed events
    for (const task of tasks) {
      const result = resultsMap.get(task.id);
      if (result) {
        this.eventHandler({ type: 'worker_completed', workerId: task.id, result });
      }
    }

    return this.formatResults(tasks, resultsMap);
  }

  /**
   * Format worker results into a structured summary for the Queen.
   */
  private formatResults(tasks: Task[], results: Map<string, TaskResult>): string {
    const succeeded = tasks.filter(t => results.get(t.id)?.success);
    const failed = tasks.filter(t => {
      const r = results.get(t.id);
      return r && !r.success;
    });

    const parts: string[] = [];
    parts.push(`## Worker Results (${tasks.length} tasks, ${succeeded.length} succeeded, ${failed.length} failed)`);

    for (const task of tasks) {
      const result = results.get(task.id);
      if (!result) {
        parts.push(`\n### Task: "${task.description}"\nStatus: no result returned`);
        continue;
      }

      parts.push(`\n### Task: "${task.description}"`);

      if (result.success) {
        parts.push(`Status: completed (${result.iterations} iterations)`);
        if (result.findings && result.findings.length > 0) {
          parts.push('Findings:');
          for (const f of result.findings) {
            parts.push(`- ${f}`);
          }
        }
        if (result.output && result.output.trim()) {
          // Include truncated output if no findings
          if (!result.findings || result.findings.length === 0) {
            const truncated = result.output.length > 1000
              ? result.output.slice(0, 1000) + '\n...(truncated)'
              : result.output;
            parts.push(`Output:\n${truncated}`);
          }
        }
      } else {
        parts.push(`Status: failed`);
        if (result.error) {
          parts.push(`Error: ${result.error}`);
        }
        if (result.output && result.output.trim()) {
          const truncated = result.output.length > 500
            ? result.output.slice(0, 500) + '\n...(truncated)'
            : result.output;
          parts.push(`Partial output:\n${truncated}`);
        }
      }
    }

    return parts.join('\n');
  }
}
