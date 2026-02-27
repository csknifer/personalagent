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
          // 1st: TaskPlanner.plan() via complete() — returns direct
          JSON.stringify({ type: 'direct', reasoning: 'Simple question' }),
          // 2nd: handleDirectRequest() via chat() — the actual response
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
          JSON.stringify({ type: 'direct', reasoning: 'Simple' }),
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
          JSON.stringify({ type: 'direct', reasoning: 'Simple' }),
          'OK',
        ],
      });
      const events: AgentEvent[] = [];
      const { queen } = createTestQueen({ provider, events });

      await queen.processMessage('test');

      const phaseEvents = events
        .filter((e): e is Extract<AgentEvent, { type: 'phase_change' }> => e.type === 'phase_change')
        .map(e => e.phase);

      expect(phaseEvents).toContain('planning');
      expect(phaseEvents).toContain('executing');
      expect(phaseEvents).toContain('idle');
      // planning should come before executing
      expect(phaseEvents.indexOf('planning')).toBeLessThan(phaseEvents.indexOf('executing'));
    });
  });

  describe('processMessage() — direct with tool calls', () => {
    it('should execute tool calls and return follow-up response', async () => {
      const provider = new MockProvider({
        responses: [
          // TaskPlanner → direct
          JSON.stringify({ type: 'direct', reasoning: 'Needs tools' }),
          // handleDirectRequest 1st chat() → triggers tool call
          'Let me search for that...',
          // handleDirectRequest 2nd chat() (follow-up after tool results)
          'Based on the search results, here is your answer.',
        ],
        supportsTools: true,
      });

      // Use toolCallsQueue: one entry per chat() call.
      // Call 1 = TaskPlanner.plan(), Call 2 = direct request (tool call), Call 3 = follow-up (no tools).
      provider.toolCallsQueue = [
        undefined, // plan call — no tools
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

      // Non-streaming path now accumulates text across tool rounds (matching streaming behavior)
      expect(result).toBe('Let me search for that...Based on the search results, here is your answer.');
      expect(mcpServer.executeCalls).toHaveLength(1);
      expect(mcpServer.executeCalls[0].name).toBe('web_search');
    });
  });

  describe('delegate_tasks tool registration', () => {
    it('includes delegate_tasks in tool definitions sent to LLM', async () => {
      const provider = new MockProvider({
        responses: [
          // TaskPlanner.plan() → direct
          JSON.stringify({ type: 'direct', reasoning: 'Simple' }),
          // handleDirectRequest chat() → simple response
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

      // The direct request chat call is the 2nd call (1st is planning)
      const directCall = provider.chatCalls[1];
      const toolNames = directCall?.options?.tools?.map((t: any) => t.name) ?? [];
      expect(toolNames).toContain('delegate_tasks');
      expect(toolNames).toContain('web_search');
    });
  });

  describe('processMessage() — delegate_tasks interception', () => {
    it('intercepts delegate_tasks tool call and dispatches to DelegateTasksHandler', async () => {
      const provider = new MockProvider({
        responses: [
          // 1: TaskPlanner.plan() → direct
          JSON.stringify({ type: 'direct', reasoning: 'Research task' }),
          // 2: handleDirectRequest chat() → Queen decides to delegate (tool call)
          'I will research this for you.',
          // 3: Worker 1 execution (ralphLoop chat)
          'Found social media profiles for John Doe.',
          // 4: Worker 1 verification (LLMVerifier complete())
          JSON.stringify({ complete: true, confidence: 1.0 }),
          // 5: handleDirectRequest follow-up chat() → Queen synthesizes
          'Based on my research, John Doe has active social media profiles.',
        ],
        supportsTools: true,
      });

      // Queue tool calls per chat() call
      provider.toolCallsQueue = [
        undefined, // plan call — no tools
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

  describe('processMessage() — decomposed path', () => {
    it('should decompose into tasks, execute workers, and aggregate', async () => {
      const provider = new MockProvider({
        responses: [
          // TaskPlanner.plan() → decomposed with 2 tasks
          JSON.stringify({
            type: 'decomposed',
            reasoning: 'Multi-part request',
            tasks: [
              { id: 't1', description: 'Part 1', successCriteria: 'Done', dependencies: [], priority: 1 },
              { id: 't2', description: 'Part 2', successCriteria: 'Done', dependencies: [], priority: 2 },
            ],
          }),
          // Worker 1 response (ralphLoop chat)
          'Result for part 1',
          // Worker 1 verification (LLMVerifier uses complete())
          JSON.stringify({ complete: true, confidence: 1.0 }),
          // Worker 2 response
          'Result for part 2',
          // Worker 2 verification
          JSON.stringify({ complete: true, confidence: 1.0 }),
          // Queen.aggregateResults() synthesis call
          'Combined answer from both parts.',
        ],
      });

      const events: AgentEvent[] = [];
      const { queen } = createTestQueen({ provider, events });
      const result = await queen.processMessage('Do two things at once');

      expect(result).toBe('Combined answer from both parts.');

      // Should have worker_spawned events
      const spawnedEvents = events.filter(e => e.type === 'worker_spawned');
      expect(spawnedEvents).toHaveLength(2);
    });

    it('should return single worker result without synthesis when only 1 task', async () => {
      const provider = new MockProvider({
        responses: [
          JSON.stringify({
            type: 'decomposed',
            reasoning: 'Single subtask',
            tasks: [
              { id: 't1', description: 'Only task', successCriteria: 'Done', dependencies: [], priority: 1 },
            ],
          }),
          'Single worker output',
          JSON.stringify({ complete: true, confidence: 1.0 }),
        ],
      });

      const { queen } = createTestQueen({ provider });
      const result = await queen.processMessage('Do one thing');

      // With only 1 result, Queen returns it directly without aggregation
      expect(result).toBe('Single worker output');
    });
  });

  describe('processMessage() — fallback behavior', () => {
    it('should fall back to direct when task planner response is unparseable', async () => {
      const provider = new MockProvider({
        responses: [
          // TaskPlanner gets garbage → defaults to direct
          'not valid json at all',
          // Direct request response
          'Handled directly',
        ],
      });

      const { queen } = createTestQueen({ provider });
      const result = await queen.processMessage('Anything');

      expect(result).toBe('Handled directly');
    });
  });

  describe('processMessage() — error handling', () => {
    it('should return error content and emit error event when provider fails on direct path', async () => {
      // Provider that always throws — TaskPlanner.plan() will catch the error
      // and default to 'direct', then handleDirectRequest() will also throw.
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
          JSON.stringify({ type: 'direct', reasoning: 'Simple' }),
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
