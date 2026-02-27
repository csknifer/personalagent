/**
 * Worker Pool - Manages parallel worker execution
 */

import { Worker, createWorker } from './Worker.js';
import type { Task, TaskResult, WorkerState, Verifier, AgentEventHandler } from '../types.js';
import type { LLMProvider } from '../../providers/index.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { DimensionalConfig } from '../../config/types.js';

interface WorkerPoolOptions {
  provider: LLMProvider;
  maxWorkers: number;
  maxIterations?: number;
  timeout?: number;
  verifier?: Verifier;
  mcpServer?: MCPServer;
  onWorkerStateChange?: (workerId: string, state: WorkerState) => void;
  onTaskComplete?: (taskId: string, result: TaskResult) => void;
  onEvent?: AgentEventHandler;
  dimensionalConfig?: DimensionalConfig;
}

interface QueuedTask {
  task: Task;
  resolve: (result: TaskResult) => void;
  reject: (error: Error) => void;
}

export class WorkerPool {
  private provider: LLMProvider;
  private maxWorkers: number;
  private maxIterations: number;
  private timeout: number;
  private verifier?: Verifier;
  private mcpServer?: MCPServer;
  private dimensionalConfig?: DimensionalConfig;
  private stateHandler?: (workerId: string, state: WorkerState) => void;
  private eventHandler?: AgentEventHandler;
  private onTaskComplete?: (taskId: string, result: TaskResult) => void;

  private workers: Map<string, Worker> = new Map();
  private activeWorkers: Set<string> = new Set();
  private taskQueue: QueuedTask[] = [];
  private workerCounter: number = 0;
  /** Maps internal worker ID → current task ID for state change events */
  private workerTaskMap: Map<string, string> = new Map();
  /** Abort controller for cooperative cancellation of in-flight workers */
  private abortController: AbortController = new AbortController();
  /** Per-task abort controllers for selective cancellation */
  private taskAbortControllers: Map<string, AbortController> = new Map();

  constructor(options: WorkerPoolOptions) {
    this.provider = options.provider;
    this.maxWorkers = options.maxWorkers;
    this.maxIterations = options.maxIterations ?? 10;
    this.timeout = options.timeout ?? 300000;
    this.verifier = options.verifier;
    this.mcpServer = options.mcpServer;
    this.dimensionalConfig = options.dimensionalConfig;
    this.stateHandler = options.onWorkerStateChange;
    this.eventHandler = options.onEvent;
    this.onTaskComplete = options.onTaskComplete;
  }

  /**
   * Submit a task for execution
   */
  async submitTask(task: Task): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ task, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Submit multiple tasks for parallel execution
   */
  async submitTasks(tasks: Task[]): Promise<TaskResult[]> {
    const promises = tasks.map(task => this.submitTask(task));
    return Promise.all(promises);
  }

  /**
   * Execute tasks respecting dependencies
   */
  async executeTasks(tasks: Task[]): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();
    const completed = new Set<string>();
    const pending = [...tasks];

    // Strip references to non-existent dependency IDs to prevent deadlocks
    const taskIds = new Set(tasks.map(t => t.id));
    for (const task of pending) {
      const invalid = task.dependencies.filter(dep => !taskIds.has(dep));
      if (invalid.length > 0) {
        task.dependencies = task.dependencies.filter(dep => taskIds.has(dep));
      }
    }

    while (pending.length > 0) {
      // Find tasks that are ready (dependencies satisfied)
      const ready = pending.filter(task =>
        task.dependencies.every(dep => completed.has(dep))
      );

      if (ready.length === 0 && pending.length > 0) {
        // Circular dependency detected
        throw new Error('Cannot resolve task dependencies — circular dependency detected');
      }

      // Inject dependency results into ready tasks — prefer structured findings
      for (const task of ready) {
        if (task.dependencies.length > 0) {
          task.dependencyResults = new Map();
          for (const depId of task.dependencies) {
            const depResult = results.get(depId);
            if (depResult && depResult.success) {
              let depContext: string;
              if (depResult.findings && depResult.findings.length > 0) {
                // Use structured findings — much more token-efficient than raw output
                depContext = `Key findings:\n${depResult.findings.map(f => `- ${f}`).join('\n')}`;
                // Append truncated raw output with remaining budget for additional context
                if (depContext.length < 800 && depResult.output) {
                  const remainingBudget = 1500 - depContext.length;
                  depContext += `\n\nAdditional detail:\n${depResult.output.slice(0, remainingBudget)}`;
                }
              } else if (depResult.output) {
                // Fallback: truncate raw output as before
                depContext = depResult.output.length > 1500
                  ? depResult.output.slice(0, 1500) + '\n... [truncated]'
                  : depResult.output;
              } else {
                continue;
              }
              task.dependencyResults.set(depId, depContext);
            }
          }
        }
      }

      // Execute ready tasks in parallel — use allSettled so one failure
      // does not discard sibling results
      const batchSettled = await Promise.allSettled(
        ready.map(async task => {
          try {
            const result = await this.submitTask(task);
            return { taskId: task.id, result };
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            const failedResult: TaskResult = {
              success: false,
              output: '',
              error: err.message,
              iterations: 0,
            };
            return { taskId: task.id, result: failedResult };
          }
        })
      );

      // Record results — both fulfilled and rejected
      for (let i = 0; i < batchSettled.length; i++) {
        const settled = batchSettled[i];
        if (settled.status === 'fulfilled') {
          const { taskId, result } = settled.value;
          results.set(taskId, result);
          completed.add(taskId);
        } else {
          const taskId = ready[i].id;
          results.set(taskId, {
            success: false,
            output: '',
            error: settled.reason?.message || 'Unknown execution error',
            iterations: 0,
          });
          completed.add(taskId);
        }
      }

      // Remove completed tasks from pending
      for (const task of ready) {
        const index = pending.findIndex(t => t.id === task.id);
        if (index !== -1) {
          pending.splice(index, 1);
        }
      }
    }

    return results;
  }

  /**
   * Process the task queue
   */
  private processQueue(): void {
    while (
      this.taskQueue.length > 0 &&
      this.activeWorkers.size < this.maxWorkers
    ) {
      const queued = this.taskQueue.shift();
      if (!queued) break;

      // Create per-task abort controller for selective cancellation
      const taskController = new AbortController();
      this.taskAbortControllers.set(queued.task.id, taskController);

      const worker = this.getOrCreateWorker(taskController, queued.task);
      this.activeWorkers.add(worker.id);

      this.executeWithWorker(worker, queued);
    }
  }

  /**
   * Execute a task with a specific worker
   */
  private async executeWithWorker(worker: Worker, queued: QueuedTask): Promise<void> {
    // Map internal worker ID to task ID so state events use task IDs
    this.workerTaskMap.set(worker.id, queued.task.id);
    try {
      const result = await worker.execute(queued.task);
      this.onTaskComplete?.(queued.task.id, result);
      queued.resolve(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      queued.reject(err);
    } finally {
      this.taskAbortControllers.delete(queued.task.id);
      this.workerTaskMap.delete(worker.id);
      this.activeWorkers.delete(worker.id);
      this.workers.delete(worker.id);
      worker.reset();
      this.processQueue();
    }
  }

  /**
   * Get an idle worker or create a new one
   */
  private getOrCreateWorker(taskController: AbortController, task?: Task): Worker {
    // Compose the per-task signal with the global shutdown signal
    const composedSignal = AbortSignal.any([this.abortController.signal, taskController.signal]);

    // Use per-task overrides from adaptive timeout if available, fall back to pool defaults
    const taskMaxIterations = task?.maxIterationsOverride ?? this.maxIterations;
    const taskTimeout = task?.timeoutOverride ?? this.timeout;

    // Always create a new worker so it picks up the composed signal for this task.
    // Workers are lightweight (stateless between tasks), so this is fine.
    const workerId = `worker-${++this.workerCounter}`;
    const worker = createWorker(workerId, this.provider, {
      maxIterations: taskMaxIterations,
      timeout: taskTimeout,
      verifier: this.verifier,
      mcpServer: this.mcpServer,
      dimensionalConfig: this.dimensionalConfig,
      signal: composedSignal,
      onEvent: this.eventHandler,
      onStateChange: (state) => {
        const taskId = this.workerTaskMap.get(workerId) || workerId;
        this.stateHandler?.(taskId, { ...state, id: taskId });
      },
    });

    this.workers.set(workerId, worker);
    return worker;
  }

  /**
   * Cancel a specific task by ID.
   * If in-flight: aborts the per-task controller → RalphLoop exits with 'cancelled'.
   * If still queued: removes from queue and resolves with cancelled result.
   * Returns true if the task was found and cancelled.
   */
  cancelTask(taskId: string): boolean {
    // Check if it's in the queue (not yet started)
    const queueIdx = this.taskQueue.findIndex(q => q.task.id === taskId);
    if (queueIdx !== -1) {
      const queued = this.taskQueue.splice(queueIdx, 1)[0];
      queued.resolve({
        success: false,
        output: '',
        error: 'Task cancelled before execution',
        exitReason: 'cancelled',
        iterations: 0,
      });
      return true;
    }

    // Check if it's in-flight
    const controller = this.taskAbortControllers.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }

    return false;
  }

  /**
   * Update the onTaskComplete callback dynamically.
   * Used by the Queen to wire up mid-flight reactivity per request.
   */
  setOnTaskComplete(handler: ((taskId: string, result: TaskResult) => void) | undefined): void {
    this.onTaskComplete = handler;
  }

  /**
   * Get all worker states
   */
  getWorkerStates(): WorkerState[] {
    return Array.from(this.workers.values()).map(w => w.getState());
  }

  /**
   * Get active worker count
   */
  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    totalWorkers: number;
    activeWorkers: number;
    queuedTasks: number;
    maxWorkers: number;
  } {
    return {
      totalWorkers: this.workers.size,
      activeWorkers: this.activeWorkers.size,
      queuedTasks: this.taskQueue.length,
      maxWorkers: this.maxWorkers,
    };
  }

  /**
   * Shutdown the pool
   */
  shutdown(): void {
    // Signal all in-flight workers to stop cooperatively
    this.abortController.abort();

    // Clear the queue
    for (const queued of this.taskQueue) {
      queued.reject(new Error('Worker pool shutdown'));
    }
    this.taskQueue = [];

    // Reset all workers
    for (const worker of this.workers.values()) {
      worker.reset();
    }
    this.activeWorkers.clear();

    // Create a fresh controller for potential reuse after shutdown
    this.abortController = new AbortController();
    // Clear stale workers so new ones pick up the fresh signal
    this.workers.clear();
  }

  /**
   * Update the provider for all workers
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
    for (const worker of this.workers.values()) {
      worker.setProvider(provider);
    }
  }

  /**
   * Update the verifier for all workers
   */
  setVerifier(verifier: Verifier): void {
    this.verifier = verifier;
    for (const worker of this.workers.values()) {
      worker.setVerifier(verifier);
    }
  }

  /**
   * Set the MCP server for tool access
   */
  setMCPServer(mcpServer: MCPServer): void {
    this.mcpServer = mcpServer;
    for (const worker of this.workers.values()) {
      worker.setMCPServer(mcpServer);
    }
  }
}

/**
 * Create a worker pool with standard configuration
 */
export function createWorkerPool(
  provider: LLMProvider,
  options: Partial<Omit<WorkerPoolOptions, 'provider'>> = {}
): WorkerPool {
  return new WorkerPool({
    provider,
    maxWorkers: options.maxWorkers ?? 4,
    ...options,
  });
}
