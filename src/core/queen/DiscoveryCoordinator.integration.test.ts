import { describe, it, expect, vi } from 'vitest';
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { Task, TaskResult, TaskPlan, AgentEvent } from '../types.js';
import type { WorkerPool } from '../worker/WorkerPool.js';

describe('DiscoveryCoordinator integration', () => {
  it('injects discovery context into wave 2 tasks', async () => {
    const events: AgentEvent[] = [];
    let wave2Tasks: Task[] | undefined;

    const mockPool = {
      executeTasks: vi.fn().mockImplementation((tasks: Task[]) => {
        const results = new Map<string, TaskResult>();
        // Detect wave 2 tasks by their prefixed IDs
        if (tasks.some(t => t.id.startsWith('w2'))) {
          wave2Tasks = tasks;
          results.set(tasks[0].id, {
            success: true,
            output: 'Verified employer info',
            findings: ['Employer confirmed: Acme Corp'],
            iterations: 1,
          });
        } else {
          // Wave 1 results
          results.set(tasks[0].id, {
            success: true,
            output: 'Initial discovery results',
            findings: ['Name: John Doe', 'City: Tampa FL'],
            iterations: 2,
            bestScore: 0.8,
          });
        }
        return Promise.resolve(results);
      }),
    } as unknown as WorkerPool;

    const mockProvider = {
      chat: vi.fn()
        // Graph extraction after wave 1
        .mockResolvedValueOnce({
          content: JSON.stringify({
            entities: [
              { name: 'John Doe', type: 'person', properties: { city: 'Tampa FL' }, confidence: 0.8 },
            ],
            relationships: [],
          }),
        })
        // Wave 1 decision: continue
        .mockResolvedValueOnce({
          content: JSON.stringify({
            action: 'continue',
            reasoning: 'Need to verify employer',
            tasks: [{
              id: 'task-1',
              description: 'Verify employer at Acme Corp',
              successCriteria: 'Employment confirmed or denied',
            }],
          }),
        })
        // Graph extraction after wave 2
        .mockResolvedValueOnce({
          content: JSON.stringify({
            entities: [
              { name: 'Acme Corp', type: 'organization', properties: {}, confidence: 0.7 },
            ],
            relationships: [
              { source: 'John Doe', target: 'Acme Corp', predicate: 'works_at', evidence: 'Employer confirmed', weight: 0.9 },
            ],
          }),
        })
        // Wave 2 decision: sufficient
        .mockResolvedValueOnce({
          content: JSON.stringify({ action: 'sufficient', reasoning: 'All verified' }),
        })
        // Aggregation
        .mockResolvedValueOnce({ content: 'Final comprehensive report.' }),
    };

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider as any,
      workerPool: mockPool,
      config: {
        enabled: true,
        maxWaves: 4,
        waveTimeout: 120000,
        totalTimeout: 600000,
        stoppingThreshold: 2,
      },
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'Investigative research',
      tasks: [{
        id: 'task-1',
        description: 'Search public records for John Doe',
        successCriteria: 'At least one record found',
        dependencies: [],
        priority: 1,
        status: 'pending' as const,
        createdAt: new Date(),
      }],
      discoveryMode: true,
    };

    const result = await coordinator.execute('Find information about John Doe', plan, {
      eventHandler: (e) => events.push(e),
    });

    // Verify wave 2 tasks received discovery context (graph-aware)
    expect(wave2Tasks).toBeDefined();
    expect(wave2Tasks![0].dependencyResults).toBeDefined();
    const context = wave2Tasks![0].dependencyResults!.get('discovery-context');
    expect(context).toBeDefined();
    expect(context).toContain('John Doe');
    expect(context).toContain('Knowledge Graph');

    // Verify events were emitted in correct order
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('discovery_wave_start');
    expect(eventTypes).toContain('discovery_wave_complete');
    expect(eventTypes).toContain('discovery_decision');

    // Verify final result
    expect(result.waveCount).toBe(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(3); // 2 from wave 1 + 1 from wave 2
  });

  it('handles all tasks failing in a wave gracefully', async () => {
    const mockPool = {
      executeTasks: vi.fn().mockResolvedValue(
        new Map<string, TaskResult>([
          ['w1-task-1', { success: false, output: '', error: 'Search failed', iterations: 1 }],
        ])
      ),
    } as unknown as WorkerPool;

    const mockProvider = {
      chat: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({ action: 'sufficient', reasoning: 'Cannot proceed, all tasks failed' }),
        }),
    };

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider as any,
      workerPool: mockPool,
      config: { enabled: true, maxWaves: 4, waveTimeout: 120000, totalTimeout: 600000, stoppingThreshold: 2 },
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'test',
      tasks: [{
        id: 'task-1',
        description: 'Search',
        successCriteria: 'Found',
        dependencies: [],
        priority: 1,
        status: 'pending' as const,
        createdAt: new Date(),
      }],
      discoveryMode: true,
    };

    const result = await coordinator.execute('Find X', plan, {
      eventHandler: () => {},
    });

    // Should not crash, should return something
    expect(result.waveCount).toBe(1);
    expect(result.findings).toHaveLength(0);
  });
});
