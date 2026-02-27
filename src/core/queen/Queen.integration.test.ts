/**
 * Queen integration tests — full flow without module-level mocking
 *
 * These tests exercise the real Queen → WorkerPool → Worker → RalphLoop
 * pipeline, with only MockProvider and MockMCPServer injected via constructor.
 * The Queen always enters direct execution and uses delegate_tasks for parallel work.
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
        // handleDirectRequest() chat → final answer (no planning step)
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

    // Verify event flow: executing → idle (no planning phase)
    const phases = events
      .filter((e): e is Extract<AgentEvent, { type: 'phase_change' }> => e.type === 'phase_change')
      .map(e => e.phase);
    expect(phases).toEqual(['executing', 'idle']);
  });

  it('should delegate to workers via delegate_tasks tool call', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider({
      responses: [
        // 1: Queen direct request → decides to delegate (tool call)
        'Let me research both topics.',
        // 2: Worker A: ralphLoop chat response
        'Research results for topic A',
        // 3: Worker A: LLMVerifier verification
        JSON.stringify({ complete: true, confidence: 0.95 }),
        // 4: Worker B: ralphLoop chat response
        'Research results for topic B',
        // 5: Worker B: LLMVerifier verification
        JSON.stringify({ complete: true, confidence: 0.9 }),
        // 6: Queen follow-up after delegate_tasks results
        'Here is a combined summary of topics A and B.',
      ],
      supportsTools: true,
    });

    // Tool calls queue: entry per chat() call
    provider.toolCallsQueue = [
      [{ id: 'tc-1', name: 'delegate_tasks', arguments: {
        tasks: [
          { description: 'Research topic A', successCriteria: 'Summary provided' },
          { description: 'Research topic B', successCriteria: 'Summary provided' },
        ],
      }}],
      undefined, // Worker A chat
      undefined, // Worker A verification
      undefined, // Worker B chat
      undefined, // Worker B verification
      undefined, // Queen follow-up
    ];

    const config = createMockConfig({
      hive: {
        queen: { provider: null, model: null, systemPrompt: null },
        worker: { provider: null, model: null, maxConcurrent: 2, timeout: 15000 },
        ralphLoop: { maxIterations: 3, verificationStrategy: 'auto' as const, dimensional: { enabled: true, convergenceThreshold: 0.05, passingScore: 0.8, stagnationWindow: 2, observationMasking: true, maxMaskedOutputLength: 200, reflexionEnabled: true } },
      },
    });

    const mcpServer = new MockMCPServer({
      toolDefinitions: [
        { name: 'web_search', description: 'Search', parameters: {} },
      ],
    });

    const queen = new Queen({
      provider,
      mcpServer: mcpServer as any,
      config,
      onEvent: (e) => events.push(e),
    });

    const result = await queen.processMessage('Research topics A and B');

    expect(result).toContain('combined summary');

    // Check worker events were emitted
    const spawned = events.filter(e => e.type === 'worker_spawned');
    expect(spawned.length).toBe(2);

    const completed = events.filter(e => e.type === 'worker_completed');
    expect(completed.length).toBe(2);

    // delegate_tasks should NOT be sent to MCP
    expect(mcpServer.executeCalls.filter(c => c.name === 'delegate_tasks')).toHaveLength(0);
  });

  it('should handle a multi-turn conversation accumulating memory', async () => {
    const provider = new MockProvider({
      responses: [
        // Turn 1: direct response (no planning)
        'First response',
        // Turn 2: direct response (no planning)
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
        // First chat → tool call response (no planning step)
        'Let me read that file for you.',
        // Follow-up chat after tool results
        'The file contains: file contents here',
      ],
      supportsTools: true,
    });

    // No planning step — tool calls queue maps directly to chat() calls.
    provider.toolCallsQueue = [
      [{ id: 'tc-1', name: 'read_file', arguments: { path: '/tmp/test.txt' } }], // direct — trigger tool
      undefined, // follow-up — no tools
    ];

    const queen = new Queen({
      provider,
      mcpServer: mcpServer as any,
      config: createMockConfig(),
    });

    const result = await queen.processMessage('Read /tmp/test.txt');

    // Non-streaming path accumulates text across tool rounds
    expect(result).toBe('Let me read that file for you.The file contains: file contents here');
    expect(mcpServer.executeCalls).toHaveLength(1);
    expect(mcpServer.executeCalls[0].arguments).toEqual({ path: '/tmp/test.txt' });
  });
});
