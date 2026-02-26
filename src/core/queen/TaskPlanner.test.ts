import { describe, it, expect, vi } from 'vitest';
import { TaskPlanner } from './TaskPlanner.js';
import type { LLMProvider } from '../../providers/index.js';

function mockProvider(response: string): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue(response),
    chat: vi.fn(),
    chatStream: vi.fn(),
    name: 'mock',
    model: 'mock-model',
  } as unknown as LLMProvider;
}

describe('TaskPlanner', () => {
  it('parses discoveryMode from decomposed plan', async () => {
    const response = JSON.stringify({
      type: 'decomposed',
      reasoning: 'Multi-wave investigation needed',
      discoveryMode: true,
      tasks: [
        {
          id: 'task-1',
          description: 'Search public records for Jose Ibarra Jr.',
          successCriteria: 'At least one record found',
          dependencies: [],
          priority: 1,
          estimatedComplexity: 'medium',
        },
      ],
    });
    const provider = mockProvider(`\`\`\`json\n${response}\n\`\`\``);
    const planner = new TaskPlanner(provider);
    const plan = await planner.plan('Look into Jose Ibarra Jr. Create a full investigative profile.');
    expect(plan.type).toBe('decomposed');
    expect(plan.discoveryMode).toBe(true);
    expect(plan.tasks).toHaveLength(1);
  });

  it('defaults discoveryMode to false when not present', async () => {
    const response = JSON.stringify({
      type: 'decomposed',
      reasoning: 'Simple decomposition',
      tasks: [
        {
          id: 'task-1',
          description: 'Search for X',
          successCriteria: 'Found',
          dependencies: [],
          priority: 1,
        },
      ],
    });
    const provider = mockProvider(`\`\`\`json\n${response}\n\`\`\``);
    const planner = new TaskPlanner(provider);
    const plan = await planner.plan('Search for X and Y');
    expect(plan.discoveryMode).toBeFalsy();
  });

  it('parses discoveryMode false for direct plans', async () => {
    const response = JSON.stringify({
      type: 'direct',
      reasoning: 'Simple question',
    });
    const provider = mockProvider(`\`\`\`json\n${response}\n\`\`\``);
    const planner = new TaskPlanner(provider);
    const plan = await planner.plan('What is the weather?');
    expect(plan.type).toBe('direct');
    expect(plan.discoveryMode).toBeFalsy();
  });
});
