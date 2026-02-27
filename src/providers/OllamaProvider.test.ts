/**
 * Tests for Ollama provider message conversion.
 * Pure unit tests — no API calls.
 */

import { describe, it, expect } from 'vitest';
import { convertMessagesToOllama, OllamaProvider } from './OllamaProvider.js';
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

describe('OllamaProvider.supportsTools', () => {
  it('returns true for exact base model names', () => {
    const provider = new OllamaProvider({ model: 'llama3' });
    expect(provider.supportsTools()).toBe(true);
  });

  it('returns true for model names with version tags', () => {
    const provider = new OllamaProvider({ model: 'llama3.1:8b' });
    expect(provider.supportsTools()).toBe(true);
  });

  it('returns true for mistral:latest', () => {
    const provider = new OllamaProvider({ model: 'mistral:latest' });
    expect(provider.supportsTools()).toBe(true);
  });

  it('returns true for qwen2.5', () => {
    const provider = new OllamaProvider({ model: 'qwen2.5:14b' });
    expect(provider.supportsTools()).toBe(true);
  });

  it('returns true for mixtral', () => {
    const provider = new OllamaProvider({ model: 'mixtral:8x7b' });
    expect(provider.supportsTools()).toBe(true);
  });

  it('returns true for command-r', () => {
    const provider = new OllamaProvider({ model: 'command-r:latest' });
    expect(provider.supportsTools()).toBe(true);
  });

  it('returns false for models without tool support', () => {
    const provider = new OllamaProvider({ model: 'codellama:7b' });
    expect(provider.supportsTools()).toBe(false);
  });

  it('returns false for unknown models', () => {
    const provider = new OllamaProvider({ model: 'phi3:mini' });
    expect(provider.supportsTools()).toBe(false);
  });

  it('handles uppercase model names', () => {
    const provider = new OllamaProvider({ model: 'Llama3:8b' });
    expect(provider.supportsTools()).toBe(true);
  });
});

describe('OllamaProvider.chatStream tools passthrough', () => {
  it('passes tools to the Ollama client in streaming mode', async () => {
    const provider = new OllamaProvider({ model: 'llama3' });

    // Capture the args passed to client.chat
    let capturedArgs: Record<string, unknown> | undefined;
    const fakeStream = (async function* () {
      yield { message: { content: 'hello', tool_calls: undefined } };
    })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = {
      chat: async (args: Record<string, unknown>) => {
        capturedArgs = args;
        return fakeStream;
      },
    };

    const tools = [
      { name: 'test_tool', description: 'A test tool', parameters: { type: 'object', properties: {} } },
    ];

    const stream = provider.chatStream([], { tools });
    // Consume the stream to trigger the call
    for await (const _chunk of stream) { /* drain */ }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.tools).toBeDefined();
    expect((capturedArgs!.tools as unknown[])[0]).toEqual({
      type: 'function',
      function: { name: 'test_tool', description: 'A test tool', parameters: { type: 'object', properties: {} } },
    });
  });
});
