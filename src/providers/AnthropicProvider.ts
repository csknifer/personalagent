/**
 * Anthropic LLM Provider
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, type ChatOptions, type ChatResponse, type StreamChunk, type ToolDefinition } from './Provider.js';
import type { Message } from '../core/types.js';

interface AnthropicConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  models?: string[];
}

/**
 * Convert internal messages to Anthropic format.
 * Extracts system message separately, maps tool_use / tool_result content blocks.
 */
export function convertMessagesToAnthropic(messages: Message[]): { system?: string; messages: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const contentBlocks: Anthropic.ContentBlock[] = [];
      if (msg.content) {
        contentBlocks.push({ type: 'text', text: msg.content } as Anthropic.TextBlock);
      }
      for (const tc of msg.toolCalls) {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        } as Anthropic.ToolUseBlock);
      }
      anthropicMessages.push({ role: 'assistant', content: contentBlocks });
    } else if (msg.role === 'user' && msg.toolResults && msg.toolResults.length > 0) {
      const resultBlocks: Anthropic.ToolResultBlockParam[] = msg.toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.toolCallId,
        content: tr.result,
      }));
      anthropicMessages.push({ role: 'user', content: resultBlocks });
    } else {
      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
  }

  return { system, messages: anthropicMessages };
}

export class AnthropicProvider extends LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  
  private client: Anthropic;
  private defaultTemperature: number;
  private defaultMaxTokens: number;
  private availableModels: string[];

  constructor(config: AnthropicConfig) {
    super();
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
    this.model = config.model;
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.availableModels = config.models ?? ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-20241022'];
  }

  private convertMessages(messages: Message[]) { return convertMessagesToAnthropic(messages); }

  /**
   * Convert tool definitions to Anthropic format
   */
  private convertTools(tools?: ToolDefinition[]): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    const response = await this.client.messages.create({
      model: this.model,
      system,
      messages: anthropicMessages,
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop_sequences: options?.stopSequences,
      tools: this.convertTools(options?.tools),
    });

    // Extract text content
    let content = '';
    const toolCalls: ChatResponse['toolCalls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens,
      },
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' :
                    response.stop_reason === 'max_tokens' ? 'length' : 'stop',
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    const stream = this.client.messages.stream({
      model: this.model,
      system,
      messages: anthropicMessages,
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop_sequences: options?.stopSequences,
      tools: this.convertTools(options?.tools),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if ('text' in delta) {
          yield { type: 'text', content: delta.text };
        } else if ('partial_json' in delta) {
          // Tool input is being streamed - we'll handle the complete tool call at the end
        }
      } else if (event.type === 'content_block_stop') {
        // Block completed
      } else if (event.type === 'message_delta') {
        // Message completed
      }
    }

    // Get final message for any tool calls
    const finalMessage = await stream.finalMessage();
    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_call',
          toolCall: {
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        };
      }
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
