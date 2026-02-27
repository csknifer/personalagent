/**
 * Ollama LLM Provider for local models
 */

import { Ollama } from 'ollama';
import { LLMProvider, type ChatOptions, type ChatResponse, type StreamChunk, type ToolDefinition } from './Provider.js';
import type { Message } from '../core/types.js';

interface OllamaConfig {
  model: string;
  host?: string;
  temperature?: number;
  models?: string[];
}

/**
 * Convert internal messages to Ollama format.
 * Ollama uses plain text, so tool results are rendered inline as markdown.
 */
export function convertMessagesToOllama(messages: Message[]): Array<{ role: string; content: string }> {
  return messages.map(msg => {
    if (msg.toolResults && msg.toolResults.length > 0 && !msg.content) {
      const rendered = msg.toolResults
        .map(tr => `## Tool Result: ${tr.toolName}\n${tr.result}`)
        .join('\n\n');
      return { role: msg.role, content: rendered };
    }
    return { role: msg.role, content: msg.content };
  });
}

export class OllamaProvider extends LLMProvider {
  readonly name = 'ollama';
  readonly model: string;
  
  private client: Ollama;
  private defaultTemperature: number;
  private availableModels: string[];

  constructor(config: OllamaConfig) {
    super();
    this.client = new Ollama({
      host: config.host || 'http://localhost:11434',
    });
    this.model = config.model;
    this.defaultTemperature = config.temperature ?? 0.7;
    this.availableModels = config.models ?? ['llama3', 'mistral', 'codellama', 'deepseek-coder'];
  }

  private convertMessages(messages: Message[]) { return convertMessagesToOllama(messages); }

  /**
   * Convert tool definitions to Ollama format
   */
  private convertTools(tools?: ToolDefinition[]): unknown[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const response = await this.client.chat({
      model: this.model,
      messages: this.convertMessages(messages),
      options: {
        temperature: options?.temperature ?? this.defaultTemperature,
      },
      tools: this.convertTools(options?.tools) as undefined,
    });

    const content = response.message.content || '';

    // Handle tool calls if present
    const toolCalls = response.message.tool_calls?.map((tc, idx) => ({
      id: `call_${idx}`,
      name: tc.function.name,
      arguments: tc.function.arguments as Record<string, unknown>,
    }));

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: response.prompt_eval_count !== undefined ? {
        input: response.prompt_eval_count,
        output: response.eval_count || 0,
        total: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      } : undefined,
      finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await this.client.chat({
      model: this.model,
      messages: this.convertMessages(messages),
      options: {
        temperature: options?.temperature ?? this.defaultTemperature,
      },
      tools: this.convertTools(options?.tools) as undefined,
      stream: true,
    });

    let toolCallIdx = 0;
    for await (const chunk of response) {
      if (chunk.message.content) {
        yield { type: 'text', content: chunk.message.content };
      }

      // Handle tool calls
      if (chunk.message.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `call_${Date.now()}_${toolCallIdx++}`,
              name: tc.function.name,
              arguments: tc.function.arguments as Record<string, unknown>,
            },
          };
        }
      }
    }

    yield { type: 'done' };
  }

  supportsTools(): boolean {
    // Not all Ollama models support tools — match base name before the ':' tag
    const base = this.model.split(':')[0].toLowerCase();
    const toolCapableModels = ['llama3', 'llama3.1', 'llama3.2', 'llama3.3', 'mistral', 'mixtral', 'qwen2.5', 'command-r'];
    return toolCapableModels.some(m => base === m || base.startsWith(m + '.'));
  }

  getAvailableModels(): string[] {
    return this.availableModels;
  }

  /**
   * Refresh the list of available models from Ollama
   */
  async refreshModels(): Promise<string[]> {
    try {
      const response = await this.client.list();
      this.availableModels = response.models.map(m => m.name);
      return this.availableModels;
    } catch {
      return this.availableModels;
    }
  }
}
