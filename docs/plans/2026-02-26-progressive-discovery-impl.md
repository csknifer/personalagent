# Progressive Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add multi-wave investigative execution so research requests progressively deepen findings across waves instead of firing all tasks at once.

**Architecture:** New `DiscoveryCoordinator` class delegates from Queen, runs waves via existing WorkerPool, accumulates findings, and uses LLM to decide next wave direction. See `docs/plans/2026-02-26-progressive-discovery-design.md` for full design.

**Tech Stack:** TypeScript, Vitest, Zod (config validation), React (web UI)

---

### Task 1: Config & Types Foundation

Add the config type, Zod schema, default YAML, and core types that everything else depends on.

**Files:**
- Modify: `src/config/types.ts:119-127` (HiveConfig)
- Modify: `src/config/ConfigSchema.ts:93-119` (Zod schemas)
- Modify: `config/default.yaml:89` (add after evaluation section)
- Modify: `src/core/types.ts:121-125` (TaskPlan), `src/core/types.ts:230` (AgentPhase), `src/core/types.ts:233` (LLMCallPurpose), `src/core/types.ts:259-275` (AgentEvent)
- Modify: `src/shared/protocol.types.ts:11` (AgentPhase)
- Test: `src/config/ConfigSchema.test.ts` (if exists, or inline validation)

**Step 1: Add `ProgressiveDiscoveryConfig` to config types**

In `src/config/types.ts`, add after `StrategyStoreConfig` (line 117):

```typescript
export interface ProgressiveDiscoveryConfig {
  enabled: boolean;
  maxWaves: number;
  waveTimeout: number;
  totalTimeout: number;
  stoppingThreshold: number;
}
```

Then add to `HiveConfig` (line 126, before the closing brace):

```typescript
  progressiveDiscovery?: ProgressiveDiscoveryConfig;
```

**Step 2: Add Zod schema for progressive discovery**

In `src/config/ConfigSchema.ts`, add after `StrategyStoreConfigSchema` (line 109):

```typescript
export const ProgressiveDiscoveryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxWaves: z.number().int().min(1).max(10).default(4),
  waveTimeout: z.number().int().positive().default(120000),
  totalTimeout: z.number().int().positive().default(600000),
  stoppingThreshold: z.number().int().min(0).default(2),
});
```

Then add to `HiveConfigSchema` (line 118, before closing):

```typescript
  progressiveDiscovery: ProgressiveDiscoveryConfigSchema.default({}),
```

**Step 3: Add defaults to YAML**

In `config/default.yaml`, add after the evaluation section (after line 89):

```yaml
  # Progressive Discovery: multi-wave investigative execution for research tasks
  progressiveDiscovery:
    enabled: false         # opt-in — set to true to enable multi-wave discovery
    maxWaves: 4            # maximum investigation waves per request
    waveTimeout: 120000    # per-wave timeout in ms (2 minutes)
    totalTimeout: 600000   # all waves combined in ms (10 minutes)
    stoppingThreshold: 2   # minimum new findings per wave to suggest continuing
```

**Step 4: Add core types to `src/core/types.ts`**

Add `discoveryMode` to `TaskPlan` (line 121-125):

```typescript
export interface TaskPlan {
  type: 'direct' | 'decomposed';
  reasoning: string;
  tasks?: Task[];
  discoveryMode?: boolean;
}
```

Add `'discovering'` to `AgentPhase` (line 230):

```typescript
export type AgentPhase = 'idle' | 'planning' | 'executing' | 'verifying' | 'aggregating' | 'replanning' | 'evaluating' | 'discovering';
```

Add `'discovery'` to `LLMCallPurpose` (line 233):

```typescript
export type LLMCallPurpose = 'planning' | 'execution' | 'verification' | 'tool_followup' | 'aggregation' | 'direct' | 'replanning' | 'evaluation' | 'discovery';
```

Add new types before the `AgentEvent` union (before line 259):

```typescript
// Progressive Discovery types
export interface Finding {
  content: string;
  source: string;
  confidence: number;
  wave: number;
  tags: string[];
}

export interface WaveResult {
  waveNumber: number;
  tasks: Task[];
  results: Map<string, TaskResult>;
  findings: Finding[];
  duration: number;
}

export type WaveDecision =
  | { action: 'continue'; tasks: Task[]; reasoning: string }
  | { action: 'sufficient'; reasoning: string }
  | { action: 'pivot'; tasks: Task[]; reasoning: string; abandonedDirections: string[] };
```

Add discovery events to the `AgentEvent` union (after the `worker_signal` line, before the semicolon):

```typescript
  | { type: 'discovery_wave_start'; waveNumber: number; taskCount: number; reasoning: string }
  | { type: 'discovery_wave_complete'; waveNumber: number; newFindings: string[]; totalFindings: number }
  | { type: 'discovery_decision'; waveNumber: number; decision: 'continue' | 'sufficient' | 'pivot'; reasoning: string };
```

**Step 5: Update shared protocol types**

In `src/shared/protocol.types.ts` (line 11), add `'discovering'`:

```typescript
export type AgentPhase = 'idle' | 'planning' | 'executing' | 'verifying' | 'aggregating' | 'replanning' | 'evaluating' | 'discovering';
```

**Step 6: Run typecheck to verify**

Run: `npm run typecheck`
Expected: PASS (no new errors — new types are additive)

**Step 7: Commit**

```bash
git add src/config/types.ts src/config/ConfigSchema.ts config/default.yaml src/core/types.ts src/shared/protocol.types.ts
git commit -m "feat: add progressive discovery config, types, and events"
```

---

### Task 2: TaskPlanner Discovery Mode Detection

Teach the planner to detect investigative requests and signal `discoveryMode: true`.

**Files:**
- Modify: `src/core/queen/TaskPlanner.ts:14-79` (planning prompt), `src/core/queen/TaskPlanner.ts:377-438` (parseTaskPlan)
- Test: `src/core/queen/TaskPlanner.test.ts`

**Step 1: Write the failing test**

Create `src/core/queen/TaskPlanner.test.ts`:

```typescript
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/TaskPlanner.test.ts`
Expected: FAIL — `plan.discoveryMode` is undefined because `parseTaskPlan` doesn't extract it.

**Step 3: Add discovery mode to planning prompt**

In `src/core/queen/TaskPlanner.ts`, add to the `TASK_PLANNING_PROMPT` string (after the "Key Rules" section, before the closing backtick around line 78):

```typescript
- **discoveryMode**: Set `"discoveryMode": true` in the top-level JSON when the request is investigative — researching a person, company, or topic in depth; competitive analysis; or any request that says "deep research", "investigate", or "full profile". For discovery requests, initial tasks should be BROAD discovery (cast a wide net) rather than targeted deep dives. The system will plan follow-up waves based on findings.
```

**Step 4: Parse discoveryMode in `parseTaskPlan`**

In `src/core/queen/TaskPlanner.ts`, inside `parseTaskPlan()`, in the `if (parsed.type === 'decomposed')` branch (around line 377), after extracting `conversationSummary` and `userPreferences`, add:

```typescript
const discoveryMode = parsed.discoveryMode === true;
```

Then in the return statement for decomposed plans (around line 421), add:

```typescript
return {
  type: 'decomposed',
  reasoning: String(parsed.reasoning || ''),
  tasks,
  discoveryMode,
};
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/TaskPlanner.test.ts`
Expected: PASS

**Step 6: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add src/core/queen/TaskPlanner.ts src/core/queen/TaskPlanner.test.ts
git commit -m "feat: teach TaskPlanner to detect discovery mode for investigative requests"
```

---

### Task 3: DiscoveryCoordinator Core — Wave Loop & Finding Accumulation

The main new class. Build it with tests first.

**Files:**
- Create: `src/core/queen/DiscoveryCoordinator.ts`
- Create: `src/core/queen/DiscoveryCoordinator.test.ts`

**Step 1: Write the failing test**

Create `src/core/queen/DiscoveryCoordinator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { LLMProvider } from '../../providers/index.js';
import type { Task, TaskResult, TaskPlan, AgentEvent, Finding } from '../types.js';
import type { WorkerPool } from '../worker/WorkerPool.js';
import type { ProgressiveDiscoveryConfig } from '../../config/types.js';

const defaultConfig: ProgressiveDiscoveryConfig = {
  enabled: true,
  maxWaves: 4,
  waveTimeout: 120000,
  totalTimeout: 600000,
  stoppingThreshold: 2,
};

function makeTask(id: string, desc: string): Task {
  return {
    id,
    description: desc,
    successCriteria: 'Found relevant information',
    dependencies: [],
    priority: 1,
    status: 'pending',
    createdAt: new Date(),
  };
}

function makeResult(output: string, findings: string[] = []): TaskResult {
  return {
    success: true,
    output,
    findings,
    iterations: 2,
    bestScore: 0.8,
  };
}

describe('DiscoveryCoordinator', () => {
  let mockProvider: LLMProvider;
  let mockWorkerPool: WorkerPool;
  let events: AgentEvent[];

  beforeEach(() => {
    events = [];
    mockProvider = {
      complete: vi.fn(),
      chat: vi.fn(),
      chatStream: vi.fn(),
      name: 'mock',
      model: 'mock-model',
    } as unknown as LLMProvider;

    mockWorkerPool = {
      executeTasks: vi.fn(),
    } as unknown as WorkerPool;
  });

  it('runs a single wave and stops when LLM says sufficient', async () => {
    const tasks = [makeTask('task-1', 'Search for person X')];
    const plan: TaskPlan = { type: 'decomposed', reasoning: 'test', tasks, discoveryMode: true };

    // Wave 1 results
    const resultsMap = new Map<string, TaskResult>();
    resultsMap.set('task-1', makeResult('Found name and address', ['Full name: John Doe', 'Address: Tampa, FL']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(resultsMap);

    // Wave decision: sufficient
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'sufficient', reasoning: 'Investigation complete' }),
    });

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider,
      workerPool: mockWorkerPool,
      config: defaultConfig,
    });

    const result = await coordinator.execute('Find person X', plan, {
      eventHandler: (e) => events.push(e),
    });

    expect(result.findings).toHaveLength(2);
    expect(result.waveCount).toBe(1);
    expect(events.some(e => e.type === 'discovery_wave_start')).toBe(true);
    expect(events.some(e => e.type === 'discovery_wave_complete')).toBe(true);
    expect(events.some(e => e.type === 'discovery_decision')).toBe(true);
  });

  it('runs multiple waves when LLM says continue', async () => {
    const tasks = [makeTask('task-1', 'Broad search')];
    const plan: TaskPlan = { type: 'decomposed', reasoning: 'test', tasks, discoveryMode: true };

    // Wave 1 results
    const results1 = new Map<string, TaskResult>();
    results1.set('task-1', makeResult('Found initial leads', ['Lead: employer Acme Corp', 'Lead: Tampa FL']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(results1);

    // Wave 1 decision: continue with new tasks
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: JSON.stringify({
        action: 'continue',
        reasoning: 'Need to verify employer',
        tasks: [{ id: 'task-1', description: 'Verify Acme Corp employment', successCriteria: 'Employment confirmed or denied', dependencies: [], priority: 1, estimatedComplexity: 'low' }],
      }),
    });

    // Wave 2 results
    const results2 = new Map<string, TaskResult>();
    results2.set('w2-task-1', makeResult('Confirmed at Acme Corp', ['Employment confirmed: Acme Corp since 2020']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(results2);

    // Wave 2 decision: sufficient
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'sufficient', reasoning: 'All leads verified' }),
    });

    // Final aggregation
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: 'Comprehensive profile: John Doe works at Acme Corp in Tampa FL.',
    });

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider,
      workerPool: mockWorkerPool,
      config: defaultConfig,
    });

    const result = await coordinator.execute('Find person X', plan, {
      eventHandler: (e) => events.push(e),
    });

    expect(result.waveCount).toBe(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(mockWorkerPool.executeTasks).toHaveBeenCalledTimes(2);
  });

  it('respects maxWaves hard stop', async () => {
    const tasks = [makeTask('task-1', 'Search')];
    const plan: TaskPlan = { type: 'decomposed', reasoning: 'test', tasks, discoveryMode: true };
    const limitedConfig = { ...defaultConfig, maxWaves: 2 };

    // Wave 1
    const results1 = new Map<string, TaskResult>();
    results1.set('task-1', makeResult('Found stuff', ['Finding 1', 'Finding 2']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(results1);

    // Decision: continue
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: JSON.stringify({
        action: 'continue',
        reasoning: 'More to find',
        tasks: [{ id: 'task-1', description: 'More search', successCriteria: 'Found', dependencies: [], priority: 1 }],
      }),
    });

    // Wave 2 (last allowed)
    const results2 = new Map<string, TaskResult>();
    results2.set('w2-task-1', makeResult('More stuff', ['Finding 3']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(results2);

    // Final aggregation
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: 'Final synthesis.',
    });

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider,
      workerPool: mockWorkerPool,
      config: limitedConfig,
    });

    const result = await coordinator.execute('Find stuff', plan, {
      eventHandler: (e) => events.push(e),
    });

    expect(result.waveCount).toBe(2);
    // Should NOT have asked for a 3rd wave decision
    // 2 wave decisions would mean asking after wave 1 + after wave 2
    // But wave 2 is the last, so no decision after it
    expect(mockProvider.chat).toHaveBeenCalledTimes(2); // 1 wave decision + 1 aggregation
  });

  it('deduplicates findings across waves', async () => {
    const tasks = [makeTask('task-1', 'Search')];
    const plan: TaskPlan = { type: 'decomposed', reasoning: 'test', tasks, discoveryMode: true };

    // Wave 1
    const results1 = new Map<string, TaskResult>();
    results1.set('task-1', makeResult('Found', ['Name: John Doe', 'Address: Tampa FL']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(results1);

    // Decision: continue
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: JSON.stringify({
        action: 'continue',
        reasoning: 'Verify',
        tasks: [{ id: 'task-1', description: 'Verify', successCriteria: 'Verified', dependencies: [], priority: 1 }],
      }),
    });

    // Wave 2 — returns duplicate finding
    const results2 = new Map<string, TaskResult>();
    results2.set('w2-task-1', makeResult('Confirmed', ['Name: John Doe', 'Employer: Acme Corp']));
    vi.mocked(mockWorkerPool.executeTasks).mockResolvedValueOnce(results2);

    // Decision: sufficient
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      content: JSON.stringify({ action: 'sufficient', reasoning: 'Done' }),
    });

    // Aggregation
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({ content: 'Profile.' });

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider,
      workerPool: mockWorkerPool,
      config: defaultConfig,
    });

    const result = await coordinator.execute('Find X', plan, {
      eventHandler: () => {},
    });

    // "Name: John Doe" appears in both waves — should be deduplicated
    const nameFindings = result.findings.filter(f => f.content === 'Name: John Doe');
    expect(nameFindings).toHaveLength(1);
    expect(result.findings).toHaveLength(3); // John Doe, Tampa FL, Acme Corp
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/DiscoveryCoordinator.test.ts`
Expected: FAIL — module not found

**Step 3: Implement DiscoveryCoordinator**

Create `src/core/queen/DiscoveryCoordinator.ts`:

```typescript
/**
 * DiscoveryCoordinator — Multi-wave investigative execution.
 *
 * Queen delegates research/investigative requests here. The coordinator
 * runs waves of workers via WorkerPool, accumulates findings, and uses
 * an LLM to decide what to investigate next at each wave boundary.
 */

import type { LLMProvider, ChatOptions } from '../../providers/index.js';
import type { WorkerPool } from '../worker/WorkerPool.js';
import type { Task, TaskPlan, TaskResult, AgentEvent, AgentEventHandler, Finding, WaveResult, WaveDecision, TokenUsage } from '../types.js';
import type { ProgressiveDiscoveryConfig } from '../../config/types.js';
import type { SkillContext } from '../types.js';

export interface DiscoveryCoordinatorOptions {
  provider: LLMProvider;
  workerPool: WorkerPool;
  config: ProgressiveDiscoveryConfig;
}

export interface DiscoveryExecuteOptions {
  eventHandler: AgentEventHandler;
  skillContext?: SkillContext;
  conversationContext?: string;
  toolNames?: string[];
  toolDescriptions?: string[];
}

export interface DiscoveryResult {
  content: string;
  findings: Finding[];
  waveCount: number;
  waveHistory: WaveResult[];
  tokenUsage?: TokenUsage;
}

export class DiscoveryCoordinator {
  private provider: LLMProvider;
  private workerPool: WorkerPool;
  private config: ProgressiveDiscoveryConfig;

  constructor(options: DiscoveryCoordinatorOptions) {
    this.provider = options.provider;
    this.workerPool = options.workerPool;
    this.config = options.config;
  }

  async execute(
    request: string,
    initialPlan: TaskPlan,
    options: DiscoveryExecuteOptions,
  ): Promise<DiscoveryResult> {
    const findings: Finding[] = [];
    const waveHistory: WaveResult[] = [];
    const abandonedDirections: string[] = [];
    let currentTasks = initialPlan.tasks ?? [];
    const startTime = Date.now();

    options.eventHandler({ type: 'phase_change', phase: 'discovering', description: 'Starting multi-wave investigation...' });

    for (let wave = 1; wave <= this.config.maxWaves; wave++) {
      // --- Hard stop: total timeout ---
      if (Date.now() - startTime > this.config.totalTimeout) break;

      // --- Emit wave start ---
      options.eventHandler({
        type: 'discovery_wave_start',
        waveNumber: wave,
        taskCount: currentTasks.length,
        reasoning: wave === 1 ? 'Initial broad discovery' : 'Targeted follow-up based on findings',
      });

      // Emit worker_spawned for each task in this wave
      for (const task of currentTasks) {
        options.eventHandler({ type: 'worker_spawned', workerId: task.id, task });
      }

      // --- Inject discovery context for waves 2+ ---
      if (wave > 1) {
        for (const task of currentTasks) {
          task.dependencyResults = task.dependencyResults ?? new Map();
          task.dependencyResults.set('discovery-context',
            this.formatDiscoveryContext(findings, waveHistory, abandonedDirections)
          );
        }
      }

      // --- Execute wave ---
      const waveStart = Date.now();
      const resultsMap = await this.workerPool.executeTasks(currentTasks);
      const waveDuration = Date.now() - waveStart;

      // --- Collect findings ---
      const waveFindings = this.collectFindings(currentTasks, resultsMap, wave);
      const newFindings = this.deduplicateFindings(waveFindings, findings);
      findings.push(...newFindings);

      const waveResult: WaveResult = {
        waveNumber: wave,
        tasks: currentTasks,
        results: resultsMap,
        findings: newFindings,
        duration: waveDuration,
      };
      waveHistory.push(waveResult);

      // --- Emit worker_completed for each task ---
      for (const task of currentTasks) {
        const result = resultsMap.get(task.id);
        if (result) {
          options.eventHandler({ type: 'worker_completed', workerId: task.id, result });
        }
      }

      // --- Emit wave complete ---
      options.eventHandler({
        type: 'discovery_wave_complete',
        waveNumber: wave,
        newFindings: newFindings.map(f => f.content),
        totalFindings: findings.length,
      });

      // --- Hard stop: last wave ---
      if (wave >= this.config.maxWaves) break;

      // --- Hard stop: total timeout check before LLM call ---
      if (Date.now() - startTime > this.config.totalTimeout) break;

      // --- Ask LLM: what next? ---
      const decision = await this.planNextWave({
        originalRequest: request,
        accumulatedFindings: findings,
        waveHistory,
        abandonedDirections,
        wavesRemaining: this.config.maxWaves - wave,
        lastWaveNewFindings: newFindings.length,
        toolNames: options.toolNames,
        toolDescriptions: options.toolDescriptions,
      });

      // --- Emit decision ---
      options.eventHandler({
        type: 'discovery_decision',
        waveNumber: wave,
        decision: decision.action,
        reasoning: decision.reasoning,
      });

      if (decision.action === 'sufficient') break;

      if (decision.action === 'pivot') {
        abandonedDirections.push(...decision.abandonedDirections);
      }

      // --- Prepare next wave tasks ---
      if (decision.action === 'continue' || decision.action === 'pivot') {
        currentTasks = decision.tasks.map(t => ({
          ...t,
          id: `w${wave + 1}-${t.id}`,
          status: 'pending' as const,
          createdAt: new Date(),
          dependencies: t.dependencies ?? [],
          priority: t.priority ?? 1,
          skillContext: options.skillContext ? {
            name: options.skillContext.name,
            instructions: options.skillContext.instructions,
            resources: options.skillContext.resources,
          } : undefined,
        }));
      }
    }

    // --- Final aggregation ---
    options.eventHandler({ type: 'phase_change', phase: 'aggregating', description: 'Synthesizing multi-wave findings...' });
    const content = await this.aggregate(request, findings, waveHistory);

    return {
      content,
      findings,
      waveCount: waveHistory.length,
      waveHistory,
    };
  }

  private collectFindings(
    tasks: Task[],
    results: Map<string, TaskResult>,
    wave: number,
  ): Finding[] {
    const collected: Finding[] = [];

    for (const task of tasks) {
      const result = results.get(task.id);
      if (!result || !result.findings) continue;

      for (const content of result.findings) {
        collected.push({
          content,
          source: task.id,
          confidence: result.bestScore ?? (result.success ? 0.7 : 0.3),
          wave,
          tags: [], // Tags could be auto-extracted in a future enhancement
        });
      }
    }

    return collected;
  }

  private deduplicateFindings(newFindings: Finding[], existing: Finding[]): Finding[] {
    const deduplicated: Finding[] = [];

    for (const finding of newFindings) {
      const isDuplicate = existing.some(e =>
        e.content === finding.content ||
        this.stringSimilarity(e.content.toLowerCase(), finding.content.toLowerCase()) > 0.85
      );
      if (!isDuplicate) {
        // Also check against already-accepted new findings
        const isDupInBatch = deduplicated.some(d =>
          d.content === finding.content ||
          this.stringSimilarity(d.content.toLowerCase(), finding.content.toLowerCase()) > 0.85
        );
        if (!isDupInBatch) {
          deduplicated.push(finding);
        }
      }
    }

    return deduplicated;
  }

  /**
   * Simple bigram similarity — sufficient for finding deduplication.
   * Returns 0.0-1.0 where 1.0 is identical.
   */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigrams = (s: string): Set<string> => {
      const set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) {
        set.add(s.slice(i, i + 2));
      }
      return set;
    };

    const aBigrams = bigrams(a);
    const bBigrams = bigrams(b);
    let intersection = 0;
    for (const bg of aBigrams) {
      if (bBigrams.has(bg)) intersection++;
    }
    return (2 * intersection) / (aBigrams.size + bBigrams.size);
  }

  private formatDiscoveryContext(
    findings: Finding[],
    waveHistory: WaveResult[],
    abandonedDirections: string[],
  ): string {
    let context = '## Discovery Context (from previous investigation waves)\n\n';

    if (findings.length > 0) {
      context += '### Verified Findings\n';
      for (const f of findings) {
        context += `- ${f.content} (wave ${f.wave}, confidence: ${(f.confidence * 100).toFixed(0)}%)\n`;
      }
      context += '\n';
    }

    if (waveHistory.length > 0) {
      context += '### Investigation History\n';
      for (const wave of waveHistory) {
        const taskDescs = wave.tasks.map(t => t.description).join('; ');
        context += `- Wave ${wave.waveNumber}: ${wave.tasks.length} tasks (${taskDescs}) → ${wave.findings.length} new findings\n`;
      }
      context += '\n';
    }

    if (abandonedDirections.length > 0) {
      context += '### Abandoned Directions (do NOT retry these)\n';
      for (const dir of abandonedDirections) {
        context += `- ${dir}\n`;
      }
      context += '\n';
    }

    context += 'Build on these findings. Do NOT repeat searches already done.\n';
    return context;
  }

  private async planNextWave(ctx: {
    originalRequest: string;
    accumulatedFindings: Finding[];
    waveHistory: WaveResult[];
    abandonedDirections: string[];
    wavesRemaining: number;
    lastWaveNewFindings: number;
    toolNames?: string[];
    toolDescriptions?: string[];
  }): Promise<WaveDecision> {
    let prompt = WAVE_PLANNING_SYSTEM;

    if (ctx.toolNames && ctx.toolNames.length > 0) {
      const toolList = ctx.toolNames.map((name, i) =>
        `- **${name}**: ${ctx.toolDescriptions?.[i] ?? ''}`
      ).join('\n');
      prompt += `\n## Available Tools\n${toolList}\n`;
    }

    const userPrompt = this.buildWavePlanningPrompt(ctx);

    try {
      const response = await this.provider.chat([
        { role: 'system', content: prompt },
        { role: 'user', content: userPrompt },
      ], { purpose: 'discovery' } as ChatOptions);

      return this.parseWaveDecision(response.content);
    } catch {
      // If wave planning fails, stop gracefully
      return { action: 'sufficient', reasoning: 'Wave planning failed, stopping with current findings' };
    }
  }

  private buildWavePlanningPrompt(ctx: {
    originalRequest: string;
    accumulatedFindings: Finding[];
    waveHistory: WaveResult[];
    abandonedDirections: string[];
    wavesRemaining: number;
    lastWaveNewFindings: number;
  }): string {
    let prompt = `## Original Request\n${ctx.originalRequest}\n\n`;

    if (ctx.accumulatedFindings.length > 0) {
      prompt += '## Accumulated Findings\n';
      for (const f of ctx.accumulatedFindings) {
        prompt += `- [Wave ${f.wave}] ${f.content} (confidence: ${(f.confidence * 100).toFixed(0)}%)\n`;
      }
      prompt += '\n';
    }

    if (ctx.waveHistory.length > 0) {
      prompt += '## Wave History\n';
      for (const wave of ctx.waveHistory) {
        const taskDescs = wave.tasks.map(t => t.description).join('; ');
        prompt += `- Wave ${wave.waveNumber}: ${taskDescs} → ${wave.findings.length} new findings (${wave.duration}ms)\n`;
      }
      prompt += '\n';
    }

    if (ctx.abandonedDirections.length > 0) {
      prompt += `## Abandoned Directions\n${ctx.abandonedDirections.map(d => `- ${d}`).join('\n')}\n\n`;
    }

    prompt += `## Budget\n`;
    prompt += `- Waves remaining: ${ctx.wavesRemaining}\n`;
    prompt += `- Last wave produced: ${ctx.lastWaveNewFindings} new findings\n`;
    if (ctx.lastWaveNewFindings < 2) {
      prompt += `- ⚠️ Diminishing returns detected — consider stopping\n`;
    }
    prompt += '\n';

    prompt += '## Your Decision\nReturn a JSON object with one of these actions:\n';
    prompt += '- `{"action": "continue", "reasoning": "...", "tasks": [...]}` — with 2-4 targeted follow-up tasks\n';
    prompt += '- `{"action": "sufficient", "reasoning": "..."}` — investigation is comprehensive\n';
    prompt += '- `{"action": "pivot", "reasoning": "...", "tasks": [...], "abandonedDirections": [...]}` — change approach\n';

    return prompt;
  }

  private parseWaveDecision(response: string): WaveDecision {
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;
      const parsed = JSON.parse(jsonStr.trim());

      if (parsed.action === 'sufficient') {
        return { action: 'sufficient', reasoning: String(parsed.reasoning || '') };
      }

      if (parsed.action === 'pivot' && Array.isArray(parsed.tasks)) {
        return {
          action: 'pivot',
          reasoning: String(parsed.reasoning || ''),
          tasks: this.parseTasks(parsed.tasks),
          abandonedDirections: Array.isArray(parsed.abandonedDirections)
            ? parsed.abandonedDirections.map(String)
            : [],
        };
      }

      if (parsed.action === 'continue' && Array.isArray(parsed.tasks)) {
        return {
          action: 'continue',
          reasoning: String(parsed.reasoning || ''),
          tasks: this.parseTasks(parsed.tasks),
        };
      }

      return { action: 'sufficient', reasoning: 'Could not parse wave decision' };
    } catch {
      return { action: 'sufficient', reasoning: 'Failed to parse wave decision response' };
    }
  }

  private parseTasks(raw: Record<string, unknown>[]): Task[] {
    return raw.slice(0, 5).map((t, i) => ({
      id: String(t.id || `task-${i + 1}`),
      description: String(t.description || ''),
      successCriteria: String(t.successCriteria || 'Task completed'),
      dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
      priority: Number(t.priority) || i + 1,
      status: 'pending' as const,
      createdAt: new Date(),
    }));
  }

  private async aggregate(
    request: string,
    findings: Finding[],
    waveHistory: WaveResult[],
  ): Promise<string> {
    // Single-wave with few findings: skip LLM synthesis
    if (waveHistory.length === 1) {
      const wave = waveHistory[0];
      const outputs = Array.from(wave.results.values())
        .filter(r => r.success)
        .map(r => r.output);
      if (outputs.length === 1) return outputs[0];
    }

    const findingsSection = findings
      .map(f => `- ${f.content} (wave ${f.wave}, source: ${f.source})`)
      .join('\n');

    const rawResultsSection = waveHistory.flatMap(w =>
      Array.from(w.results.entries())
        .filter(([, r]) => r.success)
        .map(([id, r]) => `### ${id}\n${r.output.slice(0, 1000)}`)
    ).join('\n\n');

    const prompt = `You are producing a comprehensive investigative profile based on multi-wave research.

## Original Request
${request}

## Investigation Summary
Ran ${waveHistory.length} waves, accumulated ${findings.length} verified findings.

## Verified Findings (primary source — use these)
${findingsSection}

## Raw Worker Results (for additional detail)
${rawResultsSection}

## Instructions
- Present findings as a structured profile grouped by category
- Note confidence levels where relevant
- Flag any contradictions between sources
- Acknowledge what wasn't found (investigation gaps)
- Write in a unified voice — never reference "waves" or "workers"
- Do NOT invent information not present in the findings`;

    try {
      const response = await this.provider.chat([
        { role: 'system', content: 'You are producing a unified investigative report from multi-wave research findings.' },
        { role: 'user', content: prompt },
      ], { purpose: 'aggregation' } as ChatOptions);

      return response.content;
    } catch {
      // Fallback: concatenate findings
      return `## Investigation Findings\n\n${findingsSection}`;
    }
  }
}

const WAVE_PLANNING_SYSTEM = `You are coordinating a multi-wave investigation. After each wave of parallel research tasks, you review findings and decide what to investigate next.

## Principles
- Each wave should DEEPEN, not REPEAT. Never recreate a search already done.
- Reference specific findings: "Found employer 'Acme Corp' in Wave 1 — verify on LinkedIn"
- Prioritize cross-referencing: if Wave 1 found an address and Wave 2 found a name, Wave 3 should verify they match.
- Detect diminishing returns: if last wave found 0-1 new facts, strongly consider stopping.
- Tasks must be self-contained: workers have no conversation history, only the discovery context you provide.

## Task Format
Each task in your response must have: id, description, successCriteria, dependencies (usually []), priority, estimatedComplexity (low/medium/high).

Return your decision as a JSON object (no markdown fences needed, but they're OK).`;
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queen/DiscoveryCoordinator.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/queen/DiscoveryCoordinator.ts src/core/queen/DiscoveryCoordinator.test.ts
git commit -m "feat: DiscoveryCoordinator — multi-wave investigative execution core"
```

---

### Task 4: Wire Queen to DiscoveryCoordinator

Connect the Queen's decomposed path to delegate to the coordinator when appropriate.

**Files:**
- Modify: `src/core/queen/Queen.ts:1-20` (imports), `src/core/queen/Queen.ts:62-76` (class fields), `src/core/queen/Queen.ts:77-108` (constructor), `src/core/queen/Queen.ts:597-635` (handleDecomposedRequest)

**Step 1: Add import**

In `src/core/queen/Queen.ts`, add after the existing imports (around line 14):

```typescript
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
```

**Step 2: Add class field**

In the `Queen` class, add after `private memoryStore?` (line 75):

```typescript
  private discoveryCoordinator?: DiscoveryCoordinator;
```

**Step 3: Initialize in constructor**

In the constructor, after the worker pool creation (after line 108, before `// Set system prompt`):

```typescript
    // Create discovery coordinator if enabled
    const discoveryConfig = options.config.hive.progressiveDiscovery;
    if (discoveryConfig?.enabled) {
      this.discoveryCoordinator = new DiscoveryCoordinator({
        provider: planningProvider,
        workerPool: this.workerPool,
        config: discoveryConfig,
      });
    }
```

**Step 4: Add delegation in handleDecomposedRequest**

In `handleDecomposedRequest()`, after skill context is injected into tasks and tool effectiveness hints are set (around line 631, right before `this.currentTasks = plan.tasks;`), add:

```typescript
    // Delegate to DiscoveryCoordinator for multi-wave investigative requests
    if (plan.discoveryMode && this.discoveryCoordinator) {
      const tools = this.mcpServer?.getToolDefinitions();
      const discoveryResult = await this.discoveryCoordinator.execute(
        originalRequest,
        plan,
        {
          eventHandler: (event) => this.emitEvent(event),
          skillContext: this.currentSkillContext ? {
            name: this.currentSkillContext.name,
            instructions: this.currentSkillContext.instructions,
            resources: this.currentSkillContext.resources,
          } : undefined,
          conversationContext: this.buildConversationContext(),
          toolNames: tools?.map(t => t.name),
          toolDescriptions: tools?.map(t => t.description),
        },
      );

      // Store discovery result in memory
      this.memory.addMessage({
        role: 'assistant',
        content: discoveryResult.content,
        timestamp: new Date(),
      });

      this.emitPhaseChange('idle');
      return { content: discoveryResult.content, tokenUsage: discoveryResult.tokenUsage };
    }
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm test`
Expected: PASS (existing tests unaffected — discovery is opt-in)

**Step 7: Commit**

```bash
git add src/core/queen/Queen.ts
git commit -m "feat: wire Queen to DiscoveryCoordinator for investigative requests"
```

---

### Task 5: Server Protocol & WebSocket Serialization

Wire discovery events through the WebSocket to the web UI.

**Files:**
- Modify: `src/server/protocol.ts:103-112` (SerializedAgentEvent)
- Modify: `src/server/WebSocketHandler.ts` (event handling)

**Step 1: Add discovery_wave to SerializedAgentEvent**

In `src/server/protocol.ts`, add to the `SerializedAgentEvent` union (before line 112's closing):

```typescript
  | { type: 'discovery_wave'; waveNumber: number; status: 'started' | 'completed' | 'decision';
      taskCount?: number; findings?: string[]; totalFindings?: number;
      decision?: 'continue' | 'sufficient' | 'pivot'; reasoning?: string }
```

**Step 2: Handle discovery events in WebSocketHandler**

In `src/server/WebSocketHandler.ts`, in the event handler switch (find where `replan_triggered` and `evaluation_complete` are handled — around line 420-440), add cases for the three discovery event types:

```typescript
      case 'discovery_wave_start':
        this.send({
          type: 'agent_event',
          event: {
            type: 'discovery_wave',
            waveNumber: event.waveNumber,
            status: 'started',
            taskCount: event.taskCount,
            reasoning: event.reasoning,
          },
        });
        break;

      case 'discovery_wave_complete':
        this.send({
          type: 'agent_event',
          event: {
            type: 'discovery_wave',
            waveNumber: event.waveNumber,
            status: 'completed',
            findings: event.newFindings,
            totalFindings: event.totalFindings,
          },
        });
        break;

      case 'discovery_decision':
        this.send({
          type: 'agent_event',
          event: {
            type: 'discovery_wave',
            waveNumber: event.waveNumber,
            status: 'decision',
            decision: event.decision,
            reasoning: event.reasoning,
          },
        });
        break;
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/server/protocol.ts src/server/WebSocketHandler.ts
git commit -m "feat: serialize discovery wave events through WebSocket protocol"
```

---

### Task 6: Web UI — Discovery State & WorkerPanel Enhancement

Add discovery state tracking and display accumulated findings in the WorkerPanel.

**Files:**
- Modify: `web/src/hooks/useQueenSocket.ts:47-57` (state), `web/src/hooks/useQueenSocket.ts:139-177` (event handler)
- Modify: `web/src/hooks/useQueenSocket.ts:26-39` (return type)
- Modify: `web/src/components/workers/WorkerPanel.tsx:5-9` (props), `web/src/components/workers/WorkerPanel.tsx:29-48` (header)
- Sync shared types: run `npm run sync:types` first

**Step 1: Sync shared protocol types**

Run: `npm run sync:types`

This copies `src/shared/protocol.types.ts` (with the new `'discovering'` phase) to `web/src/lib/`.

**Step 2: Add SerializedAgentEvent to web protocol types**

The web client imports `SerializedAgentEvent` from `web/src/lib/protocol.ts`. This file re-exports from the server protocol types. Verify it includes the new `discovery_wave` variant. If the web has its own copy of `SerializedAgentEvent`, add the new variant there too.

**Step 3: Add discovery state to useQueenSocket**

In `web/src/hooks/useQueenSocket.ts`, add state after the existing state declarations (around line 56):

```typescript
  const [discoveryState, setDiscoveryState] = useState<{
    active: boolean;
    currentWave: number;
    maxWaves: number;
    findings: string[];
    waveHistory: Array<{ wave: number; findingCount: number; reasoning?: string }>;
  } | null>(null);
```

Add to the return type interface (`UseQueenSocketReturn`, around line 26):

```typescript
  discoveryState: typeof discoveryState;
```

And return it (around line 276):

```typescript
    discoveryState,
```

**Step 4: Handle discovery_wave events**

In the `handleAgentEvent` function (around line 139), add a case:

```typescript
      case 'discovery_wave':
        if (event.status === 'started') {
          setDiscoveryState(prev => ({
            active: true,
            currentWave: event.waveNumber,
            maxWaves: prev?.maxWaves ?? 4,
            findings: prev?.findings ?? [],
            waveHistory: prev?.waveHistory ?? [],
          }));
          setReasoning(`Discovery Wave ${event.waveNumber}: ${event.reasoning ?? 'Investigating...'}`);
        } else if (event.status === 'completed') {
          setDiscoveryState(prev => prev ? {
            ...prev,
            findings: [...prev.findings, ...(event.findings ?? [])],
            waveHistory: [...prev.waveHistory, {
              wave: event.waveNumber,
              findingCount: event.findings?.length ?? 0,
            }],
          } : null);
        } else if (event.status === 'decision') {
          if (event.decision === 'sufficient') {
            setReasoning(`Investigation complete: ${event.reasoning ?? ''}`);
          } else {
            setReasoning(`Wave ${event.waveNumber} → ${event.decision}: ${event.reasoning ?? ''}`);
          }
        }
        break;
```

Also reset discovery state in `clearMessages` and when phase goes to `idle`:

In the `phase_change` case:
```typescript
      case 'phase_change':
        setPhase(event.phase);
        if (event.phase === 'idle') {
          setDiscoveryState(null);
        }
        break;
```

In `clearMessages`:
```typescript
    setDiscoveryState(null);
```

**Step 5: Pass discoveryState to WorkerPanel**

In the parent component that renders `WorkerPanel` (likely `web/src/App.tsx` or a layout component), pass `discoveryState` as a prop. The WorkerPanel needs to show it.

**Step 6: Update WorkerPanel to show discovery info**

In `web/src/components/workers/WorkerPanel.tsx`, add to props:

```typescript
interface WorkerPanelProps {
  workers: SerializedWorkerState[];
  phase: AgentPhase;
  llmStats: LLMCallStats | null;
  discoveryState?: {
    active: boolean;
    currentWave: number;
    findings: string[];
    waveHistory: Array<{ wave: number; findingCount: number }>;
  } | null;
}
```

In the header section (around line 29-48), when `discoveryState?.active`, show wave info:

```tsx
{discoveryState?.active && (
  <div className="px-3 py-1.5 border-b border-border bg-surface-2/40">
    <div className="flex items-center gap-1.5 text-[10px] font-mono">
      <span className="text-accent-teal">Discovery Wave {discoveryState.currentWave}</span>
      <span className="text-text-muted">·</span>
      <span className="text-text-muted">{discoveryState.findings.length} findings</span>
    </div>
    {discoveryState.findings.length > 0 && (
      <div className="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
        {discoveryState.findings.slice(-5).map((f, i) => (
          <div key={i} className="text-[10px] text-text-muted truncate">
            • {f}
          </div>
        ))}
        {discoveryState.findings.length > 5 && (
          <div className="text-[10px] text-text-muted italic">
            +{discoveryState.findings.length - 5} more
          </div>
        )}
      </div>
    )}
  </div>
)}
```

**Step 7: Run typecheck on both frontend and backend**

Run: `npm run typecheck && cd web && npx tsc --noEmit`
Expected: PASS

**Step 8: Commit**

```bash
git add web/src/hooks/useQueenSocket.ts web/src/components/workers/WorkerPanel.tsx src/shared/protocol.types.ts
git commit -m "feat: web UI discovery state tracking and findings display"
```

---

### Task 7: Integration Test & Manual Verification

Verify the full pipeline works end-to-end.

**Files:**
- Create: `src/core/queen/DiscoveryCoordinator.integration.test.ts`

**Step 1: Write integration test**

Create `src/core/queen/DiscoveryCoordinator.integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { LLMProvider } from '../../providers/index.js';
import type { Task, TaskPlan, TaskResult, AgentEvent } from '../types.js';
import type { WorkerPool } from '../worker/WorkerPool.js';

/**
 * Integration test: verify the full wave loop including
 * context injection, deduplication, and aggregation.
 */
describe('DiscoveryCoordinator integration', () => {
  it('injects discovery context into wave 2 tasks', async () => {
    const events: AgentEvent[] = [];
    let wave2Tasks: Task[] | undefined;

    const mockPool = {
      executeTasks: vi.fn().mockImplementation((tasks: Task[]) => {
        const results = new Map<string, TaskResult>();
        if (tasks[0].id.startsWith('w2')) {
          wave2Tasks = tasks;
          results.set(tasks[0].id, {
            success: true,
            output: 'Verified',
            findings: ['Employer confirmed'],
            iterations: 1,
          });
        } else {
          results.set(tasks[0].id, {
            success: true,
            output: 'Initial discovery',
            findings: ['Name: John Doe', 'City: Tampa'],
            iterations: 2,
            bestScore: 0.8,
          });
        }
        return Promise.resolve(results);
      }),
    } as unknown as WorkerPool;

    const mockProvider = {
      chat: vi.fn()
        // Wave 1 decision: continue
        .mockResolvedValueOnce({
          content: JSON.stringify({
            action: 'continue',
            reasoning: 'Need to verify employer',
            tasks: [{ id: 'task-1', description: 'Verify employer', successCriteria: 'Verified', dependencies: [], priority: 1 }],
          }),
        })
        // Wave 2 decision: sufficient
        .mockResolvedValueOnce({
          content: JSON.stringify({ action: 'sufficient', reasoning: 'Done' }),
        })
        // Aggregation
        .mockResolvedValueOnce({ content: 'Final report.' }),
    } as unknown as LLMProvider;

    const coordinator = new DiscoveryCoordinator({
      provider: mockProvider,
      workerPool: mockPool,
      config: { enabled: true, maxWaves: 4, waveTimeout: 120000, totalTimeout: 600000, stoppingThreshold: 2 },
    });

    const plan: TaskPlan = {
      type: 'decomposed',
      reasoning: 'test',
      tasks: [{
        id: 'task-1',
        description: 'Search for person',
        successCriteria: 'Found info',
        dependencies: [],
        priority: 1,
        status: 'pending',
        createdAt: new Date(),
      }],
      discoveryMode: true,
    };

    await coordinator.execute('Find person', plan, {
      eventHandler: (e) => events.push(e),
    });

    // Verify wave 2 tasks received discovery context
    expect(wave2Tasks).toBeDefined();
    expect(wave2Tasks![0].dependencyResults).toBeDefined();
    const context = wave2Tasks![0].dependencyResults!.get('discovery-context');
    expect(context).toContain('Name: John Doe');
    expect(context).toContain('City: Tampa');
    expect(context).toContain('Wave 1');
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run src/core/queen/DiscoveryCoordinator.integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: PASS (all existing tests still pass)

**Step 4: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/queen/DiscoveryCoordinator.integration.test.ts
git commit -m "test: integration test for discovery wave context injection"
```

---

### Task 8: Enable by Default & Final Verification

Turn on progressive discovery in the default config and verify everything works with `npm run dev:web`.

**Files:**
- Modify: `config/default.yaml` (flip enabled to true)

**Step 1: Enable progressive discovery**

In `config/default.yaml`, change `progressiveDiscovery.enabled` from `false` to `true`.

**Step 2: Build and verify**

Run: `npm run build`
Expected: PASS (no build errors)

Run: `npm run typecheck`
Expected: PASS

Run: `npm test`
Expected: PASS

**Step 3: Manual test with dev server**

Run: `npm run dev:web`

In the browser, send a message like: "Research OpenAI company — deep research analysis of their products, leadership, and recent news"

Verify:
- Phase indicator shows "Discovering"
- WorkerPanel shows wave number and findings accumulating
- Multiple waves execute (check reasoning messages)
- Final response is a structured profile, not just concatenated results

**Step 4: Commit**

```bash
git add config/default.yaml
git commit -m "feat: enable progressive discovery by default"
```
