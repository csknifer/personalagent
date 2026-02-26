/**
 * Tests for Ollama provider message conversion.
 * Pure unit tests — no API calls.
 */

import { describe, it, expect } from 'vitest';
import { convertMessagesToOllama } from './OllamaProvider.js';
import type { Message } from '../core/types.js';

describe('convertMessagesToOllama', () => {
  it('passes plain messages through unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Be helpful', timestamp: new Date() },
      { role: 'user', content: 'Hello', timestamp: new Date() },
      { role: 'assistant', content: 'Hi!', timestamp: new Date() },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result).toEqual([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
  });

  it('renders toolResults as markdown when content is empty', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '',
        timestamp: new Date(),
        toolResults: [
          { toolCallId: 'c1', toolName: 'web_search', result: 'search results here' },
        ],
      },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result[0].content).toBe('## Tool Result: web_search\nsearch results here');
  });

  it('renders multiple toolResults separated by double newlines', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '',
        timestamp: new Date(),
        toolResults: [
          { toolCallId: 'c1', toolName: 'web_search', result: 'result A' },
          { toolCallId: 'c2', toolName: 'read_file', result: 'result B' },
        ],
      },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result[0].content).toBe(
      '## Tool Result: web_search\nresult A\n\n## Tool Result: read_file\nresult B'
    );
  });

  it('uses content directly when content is non-empty (even with toolResults)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Here are results',
        timestamp: new Date(),
        toolResults: [
          { toolCallId: 'c1', toolName: 'web_search', result: 'data' },
        ],
      },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result[0].content).toBe('Here are results');
  });
});
