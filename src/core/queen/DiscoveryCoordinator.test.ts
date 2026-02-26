import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { Task, TaskResult, TaskPlan, AgentEvent, AgentEventHandler } from '../types.js';
import type { ProgressiveDiscoveryConfig } from '../../config/types.js';
import type { ChatResponse } from '../../providers/Provider.js';
import type { Message } from '../types.js';

// --- Mock Provider ---
function createMockProvider(chatResponses: ChatResponse[]) {
  let callIndex = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    chat: vi.fn(async (_messages: Message[]) => {
      const response = chatResponses[callIndex] ?? chatResponses[chatResponses.length - 1];
      callIndex++;
      return response;
    }),
    chatStream: vi.fn(),
    complete: vi.fn(),
    supportsTools: () => false,
    getAvailableModels: () => ['mock-model'],
  };
}

// --- Mock WorkerPool ---
function createMockWorkerPool(waveResults: Map<string, TaskResult>[]) {
  let waveIndex = 0;
  return {
    executeTasks: vi.fn(async (_tasks: Task[]) => {
      const result = waveResults[waveIndex] ?? waveResults[waveResults.length - 1];
      waveIndex++;
      return result;
    }),
  };
}

function makeTask(id: string, description: string): Task {
  return {
    id,
    description,
    successCriteria: 'Complete successfully',
    dependencies: [],
    priority: 1,
    status: 'pending' as const,
    createdAt: new Date(),
  };
}

function makeTaskResult(output: string, findings: string[] = []): TaskResult {
  return {
    success: true,
    output,
    findings,
    iterations: 1,
  };
}

function defaultConfig(overrides: Partial<ProgressiveDiscoveryConfig> = {}): ProgressiveDiscoveryConfig {
  return {
    enabled: true,
    maxWaves: 4,
    waveTimeout: 60000,
    totalTimeout: 300000,
    stoppingThreshold: 1,
    ...overrides,
  };
}

describe('DiscoveryCoordinator', () => {
  let events: AgentEvent[];
  let eventHandler: AgentEventHandler;

  beforeEach(() => {
    events = [];
    eventHandler = (event: AgentEvent) => events.push(event);
  });

  it('single wave + sufficient: executes 1 wave, LLM says sufficient, returns findings', async () => {
    const wave1Results = new Map<string, TaskResult>();
    wave1Results.set('w1-t1', makeTaskResult('Found info about topic A', ['Topic A is important', 'Topic A relates to B']));

    const mockPool = createMockWorkerPool([wave1Results]);

    // After wave 1, LLM decides "sufficient"
    const mockProvider = createMockProvider([
      // planNextWave response
      { content: JSON.stringify({ action: 'sufficient', reasoning: 'We have enough information' }) },
    ]);

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider as any,
      workerPool: mockPool as any,
      config: defaultConfig(),
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'Investigate topic',
      tasks: [makeTask('t1', 'Research topic A')],
      discoveryMode: true,
    };

    const result = await coordinator.execute('Tell me about topic A', plan, { eventHandler });

    // Should have 1 wave
    expect(result.waveCount).toBe(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].content).toBe('Topic A is important');
    expect(result.findings[1].content).toBe('Topic A relates to B');

    // Verify events emitted
    const phaseEvents = events.filter(e => e.type === 'phase_change');
    expect(phaseEvents.some(e => e.type === 'phase_change' && e.phase === 'discovering')).toBe(true);

    const waveStartEvents = events.filter(e => e.type === 'discovery_wave_start');
    expect(waveStartEvents).toHaveLength(1);

    const waveCompleteEvents = events.filter(e => e.type === 'discovery_wave_complete');
    expect(waveCompleteEvents).toHaveLength(1);

    const decisionEvents = events.filter(e => e.type === 'discovery_decision');
    expect(decisionEvents).toHaveLength(1);
    expect((decisionEvents[0] as any).decision).toBe('sufficient');
  });

  it('multi-wave continue: wave 1 finds leads, LLM continues, wave 2 executes', async () => {
    const wave1Results = new Map<string, TaskResult>();
    wave1Results.set('w1-t1', makeTaskResult('Found lead about X', ['X is a key factor']));

    const wave2Results = new Map<string, TaskResult>();
    wave2Results.set('w2-follow-1', makeTaskResult('Deeper info on X', ['X connects to Y', 'Y has implications']));

    const mockPool = createMockWorkerPool([wave1Results, wave2Results]);

    const mockProvider = createMockProvider([
      // After wave 1: continue with new tasks
      {
        content: JSON.stringify({
          action: 'continue',
          reasoning: 'Found promising lead on X, need to investigate deeper',
          tasks: [{ id: 'follow-1', description: 'Investigate X deeper', successCriteria: 'Find details about X' }],
        }),
      },
      // After wave 2: sufficient
      {
        content: JSON.stringify({ action: 'sufficient', reasoning: 'Thorough understanding achieved' }),
      },
      // Aggregation call
      {
        content: 'Here is a comprehensive synthesis of findings about X and Y.',
      },
    ]);

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider as any,
      workerPool: mockPool as any,
      config: defaultConfig(),
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'Investigate X',
      tasks: [makeTask('t1', 'Research X')],
      discoveryMode: true,
    };

    const result = await coordinator.execute('Tell me about X', plan, { eventHandler });

    expect(result.waveCount).toBe(2);
    // 3 findings total: 1 from wave 1, 2 from wave 2
    expect(result.findings).toHaveLength(3);
    expect(result.waveHistory).toHaveLength(2);

    // Verify workerPool was called twice
    expect(mockPool.executeTasks).toHaveBeenCalledTimes(2);

    // Verify wave 2 tasks have w2- prefix
    const wave2Call = mockPool.executeTasks.mock.calls[1][0] as Task[];
    expect(wave2Call[0].id).toBe('w2-follow-1');
  });

  it('maxWaves hard stop: respects maxWaves even if LLM wants to continue', async () => {
    const makeWaveResult = (id: string, finding: string) => {
      const m = new Map<string, TaskResult>();
      m.set(id, makeTaskResult(`Output for ${id}`, [finding]));
      return m;
    };

    const mockPool = createMockWorkerPool([
      makeWaveResult('w1-t1', 'The company was founded in 2010 by John Smith'),
      makeWaveResult('w2-t2', 'Revenue grew by 300% between 2020 and 2024'),
      makeWaveResult('w3-t3', 'Headquarters are located in Berlin'), // should not be reached
    ]);

    const mockProvider = createMockProvider([
      // After wave 1: continue
      {
        content: JSON.stringify({
          action: 'continue',
          reasoning: 'More to explore',
          tasks: [{ id: 't2', description: 'More research', successCriteria: 'Find more' }],
        }),
      },
      // After wave 2: would continue, but maxWaves=2 stops us
      {
        content: JSON.stringify({
          action: 'continue',
          reasoning: 'Still more to find',
          tasks: [{ id: 't3', description: 'Even more research', successCriteria: 'Find even more' }],
        }),
      },
      // Aggregation
      { content: 'Aggregated results from 2 waves.' },
    ]);

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider as any,
      workerPool: mockPool as any,
      config: defaultConfig({ maxWaves: 2 }),
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'Investigate',
      tasks: [makeTask('t1', 'Start research')],
      discoveryMode: true,
    };

    const result = await coordinator.execute('Research topic', plan, { eventHandler });

    // Only 2 waves should have executed
    expect(result.waveCount).toBe(2);
    expect(result.findings).toHaveLength(2);
    expect(mockPool.executeTasks).toHaveBeenCalledTimes(2);
  });

  it('deduplication: same finding from wave 1 and wave 2 appears only once', async () => {
    const wave1Results = new Map<string, TaskResult>();
    wave1Results.set('w1-t1', makeTaskResult('Info', ['The sky is blue', 'Water is wet']));

    const wave2Results = new Map<string, TaskResult>();
    wave2Results.set('w2-t2', makeTaskResult('More info', ['The sky is blue', 'Fire is hot']));

    const mockPool = createMockWorkerPool([wave1Results, wave2Results]);

    const mockProvider = createMockProvider([
      // After wave 1: continue
      {
        content: JSON.stringify({
          action: 'continue',
          reasoning: 'Need more data',
          tasks: [{ id: 't2', description: 'More research', successCriteria: 'Find more' }],
        }),
      },
      // After wave 2: sufficient
      {
        content: JSON.stringify({ action: 'sufficient', reasoning: 'Done' }),
      },
      // Aggregation
      { content: 'Summary of unique findings.' },
    ]);

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider as any,
      workerPool: mockPool as any,
      config: defaultConfig(),
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'Investigate',
      tasks: [makeTask('t1', 'Start research')],
      discoveryMode: true,
    };

    const result = await coordinator.execute('Research topic', plan, { eventHandler });

    // 'The sky is blue' should appear only once; total unique: 3
    expect(result.findings).toHaveLength(3);
    const contents = result.findings.map(f => f.content);
    expect(contents).toContain('The sky is blue');
    expect(contents).toContain('Water is wet');
    expect(contents).toContain('Fire is hot');
    // No duplicates
    expect(new Set(contents).size).toBe(contents.length);
  });
});
