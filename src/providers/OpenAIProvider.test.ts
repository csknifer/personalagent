/**
 * Tests for OpenAI provider message conversion and helper functions.
 * Pure unit tests — no API calls.
 */

import { describe, it, expect } from 'vitest';
import { convertMessagesToOpenAI, safeParseToolArgs } from './OpenAIProvider.js';
import type { Message } from '../core/types.js';

describe('convertMessagesToOpenAI', () => {
  it('converts plain text messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful', timestamp: new Date() },
      { role: 'user', content: 'Hello', timestamp: new Date() },
      { role: 'assistant', content: 'Hi!', timestamp: new Date() },
    ];
    const result = convertMessagesToOpenAI(messages);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'Hi!' });
  });

  it('converts assistant toolCalls with JSON-stringified arguments', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Searching...',
        timestamp: new Date(),
        toolCalls: [
          { id: 'call_1', name: 'web_search', arguments: { query: 'test' } },
        ],
      },
    ];
    const result = convertMessagesToOpenAI(messages);
    expect(result).toHaveLength(1);
    const msg = result[0] as unknown as Record<string, unknown>;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Searching...');
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('call_1');
    expect(toolCalls[0].type).toBe('function');
    const fn = toolCalls[0].function as Record<string, unknown>;
    expect(fn.name).toBe('web_search');
    expect(fn.arguments).toBe('{"query":"test"}');
  });

  it('expands multiple toolResults into individual role:tool messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '',
        timestamp: new Date(),
        toolResults: [
          { toolCallId: 'call_1', toolName: 'web_search', result: 'result A' },
          { toolCallId: 'call_2', toolName: 'read_file', result: 'result B' },
        ],
      },
    ];
    const result = convertMessagesToOpenAI(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result A' });
    expect(result[1]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'result B' });
  });
});

describe('safeParseToolArgs', () => {
  it('parses valid JSON', () => {
    expect(safeParseToolArgs('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns empty object for invalid JSON', () => {
    expect(safeParseToolArgs('not json')).toEqual({});
  });

  it('returns empty object for null', () => {
    expect(safeParseToolArgs(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(safeParseToolArgs(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(safeParseToolArgs('')).toEqual({});
  });

  it('returns empty object for truncated JSON (stream cut off mid-object)', () => {
    expect(safeParseToolArgs('{"query": "tes')).toEqual({});
  });
});
