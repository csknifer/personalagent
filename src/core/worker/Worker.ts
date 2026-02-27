/**
 * Worker Agent - Stateless task executor using Ralph Loop
 */

import { ralphLoop, UnifiedVerifier, type TestBasedVerifier } from './RalphLoop.js';
import type { Task, TaskResult, Verifier, WorkerState, AgentEventHandler } from '../types.js';
import type { LLMProvider } from '../../providers/index.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { DimensionalConfig } from '../../config/types.js';
import { getProgressTracker } from '../progress/ProgressTracker.js';

interface WorkerOptions {
  id: string;
  provider: LLMProvider;
  mcpServer?: MCPServer;
  maxIterations?: number;
  timeout?: number;
  verifier?: Verifier;
  onStateChange?: (state: WorkerState) => void;
  onEvent?: AgentEventHandler;
  dimensionalConfig?: DimensionalConfig;
  signal?: AbortSignal;
}

export class Worker {
  readonly id: string;
  private provider: LLMProvider;
  private mcpServer?: MCPServer;
  private maxIterations: number;
  private timeout: number;
  private verifier?: Verifier;
  private stateHandler?: (state: WorkerState) => void;
  private eventHandler?: AgentEventHandler;
  private dimensionalConfig?: DimensionalConfig;
  private signal?: AbortSignal;
  private state: WorkerState;

  constructor(options: WorkerOptions) {
    this.id = options.id;
    this.provider = options.provider;
    this.mcpServer = options.mcpServer;
    this.maxIterations = options.maxIterations ?? 5;
    this.timeout = options.timeout ?? 300000;
    this.verifier = options.verifier;
    this.stateHandler = options.onStateChange;
    this.eventHandler = options.onEvent;
    this.dimensionalConfig = options.dimensionalConfig;
    this.signal = options.signal;

    this.state = {
      id: this.id,
      status: 'idle',
      iteration: 0,
      maxIterations: this.maxIterations,
      toolCalls: 0,
      llmCalls: 0,
    };
  }

  /**
   * Execute a task using the Ralph Loop pattern with MCP tools
   */
  async execute(task: Task): Promise<TaskResult> {
    this.updateState({
      status: 'working',
      currentTask: task,
      iteration: 0,
      maxIterations: this.maxIterations,
      toolCalls: 0,
      llmCalls: 0,
      startedAt: new Date(),
    });

    try {
      const result = await ralphLoop(this.provider, task, {
        maxIterations: this.maxIterations,
        timeout: this.timeout,
        verifier: this.verifier || new UnifiedVerifier(this.provider, task.description, task.successCriteria),
        mcpServer: this.mcpServer,
        dimensionalConfig: this.dimensionalConfig,
        signal: this.signal,
        workerId: task.id,
        onEvent: this.eventHandler,
        onProgress: (iteration, status) => {
          // Read live metrics from the global ProgressTracker (which already
          // tracks per-worker llm/tool counts via TrackedProvider events).
          // Use task.id (not this.id) because ProgressTracker keys workers
          // by task UUID from worker_spawned events.
          const tracker = getProgressTracker();
          const workerProgress = tracker.getWorkerProgress().find(w => w.id === task.id);
          this.updateState({
            iteration,
            currentAction: status,
            llmCalls: workerProgress?.llmCalls ?? this.state.llmCalls,
            toolCalls: workerProgress?.toolCalls ?? this.state.toolCalls,
          });
        },
      });

      this.updateState({
        status: result.success ? 'completed' : 'failed',
        currentTask: { ...task, result, status: result.success ? 'completed' : 'failed' },
      });

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      const result: TaskResult = {
        success: false,
        output: '',
        error: err.message,
        iterations: this.state.iteration,
      };

      this.updateState({
        status: 'failed',
        currentTask: { ...task, result, status: 'failed' },
      });

      return result;
    }
  }

  /**
   * Get current worker state
   */
  getState(): WorkerState {
    return { ...this.state };
  }

  /**
   * Reset worker to idle state
   */
  reset(): void {
    this.state = {
      id: this.id,
      status: 'idle',
      iteration: 0,
      maxIterations: this.maxIterations,
      toolCalls: 0,
      llmCalls: 0,
    };
    this.stateHandler?.(this.state);
  }

  /**
   * Update worker state
   */
  private updateState(updates: Partial<WorkerState>): void {
    this.state = { ...this.state, ...updates };
    this.stateHandler?.(this.state);
  }

  /**
   * Get the provider being used
   */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Update the provider
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /**
   * Set a custom verifier
   */
  setVerifier(verifier: Verifier): void {
    this.verifier = verifier;
  }

  /**
   * Set the MCP server for tool access
   */
  setMCPServer(mcpServer: MCPServer): void {
    this.mcpServer = mcpServer;
  }

  /**
   * Get worker statistics
   */
  getStats(): {
    id: string;
    status: WorkerState['status'];
    currentIteration: number;
    elapsedTime?: number;
  } {
    return {
      id: this.id,
      status: this.state.status,
      currentIteration: this.state.iteration,
      elapsedTime: this.state.startedAt 
        ? Date.now() - this.state.startedAt.getTime() 
        : undefined,
    };
  }
}

/**
 * Create a worker with standard configuration
 */
export function createWorker(
  id: string,
  provider: LLMProvider,
  options: Partial<Omit<WorkerOptions, 'id' | 'provider'>> = {}
): Worker {
  return new Worker({
    id,
    provider,
    mcpServer: options.mcpServer,
    maxIterations: options.maxIterations,
    timeout: options.timeout,
    verifier: options.verifier,
    onStateChange: options.onStateChange,
    onEvent: options.onEvent,
    dimensionalConfig: options.dimensionalConfig,
    signal: options.signal,
  });
}
