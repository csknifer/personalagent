/**
 * Queen orchestration unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Queen } from './Queen.js';
import {
  MockProvider,
  MockMCPServer,
  AlwaysPassVerifier,
  createMockConfig,
  createTask,
} from '../../test/helpers.js';
import type { AgentEvent } from '../types.js';

/**
 * Helper: create a Queen with pre-configured mocks.
 * The provider response queue controls the flow:
 *   1st complete() call → TaskPlanner.plan() result
 *   Subsequent chat() calls → direct/aggregation responses
 */
function createTestQueen(options: {
  provider?: MockProvider;
  mcpServer?: MockMCPServer;
  events?: AgentEvent[];
} = {}) {
  const provider = options.provider ?? new MockProvider();
  const events = options.events ?? [];
  const config = createMockConfig();

  const queen = new Queen({
    provider,
    mcpServer: options.mcpServer as any,
    config,
    onEvent: (event) => events.push(event),
  });

  return { queen, provider, events, config };
}

describe('Queen', () => {
  describe('processMessage() — direct path', () => {
    it('should handle a direct request end-to-end', async () => {
      const provider = new MockProvider({
        responses: [
          // No planning step — goes straight to handleDirectRequest() via chat()
          'Hello! How can I help you today?',
        ],
      });

      const { queen } = createTestQueen({ provider });
      const result = await queen.processMessage('Hi there');

      expect(result).toBe('Hello! How can I help you today?');
    });

    it('should add messages to memory', async () => {
      const provider = new MockProvider({
        responses: [
          'Response text',
        ],
      });

      const { queen } = createTestQueen({ provider });
      await queen.processMessage('User says hello');

      const messages = queen.getMemory().getMessages();
      // system + user + assistant
      expect(messages.length).toBe(3);
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('User says hello');
      expect(messages[2].role).toBe('assistant');
      expect(messages[2].content).toBe('Response text');
    });

    it('should emit phase_change events in order', async () => {
      const provider = new MockProvider({
        responses: [
          'OK',
        ],
      });
      const events: AgentEvent[] = [];
      const { queen } = createTestQueen({ provider, events });

      await queen.processMessage('test');

      const phaseEvents = events
        .filter((e): e is Extract<AgentEvent, { type: 'phase_change' }> => e.type === 'phase_change')
        .map(e => e.phase);

      expect(phaseEvents).toContain('executing');
      expect(phaseEvents).toContain('idle');
    });
  });

  describe('processMessage() — direct with tool calls', () => {
    it('should execute tool calls and return follow-up response', async () => {
      const provider = new MockProvider({
        responses: [
          // handleDirectRequest 1st chat() → triggers tool call
          'Let me search for that...',
          // handleDirectRequest 2nd chat() (follow-up after tool results)
          'Based on the search results, here is your answer.',
        ],
        supportsTools: true,
      });

      // No planning step — tool calls queue maps directly to chat() calls.
      provider.toolCallsQueue = [
        [{ id: 'tc-1', name: 'web_search', arguments: { query: 'test' } }], // direct request — trigger tool
        undefined, // follow-up — no tools
      ];

      const mcpServer = new MockMCPServer({
        toolDefinitions: [
          { name: 'web_search', description: 'Search the web', parameters: {} },
        ],
      });

      const { queen } = createTestQueen({ provider, mcpServer });
      const result = await queen.processMessage('Search for cats');

      // Non-streaming path accumulates text across tool rounds
      expect(result).toBe('Let me search for that...Based on the search results, here is your answer.');
      expect(mcpServer.executeCalls).toHaveLength(1);
      expect(mcpServer.executeCalls[0].name).toBe('web_search');
    });
  });

  describe('delegate_tasks tool registration', () => {
    it('includes delegate_tasks in tool definitions sent to LLM', async () => {
      const provider = new MockProvider({
        responses: [
          'Hello!',
        ],
        supportsTools: true,
      });

      const mcpServer = new MockMCPServer({
        toolDefinitions: [
          { name: 'web_search', description: 'Search', parameters: {} },
        ],
      });

      const { queen } = createTestQueen({ provider, mcpServer });
      await queen.processMessage('Hi');

      // No planning step — first chat call is the direct request
      const directCall = provider.chatCalls[0];
      const toolNames = directCall?.options?.tools?.map((t: any) => t.name) ?? [];
      expect(toolNames).toContain('delegate_tasks');
      expect(toolNames).toContain('web_search');
    });
  });

  describe('processMessage() — delegate_tasks interception', () => {
    it('intercepts delegate_tasks tool call and dispatches to DelegateTasksHandler', async () => {
      const provider = new MockProvider({
        responses: [
          // 1: handleDirectRequest chat() → Queen decides to delegate (tool call)
          'I will research this for you.',
          // 2: Worker 1 execution (ralphLoop chat)
          'Found social media profiles for John Doe.',
          // 3: Worker 1 verification (LLMVerifier complete())
          JSON.stringify({ complete: true, confidence: 1.0 }),
          // 4: handleDirectRequest follow-up chat() → Queen synthesizes
          'Based on my research, John Doe has active social media profiles.',
        ],
        supportsTools: true,
      });

      // No planning step — tool calls queue maps directly to chat() calls
      provider.toolCallsQueue = [
        [{ id: 'tc-1', name: 'delegate_tasks', arguments: {
          tasks: [
            { description: 'Search social media for John Doe', successCriteria: 'Find profiles' },
          ],
        }}],
        undefined, // worker chat — no tool calls
        undefined, // worker verification — no tool calls
        undefined, // Queen follow-up — no tools
      ];

      const mcpServer = new MockMCPServer({
        toolDefinitions: [
          { name: 'web_search', description: 'Search', parameters: {} },
        ],
      });

      const events: AgentEvent[] = [];
      const { queen } = createTestQueen({ provider, mcpServer, events });
      const result = await queen.processMessage('Research John Doe');

      // delegate_tasks should NOT be sent to MCP
      expect(mcpServer.executeCalls.filter(c => c.name === 'delegate_tasks')).toHaveLength(0);

      // Worker events should be emitted
      expect(events.some(e => e.type === 'worker_spawned')).toBe(true);
      expect(events.some(e => e.type === 'worker_completed')).toBe(true);

      // Queen should produce a response
      expect(result).toContain('research');
    });
  });

  describe('processMessage() — always direct execution', () => {
    it('should always use direct execution without planning step', async () => {
      const provider = new MockProvider({
        responses: [
          // Only one LLM call — no separate planning call
          'Here is the answer to your complex question.',
        ],
      });

      const { queen } = createTestQueen({ provider });
      const result = await queen.processMessage('Research quantum computing advances');

      expect(result).toBe('Here is the answer to your complex question.');
      // Verify only 1 LLM call — no planning call
      expect(provider.chatCalls).toHaveLength(1);
    });
  });

  describe('processMessage() — error handling', () => {
    it('should return error content and emit error event when provider fails on direct path', async () => {
      // Provider that always throws — handleDirectRequest() will throw.
      // processMessage catches the error and returns an error message instead of throwing.
      const provider = new MockProvider();
      provider.errorToThrow = new Error('Provider is down');

      const events: AgentEvent[] = [];
      const { queen } = createTestQueen({ provider, events });

      const result = await queen.processMessage('test');
      expect(result).toContain('Provider is down');

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);

      // Phase should be reset to idle (bug #2 fix)
      const phaseEvents = events.filter(e => e.type === 'phase_change');
      const lastPhase = phaseEvents[phaseEvents.length - 1];
      expect(lastPhase).toBeDefined();
      expect((lastPhase as { phase: string }).phase).toBe('idle');
    });
  });

  describe('clearConversation()', () => {
    it('should clear memory and tasks', async () => {
      const provider = new MockProvider({
        responses: [
          'Response',
        ],
      });

      const { queen } = createTestQueen({ provider });
      await queen.processMessage('Hello');
      expect(queen.getMemory().getMessages().length).toBeGreaterThan(0);

      queen.clearConversation();
      // After clear, only system message should remain (or empty)
      expect(queen.getCurrentTasks()).toHaveLength(0);
    });
  });

  describe('getWorkerStats()', () => {
    it('should return pool statistics', () => {
      const { queen } = createTestQueen();
      const stats = queen.getWorkerStats();

      expect(stats).toHaveProperty('totalWorkers');
      expect(stats).toHaveProperty('activeWorkers');
      expect(stats).toHaveProperty('queuedTasks');
      expect(stats).toHaveProperty('maxWorkers');
    });
  });
});
