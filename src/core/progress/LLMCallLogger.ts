/**
 * LLMCallLogger - Tracks and categorizes LLM API calls
 * 
 * Provides instrumentation for LLM providers to track:
 * - Number of calls by purpose (planning, execution, verification, etc.)
 * - Token usage per call
 * - Call duration
 * - Provider/model information
 */

import type {
  LLMCallEvent,
  LLMCallPurpose,
  TokenUsage,
  AgentEventHandler,
} from '../types.js';
import { getProgressTracker } from './ProgressTracker.js';

/**
 * Generates a unique call ID
 */
function generateCallId(): string {
  return `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * LLMCallLogger class for tracking LLM calls
 */
export class LLMCallLogger {
  private activeCalls: Map<string, { event: LLMCallEvent; startTime: number }> = new Map();
  private eventHandler?: AgentEventHandler;
  private enabled: boolean = true;

  constructor(eventHandler?: AgentEventHandler) {
    this.eventHandler = eventHandler;
  }

  /**
   * Set the event handler for emitting LLM call events
   */
  setEventHandler(handler: AgentEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Enable or disable logging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Start tracking an LLM call
   * Returns a callId that should be passed to endCall
   */
  startCall(options: {
    provider: string;
    model?: string;
    purpose: LLMCallPurpose;
    workerId?: string;
  }): string {
    if (!this.enabled) {
      return '';
    }

    const callId = generateCallId();
    const event: LLMCallEvent = {
      callId,
      provider: options.provider,
      model: options.model,
      purpose: options.purpose,
      status: 'started',
      workerId: options.workerId,
    };

    this.activeCalls.set(callId, { event, startTime: Date.now() });
    this.emitEvent(event);

    return callId;
  }

  /**
   * End tracking an LLM call
   */
  endCall(callId: string, result: {
    success: boolean;
    tokens?: TokenUsage;
    error?: string;
  }): void {
    if (!this.enabled || !callId) {
      return;
    }

    const callData = this.activeCalls.get(callId);
    if (!callData) {
      return;
    }

    this.activeCalls.delete(callId);

    const durationMs = Date.now() - callData.startTime;
    const event: LLMCallEvent = {
      ...callData.event,
      status: result.success ? 'completed' : 'failed',
      tokens: result.tokens,
      durationMs,
    };

    this.emitEvent(event);
  }

  /**
   * Create a wrapper function that tracks an LLM call
   */
  wrap<T>(
    options: {
      provider: string;
      model?: string;
      purpose: LLMCallPurpose;
      workerId?: string;
    },
    fn: () => Promise<T & { tokenUsage?: TokenUsage }>
  ): Promise<T & { tokenUsage?: TokenUsage }> {
    const callId = this.startCall(options);

    return fn()
      .then((result) => {
        this.endCall(callId, {
          success: true,
          tokens: result.tokenUsage,
        });
        return result;
      })
      .catch((error) => {
        this.endCall(callId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  }

  /**
   * Emit an LLM call event
   */
  private emitEvent(event: LLMCallEvent): void {
    // Emit to local handler
    if (this.eventHandler) {
      this.eventHandler({ type: 'llm_call', event });
    }

    // Also emit to global progress tracker
    try {
      getProgressTracker().handleEvent({ type: 'llm_call', event });
    } catch {
      // Ignore if tracker not initialized
    }
  }

  /**
   * Get count of active calls
   */
  getActiveCallCount(): number {
    return this.activeCalls.size;
  }

  /**
   * Get active call details
   */
  getActiveCalls(): LLMCallEvent[] {
    return Array.from(this.activeCalls.values()).map(c => c.event);
  }

  /**
   * Clear all active calls (for cleanup)
   */
  clear(): void {
    this.activeCalls.clear();
  }
}

// Singleton instance
let globalLogger: LLMCallLogger | null = null;

/**
 * Get the global LLM call logger instance
 */
export function getLLMCallLogger(): LLMCallLogger {
  if (!globalLogger) {
    globalLogger = new LLMCallLogger();
  }
  return globalLogger;
}

/**
 * Create a new LLM call logger (for testing or isolated use)
 */
export function createLLMCallLogger(eventHandler?: AgentEventHandler): LLMCallLogger {
  return new LLMCallLogger(eventHandler);
}

/**
 * Helper to create a purpose-specific logger wrapper
 */
export function createPurposeLogger(
  logger: LLMCallLogger,
  purpose: LLMCallPurpose,
  provider: string,
  model?: string
) {
  return {
    wrap<T>(fn: () => Promise<T & { tokenUsage?: TokenUsage }>, workerId?: string): Promise<T & { tokenUsage?: TokenUsage }> {
      return logger.wrap({ provider, model, purpose, workerId }, fn);
    },
    startCall(workerId?: string): string {
      return logger.startCall({ provider, model, purpose, workerId });
    },
    endCall(callId: string, result: { success: boolean; tokens?: TokenUsage; error?: string }): void {
      logger.endCall(callId, result);
    },
  };
}
