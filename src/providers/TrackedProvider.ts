/**
 * TrackedProvider - Wrapper that adds LLM call instrumentation to any provider
 * 
 * Wraps an existing LLMProvider and emits events for every API call,
 * enabling progress tracking and debugging of LLM usage.
 */

import type { Message } from '../core/types.js';
import type { LLMCallPurpose } from '../core/types.js';
import { getLLMCallLogger, type LLMCallLogger } from '../core/progress/LLMCallLogger.js';
import { LLMProvider, ChatOptions, ChatResponse, StreamChunk } from './Provider.js';

export interface TrackedProviderOptions {
  /** Default purpose for calls when not specified */
  defaultPurpose?: LLMCallPurpose;
  /** Worker ID to associate with calls */
  workerId?: string;
  /** Custom logger instance (uses global if not provided) */
  logger?: LLMCallLogger;
}

/**
 * Extended chat options that include tracking metadata
 */
export interface TrackedChatOptions extends ChatOptions {
  /** Purpose of this LLM call for tracking */
  purpose?: LLMCallPurpose;
  /** Worker ID making this call */
  workerId?: string;
}

/**
 * TrackedProvider wraps any LLMProvider to add call instrumentation
 */
export class TrackedProvider extends LLMProvider {
  private provider: LLMProvider;
  private logger: LLMCallLogger;
  private defaultPurpose: LLMCallPurpose;
  private defaultWorkerId?: string;

  readonly name: string;
  readonly model: string;

  constructor(provider: LLMProvider, options: TrackedProviderOptions = {}) {
    super();
    this.provider = provider;
    this.logger = options.logger || getLLMCallLogger();
    this.defaultPurpose = options.defaultPurpose || 'execution';
    this.defaultWorkerId = options.workerId;
    this.name = provider.name;
    this.model = provider.model;
  }

  /**
   * Send a chat message with tracking
   */
  async chat(messages: Message[], options?: TrackedChatOptions): Promise<ChatResponse> {
    const purpose = options?.purpose || this.defaultPurpose;
    const workerId = options?.workerId || this.defaultWorkerId;

    const callId = this.logger.startCall({
      provider: this.name,
      model: this.model,
      purpose,
      workerId,
    });

    try {
      // Strip tracking-specific fields before passing to underlying provider
      const baseOptions: ChatOptions | undefined = options ? {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stopSequences: options.stopSequences,
        tools: options.tools,
      } : undefined;
      const response = await this.provider.chat(messages, baseOptions);

      this.logger.endCall(callId, {
        success: true,
        tokens: response.tokenUsage,
      });

      return response;
    } catch (error) {
      this.logger.endCall(callId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stream a chat message with tracking
   */
  async *chatStream(messages: Message[], options?: TrackedChatOptions): AsyncGenerator<StreamChunk> {
    const purpose = options?.purpose || this.defaultPurpose;
    const workerId = options?.workerId || this.defaultWorkerId;

    const callId = this.logger.startCall({
      provider: this.name,
      model: this.model,
      purpose,
      workerId,
    });

    try {
      // Strip tracking-specific fields before passing to underlying provider
      const baseOptions: ChatOptions | undefined = options ? {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stopSequences: options.stopSequences,
        tools: options.tools,
      } : undefined;
      let totalContent = '';

      for await (const chunk of this.provider.chatStream(messages, baseOptions)) {
        if (chunk.content) {
          totalContent += chunk.content;
        }
        yield chunk;
      }

      // Streaming APIs don't return token counts, so estimate them.
      // ~4 chars per token heuristic (same as estimateTokenCount in utils).
      // Include tool call/result metadata in the estimate, not just message content.
      let inputChars = 0;
      for (const m of messages) {
        inputChars += m.content.length;
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            inputChars += tc.name.length + JSON.stringify(tc.arguments).length;
          }
        }
        if (m.toolResults) {
          for (const tr of m.toolResults) {
            inputChars += tr.result.length;
          }
        }
      }
      const estimatedInput = Math.ceil(inputChars / 4);
      const estimatedOutput = Math.ceil(totalContent.length / 4);
      this.logger.endCall(callId, {
        success: true,
        tokens: {
          input: estimatedInput,
          output: estimatedOutput,
          total: estimatedInput + estimatedOutput,
        },
      });
    } catch (error) {
      this.logger.endCall(callId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Simple completion with tracking
   */
  async complete(prompt: string, options?: TrackedChatOptions): Promise<string> {
    const response = await this.chat([
      { role: 'user', content: prompt, timestamp: new Date() }
    ], options);
    return response.content;
  }

  /**
   * Check if this provider supports tools
   */
  supportsTools(): boolean {
    return this.provider.supportsTools();
  }

  /**
   * Get available models
   */
  getAvailableModels(): string[] {
    return this.provider.getAvailableModels();
  }

  /**
   * Get the underlying provider
   */
  getUnderlyingProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Update the default purpose for calls
   */
  setDefaultPurpose(purpose: LLMCallPurpose): void {
    this.defaultPurpose = purpose;
  }

  /**
   * Update the default worker ID
   */
  setWorkerId(workerId: string | undefined): void {
    this.defaultWorkerId = workerId;
  }

  /**
   * Create a new TrackedProvider with a different default purpose
   */
  withPurpose(purpose: LLMCallPurpose): TrackedProvider {
    return new TrackedProvider(this.provider, {
      defaultPurpose: purpose,
      workerId: this.defaultWorkerId,
      logger: this.logger,
    });
  }

  /**
   * Create a new TrackedProvider with a worker ID
   */
  withWorkerId(workerId: string): TrackedProvider {
    return new TrackedProvider(this.provider, {
      defaultPurpose: this.defaultPurpose,
      workerId,
      logger: this.logger,
    });
  }
}

/**
 * Wrap a provider with tracking capabilities
 */
export function wrapWithTracking(
  provider: LLMProvider,
  options?: TrackedProviderOptions
): TrackedProvider {
  // Don't double-wrap
  if (provider instanceof TrackedProvider) {
    return provider;
  }
  return new TrackedProvider(provider, options);
}

/**
 * Check if a provider is already tracked
 */
export function isTrackedProvider(provider: LLMProvider): provider is TrackedProvider {
  return provider instanceof TrackedProvider;
}
