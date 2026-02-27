/**
 * Queen.streamMessage() tests
 *
 * Tests the streaming path which has its own tool-call loop
 * and error handling distinct from processMessage().
 * The Queen always enters direct streaming — delegate_tasks triggers workers.
 */

import { describe, it, expect } from 'vitest';
import { Queen } from './Queen.js';
import { MockProvider, MockMCPServer, createMockConfig } from '../../test/helpers.js';
import type { StreamChunk } from '../../providers/Provider.js';
import type { AgentEvent } from '../types.js';

/** Collect all chunks from the stream into an array */
async function collectChunks(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Collect just the text content from a stream */
async function collectText(stream: AsyncGenerator<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) {
      text += chunk.content;
    }
  }
  return text;
}

describe('Queen.streamMessage()', () => {
  describe('direct streaming', () => {
    it('should yield text chunks and done for a simple direct request', async () => {
      const provider = new MockProvider({
        responses: [
          // No planning step — goes straight to streaming direct execution
          'Streamed response text',
        ],
      });

      const queen = new Queen({ provider, config: createMockConfig() });
      const chunks = await collectChunks(queen.streamMessage('Hello'));

      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks.length).toBeGreaterThanOrEqual(1);
      expect(textChunks.map(c => c.content).join('')).toBe('Streamed response text');

      // Should always end with 'done'
      expect(chunks[chunks.length - 1].type).toBe('done');
    });

    it('should add messages to memory after streaming', async () => {
      const provider = new MockProvider({
        responses: [
          'Stream result',
        ],
      });

      const queen = new Queen({ provider, config: createMockConfig() });
      // Consume the full stream
      await collectChunks(queen.streamMessage('Test input'));

      const messages = queen.getMemory().getMessages();
      const userMsg = messages.find(m => m.role === 'user');
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(userMsg?.content).toBe('Test input');
      expect(assistantMsg?.content).toBe('Stream result');
    });
  });

  describe('streaming with tool calls', () => {
    it('should handle tool calls during streaming and yield follow-up text', async () => {
      const provider = new MockProvider({
        responses: [
          // 1st stream round: triggers tool call (no planning step)
          'Searching...',
          // 2nd stream round: follow-up after tool results
          'Found the answer: 42',
        ],
        supportsTools: true,
      });

      // No planning step — tool calls queue maps directly to chat() calls
      provider.toolCallsQueue = [
        [{ id: 'tc-1', name: 'web_search', arguments: { query: 'meaning of life' } }],
        undefined, // follow-up
      ];

      const mcpServer = new MockMCPServer({
        toolDefinitions: [{ name: 'web_search', description: 'Search', parameters: {} }],
      });

      const queen = new Queen({
        provider,
        mcpServer: mcpServer as any,
        config: createMockConfig(),
      });

      const chunks = await collectChunks(queen.streamMessage('What is 42?'));

      // Should have tool_call chunks
      const toolCallChunks = chunks.filter(c => c.type === 'tool_call');
      expect(toolCallChunks.length).toBeGreaterThanOrEqual(1);

      // Should end with text content from follow-up and done
      expect(chunks[chunks.length - 1].type).toBe('done');

      // MCP server should have been called
      expect(mcpServer.executeCalls).toHaveLength(1);
    });
  });

  describe('delegate_tasks streaming', () => {
    it('should handle delegate_tasks during streaming', async () => {
      const provider = new MockProvider({
        responses: [
          // 1st stream: Queen decides to delegate (tool call)
          'Let me research that.',
          // Worker execution
          'Worker output',
          JSON.stringify({ complete: true, confidence: 1.0 }),
          // 2nd stream: Queen synthesizes from delegate_tasks results
          'Here are my findings.',
        ],
        supportsTools: true,
      });

      provider.toolCallsQueue = [
        [{ id: 'tc-1', name: 'delegate_tasks', arguments: {
          tasks: [{ description: 'Research topic', successCriteria: 'Done' }],
        }}],
        undefined, // Worker chat
        undefined, // Worker verification
        undefined, // Follow-up
      ];

      const mcpServer = new MockMCPServer({
        toolDefinitions: [{ name: 'web_search', description: 'Search', parameters: {} }],
      });

      const queen = new Queen({
        provider,
        mcpServer: mcpServer as any,
        config: createMockConfig(),
      });

      const text = await collectText(queen.streamMessage('Research quantum computing'));
      expect(text).toContain('research');

      // delegate_tasks should NOT be sent to MCP
      expect(mcpServer.executeCalls.filter(c => c.name === 'delegate_tasks')).toHaveLength(0);
    });
  });

  describe('error handling in streaming', () => {
    it('should yield error as text chunk instead of throwing', async () => {
      const provider = new MockProvider();
      provider.errorToThrow = new Error('Stream failed');

      const events: AgentEvent[] = [];
      const queen = new Queen({
        provider,
        config: createMockConfig(),
        onEvent: (e) => events.push(e),
      });

      const chunks = await collectChunks(queen.streamMessage('test'));

      // Should yield error as text, not throw
      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks.some(c => c.content?.includes('Stream failed'))).toBe(true);

      // Should still yield done
      expect(chunks[chunks.length - 1].type).toBe('done');

      // Should emit error event
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('should store error message in memory even on failure', async () => {
      const provider = new MockProvider();
      provider.errorToThrow = new Error('Boom');

      const queen = new Queen({ provider, config: createMockConfig() });
      await collectChunks(queen.streamMessage('test'));

      const messages = queen.getMemory().getMessages();
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.content).toContain('Boom');
    });
  });

  describe('phase events during streaming', () => {
    it('should emit executing → idle phases', async () => {
      const provider = new MockProvider({
        responses: [
          'OK',
        ],
      });

      const events: AgentEvent[] = [];
      const queen = new Queen({
        provider,
        config: createMockConfig(),
        onEvent: (e) => events.push(e),
      });

      await collectChunks(queen.streamMessage('test'));

      const phases = events
        .filter((e): e is Extract<AgentEvent, { type: 'phase_change' }> => e.type === 'phase_change')
        .map(e => e.phase);

      expect(phases).toContain('executing');
      expect(phases).toContain('idle');
    });
  });
});
