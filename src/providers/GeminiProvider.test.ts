/**
 * Tests for Gemini provider message conversion functions.
 * Pure unit tests — no API calls.
 */

import { describe, it, expect } from 'vitest';
import { Type } from '@google/genai';
import { convertMessagesToGemini, getGeminiSystemInstruction, convertGeminiSchemaType } from './GeminiProvider.js';
import type { Message } from '../core/types.js';

describe('convertMessagesToGemini', () => {
  it('filters out system messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful', timestamp: new Date() },
      { role: 'user', content: 'Hello', timestamp: new Date() },
    ];
    const result = convertMessagesToGemini(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('renames assistant role to model', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'Hi there', timestamp: new Date() },
    ];
    const result = convertMessagesToGemini(messages);
    expect(result[0].role).toBe('model');
    expect(result[0].parts).toEqual([{ text: 'Hi there' }]);
  });

  it('converts toolCalls to functionCall parts', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Let me search',
        timestamp: new Date(),
        toolCalls: [
          { id: 'c1', name: 'web_search', arguments: { query: 'test' } },
        ],
      },
    ];
    const result = convertMessagesToGemini(messages);
    expect(result[0].role).toBe('model');
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0]).toEqual({ text: 'Let me search' });
    expect(result[0].parts[1]).toEqual({
      functionCall: { name: 'web_search', args: { query: 'test' } },
    });
  });

  it('omits text part when assistant content is empty', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { path: '/a.txt' } },
        ],
      },
    ];
    const result = convertMessagesToGemini(messages);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0]).toHaveProperty('functionCall');
  });

  it('converts toolResults to functionResponse parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '',
        timestamp: new Date(),
        toolResults: [
          { toolCallId: 'c1', toolName: 'web_search', result: 'found it' },
        ],
      },
    ];
    const result = convertMessagesToGemini(messages);
    expect(result[0].role).toBe('user');
    expect(result[0].parts[0]).toEqual({
      functionResponse: {
        name: 'web_search',
        response: { result: 'found it' },
      },
    });
  });

  it('handles plain user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello', timestamp: new Date() },
    ];
    const result = convertMessagesToGemini(messages);
    expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'Hello' }] });
  });
});

describe('getGeminiSystemInstruction', () => {
  it('returns system message content', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Be helpful', timestamp: new Date() },
      { role: 'user', content: 'Hi', timestamp: new Date() },
    ];
    expect(getGeminiSystemInstruction(messages)).toBe('Be helpful');
  });

  it('returns undefined when no system message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi', timestamp: new Date() },
    ];
    expect(getGeminiSystemInstruction(messages)).toBeUndefined();
  });
});

describe('convertGeminiSchemaType', () => {
  it('converts string type to Type.STRING', () => {
    const result = convertGeminiSchemaType({ type: 'string' });
    expect(result.type).toBe(Type.STRING);
  });

  it('converts number type to Type.NUMBER', () => {
    const result = convertGeminiSchemaType({ type: 'number' });
    expect(result.type).toBe(Type.NUMBER);
  });

  it('converts object with nested properties recursively', () => {
    const result = convertGeminiSchemaType({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
      },
    });
    expect(result.type).toBe(Type.OBJECT);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.name.type).toBe(Type.STRING);
    expect(props.count.type).toBe(Type.INTEGER);
  });

  it('converts array items recursively', () => {
    const result = convertGeminiSchemaType({
      type: 'array',
      items: { type: 'boolean' },
    });
    expect(result.type).toBe(Type.ARRAY);
    expect((result.items as Record<string, unknown>).type).toBe(Type.BOOLEAN);
  });

  it('falls back to Type.STRING for unknown types', () => {
    const result = convertGeminiSchemaType({ type: 'foobar' });
    expect(result.type).toBe(Type.STRING);
  });

  it('preserves non-type fields', () => {
    const result = convertGeminiSchemaType({
      type: 'string',
      description: 'A name',
      required: true,
    });
    expect(result.description).toBe('A name');
    expect(result.required).toBe(true);
  });
});
