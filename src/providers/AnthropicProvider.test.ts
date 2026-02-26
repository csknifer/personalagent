/**
 * Tests for Anthropic provider message conversion.
 * Pure unit tests — no API calls.
 */

import { describe, it, expect } from 'vitest';
import { convertMessagesToAnthropic } from './AnthropicProvider.js';
import type { Message } from '../core/types.js';

describe('convertMessagesToAnthropic', () => {
  it('extracts system message separately', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful', timestamp: new Date() },
      { role: 'user', content: 'Hello', timestamp: new Date() },
    ];
    const result = convertMessagesToAnthropic(messages);
    expect(result.system).toBe('You are helpful');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('returns undefined system when no system message present', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello', timestamp: new Date() },
    ];
    const result = convertMessagesToAnthropic(messages);
    expect(result.system).toBeUndefined();
  });

  it('converts assistant toolCalls to tool_use content blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Let me search',
        timestamp: new Date(),
        toolCalls: [
          { id: 'tu_1', name: 'web_search', arguments: { query: 'test' } },
        ],
      },
    ];
    const result = convertMessagesToAnthropic(messages);
    const msg = result.messages[0];
    expect(msg.role).toBe('assistant');
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me search' });
    expect(blocks[1]).toMatchObject({
      type: 'tool_use',
      id: 'tu_1',
      name: 'web_search',
      input: { query: 'test' },
    });
  });

  it('uses tool_use_id (not tool_call_id) for tool_result blocks', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '',
        timestamp: new Date(),
        toolResults: [
          { toolCallId: 'tu_1', toolName: 'web_search', result: 'found it' },
        ],
      },
    ];
    const result = convertMessagesToAnthropic(messages);
    const msg = result.messages[0];
    expect(msg.role).toBe('user');
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'found it',
    });
  });

  it('converts plain assistant and user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello', timestamp: new Date() },
      { role: 'assistant', content: 'Hi!', timestamp: new Date() },
    ];
    const result = convertMessagesToAnthropic(messages);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
  });

  it('omits text block when assistant content is empty with tool calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        toolCalls: [
          { id: 'tu_1', name: 'read_file', arguments: { path: '/a.txt' } },
        ],
      },
    ];
    const result = convertMessagesToAnthropic(messages);
    const blocks = result.messages[0].content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_use');
  });
});
