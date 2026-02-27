# Robustness Layer — v0.2.1

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make PersonalAgent's agent loop robust — it should know when to stop, what went wrong, what things cost, and what to remember. This plan adds failure taxonomy, cost awareness, intelligent loop termination, structured context management, and cross-session memory.

**Architecture:** Four pillars layered onto the existing v0.2.0 foundation:
1. **Failure Intelligence** — structured failure classification drives recovery decisions instead of heuristic string matching
2. **Cost Awareness** — every LLM call has a price, every retry has a cost-benefit calculation, and budgets are enforced
3. **Context Hygiene** — Ralph Loop iterations get hierarchical summarization (HiAgent pattern) instead of naive observation masking; feedback is structured, not appended strings
4. **Persistent Memory** — filesystem-based memory following the GCC/A-MEM pattern with strength-based forgetting (MemoryBank's Ebbinghaus curve)

**Tech Stack:** TypeScript (ES2022, strict), Vitest, Zod, existing provider abstraction. No new dependencies — all patterns are implemented in-house.

**Research basis:** This plan is grounded in specific papers. Each task references its source. Key papers:
- MAST: Why Do Multi-Agent LLM Systems Fail? (NeurIPS 2025)
- BATS: Budget-Aware Tool-Use (2025)
- HiAgent: Hierarchical Working Memory (ACL 2025)
- The Complexity Trap: Observation Masking (NeurIPS 2025 Workshop)
- The Illusion of Diminishing Returns (2025) — self-conditioning in agent loops
- GCC: Git Context Controller (2025) — filesystem-as-memory with COMMIT/BRANCH
- MemoryBank (2023) — Ebbinghaus forgetting curve for agent memory
- FrugalGPT / RouteLLM / Hybrid LLM — cost-aware model routing
- Alas: Adaptive LLM Agent Scheduler (2025) — local-first recovery, disruption penalty

**Prerequisite:** This plan assumes Phase 1 of the v0.2.0 overhaul is complete (purpose temperatures, stripped prompts, honest failures, eval loop removed). Tasks here are numbered starting at 16 to continue from that plan's Task 15.

---

## Phase A: Failure Intelligence (Pillar 1)

These tasks give the system a vocabulary for failure. Instead of "task failed" with a string reason, failures are structured objects that drive recovery decisions.

---

### Task 16: Failure Taxonomy Types

Define the structured failure classification system. No behavior changes yet — just types.

**Research source:** MAST (NeurIPS 2025) identifies 14 failure modes across 3 categories. AgentErrorTaxonomy (ICLR 2025 Workshop) adds a 5-layer operational model. TALLM (AST 2025) specifically addresses tool-use failures. We synthesize these into a practical taxonomy for our Queen/Worker architecture.

**Files:**
- Create: `src/core/failures.ts`
- Test: `src/core/failures.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/failures.test.ts
import { classifyFailure, FailureCategory, RecoveryAction } from './failures.js';

describe('classifyFailure', () => {
  it('should classify tool infrastructure failure', () => {
    const result = classifyFailure({
      exitReason: 'total_tool_failure',
      toolFailures: [
        { tool: 'web_search', error: 'ECONNREFUSED', category: 'network' },
        { tool: 'web_search', error: 'ECONNREFUSED', category: 'network' },
      ],
      bestScore: 0,
      iterations: 2,
    });

    expect(result.category).toBe(FailureCategory.Infrastructure);
    expect(result.subcategory).toBe('tool_unavailable');
    expect(result.isTransient).toBe(true);
    expect(result.suggestedRecovery).toBe(RecoveryAction.RetryWithBackoff);
  });

  it('should classify strategy exhaustion', () => {
    const result = classifyFailure({
      exitReason: 'stall',
      toolFailures: [],
      bestScore: 0.45,
      iterations: 5,
    });

    expect(result.category).toBe(FailureCategory.Strategy);
    expect(result.subcategory).toBe('approach_exhausted');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.Replan);
  });

  it('should classify impossible task', () => {
    const result = classifyFailure({
      exitReason: 'hopelessness',
      toolFailures: [],
      bestScore: 0.05,
      iterations: 6,
    });

    expect(result.category).toBe(FailureCategory.TaskDefinition);
    expect(result.subcategory).toBe('likely_impossible');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.ReportHonestly);
  });

  it('should classify quota exhaustion as non-transient infrastructure', () => {
    const result = classifyFailure({
      exitReason: 'total_tool_failure',
      toolFailures: [
        { tool: 'web_search', error: 'Rate limit exceeded', category: 'quota' },
      ],
      bestScore: 0,
      iterations: 1,
    });

    expect(result.category).toBe(FailureCategory.Infrastructure);
    expect(result.subcategory).toBe('quota_exhausted');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.ReportHonestly);
  });

  it('should classify partial progress with model limitation', () => {
    const result = classifyFailure({
      exitReason: 'max_iterations',
      toolFailures: [],
      bestScore: 0.65,
      iterations: 5,
    });

    expect(result.category).toBe(FailureCategory.ModelCapability);
    expect(result.subcategory).toBe('insufficient_reasoning');
    expect(result.isTransient).toBe(false);
    expect(result.suggestedRecovery).toBe(RecoveryAction.EscalateModel);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/failures.test.ts -v`
Expected: FAIL — module does not exist

**Step 3: Implement**

```typescript
// src/core/failures.ts

export enum FailureCategory {
  Infrastructure = 'infrastructure',   // Tools down, network, quota
  Strategy = 'strategy',               // Approach exhausted, stalled
  TaskDefinition = 'task_definition',   // Impossible, ambiguous, missing info
  ModelCapability = 'model_capability', // Model not capable enough
  Coordination = 'coordination',       // Inter-agent issues (cascading, dependency)
}

export enum RecoveryAction {
  RetryWithBackoff = 'retry_with_backoff',   // Transient infra — wait and retry
  RetrySameModel = 'retry_same_model',       // Try again with different strategy
  EscalateModel = 'escalate_model',          // Use a more capable model
  Replan = 'replan',                         // Re-decompose the task
  ReportHonestly = 'report_honestly',        // Give up and tell the user
  SkipAndContinue = 'skip_and_continue',     // Non-critical subtask, move on
}

export interface ClassifiedFailure {
  category: FailureCategory;
  subcategory: string;
  isTransient: boolean;
  suggestedRecovery: RecoveryAction;
  confidence: number;         // 0-1: how confident are we in this classification
  context: string;            // Human-readable explanation for Queen
  partialOutput?: string;     // Best output so far, if any
  partialScore?: number;      // Best verification score achieved
}

export interface FailureInput {
  exitReason: string;
  toolFailures: Array<{ tool: string; error: string; category?: string }>;
  bestScore: number;
  iterations: number;
  output?: string;
}

export function classifyFailure(input: FailureInput): ClassifiedFailure {
  const { exitReason, toolFailures, bestScore, iterations } = input;

  // Infrastructure failures — tools are broken
  if (exitReason === 'total_tool_failure' || toolFailures.length > 0) {
    const allQuota = toolFailures.every(f => f.category === 'quota');
    const allNetwork = toolFailures.every(f =>
      f.category === 'network' || f.category === 'timeout'
    );

    if (allQuota) {
      return {
        category: FailureCategory.Infrastructure,
        subcategory: 'quota_exhausted',
        isTransient: false,
        suggestedRecovery: RecoveryAction.ReportHonestly,
        confidence: 0.9,
        context: `Tools hit rate limits: ${toolFailures.map(f => f.tool).join(', ')}`,
        partialScore: bestScore,
      };
    }

    if (allNetwork) {
      return {
        category: FailureCategory.Infrastructure,
        subcategory: 'tool_unavailable',
        isTransient: true,
        suggestedRecovery: RecoveryAction.RetryWithBackoff,
        confidence: 0.85,
        context: `Network failures on: ${toolFailures.map(f => f.tool).join(', ')}`,
        partialScore: bestScore,
      };
    }

    return {
      category: FailureCategory.Infrastructure,
      subcategory: 'tool_error',
      isTransient: false,
      suggestedRecovery: bestScore > 0.3
        ? RecoveryAction.RetrySameModel
        : RecoveryAction.ReportHonestly,
      confidence: 0.7,
      context: `Tool failures: ${toolFailures.map(f => `${f.tool}: ${f.error}`).join('; ')}`,
      partialScore: bestScore,
    };
  }

  // Stall — same output repeated, strategy exhausted
  if (exitReason === 'stall') {
    return {
      category: FailureCategory.Strategy,
      subcategory: 'approach_exhausted',
      isTransient: false,
      suggestedRecovery: bestScore > 0.5
        ? RecoveryAction.Replan
        : RecoveryAction.EscalateModel,
      confidence: 0.8,
      context: `Worker stalled after ${iterations} iterations (best score: ${bestScore})`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Hopelessness — score never got above threshold
  if (exitReason === 'hopelessness') {
    return {
      category: FailureCategory.TaskDefinition,
      subcategory: 'likely_impossible',
      isTransient: false,
      suggestedRecovery: RecoveryAction.ReportHonestly,
      confidence: 0.75,
      context: `Task appears unachievable — best score ${bestScore} after ${iterations} iterations`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Divergence — quality getting worse
  if (exitReason === 'divergence') {
    return {
      category: FailureCategory.Strategy,
      subcategory: 'quality_degrading',
      isTransient: false,
      suggestedRecovery: RecoveryAction.Replan,
      confidence: 0.8,
      context: `Quality diverged across iterations — approach is counterproductive`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Max iterations with decent progress — model capability issue
  if (exitReason === 'max_iterations' && bestScore > 0.4) {
    return {
      category: FailureCategory.ModelCapability,
      subcategory: 'insufficient_reasoning',
      isTransient: false,
      suggestedRecovery: RecoveryAction.EscalateModel,
      confidence: 0.6,
      context: `Made progress (score: ${bestScore}) but couldn't complete in ${iterations} iterations`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Max iterations with no progress — task or strategy issue
  if (exitReason === 'max_iterations') {
    return {
      category: FailureCategory.Strategy,
      subcategory: 'approach_exhausted',
      isTransient: false,
      suggestedRecovery: RecoveryAction.Replan,
      confidence: 0.5,
      context: `No meaningful progress after ${iterations} iterations (best: ${bestScore})`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Timeout
  if (exitReason === 'timeout') {
    return {
      category: FailureCategory.Infrastructure,
      subcategory: 'timeout',
      isTransient: true,
      suggestedRecovery: bestScore > 0.5
        ? RecoveryAction.SkipAndContinue
        : RecoveryAction.RetryWithBackoff,
      confidence: 0.7,
      context: `Worker timed out after ${iterations} iterations`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Cancelled — not really a failure, but handle gracefully
  if (exitReason === 'cancelled') {
    return {
      category: FailureCategory.Coordination,
      subcategory: 'cancelled_by_queen',
      isTransient: false,
      suggestedRecovery: RecoveryAction.SkipAndContinue,
      confidence: 1.0,
      context: `Task cancelled (likely due to dependency failure)`,
      partialOutput: input.output,
      partialScore: bestScore,
    };
  }

  // Fallback
  return {
    category: FailureCategory.Strategy,
    subcategory: 'unknown',
    isTransient: false,
    suggestedRecovery: RecoveryAction.ReportHonestly,
    confidence: 0.3,
    context: `Unclassified failure: ${exitReason}`,
    partialOutput: input.output,
    partialScore: bestScore,
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/failures.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass (this is a new module with no integration yet)

**Step 6: Commit**

```bash
git add src/core/failures.ts src/core/failures.test.ts
git commit -m "feat: structured failure taxonomy — classifies failures into categories with recovery suggestions"
```

---

### Task 17: Wire Failure Classification into Queen Escalation

Replace the Queen's heuristic `classifyEscalation()` with the structured failure taxonomy. Recovery decisions now come from the failure classifier, not ad-hoc string matching.

**Research source:** Alas (2025) — local-first recovery with disruption penalty. Don't globally replan when a local retry would suffice.

**Files:**
- Modify: `src/core/queen/Queen.ts` — `classifyEscalation()` method and `aggregateResults()`
- Modify: `src/core/worker/RalphLoop.ts` — attach failure classification to TaskResult
- Modify: `src/core/types.ts` — add `ClassifiedFailure` to TaskResult
- Test: `src/core/queen/Queen.test.ts`

**Step 1: Write the failing test**

```typescript
// In src/core/queen/Queen.test.ts
import { FailureCategory, RecoveryAction } from '../failures.js';

describe('Queen failure-driven escalation', () => {
  it('should retry with backoff for transient infrastructure failures', async () => {
    const result = createFailedTaskResult({
      exitReason: 'total_tool_failure',
      toolFailures: [{ tool: 'web_search', error: 'ECONNREFUSED', category: 'network' }],
      bestScore: 0,
    });

    const decision = queen.classifyEscalation(result, { replanCount: 0, dependentTaskIds: [] });

    expect(decision.action).toBe('retry');
    expect(decision.delay).toBeGreaterThan(0); // backoff
  });

  it('should replan for strategy exhaustion only if disruption cost is low', async () => {
    const result = createFailedTaskResult({
      exitReason: 'stall',
      bestScore: 0.45,
    });

    // 3 of 4 tasks already completed — disruption cost is high
    const decision = queen.classifyEscalation(result, {
      replanCount: 0,
      dependentTaskIds: [],
      completedTaskCount: 3,
      totalTaskCount: 4,
    });

    // Should NOT replan when most work is done — just report the partial result
    expect(decision.action).toBe('accept_partial');
  });

  it('should escalate model when model capability is the issue', async () => {
    const result = createFailedTaskResult({
      exitReason: 'max_iterations',
      bestScore: 0.65,
    });

    const decision = queen.classifyEscalation(result, { replanCount: 0, dependentTaskIds: [] });

    expect(decision.action).toBe('retry_stronger_model');
  });

  it('should report honestly for impossible tasks', async () => {
    const result = createFailedTaskResult({
      exitReason: 'hopelessness',
      bestScore: 0.05,
    });

    const decision = queen.classifyEscalation(result, { replanCount: 0, dependentTaskIds: [] });

    expect(decision.action).toBe('accept_failure');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/Queen.test.ts -t "failure-driven" -v`
Expected: FAIL — current classifyEscalation doesn't return these action types

**Step 3: Implement**

In `src/core/types.ts`, add to TaskResult:
```typescript
import type { ClassifiedFailure } from './failures.js';

export interface TaskResult {
  // ... existing fields ...
  failure?: ClassifiedFailure;  // Structured failure classification (only when !success)
}
```

In `src/core/worker/RalphLoop.ts`, at every exit point that produces a non-success result, add:
```typescript
import { classifyFailure } from '../failures.js';

// At each failure exit (stall, hopelessness, max_iterations, timeout, etc.):
const failure = classifyFailure({
  exitReason,
  toolFailures: context.lastToolFailures ?? [],
  bestScore: context.bestScore,
  iterations: context.iteration,
  output: context.bestOutput,
});

return {
  success: false,
  output: context.bestOutput || lastOutput,
  // ... existing fields ...
  failure,
};
```

In `src/core/queen/Queen.ts`, rewrite `classifyEscalation()`:

```typescript
interface EscalationContext {
  replanCount: number;
  dependentTaskIds: string[];
  completedTaskCount?: number;
  totalTaskCount?: number;
}

interface EscalationDecision {
  action: 'retry' | 'retry_stronger_model' | 'replan' | 'accept_partial' | 'accept_failure';
  delay?: number;        // ms, for retry_with_backoff
  reason: string;
}

classifyEscalation(result: TaskResult, ctx: EscalationContext): EscalationDecision {
  const failure = result.failure;
  if (!failure) {
    return { action: 'accept_failure', reason: 'No failure classification available' };
  }

  // Disruption penalty (Alas pattern): if most work is done, don't replan
  const completionRatio = (ctx.completedTaskCount ?? 0) / (ctx.totalTaskCount ?? 1);
  const highDisruption = completionRatio > 0.6;

  switch (failure.suggestedRecovery) {
    case RecoveryAction.RetryWithBackoff:
      return {
        action: 'retry',
        delay: 2000 * (ctx.replanCount + 1), // exponential-ish backoff
        reason: failure.context,
      };

    case RecoveryAction.EscalateModel:
      return {
        action: 'retry_stronger_model',
        reason: failure.context,
      };

    case RecoveryAction.Replan:
      if (highDisruption) {
        // Most work done — accept partial rather than disrupting
        return {
          action: 'accept_partial',
          reason: `${failure.context}. Not replanning — ${ctx.completedTaskCount}/${ctx.totalTaskCount} tasks complete.`,
        };
      }
      if (ctx.replanCount >= 2) {
        return { action: 'accept_failure', reason: `${failure.context}. Max replans reached.` };
      }
      return { action: 'replan', reason: failure.context };

    case RecoveryAction.ReportHonestly:
      return { action: 'accept_failure', reason: failure.context };

    case RecoveryAction.SkipAndContinue:
      return { action: 'accept_partial', reason: failure.context };

    default:
      return { action: 'accept_failure', reason: failure.context };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/queen/Queen.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/core/types.ts src/core/worker/RalphLoop.ts src/core/queen/Queen.ts src/core/queen/Queen.test.ts
git commit -m "feat: wire failure taxonomy into Queen escalation — recovery driven by failure classification"
```

---

### Task 18: Partial Progress Preservation

When a task fails with decent partial progress (bestScore > 0.4), preserve the partial output and pass it to the replanner as context. Don't throw away 70% correct work.

**Research source:** Alas LRCP (2025) — "local reactive compensation" prioritizes low-overhead recovery. HiAgent (ACL 2025) — subgoal completion tracking preserves work across boundaries.

**Files:**
- Modify: `src/core/queen/TaskPlanner.ts` — `replan()` method accepts partial results
- Test: `src/core/queen/TaskPlanner.test.ts`

**Step 1: Write the failing test**

```typescript
describe('TaskPlanner.replan with partial results', () => {
  it('should include partial output in replanned task context', async () => {
    const chatSpy = vi.spyOn(mockProvider, 'chat');

    await planner.replan({
      failureReason: 'Strategy exhausted',
      completedTasks: [],
      failedTasks: [{
        id: 'task-1',
        description: 'Research AAPL stock',
        exitReason: 'stall',
        bestScore: 0.65,
        partialOutput: 'Found current price $182.50 and P/E ratio of 28.3, but could not find analyst opinions.',
        failure: {
          category: FailureCategory.Strategy,
          subcategory: 'approach_exhausted',
          suggestedRecovery: RecoveryAction.Replan,
        },
      }],
      cancelledTaskIds: [],
    });

    const prompt = chatSpy.mock.calls[0][0].map((m: any) => m.content).join(' ');
    // Partial output should be included so replanner can build on it
    expect(prompt).toContain('Found current price $182.50');
    // Failure classification should be included so replanner knows WHY it failed
    expect(prompt).toContain('approach_exhausted');
  });

  it('should instruct replanned task to build on partial results, not restart', async () => {
    const chatSpy = vi.spyOn(mockProvider, 'chat');

    await planner.replan({
      failureReason: 'Strategy exhausted',
      completedTasks: [],
      failedTasks: [{
        id: 'task-1',
        description: 'Research AAPL stock',
        exitReason: 'stall',
        bestScore: 0.65,
        partialOutput: 'Found price and P/E ratio...',
        failure: {
          category: FailureCategory.Strategy,
          subcategory: 'approach_exhausted',
          suggestedRecovery: RecoveryAction.Replan,
        },
      }],
      cancelledTaskIds: [],
    });

    const prompt = chatSpy.mock.calls[0][0].map((m: any) => m.content).join(' ');
    expect(prompt).toContain('build on');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/TaskPlanner.test.ts -t "partial results" -v`
Expected: FAIL

**Step 3: Implement**

In `TaskPlanner.ts`, modify the `replan()` method's prompt construction. Where it currently builds `failedTasks` context, enrich it:

```typescript
// In the replan prompt construction, replace the failed task section:
const failedTaskSummaries = replanContext.failedTasks.map(task => {
  const lines = [
    `- Task: ${task.description}`,
    `  Failure: ${task.failure?.subcategory ?? task.exitReason} (${task.failure?.category ?? 'unknown'})`,
    `  Recovery suggestion: ${task.failure?.suggestedRecovery ?? 'unknown'}`,
  ];

  if (task.bestScore && task.bestScore > 0.3 && task.partialOutput) {
    lines.push(
      `  Progress: ${Math.round(task.bestScore * 100)}% complete`,
      `  Partial results (build on these, do NOT restart from scratch):`,
      `  ${task.partialOutput.slice(0, 1500)}`,
    );
  }

  return lines.join('\n');
}).join('\n\n');
```

**Step 4: Run tests**

Run: `npx vitest run src/core/queen/TaskPlanner.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/queen/TaskPlanner.ts src/core/queen/TaskPlanner.test.ts
git commit -m "feat: preserve partial progress in replanning — don't discard 70% correct work"
```

---

## Phase B: Cost Awareness (Pillar 2)

The system currently tracks token counts but has no concept of cost. These tasks add a cost model, budget enforcement, and cost-benefit analysis for recovery decisions.

---

### Task 19: Provider Cost Registry

A static registry of per-provider pricing. No behavior changes — just data.

**Research source:** FrugalGPT (TMLR 2024), BATS (2025). Both require cost data to make routing/budget decisions.

**Files:**
- Create: `src/core/cost/CostRegistry.ts`
- Test: `src/core/cost/CostRegistry.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/cost/CostRegistry.test.ts
import { CostRegistry } from './CostRegistry.js';

describe('CostRegistry', () => {
  it('should return cost for known provider and model', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('openai', 'gpt-4o', {
      input: 1000,
      output: 500,
      total: 1500,
    });

    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01); // 1K input + 500 output for gpt-4o should be < 1 cent
  });

  it('should return zero for self-hosted providers', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('ollama', 'llama3', {
      input: 10000,
      output: 5000,
      total: 15000,
    });

    expect(cost).toBe(0);
  });

  it('should use fallback pricing for unknown models', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('openai', 'gpt-future-9', {
      input: 1000,
      output: 500,
      total: 1500,
    });

    // Should use the provider's default/fallback pricing
    expect(cost).toBeGreaterThan(0);
  });

  it('should allow custom pricing overrides', () => {
    const registry = new CostRegistry({
      overrides: {
        'openai-compatible': {
          default: { inputPer1M: 0.50, outputPer1M: 1.50 },
        },
      },
    });

    const cost = registry.calculateCost('openai-compatible', 'custom-model', {
      input: 1_000_000,
      output: 1_000_000,
      total: 2_000_000,
    });

    expect(cost).toBeCloseTo(2.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cost/CostRegistry.test.ts -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/core/cost/CostRegistry.ts
import type { TokenUsage } from '../types.js';

interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

interface ProviderPricing {
  models: Record<string, ModelPricing>;
  default: ModelPricing;
}

// Pricing as of early 2026 — update periodically
const DEFAULT_PRICING: Record<string, ProviderPricing> = {
  openai: {
    models: {
      'gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.00 },
      'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
      'gpt-4.1': { inputPer1M: 2.00, outputPer1M: 8.00 },
      'gpt-4.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60 },
      'gpt-4.1-nano': { inputPer1M: 0.10, outputPer1M: 0.40 },
      'o3-mini': { inputPer1M: 1.10, outputPer1M: 4.40 },
    },
    default: { inputPer1M: 2.50, outputPer1M: 10.00 },
  },
  anthropic: {
    models: {
      'claude-sonnet-4-6': { inputPer1M: 3.00, outputPer1M: 15.00 },
      'claude-haiku-4-5-20251001': { inputPer1M: 0.80, outputPer1M: 4.00 },
      'claude-opus-4-6': { inputPer1M: 15.00, outputPer1M: 75.00 },
    },
    default: { inputPer1M: 3.00, outputPer1M: 15.00 },
  },
  gemini: {
    models: {
      'gemini-2.0-flash': { inputPer1M: 0.10, outputPer1M: 0.40 },
      'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.00 },
      'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.60 },
    },
    default: { inputPer1M: 0.15, outputPer1M: 0.60 },
  },
  ollama: {
    models: {},
    default: { inputPer1M: 0, outputPer1M: 0 },
  },
};

interface CostRegistryOptions {
  overrides?: Record<string, Partial<ProviderPricing>>;
}

export class CostRegistry {
  private pricing: Record<string, ProviderPricing>;

  constructor(options?: CostRegistryOptions) {
    this.pricing = { ...DEFAULT_PRICING };

    if (options?.overrides) {
      for (const [provider, override] of Object.entries(options.overrides)) {
        this.pricing[provider] = {
          models: {
            ...(this.pricing[provider]?.models ?? {}),
            ...(override.models ?? {}),
          },
          default: override.default ?? this.pricing[provider]?.default ?? { inputPer1M: 0, outputPer1M: 0 },
        };
      }
    }
  }

  calculateCost(provider: string, model: string, usage: TokenUsage): number {
    const providerPricing = this.pricing[provider];
    if (!providerPricing) return 0;

    const modelPricing = providerPricing.models[model] ?? providerPricing.default;

    return (
      (usage.input * modelPricing.inputPer1M) / 1_000_000 +
      (usage.output * modelPricing.outputPer1M) / 1_000_000
    );
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/cost/CostRegistry.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/cost/CostRegistry.ts src/core/cost/CostRegistry.test.ts
git commit -m "feat: provider cost registry — static pricing data for cost calculations"
```

---

### Task 20: Cost Tracker Integration

Wire the cost registry into `ProgressTracker` so every LLM call has a cost in USD. Add per-request cost accumulation and budget enforcement.

**Research source:** BATS (2025) — budget awareness injection. CostBench (2025) — cost-optimal planning evaluation.

**Files:**
- Modify: `src/core/progress/ProgressTracker.ts` — add cost tracking
- Modify: `src/providers/TrackedProvider.ts` — emit cost with each call
- Create: `src/core/cost/BudgetGuard.ts` — budget enforcement
- Test: `src/core/cost/BudgetGuard.test.ts`
- Test: `src/core/progress/ProgressTracker.test.ts` (add cost tests)

**Step 1: Write the failing test**

```typescript
// src/core/cost/BudgetGuard.test.ts
import { BudgetGuard } from './BudgetGuard.js';

describe('BudgetGuard', () => {
  it('should allow calls within budget', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });

    guard.recordCost(0.10);
    guard.recordCost(0.15);

    expect(guard.isExhausted()).toBe(false);
    expect(guard.remaining()).toBeCloseTo(0.25);
  });

  it('should flag exhaustion when budget exceeded', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });

    guard.recordCost(0.30);
    guard.recordCost(0.25);

    expect(guard.isExhausted()).toBe(true);
    expect(guard.remaining()).toBeLessThanOrEqual(0);
  });

  it('should provide budget status summary for prompt injection', () => {
    const guard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    guard.recordCost(0.35);

    const status = guard.status();

    expect(status.spent).toBeCloseTo(0.35);
    expect(status.remaining).toBeCloseTo(0.15);
    expect(status.percentUsed).toBeCloseTo(70);
  });

  it('should be disabled when no budget set', () => {
    const guard = new BudgetGuard({});

    guard.recordCost(100);

    expect(guard.isExhausted()).toBe(false);
    expect(guard.isEnabled()).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cost/BudgetGuard.test.ts -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/core/cost/BudgetGuard.ts

interface BudgetConfig {
  maxCostPerRequest?: number;  // USD, undefined = unlimited
}

interface BudgetStatus {
  spent: number;
  remaining: number;
  percentUsed: number;
  isExhausted: boolean;
}

export class BudgetGuard {
  private spent = 0;
  private readonly maxCost?: number;

  constructor(config: BudgetConfig) {
    this.maxCost = config.maxCostPerRequest;
  }

  recordCost(amount: number): void {
    this.spent += amount;
  }

  isExhausted(): boolean {
    if (this.maxCost === undefined) return false;
    return this.spent >= this.maxCost;
  }

  isEnabled(): boolean {
    return this.maxCost !== undefined;
  }

  remaining(): number {
    if (this.maxCost === undefined) return Infinity;
    return this.maxCost - this.spent;
  }

  status(): BudgetStatus {
    return {
      spent: this.spent,
      remaining: this.remaining(),
      percentUsed: this.maxCost ? (this.spent / this.maxCost) * 100 : 0,
      isExhausted: this.isExhausted(),
    };
  }

  reset(): void {
    this.spent = 0;
  }
}
```

In `ProgressTracker.ts`, add cost fields:
```typescript
// Add to the stats tracking:
totalCost: number;  // USD accumulated
costByPurpose: Record<string, number>;
```

In `TrackedProvider.ts`, after each `chat()` call:
```typescript
// After getting response with tokenUsage:
if (response.tokenUsage) {
  const cost = this.costRegistry.calculateCost(
    this.provider.name, this.provider.model, response.tokenUsage
  );
  this.budgetGuard?.recordCost(cost);
  this.tracker.recordCost(cost, this.purpose);
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/cost/ -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/core/cost/ src/core/progress/ProgressTracker.ts src/providers/TrackedProvider.ts
git commit -m "feat: cost tracking and budget guard — every LLM call priced in USD with budget enforcement"
```

---

### Task 21: Budget Awareness in Ralph Loop

Inject remaining budget into Worker prompts at each iteration. Workers become aware of their resource constraints and can adjust strategy accordingly. Also: abort the loop early when budget is exhausted.

**Research source:** BATS (2025) — simply informing the agent of remaining budget improves cost-efficiency by 2x. Token-Budget-Aware LLM Reasoning (ACL 2025) — prompt-based budget hints compress reasoning with minimal quality loss.

**Files:**
- Modify: `src/core/worker/RalphLoop.ts` — check budget before each iteration, pass to prompt
- Modify: `src/core/worker/iterationPrompt.ts` — add budget status section
- Test: `src/core/worker/RalphLoop.test.ts`

**Step 1: Write the failing test**

```typescript
describe('RalphLoop budget awareness', () => {
  it('should abort early when budget is exhausted', async () => {
    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 0.01 }); // Very low budget
    budgetGuard.recordCost(0.01); // Already spent

    const result = await ralphLoop(provider, task, {
      ...defaultOptions,
      budgetGuard,
    });

    expect(result.exitReason).toBe('budget_exhausted');
    expect(result.iterations).toBe(0);
  });

  it('should inject budget status into iteration prompt', async () => {
    const budgetGuard = new BudgetGuard({ maxCostPerRequest: 0.50 });
    budgetGuard.recordCost(0.35);

    const chatSpy = vi.spyOn(provider, 'chat');

    await ralphLoop(provider, task, {
      ...defaultOptions,
      budgetGuard,
      maxIterations: 1,
    });

    const prompt = chatSpy.mock.calls[0][0].map((m: any) => m.content).join(' ');
    expect(prompt).toContain('Budget: 30% remaining');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/RalphLoop.test.ts -t "budget" -v`
Expected: FAIL

**Step 3: Implement**

In `RalphLoop.ts`, at the top of the iteration loop (before the LLM call):
```typescript
// Check budget before each iteration
if (options.budgetGuard?.isExhausted()) {
  return {
    success: false,
    output: context.bestOutput || '',
    exitReason: 'budget_exhausted',
    iterations: context.iteration,
    failure: classifyFailure({
      exitReason: 'budget_exhausted',
      toolFailures: [],
      bestScore: context.bestScore,
      iterations: context.iteration,
    }),
  };
}
```

In `iterationPrompt.ts`, in `buildIterationPrompt()`, add a budget section:
```typescript
if (context.budgetStatus) {
  const { percentUsed, remaining } = context.budgetStatus;
  const remainingPct = Math.round(100 - percentUsed);
  sections.push(
    `## Resource Budget\nBudget: ${remainingPct}% remaining.` +
    (remainingPct < 30
      ? ' Prioritize completing the most important criteria. Be concise.'
      : '')
  );
}
```

Add `budget_exhausted` to the `classifyFailure` function in `failures.ts`:
```typescript
if (exitReason === 'budget_exhausted') {
  return {
    category: FailureCategory.Infrastructure,
    subcategory: 'budget_exhausted',
    isTransient: false,
    suggestedRecovery: bestScore > 0.5
      ? RecoveryAction.SkipAndContinue
      : RecoveryAction.ReportHonestly,
    confidence: 1.0,
    context: `Budget exhausted after ${iterations} iterations (best: ${bestScore})`,
    partialOutput: input.output,
    partialScore: bestScore,
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/RalphLoop.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/worker/RalphLoop.ts src/core/worker/iterationPrompt.ts src/core/failures.ts src/core/worker/RalphLoop.test.ts
git commit -m "feat: budget awareness in Ralph Loop — workers know their resource constraints"
```

---

## Phase C: Context Hygiene (Pillar 3)

Replace naive context accumulation with structured, hierarchical context management. Failed iteration traces get summarized (not accumulated verbatim). Feedback becomes structured objects. Self-conditioning is mitigated.

---

### Task 22: Structured Feedback Objects

Replace appended feedback strings with structured objects that track status (resolved/pending) per criterion. Old resolved feedback is collapsed.

**Research source:** The Illusion of Diminishing Returns (2025) — agents suffer from self-conditioning when context contains their own prior errors. Resolved feedback about old failures adds noise and increases the chance of repeating those errors.

**Files:**
- Create: `src/core/worker/StructuredFeedback.ts`
- Modify: `src/core/worker/RalphLoop.ts` — use structured feedback
- Modify: `src/core/worker/iterationPrompt.ts` — render structured feedback
- Test: `src/core/worker/StructuredFeedback.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/worker/StructuredFeedback.test.ts
import { FeedbackTracker } from './StructuredFeedback.js';

describe('FeedbackTracker', () => {
  it('should track feedback per criterion', () => {
    const tracker = new FeedbackTracker();

    tracker.addFeedback(1, 'criterion-A', {
      status: 'failing',
      score: 0.2,
      feedback: 'No data found for criterion A',
    });

    tracker.addFeedback(1, 'criterion-B', {
      status: 'passing',
      score: 0.9,
      feedback: 'Criterion B fully met',
    });

    expect(tracker.pendingCriteria()).toEqual(['criterion-A']);
    expect(tracker.resolvedCriteria()).toEqual(['criterion-B']);
  });

  it('should mark criterion as resolved when it passes', () => {
    const tracker = new FeedbackTracker();

    tracker.addFeedback(1, 'criterion-A', {
      status: 'failing', score: 0.2, feedback: 'Not found',
    });

    tracker.addFeedback(2, 'criterion-A', {
      status: 'passing', score: 0.85, feedback: 'Found and verified',
    });

    expect(tracker.pendingCriteria()).toEqual([]);
    expect(tracker.resolvedCriteria()).toEqual(['criterion-A']);
  });

  it('should render only pending feedback for prompt', () => {
    const tracker = new FeedbackTracker();

    tracker.addFeedback(1, 'criterion-A', {
      status: 'failing', score: 0.2, feedback: 'Missing',
    });
    tracker.addFeedback(1, 'criterion-B', {
      status: 'passing', score: 0.9, feedback: 'Good',
    });
    tracker.addFeedback(2, 'criterion-A', {
      status: 'failing', score: 0.4, feedback: 'Improved but incomplete',
    });

    const rendered = tracker.renderForPrompt();

    // Should show criterion-A's LATEST feedback only
    expect(rendered).toContain('Improved but incomplete');
    // Should NOT show old iteration 1 feedback for A
    expect(rendered).not.toContain('Missing');
    // Should NOT show resolved criterion B details
    expect(rendered).not.toContain('Good');
    // Should mention B is resolved (brief acknowledgment)
    expect(rendered).toContain('criterion-B');
    expect(rendered).toContain('resolved');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/StructuredFeedback.test.ts -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/core/worker/StructuredFeedback.ts

interface CriterionFeedback {
  status: 'failing' | 'passing';
  score: number;
  feedback: string;
  iteration: number;
}

export class FeedbackTracker {
  private criteria: Map<string, CriterionFeedback[]> = new Map();

  addFeedback(iteration: number, criterion: string, entry: Omit<CriterionFeedback, 'iteration'>): void {
    const history = this.criteria.get(criterion) ?? [];
    history.push({ ...entry, iteration });
    this.criteria.set(criterion, history);
  }

  pendingCriteria(): string[] {
    return [...this.criteria.entries()]
      .filter(([, history]) => history[history.length - 1].status === 'failing')
      .map(([name]) => name);
  }

  resolvedCriteria(): string[] {
    return [...this.criteria.entries()]
      .filter(([, history]) => history[history.length - 1].status === 'passing')
      .map(([name]) => name);
  }

  renderForPrompt(): string {
    const pending = this.pendingCriteria();
    const resolved = this.resolvedCriteria();
    const lines: string[] = [];

    if (resolved.length > 0) {
      lines.push(`Resolved (do not revisit): ${resolved.join(', ')}`);
    }

    for (const name of pending) {
      const history = this.criteria.get(name)!;
      const latest = history[history.length - 1];
      lines.push(`PENDING — ${name} (score: ${latest.score}): ${latest.feedback}`);
    }

    return lines.join('\n');
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/StructuredFeedback.test.ts -v`
Expected: PASS

**Step 5: Wire into RalphLoop**

In `RalphLoop.ts`, replace the `context.feedback.push(...)` pattern with:
```typescript
// After verification:
if (verification.dimensions) {
  for (const dim of verification.dimensions) {
    feedbackTracker.addFeedback(context.iteration, dim.name, {
      status: dim.passed ? 'passing' : 'failing',
      score: dim.score,
      feedback: dim.feedback,
    });
  }
} else {
  feedbackTracker.addFeedback(context.iteration, 'overall', {
    status: verification.complete ? 'passing' : 'failing',
    score: verification.confidence,
    feedback: verification.feedback,
  });
}

// In context for next iteration:
context.renderedFeedback = feedbackTracker.renderForPrompt();
```

In `iterationPrompt.ts`, use `context.renderedFeedback` instead of joining `context.feedback`.

**Step 6: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/core/worker/StructuredFeedback.ts src/core/worker/StructuredFeedback.test.ts src/core/worker/RalphLoop.ts src/core/worker/iterationPrompt.ts
git commit -m "feat: structured feedback tracking — only pending criteria shown, resolved ones collapsed"
```

---

### Task 23: Iteration Summarization (Context Hygiene)

After each failed iteration, summarize the iteration's execution into a compact form rather than keeping the raw output. Current iteration stays in full detail. This reduces self-conditioning.

**Research source:** HiAgent (ACL 2025) — 2x success rate with subgoal-boundary summarization and 35% context reduction. The Illusion of Diminishing Returns (2025) — self-conditioning from prior error traces.

**Files:**
- Modify: `src/core/worker/RalphLoop.ts` — summarize completed iterations
- Modify: `src/core/worker/ralphUtils.ts` — add `summarizeIteration()` function
- Test: `src/core/worker/ralphUtils.test.ts`

**Step 1: Write the failing test**

```typescript
// In src/core/worker/ralphUtils.test.ts
import { summarizeIteration } from './ralphUtils.js';

describe('summarizeIteration', () => {
  it('should extract key information from verbose iteration output', () => {
    const rawOutput = `
I'll search for AAPL stock information using web_search.

Tool call: web_search("AAPL stock price 2026")
Result: {"title": "Apple Inc (AAPL) Stock Price", "url": "https://finance.yahoo.com/quote/AAPL", "snippet": "AAPL is trading at $182.50, up 2.3% today. Market cap $2.8T..."}

The current price is $182.50. Let me now search for analyst opinions.

Tool call: web_search("AAPL analyst opinions 2026")
Result: {"error": "Rate limit exceeded"}

I was unable to find analyst opinions due to a rate limit error.

## KEY FINDINGS
- AAPL current price: $182.50 (up 2.3%)
- Market cap: $2.8T
- Analyst opinions: UNAVAILABLE (rate limit)
    `;

    const summary = summarizeIteration(rawOutput);

    // Should be much shorter than input
    expect(summary.length).toBeLessThan(rawOutput.length * 0.5);
    // Should preserve key findings
    expect(summary).toContain('$182.50');
    // Should note the tool failure
    expect(summary).toContain('rate limit');
    // Should NOT contain raw JSON tool results
    expect(summary).not.toContain('"title"');
    expect(summary).not.toContain('"snippet"');
  });

  it('should preserve findings section verbatim', () => {
    const output = `Some reasoning...\n## KEY FINDINGS\n- Finding 1\n- Finding 2`;
    const summary = summarizeIteration(output);

    expect(summary).toContain('Finding 1');
    expect(summary).toContain('Finding 2');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/ralphUtils.test.ts -t "summarizeIteration" -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// In src/core/worker/ralphUtils.ts

export function summarizeIteration(output: string): string {
  const sections: string[] = [];

  // 1. Extract KEY FINDINGS section (preserve verbatim)
  const findingsMatch = output.match(/## KEY FINDINGS\n([\s\S]*?)(?=\n##|$)/i);
  if (findingsMatch) {
    sections.push(findingsMatch[1].trim());
  }

  // 2. Extract tool call outcomes (success/fail, not raw results)
  const toolCalls = output.matchAll(/Tool call:\s*(\w+)\(([^)]*)\)/g);
  const toolResults: string[] = [];
  for (const match of toolCalls) {
    const toolName = match[1];
    const args = match[2].slice(0, 80); // Truncate long args
    // Check if this tool call was followed by an error
    const afterMatch = output.slice(match.index! + match[0].length, match.index! + match[0].length + 500);
    const hasError = /error|failed|unavailable|rate limit/i.test(afterMatch.slice(0, 200));
    toolResults.push(`${toolName}(${args}): ${hasError ? 'FAILED' : 'OK'}`);
  }
  if (toolResults.length > 0) {
    sections.push('Tools: ' + toolResults.join(', '));
  }

  // 3. Extract SCRATCHPAD if present
  const scratchMatch = output.match(/## SCRATCHPAD\n([\s\S]*?)(?=\n##|$)/i);
  if (scratchMatch) {
    sections.push('Reasoning: ' + scratchMatch[1].trim().slice(0, 300));
  }

  // 4. If no structured sections found, take first and last 200 chars of reasoning
  if (sections.length === 0) {
    const cleaned = output
      .replace(/```[\s\S]*?```/g, '[code block]')           // Remove code blocks
      .replace(/\{[\s\S]{200,}?\}/g, '[large JSON]')        // Remove large JSON
      .trim();
    const first = cleaned.slice(0, 200);
    const last = cleaned.length > 400 ? '...' + cleaned.slice(-200) : '';
    sections.push(first + last);
  }

  return sections.join('\n');
}
```

In `RalphLoop.ts`, after each iteration completes and before the next iteration starts:
```typescript
// Replace raw previousAttempts accumulation:
// OLD: context.previousAttempts.push(output);
// NEW:
if (context.iteration > 1) {
  // Summarize the PREVIOUS iteration (keep current iteration details for next call)
  const prevIdx = context.previousAttempts.length - 1;
  if (prevIdx >= 0) {
    context.previousAttempts[prevIdx] = summarizeIteration(context.previousAttempts[prevIdx]);
  }
}
context.previousAttempts.push(output);
```

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/ralphUtils.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/core/worker/ralphUtils.ts src/core/worker/ralphUtils.test.ts src/core/worker/RalphLoop.ts
git commit -m "feat: iteration summarization — compress failed iterations to reduce self-conditioning"
```

---

### Task 24: Tool Failure Memory Across Iterations

Track which tools failed across iterations so workers don't retry broken tools. If `web_search` returned rate-limit errors in iterations 2 and 3, iteration 4 should know not to try it again.

**Files:**
- Create: `src/core/worker/ToolMemory.ts`
- Modify: `src/core/worker/RalphLoop.ts` — track and inject tool memory
- Modify: `src/core/worker/iterationPrompt.ts` — include tool status
- Test: `src/core/worker/ToolMemory.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/worker/ToolMemory.test.ts
import { ToolMemory } from './ToolMemory.js';

describe('ToolMemory', () => {
  it('should track consecutive failures per tool', () => {
    const memory = new ToolMemory();

    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    memory.recordResult('read_file', { success: true });

    expect(memory.isBlocked('web_search')).toBe(true);
    expect(memory.isBlocked('read_file')).toBe(false);
  });

  it('should unblock tool after a successful call', () => {
    const memory = new ToolMemory();

    memory.recordResult('web_search', { success: false, error: 'Timeout', category: 'network' });
    memory.recordResult('web_search', { success: false, error: 'Timeout', category: 'network' });
    memory.recordResult('web_search', { success: true });

    expect(memory.isBlocked('web_search')).toBe(false);
  });

  it('should render tool status for prompt injection', () => {
    const memory = new ToolMemory();

    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });

    const status = memory.renderForPrompt();

    expect(status).toContain('web_search');
    expect(status).toContain('UNAVAILABLE');
    expect(status).toContain('quota');
  });

  it('should not block after a single failure', () => {
    const memory = new ToolMemory();

    memory.recordResult('web_search', { success: false, error: 'Temporary error', category: 'network' });

    expect(memory.isBlocked('web_search')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/ToolMemory.test.ts -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/core/worker/ToolMemory.ts

interface ToolResult {
  success: boolean;
  error?: string;
  category?: string;
}

interface ToolState {
  consecutiveFailures: number;
  lastError?: string;
  lastCategory?: string;
  totalCalls: number;
  totalFailures: number;
}

export class ToolMemory {
  private tools: Map<string, ToolState> = new Map();
  private readonly blockThreshold = 2; // Block after 2 consecutive failures

  recordResult(toolName: string, result: ToolResult): void {
    const state = this.tools.get(toolName) ?? {
      consecutiveFailures: 0,
      totalCalls: 0,
      totalFailures: 0,
    };

    state.totalCalls++;

    if (result.success) {
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures++;
      state.totalFailures++;
      state.lastError = result.error;
      state.lastCategory = result.category;
    }

    this.tools.set(toolName, state);
  }

  isBlocked(toolName: string): boolean {
    const state = this.tools.get(toolName);
    if (!state) return false;
    return state.consecutiveFailures >= this.blockThreshold;
  }

  renderForPrompt(): string {
    const blocked = [...this.tools.entries()]
      .filter(([, state]) => state.consecutiveFailures >= this.blockThreshold);

    if (blocked.length === 0) return '';

    return '## Tool Status\n' + blocked
      .map(([name, state]) =>
        `- ${name}: UNAVAILABLE (${state.lastCategory ?? 'error'} — failed ${state.consecutiveFailures}x consecutively). Do not attempt.`
      )
      .join('\n');
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/ToolMemory.test.ts -v`
Expected: PASS

**Step 5: Wire into RalphLoop and iterationPrompt**

In `RalphLoop.ts`, create a `ToolMemory` instance at the start of the loop. After each tool call result, call `toolMemory.recordResult()`. Pass `toolMemory.renderForPrompt()` into the iteration context.

In `iterationPrompt.ts`, include the tool status section when non-empty.

**Step 6: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/core/worker/ToolMemory.ts src/core/worker/ToolMemory.test.ts src/core/worker/RalphLoop.ts src/core/worker/iterationPrompt.ts
git commit -m "feat: tool failure memory — workers remember which tools are broken across iterations"
```

---

## Phase D: Persistent Memory (Pillar 4)

Add cross-session filesystem-based memory so the Queen learns from past interactions.

---

### Task 25: Memory Store (Filesystem-Based)

A filesystem-backed store at `~/.personalagent/memory/` that stores structured markdown notes with YAML frontmatter. Supports write, read, query-by-tag, and strength-based decay.

**Research source:** GCC (2025) — markdown + YAML files, COMMIT after successful tasks. A-MEM (NeurIPS 2025) — Zettelkasten notes with tags and links. MemoryBank (2023) — Ebbinghaus forgetting curve for decay.

**Files:**
- Create: `src/core/memory/MemoryStore.ts`
- Test: `src/core/memory/MemoryStore.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/memory/MemoryStore.test.ts
import { MemoryStore } from './MemoryStore.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('MemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memtest-'));
    store = new MemoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('should write and read a memory note', async () => {
    await store.write({
      id: 'task-patterns-1',
      content: 'Web search tasks work best when decomposed into 2-3 specific queries.',
      tags: ['strategy', 'web-search'],
      source: 'task-execution',
    });

    const note = await store.read('task-patterns-1');

    expect(note).not.toBeNull();
    expect(note!.content).toContain('Web search tasks');
    expect(note!.tags).toContain('strategy');
    expect(note!.strength).toBe(1.0); // Initial strength
  });

  it('should query by tags', async () => {
    await store.write({
      id: 'note-1',
      content: 'Note about web search',
      tags: ['web-search', 'strategy'],
      source: 'execution',
    });

    await store.write({
      id: 'note-2',
      content: 'Note about file operations',
      tags: ['file-ops', 'strategy'],
      source: 'execution',
    });

    const results = await store.queryByTags(['web-search']);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('note-1');
  });

  it('should reinforce strength on access', async () => {
    await store.write({
      id: 'note-1',
      content: 'Important pattern',
      tags: ['pattern'],
      source: 'execution',
    });

    // Simulate time passing and decay
    await store.applyDecay(0.5); // 50% decay

    let note = await store.read('note-1');
    expect(note!.strength).toBeCloseTo(0.5);

    // Reading reinforces
    note = await store.read('note-1', { reinforce: true });
    expect(note!.strength).toBeGreaterThan(0.5);
  });

  it('should list all notes sorted by strength', async () => {
    await store.write({ id: 'weak', content: 'Old note', tags: [], source: 'test' });
    await store.write({ id: 'strong', content: 'New note', tags: [], source: 'test' });

    await store.applyDecay(0.3); // Decay both

    // Reinforce 'strong'
    await store.read('strong', { reinforce: true });

    const all = await store.list();

    expect(all[0].id).toBe('strong'); // Stronger first
    expect(all[0].strength).toBeGreaterThan(all[1].strength);
  });

  it('should prune notes below strength threshold', async () => {
    await store.write({ id: 'note-1', content: 'Will decay', tags: [], source: 'test' });

    await store.applyDecay(0.05); // Decay to 5%

    const pruned = await store.prune(0.1); // Prune below 10%

    expect(pruned).toBe(1);
    expect(await store.read('note-1')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/memory/MemoryStore.test.ts -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/core/memory/MemoryStore.ts
import { readFile, writeFile, readdir, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

interface MemoryNote {
  id: string;
  content: string;
  tags: string[];
  source: string;
  strength: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
}

interface WriteInput {
  id: string;
  content: string;
  tags: string[];
  source: string;
}

export class MemoryStore {
  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  async write(input: WriteInput): Promise<void> {
    await this.ensureDir();
    const now = new Date().toISOString();
    const note: MemoryNote = {
      ...input,
      strength: 1.0,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
    };
    await this.save(note);
  }

  async read(id: string, options?: { reinforce?: boolean }): Promise<MemoryNote | null> {
    try {
      const raw = await readFile(this.filePath(id), 'utf-8');
      const note = this.parse(raw);
      if (options?.reinforce) {
        note.strength = Math.min(1.0, note.strength + 0.3);
        note.lastAccessed = new Date().toISOString();
        note.accessCount++;
        await this.save(note);
      }
      return note;
    } catch {
      return null;
    }
  }

  async queryByTags(tags: string[]): Promise<MemoryNote[]> {
    const all = await this.list();
    return all.filter(note =>
      tags.some(tag => note.tags.includes(tag))
    );
  }

  async list(): Promise<MemoryNote[]> {
    await this.ensureDir();
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const notes: MemoryNote[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const raw = await readFile(join(this.dir, file), 'utf-8');
        notes.push(this.parse(raw));
      } catch {
        // Skip malformed files
      }
    }

    return notes.sort((a, b) => b.strength - a.strength);
  }

  async applyDecay(factor: number): Promise<void> {
    const notes = await this.list();
    for (const note of notes) {
      note.strength *= factor;
      await this.save(note);
    }
  }

  async prune(threshold: number): Promise<number> {
    const notes = await this.list();
    let pruned = 0;
    for (const note of notes) {
      if (note.strength < threshold) {
        try {
          await unlink(this.filePath(note.id));
          pruned++;
        } catch {
          // Ignore
        }
      }
    }
    return pruned;
  }

  private async save(note: MemoryNote): Promise<void> {
    const frontmatter = [
      '---',
      `id: ${note.id}`,
      `tags: [${note.tags.join(', ')}]`,
      `source: ${note.source}`,
      `strength: ${note.strength.toFixed(4)}`,
      `createdAt: ${note.createdAt}`,
      `lastAccessed: ${note.lastAccessed}`,
      `accessCount: ${note.accessCount}`,
      '---',
    ].join('\n');

    await writeFile(this.filePath(note.id), `${frontmatter}\n\n${note.content}\n`);
  }

  private parse(raw: string): MemoryNote {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!fmMatch) throw new Error('Invalid memory note format');

    const fm = fmMatch[1];
    const content = fmMatch[2].trim();

    const get = (key: string): string => {
      const match = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
      return match?.[1]?.trim() ?? '';
    };

    const tagsStr = get('tags');
    const tagsMatch = tagsStr.match(/\[(.*)\]/);
    const tags = tagsMatch
      ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      : [];

    return {
      id: get('id'),
      content,
      tags,
      source: get('source'),
      strength: parseFloat(get('strength')) || 1.0,
      createdAt: get('createdAt'),
      lastAccessed: get('lastAccessed'),
      accessCount: parseInt(get('accessCount')) || 0,
    };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/memory/MemoryStore.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/core/memory/MemoryStore.ts src/core/memory/MemoryStore.test.ts
git commit -m "feat: filesystem-based memory store — markdown notes with strength-based decay"
```

---

### Task 26: Queen Memory Integration

Wire the MemoryStore into Queen so it:
1. Writes a memory note after each successful decomposed request (what worked)
2. Queries relevant memories during planning (what worked before for similar tasks)
3. Applies decay periodically (on startup)
4. Prunes weak memories (on startup)

**Research source:** Mem0 (2025) — extraction-then-update pipeline after each turn. MemoryBank (2023) — reinforcement on access.

**Files:**
- Modify: `src/core/queen/Queen.ts` — inject MemoryStore, use in planning/aggregation
- Modify: `src/core/queen/TaskPlanner.ts` — accept memory context
- Modify: `src/bootstrap.ts` — create MemoryStore instance
- Test: `src/core/queen/Queen.test.ts`

**Step 1: Write the failing test**

```typescript
describe('Queen memory integration', () => {
  it('should write memory after successful decomposed request', async () => {
    const memoryStore = new MemoryStore(tempDir);
    const queen = createTestQueen({ memoryStore });

    await queen.processMessage('Research AAPL and GOOGL stock prices');

    const notes = await memoryStore.list();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].tags).toContain('task-outcome');
  });

  it('should query memories during planning for similar tasks', async () => {
    const memoryStore = new MemoryStore(tempDir);

    // Pre-seed a memory
    await memoryStore.write({
      id: 'past-stock-research',
      content: 'Stock research works best with 2 workers: one for price data, one for analyst opinions.',
      tags: ['strategy', 'stock', 'research'],
      source: 'task-outcome',
    });

    const queen = createTestQueen({ memoryStore });
    const plannerSpy = vi.spyOn(queen['taskPlanner'], 'plan');

    await queen.processMessage('Research MSFT stock');

    // Memory context should have been passed to planner
    const plannerCall = plannerSpy.mock.calls[0];
    const options = plannerCall[1]; // planning options
    expect(options.memoryContext).toContain('Stock research works best');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/Queen.test.ts -t "memory integration" -v`
Expected: FAIL

**Step 3: Implement**

In `Queen.ts`, add memory operations:

```typescript
// After successful aggregation:
private async writeTaskMemory(
  userMessage: string,
  tasks: Task[],
  results: Map<string, TaskResult>,
): Promise<void> {
  if (!this.memoryStore) return;

  const successful = [...results.values()].filter(r => r.success);
  if (successful.length === 0) return;

  // Extract keywords from the user message for tags
  const keywords = userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  const taskSummary = tasks.map(t => t.description).join('; ');
  const id = `task-${Date.now()}`;

  await this.memoryStore.write({
    id,
    content: `Request: ${userMessage}\nDecomposition: ${tasks.length} tasks — ${taskSummary}\nOutcome: ${successful.length}/${tasks.length} succeeded.`,
    tags: ['task-outcome', ...keywords],
    source: 'queen-aggregation',
  });
}

// Before planning:
private async queryRelevantMemories(userMessage: string): Promise<string> {
  if (!this.memoryStore) return '';

  const keywords = userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  const memories = await this.memoryStore.queryByTags(keywords);
  if (memories.length === 0) return '';

  // Take top 3 most relevant (by strength), reinforce them
  const top = memories.slice(0, 3);
  for (const mem of top) {
    await this.memoryStore.read(mem.id, { reinforce: true });
  }

  return top.map(m => m.content).join('\n---\n');
}
```

In `bootstrap.ts`:
```typescript
const memoryStore = new MemoryStore(join(homedir(), '.personalagent', 'memory'));
// Apply decay on startup (mild — 0.95 per session)
await memoryStore.applyDecay(0.95);
// Prune very weak memories
await memoryStore.prune(0.05);
```

**Step 4: Run tests**

Run: `npx vitest run src/core/queen/Queen.test.ts -t "memory" -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/core/queen/Queen.ts src/core/queen/TaskPlanner.ts src/bootstrap.ts src/core/queen/Queen.test.ts
git commit -m "feat: Queen memory integration — writes outcomes, queries past strategies during planning"
```

---

## Phase E: Convergence Improvements (Pillar 1+3 synthesis)

These tasks enhance the existing convergence tracking and loop termination with insights from the research.

---

### Task 27: Universal Convergence Tracking

Extend convergence tracking beyond DCL to all tasks (single-criterion included). Track score history, detect plateaus, and detect self-conditioning regression.

**Research source:** BATS (2025) — convergence-aware budget allocation. The Illusion of Diminishing Returns (2025) — score regression indicates self-conditioning.

**Files:**
- Modify: `src/core/worker/RalphLoop.ts` — track convergence for all tasks, not just DCL
- Modify: `src/core/worker/dimensional.ts` — extract `ConvergenceTracker` for reuse
- Test: `src/core/worker/RalphLoop.test.ts`

**Step 1: Write the failing test**

```typescript
describe('RalphLoop universal convergence', () => {
  it('should detect score plateau on single-criterion task', async () => {
    // Mock provider that returns outputs with slowly declining improvement
    const provider = createMockProviderWithScores([0.4, 0.42, 0.43, 0.43, 0.43]);
    const verifier = createMockVerifierWithScores([0.4, 0.42, 0.43, 0.43, 0.43]);

    const result = await ralphLoop(provider, singleCriterionTask, {
      maxIterations: 10,
      verifier,
    });

    // Should exit early due to plateau, not burn all 10 iterations
    expect(result.iterations).toBeLessThan(7);
    expect(result.exitReason).toBe('plateau');
  });

  it('should detect score regression (self-conditioning)', async () => {
    const provider = createMockProviderWithScores([0.5, 0.45, 0.35]);
    const verifier = createMockVerifierWithScores([0.5, 0.45, 0.35]);

    const result = await ralphLoop(provider, singleCriterionTask, {
      maxIterations: 10,
      verifier,
    });

    expect(result.exitReason).toBe('divergence');
    // Should return the BEST output (iteration 1), not the last
    expect(result.bestScore).toBeCloseTo(0.5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/RalphLoop.test.ts -t "universal convergence" -v`
Expected: FAIL — single-criterion tasks don't have convergence tracking

**Step 3: Implement**

Extract `ScoreTracker` from `ConvergenceTracker` in `dimensional.ts` as a simpler utility:

```typescript
// In dimensional.ts, add:
export class ScoreTracker {
  private scores: number[] = [];

  record(score: number): void {
    this.scores.push(score);
  }

  get best(): number {
    return Math.max(0, ...this.scores);
  }

  /** Plateau: last 3 scores within epsilon of each other */
  isPlateau(epsilon = 0.03): boolean {
    if (this.scores.length < 3) return false;
    const last3 = this.scores.slice(-3);
    const max = Math.max(...last3);
    const min = Math.min(...last3);
    return (max - min) < epsilon;
  }

  /** Regression: last 3 scores are strictly decreasing */
  isRegressing(): boolean {
    if (this.scores.length < 3) return false;
    const last3 = this.scores.slice(-3);
    return last3[0] > last3[1] && last3[1] > last3[2];
  }
}
```

In `RalphLoop.ts`, use `ScoreTracker` for all tasks:
```typescript
const scoreTracker = new ScoreTracker();

// After each verification:
scoreTracker.record(verification.confidence);

// New exit conditions:
if (scoreTracker.isPlateau() && context.iteration >= 3) {
  return { ...bestResult, exitReason: 'plateau' };
}

if (scoreTracker.isRegressing()) {
  return { ...bestResult, exitReason: 'divergence' };
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/RalphLoop.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/worker/dimensional.ts src/core/worker/RalphLoop.ts src/core/worker/RalphLoop.test.ts
git commit -m "feat: universal convergence tracking — plateau and regression detection for all tasks"
```

---

### Task 28: Pre-Verification Heuristic

Before calling the expensive LLM verifier, run a cheap heuristic check. If the output is obviously incomplete (too short, contains "I cannot", is identical to previous), skip verification and go straight to next iteration.

**Research source:** FrugalGPT (TMLR 2024) — answer scorer before expensive model. Saves one LLM call per obviously-failed iteration.

**Files:**
- Create: `src/core/worker/PreCheck.ts`
- Modify: `src/core/worker/RalphLoop.ts` — insert pre-check before verification
- Test: `src/core/worker/PreCheck.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/worker/PreCheck.test.ts
import { preCheckOutput } from './PreCheck.js';

describe('preCheckOutput', () => {
  it('should reject obviously incomplete output', () => {
    const result = preCheckOutput('I was unable to find any information.', {
      taskDescription: 'Research current AAPL stock price and analyst opinions',
      successCriteria: 'Price obtained; analyst opinions found',
    });

    expect(result.shouldSkipVerification).toBe(true);
    expect(result.reason).toContain('failure indicator');
  });

  it('should reject output identical to previous attempt', () => {
    const result = preCheckOutput('The stock price is approximately...', {
      taskDescription: 'Research AAPL',
      successCriteria: 'Price obtained',
      previousOutput: 'The stock price is approximately...',
    });

    expect(result.shouldSkipVerification).toBe(true);
    expect(result.reason).toContain('identical');
  });

  it('should reject very short output for complex task', () => {
    const result = preCheckOutput('Yes.', {
      taskDescription: 'Research current AAPL stock price and analyst opinions',
      successCriteria: 'Price obtained; at least 3 analyst opinions; recent news',
    });

    expect(result.shouldSkipVerification).toBe(true);
    expect(result.reason).toContain('too short');
  });

  it('should allow reasonable output through to verification', () => {
    const result = preCheckOutput(
      'Based on my research, AAPL is trading at $182.50. Analysts from Goldman Sachs, Morgan Stanley, and JP Morgan rate it as Buy.',
      {
        taskDescription: 'Research AAPL',
        successCriteria: 'Price obtained; analyst opinions found',
      },
    );

    expect(result.shouldSkipVerification).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/PreCheck.test.ts -v`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/core/worker/PreCheck.ts

interface PreCheckInput {
  taskDescription: string;
  successCriteria: string;
  previousOutput?: string;
}

interface PreCheckResult {
  shouldSkipVerification: boolean;
  reason?: string;
  syntheticFeedback?: string; // Feedback to inject if skipping verification
}

const FAILURE_INDICATORS = [
  /i (?:was |am )?unable to/i,
  /i (?:could|can)(?:n't| not) (?:find|access|retrieve|complete)/i,
  /no (?:results|data|information) (?:found|available)/i,
  /i don't have (?:access|the ability)/i,
];

export function preCheckOutput(output: string, input: PreCheckInput): PreCheckResult {
  // 1. Failure indicators
  for (const pattern of FAILURE_INDICATORS) {
    if (pattern.test(output) && output.length < 500) {
      return {
        shouldSkipVerification: true,
        reason: 'Output contains failure indicator',
        syntheticFeedback: 'Previous attempt reported inability to complete. Try a different approach or different tools.',
      };
    }
  }

  // 2. Identical to previous output
  if (input.previousOutput && output.trim() === input.previousOutput.trim()) {
    return {
      shouldSkipVerification: true,
      reason: 'Output identical to previous attempt',
      syntheticFeedback: 'Output is identical to previous attempt. You MUST try a fundamentally different approach.',
    };
  }

  // 3. Too short for complex task
  const criteriaCount = input.successCriteria.split(/[;\n]/).filter(c => c.trim()).length;
  const minLength = criteriaCount * 50; // ~50 chars per criterion minimum
  if (output.trim().length < minLength && criteriaCount > 1) {
    return {
      shouldSkipVerification: true,
      reason: `Output too short (${output.trim().length} chars) for ${criteriaCount} criteria`,
      syntheticFeedback: `Output is too brief to address all ${criteriaCount} success criteria. Provide detailed results.`,
    };
  }

  return { shouldSkipVerification: false };
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/PreCheck.test.ts -v`
Expected: PASS

**Step 5: Wire into RalphLoop**

In `RalphLoop.ts`, before the verification call:
```typescript
import { preCheckOutput } from './PreCheck.js';

// Before verification:
const preCheck = preCheckOutput(output, {
  taskDescription: task.description,
  successCriteria: task.successCriteria,
  previousOutput: context.previousAttempts[context.previousAttempts.length - 1],
});

if (preCheck.shouldSkipVerification) {
  // Skip expensive verification, use synthetic feedback
  context.feedback.push(preCheck.syntheticFeedback ?? 'Output did not meet basic quality checks.');
  continue; // Next iteration
}

// ... proceed with normal verification ...
```

**Step 6: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/core/worker/PreCheck.ts src/core/worker/PreCheck.test.ts src/core/worker/RalphLoop.ts
git commit -m "feat: pre-verification heuristic — skip expensive LLM verification for obviously bad output"
```

---

## Summary

| Phase | Tasks | Core Contribution |
|-------|-------|-------------------|
| **A: Failure Intelligence** | 16-18 | Structured failure taxonomy, classification-driven recovery, partial progress preservation |
| **B: Cost Awareness** | 19-21 | Provider pricing, budget guard, budget awareness injection into worker prompts |
| **C: Context Hygiene** | 22-24 | Structured feedback (resolved/pending), iteration summarization, tool failure memory |
| **D: Persistent Memory** | 25-26 | Filesystem-backed memory store with Ebbinghaus decay, Queen read/write integration |
| **E: Convergence** | 27-28 | Universal convergence tracking (plateau + regression), pre-verification heuristic |

**Total: 13 tasks across 5 phases.**

Each task is independently committable. Phases can be executed in order (A→B→C→D→E) or in parallel where there are no dependencies:
- Phases A and C can run in parallel (different subsystems)
- Phase B depends on nothing
- Phase D depends on nothing
- Phase E depends on Phase A (failure types) but can start while A is in progress

**What this does NOT cover (intentionally deferred):**
- Model routing / cascade fallback (FrugalGPT/RouteLLM pattern) — requires production usage data to calibrate
- Full Saga pattern for tool side-effect rollback — only needed when tools have destructive operations
- Embedding-based memory retrieval — filesystem tag-based retrieval is sufficient until memory grows large
- Checkpoint/resume for Ralph Loop — valuable but architecturally complex; save for v0.3.0
