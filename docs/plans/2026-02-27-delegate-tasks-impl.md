# delegate_tasks Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the FastClassifier + TaskPlanner upfront decomposition pipeline with a `delegate_tasks` tool that the Queen calls dynamically during direct execution, matching Claude Code's agent architecture.

**Architecture:** Remove the `plan.type` branching in `processMessage()`/`streamMessage()`. The Queen always enters direct execution. A new `delegate_tasks` internal tool is intercepted in `executeToolCalls()` before MCP dispatch. It spawns workers via `WorkerPool`, optionally uses `DiscoveryCoordinator`, and returns structured results as a tool result string. Background execution support via a `background` parameter with result injection on the next LLM call.

**Tech Stack:** TypeScript, Vitest, existing WorkerPool/RalphLoop/DiscoveryCoordinator, existing MCP tool system.

---

### Task 1: Create DelegateTasksHandler class

**Files:**
- Create: `src/core/queen/DelegateTasksHandler.ts`
- Test: `src/core/queen/DelegateTasksHandler.test.ts`

**Step 1: Write the failing tests**

Create `src/core/queen/DelegateTasksHandler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegateTasksHandler } from './DelegateTasksHandler.js';
import type { Task, TaskResult, AgentEvent } from '../types.js';
import type { WorkerPool } from '../worker/WorkerPool.js';

function createMockWorkerPool(results: Map<string, TaskResult>) {
  return {
    executeTasks: vi.fn(async () => results),
    setOnTaskComplete: vi.fn(),
    cancelTask: vi.fn(),
  } as unknown as WorkerPool;
}

function makeResult(output: string, findings: string[] = []): TaskResult {
  return { success: true, output, findings, iterations: 2 };
}

function makeFailedResult(error: string): TaskResult {
  return { success: false, output: '', error, iterations: 1 };
}

describe('DelegateTasksHandler', () => {
  let events: AgentEvent[];

  beforeEach(() => {
    events = [];
  });

  describe('execute', () => {
    it('dispatches tasks to worker pool and returns structured results', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Found social media profiles', ['LinkedIn: Senior Engineer at Acme']));
      results.set('task-1', makeResult('Found public records', ['Property in Tampa, FL']));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      const result = await handler.execute({
        tasks: [
          { description: 'Search social media', successCriteria: 'Find profiles' },
          { description: 'Search public records', successCriteria: 'Find records' },
        ],
      });

      expect(pool.executeTasks).toHaveBeenCalledTimes(1);
      expect(result).toContain('Search social media');
      expect(result).toContain('completed');
      expect(result).toContain('LinkedIn: Senior Engineer at Acme');
      expect(result).toContain('Search public records');
      expect(result).toContain('Property in Tampa, FL');
    });

    it('reports failed tasks in results', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Found info', ['Some finding']));
      results.set('task-1', makeFailedResult('Search API rate limited'));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      const result = await handler.execute({
        tasks: [
          { description: 'Task A', successCriteria: 'Do A' },
          { description: 'Task B', successCriteria: 'Do B' },
        ],
      });

      expect(result).toContain('1 succeeded');
      expect(result).toContain('1 failed');
      expect(result).toContain('rate limited');
    });

    it('rejects empty task list', async () => {
      const pool = createMockWorkerPool(new Map());
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      const result = await handler.execute({ tasks: [] });

      expect(result).toContain('Error');
      expect(pool.executeTasks).not.toHaveBeenCalled();
    });

    it('emits worker_spawned and worker_completed events', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Done', []));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      await handler.execute({
        tasks: [{ description: 'Do something', successCriteria: 'Done' }],
      });

      expect(events.some(e => e.type === 'worker_spawned')).toBe(true);
      expect(events.some(e => e.type === 'worker_completed')).toBe(true);
    });

    it('injects skill context into tasks when provided', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Done', []));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: (e) => events.push(e),
      });

      await handler.execute(
        {
          tasks: [{ description: 'Do research', successCriteria: 'Find info' }],
        },
        { skillContext: { name: 'research', instructions: 'Use academic sources' } },
      );

      const calledTasks = (pool.executeTasks as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task[];
      expect(calledTasks[0].skillContext).toBeDefined();
      expect(calledTasks[0].skillContext!.name).toBe('research');
    });
  });

  describe('formatResults', () => {
    it('formats all-success results', async () => {
      const results = new Map<string, TaskResult>();
      results.set('task-0', makeResult('Output A', ['Finding 1']));
      results.set('task-1', makeResult('Output B', ['Finding 2', 'Finding 3']));

      const pool = createMockWorkerPool(results);
      const handler = new DelegateTasksHandler({
        workerPool: pool,
        eventHandler: () => {},
      });

      const result = await handler.execute({
        tasks: [
          { description: 'Task A', successCriteria: 'Do A' },
          { description: 'Task B', successCriteria: 'Do B' },
        ],
      });

      expect(result).toContain('2 succeeded');
      expect(result).not.toContain('failed');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/queen/DelegateTasksHandler.test.ts`
Expected: FAIL — module `./DelegateTasksHandler.js` not found

**Step 3: Write the implementation**

Create `src/core/queen/DelegateTasksHandler.ts`:

```typescript
/**
 * DelegateTasksHandler — executes the delegate_tasks internal tool.
 *
 * Spawns parallel workers via WorkerPool, optionally delegates to
 * DiscoveryCoordinator for multi-wave investigative tasks. Returns
 * structured result summaries to the Queen's tool-call loop.
 */

import type { WorkerPool } from '../worker/WorkerPool.js';
import type { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { Task, TaskResult, TaskPlan, AgentEventHandler, SkillContext } from '../types.js';

export interface DelegateTasksInput {
  tasks: Array<{ description: string; successCriteria: string }>;
  discoveryMode?: boolean;
  background?: boolean;
}

export interface DelegateTasksContext {
  skillContext?: { name: string; instructions: string; resources?: Map<string, string> };
  toolEffectivenessHints?: (description: string) => string | undefined;
  strategyHints?: (description: string) => string | undefined;
}

export interface DelegateTasksHandlerOptions {
  workerPool: WorkerPool;
  discoveryCoordinator?: DiscoveryCoordinator;
  eventHandler: AgentEventHandler;
}

export class DelegateTasksHandler {
  private workerPool: WorkerPool;
  private discoveryCoordinator?: DiscoveryCoordinator;
  private eventHandler: AgentEventHandler;

  constructor(options: DelegateTasksHandlerOptions) {
    this.workerPool = options.workerPool;
    this.discoveryCoordinator = options.discoveryCoordinator;
    this.eventHandler = options.eventHandler;
  }

  /**
   * Execute the delegate_tasks tool call.
   * Returns a structured result string for the Queen's context.
   */
  async execute(input: DelegateTasksInput, context?: DelegateTasksContext): Promise<string> {
    if (!input.tasks || input.tasks.length === 0) {
      return 'Error: delegate_tasks requires at least one task.';
    }

    // Build Task objects
    const tasks: Task[] = input.tasks.map((t, i) => ({
      id: `task-${i}`,
      description: t.description,
      successCriteria: t.successCriteria,
      dependencies: [],
      priority: 1,
      status: 'pending' as const,
      createdAt: new Date(),
    }));

    // Inject skill context if available
    if (context?.skillContext) {
      for (const task of tasks) {
        task.skillContext = {
          name: context.skillContext.name,
          instructions: context.skillContext.instructions,
          resources: context.skillContext.resources,
        };
      }
    }

    // Inject tool effectiveness and strategy hints
    if (context?.toolEffectivenessHints || context?.strategyHints) {
      for (const task of tasks) {
        if (context.toolEffectivenessHints) {
          const hints = context.toolEffectivenessHints(task.description);
          if (hints) task.toolEffectivenessHints = hints;
        }
        if (context.strategyHints) {
          const hints = context.strategyHints(task.description);
          if (hints) task.strategyHints = hints;
        }
      }
    }

    // Emit worker_spawned events
    for (const task of tasks) {
      this.eventHandler({ type: 'worker_spawned', workerId: task.id, task });
    }

    // Discovery mode: delegate to DiscoveryCoordinator
    if (input.discoveryMode && this.discoveryCoordinator) {
      const plan: TaskPlan = {
        type: 'decomposed',
        reasoning: 'Delegated discovery task',
        tasks,
        discoveryMode: true,
      };
      const discoveryResult = await this.discoveryCoordinator.execute(
        tasks.map(t => t.description).join('; '),
        plan,
        { eventHandler: this.eventHandler },
      );
      return discoveryResult.content;
    }

    // Normal mode: dispatch to worker pool
    const resultsMap = await this.workerPool.executeTasks(tasks);

    // Emit worker_completed events
    for (const task of tasks) {
      const result = resultsMap.get(task.id);
      if (result) {
        this.eventHandler({ type: 'worker_completed', workerId: task.id, result });
      }
    }

    return this.formatResults(tasks, resultsMap);
  }

  /**
   * Format worker results into a structured summary for the Queen.
   */
  private formatResults(tasks: Task[], results: Map<string, TaskResult>): string {
    const succeeded = tasks.filter(t => results.get(t.id)?.success);
    const failed = tasks.filter(t => {
      const r = results.get(t.id);
      return r && !r.success;
    });

    const parts: string[] = [];
    parts.push(`## Worker Results (${tasks.length} tasks, ${succeeded.length} succeeded, ${failed.length} failed)`);

    for (const task of tasks) {
      const result = results.get(task.id);
      if (!result) {
        parts.push(`\n### Task: "${task.description}"\nStatus: no result returned`);
        continue;
      }

      parts.push(`\n### Task: "${task.description}"`);

      if (result.success) {
        parts.push(`Status: completed (${result.iterations} iterations)`);
        if (result.findings && result.findings.length > 0) {
          parts.push('Findings:');
          for (const f of result.findings) {
            parts.push(`- ${f}`);
          }
        }
        if (result.output && result.output.trim()) {
          // Include truncated output if no findings
          if (!result.findings || result.findings.length === 0) {
            const truncated = result.output.length > 1000
              ? result.output.slice(0, 1000) + '\n...(truncated)'
              : result.output;
            parts.push(`Output:\n${truncated}`);
          }
        }
      } else {
        parts.push(`Status: failed`);
        if (result.error) {
          parts.push(`Error: ${result.error}`);
        }
        if (result.output && result.output.trim()) {
          const truncated = result.output.length > 500
            ? result.output.slice(0, 500) + '\n...(truncated)'
            : result.output;
          parts.push(`Partial output:\n${truncated}`);
        }
      }
    }

    return parts.join('\n');
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/DelegateTasksHandler.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/queen/DelegateTasksHandler.ts src/core/queen/DelegateTasksHandler.test.ts
git commit -m "feat: add DelegateTasksHandler for delegate_tasks internal tool"
```

---

### Task 2: Intercept delegate_tasks in Queen.executeToolCalls()

**Files:**
- Modify: `src/core/queen/Queen.ts:589-613` (executeToolCalls method)
- Modify: `src/core/queen/Queen.ts:78-92` (add delegateHandler field)
- Modify: `src/core/queen/Queen.ts:94-149` (construct handler in constructor)

**Step 1: Write the failing test**

Add to `src/core/queen/Queen.test.ts`:

```typescript
it('intercepts delegate_tasks tool call and dispatches to DelegateTasksHandler', async () => {
  // This test verifies the wiring: when the LLM returns a delegate_tasks tool call,
  // the Queen routes it to DelegateTasksHandler instead of MCP.
  // The mock provider returns a delegate_tasks tool call, then a final text response.
  const mockProvider = createMockProvider([
    // First call: LLM decides to delegate
    {
      content: '',
      toolCalls: [{
        id: 'tc-1',
        name: 'delegate_tasks',
        arguments: {
          tasks: [
            { description: 'Search social media', successCriteria: 'Find profiles' },
          ],
        },
      }],
    },
    // Second call: LLM synthesizes from tool results
    { content: 'Based on the research, here are the findings.' },
  ]);

  const queen = createQueen({ provider: mockProvider });
  const result = await queen.processMessage('Research John Doe');

  expect(result).toContain('findings');
  // Verify MCP was NOT called with delegate_tasks
  // (the mock MCP server would throw on unknown tool)
});
```

Note: The exact test setup depends on existing test helpers in `Queen.test.ts`. Adapt `createMockProvider` and `createQueen` to match the existing patterns. The key assertion is that `delegate_tasks` is intercepted and not forwarded to MCP.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/Queen.test.ts`
Expected: FAIL — delegate_tasks not intercepted yet

**Step 3: Modify Queen.ts**

1. **Add import** (after existing imports near line 10):
```typescript
import { DelegateTasksHandler } from './DelegateTasksHandler.js';
import type { DelegateTasksInput } from './DelegateTasksHandler.js';
```

2. **Add field** (after line 91, `private discoveryCoordinator?`):
```typescript
  private delegateHandler: DelegateTasksHandler;
```

3. **Construct handler** (after discoveryCoordinator construction, around line 135):
```typescript
    // Create delegate_tasks handler
    this.delegateHandler = new DelegateTasksHandler({
      workerPool: this.workerPool,
      discoveryCoordinator: this.discoveryCoordinator,
      eventHandler: (event: AgentEvent) => this.emitEvent(event),
    });
```

4. **Modify executeToolCalls()** (lines 589-613) — intercept delegate_tasks before MCP:
```typescript
  private async executeToolCalls(toolCalls: ToolCall[]): Promise<Array<{ toolCallId: string; name: string; result: string }>> {
    if (!this.mcpServer && !toolCalls.some(tc => tc.name === 'delegate_tasks')) return [];

    const mcpServer = this.mcpServer;
    const settled = await Promise.allSettled(
      toolCalls.map(async (toolCall) => {
        try {
          // Intercept delegate_tasks — Queen-internal tool
          if (toolCall.name === 'delegate_tasks') {
            const input = toolCall.arguments as unknown as DelegateTasksInput;
            const result = await this.delegateHandler.execute(input, {
              skillContext: this.currentSkillContext ? {
                name: this.currentSkillContext.name,
                instructions: this.currentSkillContext.instructions,
                resources: this.currentSkillContext.resources,
              } : undefined,
              toolEffectivenessHints: (desc: string) => {
                const pattern = this.toolTracker.classifyTaskPattern(desc);
                return this.toolTracker.getHints(pattern) ?? undefined;
              },
              strategyHints: this.strategyStore ? (desc: string) => {
                const pattern = this.toolTracker.classifyTaskPattern(desc);
                return this.strategyStore!.buildStrategyHints(pattern) ?? undefined;
              } : undefined,
            });
            return { toolCallId: toolCall.id, name: toolCall.name, result };
          }

          if (!mcpServer) {
            return { toolCallId: toolCall.id, name: toolCall.name, result: 'Error: No MCP server available' };
          }
          const result = await mcpServer.executeToolCall(toolCall);
          const resultStr = result.success
            ? truncateToolResult(JSON.stringify(result.data, null, 2))
            : `Error: ${result.error}`;
          return { toolCallId: toolCall.id, name: toolCall.name, result: resultStr };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          return { toolCallId: toolCall.id, name: toolCall.name, result: `Error: ${err.message}` };
        }
      })
    );

    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { toolCallId: toolCalls[i].id, name: toolCalls[i].name, result: `Error: ${(s as PromiseRejectedResult).reason}` }
    );
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/Queen.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/queen/Queen.ts src/core/queen/Queen.test.ts
git commit -m "feat: intercept delegate_tasks in executeToolCalls before MCP dispatch"
```

---

### Task 3: Register delegate_tasks tool definition with the LLM

**Files:**
- Modify: `src/core/queen/Queen.ts:400-411` (handleDirectRequest — tool definitions)
- Modify: `src/core/queen/Queen.ts:486-507` (prepareDirectMessages — if tools are injected there)
- Modify: `src/core/queen/Queen.ts:418-479` (executeDirectRequest — raise maxToolRounds)

**Step 1: Write the failing test**

Add to `src/core/queen/Queen.test.ts`:

```typescript
it('includes delegate_tasks in tool definitions sent to LLM', async () => {
  // The mock provider should receive tool definitions that include delegate_tasks
  const chatSpy = vi.fn(async () => ({ content: 'Hello!' }));
  const mockProvider = {
    name: 'mock', model: 'mock',
    chat: chatSpy,
    chatStream: vi.fn(), complete: vi.fn(),
    supportsTools: () => true,
    getAvailableModels: () => ['mock'],
  };

  const queen = createQueen({ provider: mockProvider as any });
  await queen.processMessage('Hi');

  // Check that delegate_tasks was in the tools option
  const chatCall = chatSpy.mock.calls[0];
  const options = chatCall[1]; // ChatOptions
  const toolNames = options?.tools?.map((t: any) => t.name) ?? [];
  expect(toolNames).toContain('delegate_tasks');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/Queen.test.ts`
Expected: FAIL — delegate_tasks not in tool definitions

**Step 3: Modify Queen.ts**

1. **Add a constant for the delegate_tasks tool definition** (near the top of the file, after imports):
```typescript
import type { ToolDefinition } from '../providers/Provider.js';

const DELEGATE_TASKS_TOOL: ToolDefinition = {
  name: 'delegate_tasks',
  description: 'Spawn parallel worker agents to execute tasks concurrently. Each worker iterates with external verification until objectively complete. Use when you need to research multiple topics, investigate from different angles, or do parallel work that benefits from independent verification. Set discoveryMode to true for investigative research that may need multiple follow-up waves.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What the worker should do' },
            successCriteria: { type: 'string', description: 'How to verify the task is complete' },
          },
          required: ['description', 'successCriteria'],
        },
        description: 'Tasks to execute in parallel (1-10)',
        minItems: 1,
        maxItems: 10,
      },
      discoveryMode: {
        type: 'boolean',
        description: 'Run multi-wave progressive discovery with follow-up waves based on findings. Use for deep research on a person, company, or topic.',
      },
      background: {
        type: 'boolean',
        description: 'Execute workers in background. Returns immediately with a delegation ID. Results injected into context when workers complete.',
      },
    },
    required: ['tasks'],
  },
};
```

2. **Modify handleDirectRequest()** (line 401) to include delegate_tasks in tools:
```typescript
  private async handleDirectRequest(userMessage: string): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    const mcpTools = this.mcpServer?.getToolDefinitions() ?? [];
    const tools = [...mcpTools, DELEGATE_TASKS_TOOL];
    const messages = this.prepareDirectMessages(this.memory.getContextMessages(), tools);

    try {
      return await this.executeDirectRequest(messages, tools);
    } catch (error) {
      // ...existing error handling...
    }
  }
```

3. **Raise maxToolRounds in executeDirectRequest()** (line 420):
```typescript
  private async executeDirectRequest(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    maxToolRounds: number = 10,  // raised from 5
  ): Promise<{ content: string; tokenUsage?: TokenUsage }> {
```

4. **Apply the same changes in the streaming path** (`streamMessage()`) — find where tools are fetched and include `DELEGATE_TASKS_TOOL`, and raise the streaming tool round limit similarly.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/Queen.test.ts`
Expected: All tests PASS

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

**Step 6: Commit**

```bash
git add src/core/queen/Queen.ts src/core/queen/Queen.test.ts
git commit -m "feat: register delegate_tasks tool definition with LLM, raise maxToolRounds to 10"
```

---

### Task 4: Simplify processMessage() — remove FastClassifier and TaskPlanner branching

**Files:**
- Modify: `src/core/queen/Queen.ts:202-257` (processMessage)
- Modify: `src/core/queen/Queen.ts:1102-1222` (streamMessage)
- Modify: `src/core/queen/Queen.ts:11` (remove classifyFast import)

**Step 1: Write the test**

Add to `src/core/queen/Queen.test.ts`:

```typescript
it('always enters direct execution without FastClassifier or TaskPlanner', async () => {
  // Even a research query should go through direct execution (not decomposed)
  // The Queen will call delegate_tasks if she decides to use workers
  const chatResponses = [
    // Queen decides to handle directly
    { content: 'Here is what I found about the topic.' },
  ];
  const mockProvider = createMockProvider(chatResponses);
  const queen = createQueen({ provider: mockProvider });

  const result = await queen.processMessage('Research quantum computing');

  expect(result).toContain('found');
  // Verify only 1 LLM call — no separate planning call
  expect(mockProvider.chat).toHaveBeenCalledTimes(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/Queen.test.ts`
Expected: FAIL — currently makes 2 calls (planning + direct)

**Step 3: Modify processMessage()**

Replace the FastClassifier + TaskPlanner + branching block (lines 202-257) with:

```typescript
    // Always enter direct execution — Queen decides dynamically
    // whether to use delegate_tasks tool for parallel work
    this.emitPhaseChange('executing', 'Processing request...');
    result = await this.handleDirectRequest(userMessage);
```

Remove the `classifyFast` import (line 11) and the `TaskPlan` usage in processMessage.

**Step 4: Apply the same simplification to streamMessage()**

Replace the FastClassifier + TaskPlanner + branching block (lines 1102-1222) with:

```typescript
    // Always enter streaming direct execution
    this.emitPhaseChange('executing', 'Streaming response...');
    // ... existing streaming tool-call loop (lines 1126-1197) ...
    // Remove the else branch for decomposed (lines 1198-1222)
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/Queen.test.ts`
Expected: All tests PASS (some existing tests may need mock response sequences updated since the planning LLM call is removed)

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass. Other test files (Queen.integration.test.ts, Queen.stream.test.ts) may need mock response sequences adjusted — planning calls are no longer made.

**Step 7: Commit**

```bash
git add src/core/queen/Queen.ts src/core/queen/Queen.test.ts
git commit -m "refactor: remove FastClassifier and TaskPlanner branching from processMessage/streamMessage"
```

---

### Task 5: Update Queen system prompt with delegation guidance

**Files:**
- Modify: `src/core/queen/Queen.ts:1550-1578` (getDefaultSystemPrompt)
- Modify: `prompts/queen-system.md` (overridable version)

**Step 1: Modify getDefaultSystemPrompt()**

Replace the current system prompt content with updated guidance that includes delegate_tasks usage:

```typescript
  private getDefaultSystemPrompt(): string {
    return `You are the Queen agent, the intelligent orchestrator of a multi-agent system. You have access to tools for searching, reading files, fetching URLs, and executing commands. You also have a delegate_tasks tool for spawning parallel worker agents.

## How to Work

1. **Start with your own tools** — do a quick search, read a file, or fetch a URL to understand the request.
2. **Delegate when parallelism helps** — use delegate_tasks to spawn workers for independent research threads, multi-angle investigations, or any work that benefits from parallel execution with verification.
3. **Synthesize results** — after workers complete, combine their findings into a unified response.

## When to Use delegate_tasks

USE delegate_tasks WHEN:
- Researching a person, company, or topic from multiple angles
- The user asks for "deep research", "investigate", "full profile", or "comprehensive analysis"
- You need information from 2+ independent sources or search strategies
- Tasks are independent and benefit from parallel execution
- Set discoveryMode to true for investigative research that may need multiple follow-up waves

HANDLE DIRECTLY (without delegate_tasks) WHEN:
- Simple questions, greetings, follow-ups, or conversational responses
- A single tool call is sufficient (one search, one file read, one URL fetch)
- You already have the answer from conversation context
- The user is asking about something you just retrieved

## Communication Style

- Write clearly and concisely
- Structure long responses with headers and bullet points
- When presenting research findings, cite sources and note confidence levels
- Never reference internal implementation details (workers, tasks, agents) to the user
- Present results as if you personally gathered all the information`;
  }
```

**Step 2: Update prompts/queen-system.md with the same guidance**

This file is the overridable version. Update it to match the new default prompt content.

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/core/queen/Queen.ts prompts/queen-system.md
git commit -m "feat: update Queen system prompt with delegate_tasks guidance"
```

---

### Task 6: Add background delegation support

**Files:**
- Modify: `src/core/queen/DelegateTasksHandler.ts` (add background execution)
- Modify: `src/core/queen/DelegateTasksHandler.test.ts` (add background tests)
- Modify: `src/core/queen/Queen.ts` (track pending delegations, inject results)

**Step 1: Write the failing tests**

Add to `src/core/queen/DelegateTasksHandler.test.ts`:

```typescript
describe('background execution', () => {
  it('returns immediately with delegation ID when background is true', async () => {
    const results = new Map<string, TaskResult>();
    results.set('task-0', makeResult('Done', ['Finding']));

    const pool = createMockWorkerPool(results);
    const handler = new DelegateTasksHandler({
      workerPool: pool,
      eventHandler: () => {},
    });

    const result = await handler.execute({
      tasks: [{ description: 'Background work', successCriteria: 'Done' }],
      background: true,
    });

    // Should return immediately with delegation ID, not worker results
    expect(result).toContain('Delegated');
    expect(result).toContain('background');
    expect(result).toMatch(/d-[a-z0-9]+/); // delegation ID pattern
  });

  it('stores results that can be retrieved later', async () => {
    const results = new Map<string, TaskResult>();
    results.set('task-0', makeResult('Done', ['Finding']));

    const pool = createMockWorkerPool(results);
    const handler = new DelegateTasksHandler({
      workerPool: pool,
      eventHandler: () => {},
    });

    await handler.execute({
      tasks: [{ description: 'Background work', successCriteria: 'Done' }],
      background: true,
    });

    // Wait for background execution to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const pending = handler.collectCompletedResults();
    expect(pending.length).toBe(1);
    expect(pending[0]).toContain('Background work');
    expect(pending[0]).toContain('Finding');
  });

  it('returns empty array when no background results pending', () => {
    const pool = createMockWorkerPool(new Map());
    const handler = new DelegateTasksHandler({
      workerPool: pool,
      eventHandler: () => {},
    });

    expect(handler.collectCompletedResults()).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/queen/DelegateTasksHandler.test.ts`
Expected: FAIL — background mode not implemented

**Step 3: Add background support to DelegateTasksHandler**

Add to `DelegateTasksHandler`:

```typescript
  private completedBackgroundResults: string[] = [];
  private pendingCount = 0;

  get hasPendingDelegations(): boolean {
    return this.pendingCount > 0;
  }

  /**
   * Collect and clear completed background delegation results.
   * Called by Queen before each LLM call to inject results.
   */
  collectCompletedResults(): string[] {
    const results = [...this.completedBackgroundResults];
    this.completedBackgroundResults = [];
    return results;
  }
```

Modify `execute()` to handle `background: true`:

```typescript
    if (input.background) {
      const delegationId = `d-${Date.now().toString(36)}`;
      this.pendingCount++;

      // Fire-and-forget: execute in background
      this.executeWorkers(tasks, input, context).then(result => {
        this.completedBackgroundResults.push(
          `[Background delegation ${delegationId} completed]\n${result}`
        );
        this.pendingCount--;
      }).catch(() => {
        this.completedBackgroundResults.push(
          `[Background delegation ${delegationId} failed]`
        );
        this.pendingCount--;
      });

      return `Delegated ${tasks.length} tasks in background (id: "${delegationId}"). Workers are executing. Results will be provided when ready. You can continue with other work.`;
    }
```

Extract the worker dispatch logic into a private `executeWorkers()` method that both foreground and background paths call.

**Step 4: Modify Queen.executeDirectRequest() to inject background results**

In the tool-call loop (around line 440), before each LLM call, check for completed background results:

```typescript
    // Inject completed background delegation results
    const bgResults = this.delegateHandler.collectCompletedResults();
    if (bgResults.length > 0) {
      const bgMessage: Message = {
        role: 'user' as const,
        content: bgResults.join('\n\n'),
        timestamp: new Date(),
      };
      currentMessages = [...currentMessages, bgMessage];
      this.memory.addMessage(bgMessage);
    }
```

Also, after the main loop ends, if there are still pending background delegations, wait for them:

```typescript
    // Wait for pending background delegations before returning final response
    if (this.delegateHandler.hasPendingDelegations) {
      // Poll briefly for completion
      const maxWaitMs = 300_000; // 5 minutes max
      const start = Date.now();
      while (this.delegateHandler.hasPendingDelegations && Date.now() - start < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const finalBgResults = this.delegateHandler.collectCompletedResults();
      if (finalBgResults.length > 0) {
        // Make one more LLM call to incorporate background results
        const bgMessage: Message = {
          role: 'user', content: finalBgResults.join('\n\n'), timestamp: new Date(),
        };
        currentMessages = [...currentMessages, bgMessage];
        const response = await callWithTimeout(
          trackedProvider.chat(currentMessages, chatOptions),
          STREAM_TIMEOUT_MS, 'LLM call',
        );
        finalOutput = response.content; // replace with synthesized version
      }
    }
```

**Step 5: Run tests**

Run: `npx vitest run src/core/queen/DelegateTasksHandler.test.ts`
Expected: All tests PASS

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/core/queen/DelegateTasksHandler.ts src/core/queen/DelegateTasksHandler.test.ts src/core/queen/Queen.ts
git commit -m "feat: add background delegation support with result injection"
```

---

### Task 7: Clean up dead code

**Files:**
- Delete: `src/core/queen/FastClassifier.ts`
- Delete: `src/core/queen/FastClassifier.test.ts`
- Modify: `src/core/queen/Queen.ts` (remove unused imports)

**Step 1: Delete FastClassifier files**

```bash
rm src/core/queen/FastClassifier.ts src/core/queen/FastClassifier.test.ts
```

**Step 2: Remove unused imports from Queen.ts**

Remove the `classifyFast` import and any other imports that are no longer used (e.g., if `TaskPlan` is no longer referenced in processMessage).

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Clean — no type errors

**Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Run lint**

Run: `npm run lint`
Expected: No new lint errors in changed files

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove FastClassifier and dead code from classifier-based routing"
```

---

### Task 8: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

**Step 3: Run lint on changed files**

Run: `npm run lint`
Expected: No new errors

**Step 4: Review diff**

Run: `git diff master --stat`
Expected: Only expected files changed — new DelegateTasksHandler, modified Queen, deleted FastClassifier.
