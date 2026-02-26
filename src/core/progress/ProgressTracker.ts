/**
 * ProgressTracker - Central service for tracking agent/worker progress
 * 
 * Aggregates events from Queen, Workers, and LLM calls into a coherent
 * progress view that can be displayed to users.
 */

import type {
  AgentEvent,
  AgentEventHandler,
  AgentPhase,
  ProgressState,
  WorkerProgress,
  LLMCallStats,
  LLMCallPurpose,
  TokenUsage,
  LLMCallEvent,
  ToolExecutionEvent,
} from '../types.js';

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Creates initial LLM call stats
 */
function createEmptyLLMStats(): LLMCallStats {
  return {
    total: 0,
    byPurpose: {
      planning: 0,
      execution: 0,
      verification: 0,
      tool_followup: 0,
      aggregation: 0,
      direct: 0,
      replanning: 0,
      evaluation: 0,
      discovery: 0,
    },
    byProvider: {},
    totalTokens: { input: 0, output: 0, total: 0 },
  };
}

/**
 * ProgressTracker class - Singleton pattern for global progress tracking
 */
export class ProgressTracker {
  private state: ProgressState;
  private eventListeners: Set<AgentEventHandler> = new Set();
  private activeLLMCalls: Map<string, LLMCallEvent> = new Map();
  private activeToolCalls: Map<string, ToolExecutionEvent> = new Map();

  constructor() {
    this.state = {
      phase: 'idle',
      workers: new Map(),
      llmCalls: createEmptyLLMStats(),
    };
  }

  /**
   * Reset the tracker state
   */
  reset(): void {
    this.state = {
      phase: 'idle',
      workers: new Map(),
      llmCalls: createEmptyLLMStats(),
    };
    this.activeLLMCalls.clear();
    this.activeToolCalls.clear();
  }

  /**
   * Start tracking a new request
   */
  startRequest(): void {
    this.reset();
    this.state.startedAt = new Date();
    this.state.lastActivity = new Date();
  }

  /**
   * Handle incoming agent events and update progress state
   */
  handleEvent(event: AgentEvent): void {
    this.state.lastActivity = new Date();

    switch (event.type) {
      case 'phase_change':
        this.state.phase = event.phase;
        break;

      case 'worker_spawned':
        this.state.workers.set(event.workerId, {
          id: event.workerId,
          taskDescription: event.task.description,
          status: 'queued',
          iteration: 0,
          maxIterations: DEFAULT_MAX_ITERATIONS,
          toolCalls: 0,
          llmCalls: 0,
          startedAt: new Date(),
        });
        break;

      case 'worker_progress':
        this.updateWorker(event.workerId, {
          iteration: event.iteration,
          currentAction: event.status,
          status: event.status.includes('verifying') ? 'verifying' : 'working',
        });
        break;

      case 'worker_completed':
        this.updateWorker(event.workerId, {
          status: event.result.success ? 'completed' : 'failed',
          currentAction: event.result.success ? 'Completed' : `Failed: ${event.result.error}`,
        });
        break;

      case 'worker_state_change':
        const workerState = event.state;
        this.updateWorker(event.workerId, {
          status: workerState.status === 'working' ? 'working' : 
                  workerState.status === 'verifying' ? 'verifying' :
                  workerState.status === 'completed' ? 'completed' :
                  workerState.status === 'failed' ? 'failed' : 'queued',
          iteration: workerState.iteration,
          maxIterations: workerState.maxIterations,
          currentAction: workerState.currentAction,
          toolCalls: workerState.toolCalls,
          llmCalls: workerState.llmCalls,
        });
        break;

      case 'step_progress':
        this.updateWorker(event.workerId, {
          currentAction: `Step ${event.step}/${event.totalSteps}: ${event.description}`,
        });
        break;

      case 'llm_call':
        this.handleLLMCallEvent(event.event);
        break;

      case 'tool_execution':
        this.handleToolExecutionEvent(event.event);
        break;

      case 'replan_triggered':
        // Handled via phase_change event; this is primarily for UI notification
        break;

      case 'evaluation_complete':
        // Handled via phase_change event; primarily for UI notification
        break;

      case 'worker_signal':
        // Worker signals are logged by Queen and forwarded to listeners for UI
        break;
    }

    // Notify listeners
    this.notifyListeners(event);
  }

  /**
   * Handle LLM call events
   */
  private handleLLMCallEvent(event: LLMCallEvent): void {
    if (event.status === 'started') {
      this.activeLLMCalls.set(event.callId, event);
    } else {
      this.activeLLMCalls.delete(event.callId);
      
      // Update stats on completion
      if (event.status === 'completed') {
        this.state.llmCalls.total++;
        this.state.llmCalls.byPurpose[event.purpose]++;
        
        if (event.provider) {
          this.state.llmCalls.byProvider[event.provider] = 
            (this.state.llmCalls.byProvider[event.provider] || 0) + 1;
        }
        
        if (event.tokens) {
          this.state.llmCalls.totalTokens.input += event.tokens.input;
          this.state.llmCalls.totalTokens.output += event.tokens.output;
          this.state.llmCalls.totalTokens.total += event.tokens.total;
        }

        // Update worker LLM call count if associated with a worker
        if (event.workerId) {
          const worker = this.state.workers.get(event.workerId);
          if (worker) {
            worker.llmCalls++;
          }
        }
      }
    }
  }

  /**
   * Handle tool execution events
   */
  private handleToolExecutionEvent(event: ToolExecutionEvent): void {
    const key = `${event.workerId || 'main'}-${event.toolName}`;
    
    if (event.status === 'started') {
      this.activeToolCalls.set(key, event);
      
      // Update worker current action
      if (event.workerId) {
        this.updateWorker(event.workerId, {
          currentAction: `Executing tool: ${event.toolName}`,
        });
      }
    } else {
      this.activeToolCalls.delete(key);
      
      // Update worker tool call count
      if (event.workerId && event.status === 'completed') {
        const worker = this.state.workers.get(event.workerId);
        if (worker) {
          worker.toolCalls++;
        }
      }
    }
  }

  /**
   * Update worker progress state
   */
  private updateWorker(workerId: string, updates: Partial<WorkerProgress>): void {
    const worker = this.state.workers.get(workerId);
    if (worker) {
      Object.assign(worker, updates);
    }
  }

  /**
   * Add an event listener
   */
  addListener(handler: AgentEventHandler): void {
    this.eventListeners.add(handler);
  }

  /**
   * Remove an event listener
   */
  removeListener(handler: AgentEventHandler): void {
    this.eventListeners.delete(handler);
  }

  /**
   * Notify all listeners of an event
   */
  private notifyListeners(event: AgentEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in progress event listener:', error);
      }
    }
  }

  /**
   * Get current progress state
   */
  getCurrentProgress(): ProgressState {
    return { ...this.state };
  }

  /**
   * Get current phase
   */
  getPhase(): AgentPhase {
    return this.state.phase;
  }

  /**
   * Get all worker progress
   */
  getWorkerProgress(): WorkerProgress[] {
    return Array.from(this.state.workers.values());
  }

  /**
   * Get active worker count
   */
  getActiveWorkerCount(): number {
    return Array.from(this.state.workers.values())
      .filter(w => w.status === 'working' || w.status === 'verifying')
      .length;
  }

  /**
   * Get LLM call statistics
   */
  getLLMCallStats(): LLMCallStats {
    return { ...this.state.llmCalls };
  }

  /**
   * Get number of active LLM calls
   */
  getActiveLLMCallCount(): number {
    return this.activeLLMCalls.size;
  }

  /**
   * Get number of active tool calls
   */
  getActiveToolCallCount(): number {
    return this.activeToolCalls.size;
  }

  /**
   * Get a summary string of current progress
   */
  getSummary(): string {
    const workers = this.getWorkerProgress();
    const activeWorkers = workers.filter(w => w.status === 'working' || w.status === 'verifying');
    const completedWorkers = workers.filter(w => w.status === 'completed');
    const stats = this.getLLMCallStats();

    let summary = `Phase: ${this.state.phase}`;
    
    if (workers.length > 0) {
      summary += ` | Workers: ${activeWorkers.length} active, ${completedWorkers.length} completed`;
    }
    
    summary += ` | LLM Calls: ${stats.total}`;
    
    if (stats.totalTokens.total > 0) {
      summary += ` (${stats.totalTokens.total} tokens)`;
    }

    return summary;
  }

  /**
   * Get detailed progress report
   */
  getDetailedReport(): string {
    const lines: string[] = [];
    const duration = this.state.startedAt 
      ? Math.round((Date.now() - this.state.startedAt.getTime()) / 1000)
      : 0;

    lines.push(`=== Progress Report ===`);
    lines.push(`Phase: ${this.state.phase}`);
    lines.push(`Duration: ${duration}s`);
    lines.push('');

    // LLM Call breakdown
    const stats = this.getLLMCallStats();
    lines.push(`LLM Calls: ${stats.total} total`);
    lines.push(`  By Purpose:`);
    for (const [purpose, count] of Object.entries(stats.byPurpose)) {
      if (count > 0) {
        lines.push(`    ${purpose}: ${count}`);
      }
    }
    if (Object.keys(stats.byProvider).length > 0) {
      lines.push(`  By Provider:`);
      for (const [provider, count] of Object.entries(stats.byProvider)) {
        lines.push(`    ${provider}: ${count}`);
      }
    }
    lines.push(`  Tokens: ${stats.totalTokens.input} in / ${stats.totalTokens.output} out`);
    lines.push('');

    // Worker details
    const workers = this.getWorkerProgress();
    if (workers.length > 0) {
      lines.push(`Workers: ${workers.length}`);
      for (const worker of workers) {
        const statusIcon = worker.status === 'completed' ? '✓' :
                          worker.status === 'failed' ? '✗' :
                          worker.status === 'working' ? '◉' :
                          worker.status === 'verifying' ? '⋯' : '○';
        lines.push(`  ${statusIcon} [${worker.id}] ${worker.taskDescription.slice(0, 40)}...`);
        lines.push(`    Status: ${worker.status} | Iteration: ${worker.iteration}/${worker.maxIterations}`);
        lines.push(`    LLM Calls: ${worker.llmCalls} | Tool Calls: ${worker.toolCalls}`);
        if (worker.currentAction) {
          lines.push(`    Current: ${worker.currentAction}`);
        }
      }
    }

    return lines.join('\n');
  }
}

// Singleton instance
let globalTracker: ProgressTracker | null = null;

/**
 * Get the global progress tracker instance
 */
export function getProgressTracker(): ProgressTracker {
  if (!globalTracker) {
    globalTracker = new ProgressTracker();
  }
  return globalTracker;
}

/**
 * Create a new progress tracker (for testing or isolated use)
 */
export function createProgressTracker(): ProgressTracker {
  return new ProgressTracker();
}
