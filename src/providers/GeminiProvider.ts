/**
 * Google Gemini LLM Provider
 */

import { GoogleGenAI, Type } from '@google/genai';
import { LLMProvider, type ChatOptions, type ChatResponse, type StreamChunk, type ToolDefinition } from './Provider.js';
import type { Message } from '../core/types.js';

/**
 * Map JSON Schema type strings to Google GenAI Type enum
 */
const typeMap: Record<string, Type> = {
  'string': Type.STRING,
  'number': Type.NUMBER,
  'integer': Type.INTEGER,
  'boolean': Type.BOOLEAN,
  'array': Type.ARRAY,
  'object': Type.OBJECT,
};

interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  models?: string[];
}

/**
 * Convert internal messages to Gemini format.
 * Filters out system messages, maps assistant→model, and handles
 * functionCall / functionResponse parts for tool interactions.
 */
export function convertMessagesToGemini(messages: Message[]): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  return messages
    .filter(m => m.role !== 'system')
    .map(msg => {
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          const part: Record<string, unknown> = {
            functionCall: { name: tc.name, args: tc.arguments },
          };
          // Replay thought_signature for Gemini 3+ models
          if (tc.providerMetadata?.thoughtSignature) {
            part.thoughtSignature = tc.providerMetadata.thoughtSignature;
          }
          parts.push(part);
        }
        return { role: 'model', parts };
      }

      if (msg.role === 'user' && msg.toolResults && msg.toolResults.length > 0) {
        const parts: Array<Record<string, unknown>> = msg.toolResults.map(tr => ({
          functionResponse: {
            name: tr.toolName,
            response: { result: tr.result },
          },
        }));
        return { role: 'user', parts };
      }

      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      };
    });
}

/**
 * Extract the system instruction from messages (first system message content).
 */
export function getGeminiSystemInstruction(messages: Message[]): string | undefined {
  const systemMsgs = messages.filter(m => m.role === 'system');
  if (systemMsgs.length === 0) return undefined;
  return systemMsgs.map(m => m.content).join('\n\n');
}

/**
 * Recursively convert JSON Schema type strings to Google GenAI Type enum values.
 */
export function convertGeminiSchemaType(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      result[key] = typeMap[value.toLowerCase()] || Type.STRING;
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        if (typeof propSchema === 'object' && propSchema !== null) {
          props[propName] = convertGeminiSchemaType(propSchema as Record<string, unknown>);
        } else {
          props[propName] = propSchema;
        }
      }
      result[key] = props;
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      result[key] = convertGeminiSchemaType(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export class GeminiProvider extends LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  
  private client: GoogleGenAI;
  private defaultTemperature: number;
  private defaultMaxTokens: number;
  private availableModels: string[];

  constructor(config: GeminiConfig) {
    super();
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.availableModels = config.models ?? [
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
    ];
  }

  private convertMessages(messages: Message[]) { return convertMessagesToGemini(messages); }
  private getSystemInstruction(messages: Message[]) { return getGeminiSystemInstruction(messages); }
  private convertSchemaType(schema: Record<string, unknown>) { return convertGeminiSchemaType(schema); }

  /**
   * Convert tool definitions to Gemini format
   */
  private convertTools(tools?: ToolDefinition[]): unknown[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    
    return [{
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ? this.convertSchemaType(tool.parameters as Record<string, unknown>) : undefined,
      })),
    }];
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const systemInstruction = this.getSystemInstruction(messages);
    const contents = this.convertMessages(messages);
    
    // Build config with optional tools
    const config: Record<string, unknown> = {
      systemInstruction,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxOutputTokens: options?.maxTokens ?? this.defaultMaxTokens,
      stopSequences: options?.stopSequences,
    };

    // Add tools inside config (per SDK documentation)
    if (options?.tools && options.tools.length > 0) {
      config.tools = this.convertTools(options.tools);
    }
    
    const generateParams = {
      model: this.model,
      contents,
      config,
    };

    const response = await this.client.models.generateContent(generateParams);

    const usage = response.usageMetadata;

    // Extract text and tool calls from raw parts to preserve thought_signature
    // (Gemini 3+ requires thought_signature on functionCall parts in conversation history)
    let text = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; providerMetadata?: Record<string, unknown> }> = [];
    let fcIdx = 0;
    if (response.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if ('text' in part && typeof part.text === 'string') {
          text += part.text;
        }
        if ('functionCall' in part && part.functionCall) {
          const fc = part.functionCall;
          const metadata: Record<string, unknown> = {};
          // Preserve thought_signature for Gemini 3+ models
          if ('thoughtSignature' in part && (part as Record<string, unknown>).thoughtSignature) {
            metadata.thoughtSignature = (part as Record<string, unknown>).thoughtSignature;
          }
          toolCalls.push({
            id: `call_${fcIdx++}`,
            name: fc.name || '',
            arguments: (fc.args as Record<string, unknown>) || {},
            ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
          });
        }
      }
    }

    return {
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: usage ? {
        input: usage.promptTokenCount || 0,
        output: usage.candidatesTokenCount || 0,
        total: usage.totalTokenCount || 0,
      } : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_calls'
        : response.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length'
        : 'stop',
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const systemInstruction = this.getSystemInstruction(messages);
    const contents = this.convertMessages(messages);

    const config: Record<string, unknown> = {
      systemInstruction,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxOutputTokens: options?.maxTokens ?? this.defaultMaxTokens,
      stopSequences: options?.stopSequences,
    };

    // Add tools inside config (same as chat method)
    if (options?.tools && options.tools.length > 0) {
      config.tools = this.convertTools(options.tools);
    }

    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents,
      config,
    });

    let toolCallIdx = 0;
    for await (const chunk of stream) {
      // Extract from raw parts to preserve thought_signature
      const parts = chunk.candidates?.[0]?.content?.parts;
      if (parts) {
        for (const part of parts) {
          if ('text' in part && typeof part.text === 'string') {
            yield { type: 'text', content: part.text };
          }
          if ('functionCall' in part && part.functionCall) {
            const fc = part.functionCall;
            const metadata: Record<string, unknown> = {};
            if ('thoughtSignature' in part && (part as Record<string, unknown>).thoughtSignature) {
              metadata.thoughtSignature = (part as Record<string, unknown>).thoughtSignature;
            }
            yield {
              type: 'tool_call',
              toolCall: {
                id: `call_${Date.now()}_${toolCallIdx++}`,
                name: fc.name || '',
                arguments: (fc.args as Record<string, unknown>) || {},
                ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
              },
            };
          }
        }
      } else {
        // Fallback: no parts in chunk, try text accessor
        const text = chunk.text;
        if (text) {
          yield { type: 'text', content: text };
        }
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
