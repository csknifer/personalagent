/**
 * Queen integration tests — full flow without module-level mocking
 *
 * These tests exercise the real Queen → TaskPlanner → WorkerPool → Worker → RalphLoop
 * pipeline, with only MockProvider and MockMCPServer injected via constructor.
 */

import { describe, it, expect } from 'vitest';
import { Queen } from './Queen.js';
import { MockProvider, MockMCPServer, createMockConfig } from '../../test/helpers.js';
import type { AgentEvent } from '../types.js';

describe('Queen integration', () => {
  it('should complete a full direct request flow', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider({
      responses: [
        // TaskPlanner.plan() → direct
        JSON.stringify({ type: 'direct', reasoning: 'Simple greeting' }),
        // handleDirectRequest() chat → final answer
        'Hello! I am your assistant.',
      ],
    });

    const queen = new Queen({
      provider,
      config: createMockConfig(),
      onEvent: (e) => events.push(e),
    });

    const result = await queen.processMessage('Hello');

    // Verify response
    expect(result).toBe('Hello! I am your assistant.');

    // Verify memory has user + assistant messages
    const messages = queen.getMemory().getMessages();
    const userMsg = messages.find(m => m.role === 'user');
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(userMsg?.content).toBe('Hello');
    expect(assistantMsg?.content).toBe('Hello! I am your assistant.');

    // Verify event flow: planning → executing → idle
    const phases = events
      .filter((e): e is Extract<AgentEvent, { type: 'phase_change' }> => e.type === 'phase_change')
      .map(e => e.phase);
    expect(phases).toEqual(['planning', 'executing', 'idle']);
  });

  it('should complete a full decomposed request flow with 2 tasks', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider({
      responses: [
        // TaskPlanner.plan() → decomposed
        JSON.stringify({
          type: 'decomposed',
          reasoning: 'Two independent sub-tasks',
          tasks: [
            { id: 'task-a', description: 'Research topic A', successCriteria: 'Summary provided', dependencies: [], priority: 1 },
            { id: 'task-b', description: 'Research topic B', successCriteria: 'Summary provided', dependencies: [], priority: 2 },
          ],
        }),
        // Worker A: ralphLoop chat response
        'Research results for topic A',
        // Worker A: LLMVerifier verification
        JSON.stringify({ complete: true, confidence: 0.95 }),
        // Worker B: ralphLoop chat response
        'Research results for topic B',
        // Worker B: LLMVerifier verification
        JSON.stringify({ complete: true, confidence: 0.9 }),
        // Queen aggregation synthesis
        'Here is a combined summary of topics A and B.',
      ],
    });

    const config = createMockConfig({
      hive: {
        queen: { provider: null, model: null, systemPrompt: null },
        worker: { provider: null, model: null, maxConcurrent: 2, timeout: 15000 },
        ralphLoop: { maxIterations: 3, verificationStrategy: 'auto' as const, dimensional: { enabled: true, convergenceThreshold: 0.05, passingScore: 0.8, stagnationWindow: 2, observationMasking: true, maxMaskedOutputLength: 200, reflexionEnabled: true } },
      },
    });

    const queen = new Queen({
      provider,
      config,
      onEvent: (e) => events.push(e),
    });

    const result = await queen.processMessage('Research topics A and B');

    expect(result).toBe('Here is a combined summary of topics A and B.');

    // Check worker events were emitted
    const spawned = events.filter(e => e.type === 'worker_spawned');
    expect(spawned.length).toBe(2);

    const completed = events.filter(e => e.type === 'worker_completed');
    expect(completed.length).toBe(2);
  });

  it('should handle a multi-turn conversation accumulating memory', async () => {
    const provider = new MockProvider({
      responses: [
        // Turn 1: plan → direct
        JSON.stringify({ type: 'direct', reasoning: 'Simple' }),
        'First response',
        // Turn 2: plan → direct
        JSON.stringify({ type: 'direct', reasoning: 'Follow-up' }),
        'Second response, building on context',
      ],
    });

    const queen = new Queen({
      provider,
      config: createMockConfig(),
    });

    const result1 = await queen.processMessage('Tell me about X');
    expect(result1).toBe('First response');

    const result2 = await queen.processMessage('Tell me more');
    expect(result2).toBe('Second response, building on context');

    // Memory should have system + 2 user + 2 assistant = 5 messages
    const messages = queen.getMemory().getMessages();
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    expect(userMsgs).toHaveLength(2);
    expect(assistantMsgs).toHaveLength(2);
  });

  it('should handle direct request with MCP tool calls end-to-end', async () => {
    const mcpServer = new MockMCPServer({
      toolDefinitions: [
        { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
    });
    mcpServer.executeResults.set('read_file', { success: true, data: { content: 'file contents here' } });

    const provider = new MockProvider({
      responses: [
        // TaskPlanner → direct
        JSON.stringify({ type: 'direct', reasoning: 'Needs file access' }),
        // First chat → tool call response
        'Let me read that file for you.',
        // Follow-up chat after tool results
        'The file contains: file contents here',
      ],
      supportsTools: true,
    });

    // Use toolCallsQueue: one entry per chat() call.
    // Call 1 = TaskPlanner.plan(), Call 2 = direct request (tool call), Call 3 = follow-up.
    provider.toolCallsQueue = [
      undefined, // plan call — no tools
      [{ id: 'tc-1', name: 'read_file', arguments: { path: '/tmp/test.txt' } }], // direct — trigger tool
      undefined, // follow-up — no tools
    ];

    const queen = new Queen({
      provider,
      mcpServer: mcpServer as any,
      config: createMockConfig(),
    });

    const result = await queen.processMessage('Read /tmp/test.txt');

    // Non-streaming path now accumulates text across tool rounds (matching streaming behavior)
    expect(result).toBe('Let me read that file for you.The file contains: file contents here');
    expect(mcpServer.executeCalls).toHaveLength(1);
    expect(mcpServer.executeCalls[0].arguments).toEqual({ path: '/tmp/test.txt' });
  });
});
