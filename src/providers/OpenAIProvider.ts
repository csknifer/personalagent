/**
 * OpenAI LLM Provider
 */

import OpenAI from 'openai';
import { LLMProvider, type ChatOptions, type ChatResponse, type StreamChunk, type ToolDefinition } from './Provider.js';
import type { Message } from '../core/types.js';

export function safeParseToolArgs(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface OpenAIConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  models?: string[];
  providerName?: string;
}

/**
 * Convert internal messages to OpenAI format.
 * Handles tool_calls on assistant messages and expands tool results
 * into individual role:"tool" messages.
 */
export function convertMessagesToOpenAI(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      });
    } else if (msg.role === 'user' && msg.toolResults && msg.toolResults.length > 0) {
      for (const tr of msg.toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.toolCallId,
          content: tr.result,
        });
      }
    } else {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return result;
}

export class OpenAIProvider extends LLMProvider {
  readonly name: string;
  readonly model: string;

  private client: OpenAI;
  private defaultTemperature: number;
  private defaultMaxTokens: number;
  private availableModels: string[];

  constructor(config: OpenAIConfig) {
    super();
    this.name = config.providerName ?? 'openai';
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens ?? 4096;
    this.availableModels = config.models ?? ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'];
  }

  private convertMessages(messages: Message[]) { return convertMessagesToOpenAI(messages); }

  /**
   * Convert tool definitions to OpenAI format
   */
  private convertTools(tools?: ToolDefinition[]): OpenAI.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stopSequences,
      tools: this.convertTools(options?.tools),
    });

    const choice = response.choices[0];
    const message = choice?.message;
    const content = message?.content || '';

    // Handle tool calls
    const toolCalls = message?.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseToolArgs(tc.function.arguments),
    }));

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: response.usage ? {
        input: response.usage.prompt_tokens || 0,
        output: response.usage.completion_tokens || 0,
        total: response.usage.total_tokens || 0,
      } : undefined,
      finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 
                    choice?.finish_reason === 'length' ? 'length' : 'stop',
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stopSequences,
      tools: this.convertTools(options?.tools),
      stream: true,
    });

    // Track multiple concurrent tool calls by index (OpenAI streams parallel
    // tool calls with interleaved argument deltas distinguished by tc.index).
    const activeToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { type: 'text', content: delta.content };
      }

      // Handle streaming tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          if (tc.id) {
            // New tool call starting at this index
            activeToolCalls.set(index, {
              id: tc.id,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '',
            });
          } else {
            const existing = activeToolCalls.get(index);
            if (existing) {
              if (tc.function?.name) {
                existing.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                existing.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    }

    // Emit all accumulated tool calls in index order
    const sortedEntries = [...activeToolCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, toolCall] of sortedEntries) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          arguments: safeParseToolArgs(toolCall.arguments),
        },
      };
    }

    yield { type: 'done' };
  }

  supportsTools(): boolean {
    return true;
  }

  getAvailableModels(): string[] {
    return this.availableModels;
  }
}
