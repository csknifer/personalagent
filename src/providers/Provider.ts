/**
 * Base LLM Provider interface
 */

import type { Message, TokenUsage } from '../core/types.js';

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider-specific metadata (e.g. Gemini thought_signature) */
  providerMetadata?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  tokenUsage?: TokenUsage;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done';
  content?: string;
  toolCall?: ToolCall;
}

/**
 * Abstract base class for LLM providers
 */
export abstract class LLMProvider {
  abstract readonly name: string;
  abstract readonly model: string;

  /**
   * Send a chat message and get a complete response
   */
  abstract chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;

  /**
   * Send a chat message and stream the response
   */
  abstract chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk>;

  /**
   * Simple completion (no conversation context)
   */
  async complete(prompt: string, options?: ChatOptions): Promise<string> {
    const response = await this.chat([
      { role: 'user', content: prompt, timestamp: new Date() }
    ], options);
    return response.content;
  }

  /**
   * Check if this provider supports tool/function calling
   */
  abstract supportsTools(): boolean;

  /**
   * Get the list of available models for this provider
   */
  abstract getAvailableModels(): string[];
}
