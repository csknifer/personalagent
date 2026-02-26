# Consolidation & Prompt Externalization — v0.2.2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten the existing framework — wire up partially-integrated systems, consolidate the verification layer, and externalize all LLM prompts into versioned markdown files.

**Architecture:** Bottom-up in 3 phases. Phase 1 wires BudgetGuard enforcement and strips dead weight. Phase 2 collapses 3 verifier classes into 1. Phase 3 builds a PromptRegistry and moves all 9 inline prompts to versioned `.md` files with template slots.

**Tech Stack:** TypeScript (ES2022, strict), Vitest, Zod. No new dependencies.

---

## Phase 1: Tighten What Exists

---

### Task 1: BudgetGuard Enforcement in RalphLoop

The cost recording path (`RalphLoop.ts:372-379`) calls `budgetGuard.recordCost()` but the early-exit check (`RalphLoop.ts:174-192`) may not trigger in practice because cost gets recorded AFTER the attempt completes. Prove it works with a test.

**Files:**
- Test: `src/core/worker/RalphLoop.test.ts`
- Modify: `src/core/worker/RalphLoop.ts:372-379` (if needed)

**Step 1: Write failing test**

```typescript
// In RalphLoop.test.ts — add to existing describe block
it('should exit early when budget is exhausted', async () => {
  const guard = new BudgetGuard({ maxCostPerRequest: 0.001 }); // tiny budget
  const registry = new CostRegistry();
  const mockProvider = createMockProvider('Iteration 1 result');

  const result = await ralphLoop(
    mockProvider,
    {
      id: 'budget-test',
      description: 'Test budget enforcement',
      successCriteria: 'Must contain specific data',
      dependencies: [],
      priority: 1,
      status: 'in_progress',
      createdAt: new Date(),
    },
    {
      maxIterations: 10,
      timeout: 30000,
      budgetGuard: guard,
      costRegistry: registry,
    },
  );

  expect(result.exitReason).toBe('budget_exhausted');
  expect(result.iterations).toBeLessThan(10);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/RalphLoop.test.ts -t "budget is exhausted"`
Expected: FAIL — either budget never exhausts or exitReason isn't set

**Step 3: Fix cost recording if needed**

In `RalphLoop.ts`, ensure cost is recorded immediately after each LLM call (not just after the full iteration). If the existing path at lines 372-379 already works, the test should pass without changes. If not, move cost recording to right after `callWithTimeout` returns.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/worker/RalphLoop.test.ts -t "budget is exhausted"`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All 538+ tests pass

**Step 6: Commit**

```bash
git add src/core/worker/RalphLoop.test.ts src/core/worker/RalphLoop.ts
git commit -m "test: prove BudgetGuard enforcement in RalphLoop"
```

---

### Task 2: Surface Budget Status to Queen's Escalation Decisions

Queen dispatches workers via WorkerPool but the EscalationClassifier doesn't know about remaining budget. When budget is nearly exhausted (<15%), prefer `accept_partial` over `replan` to avoid wasting remaining budget on replanning LLM calls.

**Files:**
- Modify: `src/core/queen/EscalationClassifier.ts:17-33` (add `remainingBudgetPercent` to context)
- Test: `src/core/queen/EscalationClassifier.test.ts` (create if it doesn't exist)

**Step 1: Write failing test**

```typescript
// src/core/queen/EscalationClassifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyEscalation } from './EscalationClassifier.js';
import { FailureCategory, RecoveryAction } from '../failures.js';

describe('classifyEscalation', () => {
  it('should prefer accept_partial over replan when budget nearly exhausted', () => {
    const decision = classifyEscalation({
      result: {
        success: false,
        output: 'partial result',
        exitReason: 'stall',
        failure: {
          category: FailureCategory.Strategy,
          subcategory: 'approach_exhausted',
          isTransient: false,
          suggestedRecovery: RecoveryAction.Replan,
          context: 'Worker stalled',
          rawExitReason: 'stall',
        },
      },
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: ['task-2'],
      remainingBudgetPercent: 10, // <15% — should suppress replan
    });

    expect(decision.action).toBe('accept_partial');
    expect(decision.reason).toContain('budget');
  });

  it('should allow replan when budget is sufficient', () => {
    const decision = classifyEscalation({
      result: {
        success: false,
        output: 'partial result',
        exitReason: 'stall',
        failure: {
          category: FailureCategory.Strategy,
          subcategory: 'approach_exhausted',
          isTransient: false,
          suggestedRecovery: RecoveryAction.Replan,
          context: 'Worker stalled',
          rawExitReason: 'stall',
        },
      },
      replanCount: 0,
      maxReplans: 3,
      dependentTaskIds: ['task-2'],
      remainingBudgetPercent: 80, // plenty of budget
    });

    expect(decision.action).toBe('replan');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/EscalationClassifier.test.ts`
Expected: FAIL — `remainingBudgetPercent` not in interface

**Step 3: Implement**

In `EscalationClassifier.ts`, add `remainingBudgetPercent?: number` to `EscalationContext` (line ~30). In the `classifyEscalation` function, add a budget gate before any `replan` decision:

```typescript
// Add to EscalationContext interface:
remainingBudgetPercent?: number;

// Add near the top of classifyEscalation, after the replan-limit check:
if (ctx.remainingBudgetPercent !== undefined && ctx.remainingBudgetPercent < 15) {
  if (!result.success) {
    return {
      action: 'accept_partial',
      reason: `Budget nearly exhausted (${ctx.remainingBudgetPercent.toFixed(0)}% remaining) — using best partial result`,
    };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/queen/EscalationClassifier.test.ts`
Expected: PASS

**Step 5: Wire into Queen**

In `Queen.ts`, where `classifyEscalation` is called (~line 711), pass budget info from the WorkerPool's budget guard:

```typescript
const budgetPercent = this.budgetGuard?.isEnabled()
  ? 100 - this.budgetGuard.status().percentUsed
  : undefined;

const decision = classifyEscalation({
  result,
  replanCount,
  maxReplans,
  dependentTaskIds,
  remainingBudgetPercent: budgetPercent,
});
```

**Step 6: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/core/queen/EscalationClassifier.ts src/core/queen/EscalationClassifier.test.ts src/core/queen/Queen.ts
git commit -m "feat: budget-aware escalation — suppress replan when budget <15%"
```

---

### Task 3: Clean Up Dead Code and Artifacts

**Files:**
- Delete: orphaned `worktree-agent-*` branches
- Delete: untracked test artifacts in repo root
- Audit: dead exports in `src/`

**Step 1: Delete orphaned worktree branches**

```bash
git branch -D worktree-agent-a0398dea worktree-agent-a07c4f05 worktree-agent-a2a2df2a worktree-agent-a36d3b5d worktree-agent-a5009eaf worktree-agent-a5723e66 worktree-agent-a6ac067d worktree-agent-a891ada2 worktree-agent-a8eaf261 worktree-agent-aa651212 worktree-agent-ad79116a worktree-agent-af4aa1da
```

**Step 2: Delete untracked test artifacts**

```bash
rm dns_resolution_guide.md jose_ibarra_jr_profile.md python_vs_rust_web_scraping.md
```

**Step 3: Audit dead exports**

Search for exported functions/classes that have zero importers outside their own file. Focus on `src/core/` and `src/skills/`. Check for:
- `SkillExecutor` — used in CLI (`useChat.ts`), so NOT dead
- `StrategyStore` — check if imported anywhere besides bootstrap
- Any re-exports in barrel files that reference removed code

Remove genuinely dead code. Leave anything with even one consumer.

**Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: clean orphaned branches, test artifacts, dead exports"
```

---

### Task 4: Sparse Task Descriptions

Remove `conversationSummary` and `userPreferences` from the Task interface. Update the planning prompt to instruct minimal descriptions.

**Files:**
- Modify: `src/core/types.ts:72-75`
- Modify: `src/core/queen/TaskPlanner.ts:14-80`
- Test: existing tests

**Step 1: Remove fields from Task interface**

In `src/core/types.ts`, delete lines 72-75:

```typescript
// DELETE these lines:
  /** Compressed conversation summary for worker context */
  conversationSummary?: string;
  /** User preferences extracted from conversation */
  userPreferences?: string[];
```

**Step 2: Run typecheck to find references**

Run: `npx tsc --noEmit`

Fix any compilation errors — remove references to `task.conversationSummary` and `task.userPreferences` wherever they appear (TaskPlanner, WorkerPool, iterationPrompt).

**Step 3: Update TASK_PLANNING_PROMPT**

In `TaskPlanner.ts`, add to the task description rules in TASK_PLANNING_PROMPT (around line 70):

```
## Task Description Rules
Task descriptions must be **minimal** — maximum signal, minimum noise:
- **The goal**: what to find or do
- **Only non-obvious context**: facts the worker cannot discover from its tools

Do NOT include in task descriptions:
- Information available via search or file tools
- Style or formatting preferences
- Conversation history summaries
- Metadata the worker doesn't need
```

Remove any references to `conversationSummary` or `userPreferences` in the JSON schema examples within the prompt.

**Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/core/types.ts src/core/queen/TaskPlanner.ts
git commit -m "refactor: sparse task descriptions — remove conversationSummary and userPreferences"
```

---

## Phase 2: Consolidate Verification

---

### Task 5: Remove LLMVerifier

`LLMVerifier` (verifiers.ts:75-178) is superseded by `UnifiedVerifier` (verifiers.ts:188-305). Remove it.

**Files:**
- Modify: `src/core/worker/verifiers.ts` (delete LLMVerifier class, lines 75-178)
- Modify: `src/core/worker/RalphLoop.ts:415` (remove `instanceof LLMVerifier` check)
- Test: `src/core/worker/RalphLoop.test.ts` (update any tests creating LLMVerifier)

**Step 1: Search for all LLMVerifier references**

```bash
grep -rn "LLMVerifier" src/
```

**Step 2: Remove LLMVerifier class from verifiers.ts**

Delete the `LLMVerifier` class (lines 75-178) and its export.

**Step 3: Update RalphLoop.ts**

At line 415, change:
```typescript
// OLD:
} else if (!verifier || verifier instanceof LLMVerifier) {
  activeVerifier = new UnifiedVerifier(verificationProvider, task.description, task.successCriteria);
  useUnifiedVerifier = true;
// NEW:
} else if (!verifier) {
  activeVerifier = new UnifiedVerifier(verificationProvider, task.description, task.successCriteria);
  useUnifiedVerifier = true;
```

Remove the LLMVerifier import from RalphLoop.ts.

**Step 4: Update tests**

Any test that directly instantiates `LLMVerifier` should use `UnifiedVerifier` instead. The mock provider interface is the same (both use `provider.complete()`).

**Step 5: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/core/worker/verifiers.ts src/core/worker/RalphLoop.ts src/core/worker/RalphLoop.test.ts
git commit -m "refactor: remove LLMVerifier — UnifiedVerifier is the sole LLM verifier"
```

---

### Task 6: Merge DimensionalVerifier Into UnifiedVerifier

Make UnifiedVerifier detect multi-criterion tasks and switch to per-criterion evaluation internally. The external interface stays `Verifier.check(result) → Verification`.

**Files:**
- Modify: `src/core/worker/verifiers.ts` (UnifiedVerifier gains dimensional mode)
- Modify: `src/core/worker/dimensional.ts` (DimensionalVerifier no longer exported as standalone verifier)
- Test: `src/core/worker/verifiers.test.ts` (new file or add to existing)

**Step 1: Write failing tests**

```typescript
// src/core/worker/verifiers.test.ts
import { describe, it, expect } from 'vitest';
import { UnifiedVerifier } from './verifiers.js';

describe('UnifiedVerifier', () => {
  it('should use single-criterion path for simple criteria', async () => {
    const mockProvider = {
      complete: async () => JSON.stringify({
        complete: true, confidence: 0.95,
        feedback: 'All good', nextAction: undefined,
      }),
    };
    const verifier = new UnifiedVerifier(
      mockProvider as any,
      'Find stock price',
      'Current AAPL stock price included',
    );
    const result = await verifier.check({ success: true, output: 'AAPL: $150', iterations: 1, tokenUsage: { input: 0, output: 0, total: 0 } });
    expect(result.complete).toBe(true);
    expect((result as any).dimensions).toBeUndefined(); // single criterion, no dimensions
  });

  it('should use dimensional path for multi-criterion tasks', async () => {
    const mockProvider = {
      complete: async () => JSON.stringify({
        complete: false, feedback: 'Missing criterion 2',
        dimensions: [
          { name: 'Price data', score: 0.9, passed: true, feedback: 'Good' },
          { name: 'Analyst opinions', score: 0.3, passed: false, feedback: 'Missing' },
        ],
      }),
    };
    const verifier = new UnifiedVerifier(
      mockProvider as any,
      'Research AAPL',
      'Price data; Analyst opinions',  // semicolon = multi-criterion
    );
    const result = await verifier.check({ success: true, output: 'AAPL: $150', iterations: 1, tokenUsage: { input: 0, output: 0, total: 0 } });
    expect(result.complete).toBe(false);
    expect((result as any).dimensions).toHaveLength(2);
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run src/core/worker/verifiers.test.ts`
Expected: FAIL — UnifiedVerifier doesn't handle dimensions yet

**Step 3: Implement dimensional mode in UnifiedVerifier**

Modify UnifiedVerifier constructor to accept optional criteria array. Use `parseSuccessCriteria()` from `dimensional.ts` to detect multi-criterion tasks. When multi-criterion:
- Use the DimensionalVerifier's prompt format internally
- Return a result with `dimensions` property
- Compute confidence as `Math.min(...scores)` (pessimistic)

When single-criterion, use existing fast path unchanged.

Key change in `UnifiedVerifier.check()`:
```typescript
async check(result: TaskResult): Promise<UnifiedVerificationResult> {
  const criteria = parseSuccessCriteria(this.successCriteria);
  if (criteria.length > 1) {
    return this.checkDimensional(result, criteria);
  }
  return this.checkSingle(result);
}
```

Move existing `check()` logic to `checkSingle()`. Create `checkDimensional()` using DimensionalVerifier's prompt and parsing logic. Import `parseSuccessCriteria` and `findBestMatch` as utility functions from `dimensional.ts`.

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/verifiers.test.ts`
Expected: PASS

**Step 5: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/core/worker/verifiers.ts src/core/worker/verifiers.test.ts src/core/worker/dimensional.ts
git commit -m "feat: UnifiedVerifier gains dimensional mode — auto-detects multi-criterion tasks"
```

---

### Task 7: Simplify RalphLoop Verifier Selection

With DimensionalVerifier merged into UnifiedVerifier, RalphLoop no longer needs the `useDCL` branching logic.

**Files:**
- Modify: `src/core/worker/RalphLoop.ts:404-420` (collapse verifier selection)
- Modify: `src/core/worker/RalphLoop.ts` (remove `useDCL` variable and associated conditionals)

**Step 1: Simplify verifier creation**

Replace lines ~404-420 with:

```typescript
const activeVerifier: Verifier = verifier ?? new UnifiedVerifier(
  verificationProvider,
  task.description,
  task.successCriteria,
);
```

**Step 2: Update reflexion path**

The reflexion path at lines ~518-543 has branching for `useUnifiedVerifier` vs DCL vs legacy. After this change:
- UnifiedVerifier handles both paths (returns `nextAction` for single-criterion, returns dimensional data for multi-criterion)
- The reflexion section should check if `verification` has `nextAction` (single path) or `dimensions` (dimensional path, generate dimensional reflexion)

```typescript
if (!verification.complete) {
  const unified = verification as UnifiedVerificationResult;
  if (unified.nextAction) {
    context.reflexionGuidance = unified.nextAction;
  } else if (unified.dimensions && useReflexion) {
    context.llmCalls++;
    context.reflexionGuidance = await generateDimensionalReflexion(
      verificationProvider, task, attempt.output,
      unified.dimensions, context.convergenceState,
    );
  }
}
```

**Step 3: Remove dead variables**

Remove `useDCL`, `useUnifiedVerifier`, `criteria` (computed at verifier selection), and related conditionals.

**Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/core/worker/RalphLoop.ts
git commit -m "refactor: simplify RalphLoop verifier selection — one path, no branching"
```

---

## Phase 3: Prompt Externalization

---

### Task 8: Build PromptRegistry

**Files:**
- Create: `src/core/prompts/PromptRegistry.ts`
- Create: `src/core/prompts/PromptRegistry.test.ts`

**Step 1: Write failing tests**

```typescript
// src/core/prompts/PromptRegistry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PromptRegistry } from './PromptRegistry.js';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PromptRegistry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prompts-'));
  });

  it('should load a prompt with frontmatter and render slots', async () => {
    await writeFile(join(dir, 'greeting.md'), `---
name: greeting
purpose: execution
description: A greeting prompt
slots:
  - userName
---
Hello, {{userName}}! How can I help you today?`);

    const registry = new PromptRegistry([dir]);
    await registry.load();

    expect(registry.has('greeting')).toBe(true);
    const rendered = registry.render('greeting', { userName: 'Alice' });
    expect(rendered).toBe('Hello, Alice! How can I help you today?');
  });

  it('should warn but not crash on missing slots', async () => {
    await writeFile(join(dir, 'test.md'), `---
name: test
purpose: execution
description: Test
slots:
  - required
---
Value: {{required}}, Other: {{optional}}`);

    const registry = new PromptRegistry([dir]);
    await registry.load();

    // Missing 'required' — should still render with empty string
    const rendered = registry.render('test', {});
    expect(rendered).toContain('Value: ');
    expect(rendered).toContain('Other: ');
  });

  it('should respect directory priority order', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'prompts2-'));
    await writeFile(join(dir, 'shared.md'), `---
name: shared
purpose: execution
description: Override
slots: []
---
Override version`);
    await writeFile(join(dir2, 'shared.md'), `---
name: shared
purpose: execution
description: Default
slots: []
---
Default version`);

    const registry = new PromptRegistry([dir, dir2]); // dir takes priority
    await registry.load();

    expect(registry.render('shared', {})).toBe('Override version');
  });

  it('should return empty string for unknown prompt', async () => {
    const registry = new PromptRegistry([dir]);
    await registry.load();
    expect(registry.render('nonexistent', {})).toBe('');
  });

  it('should list loaded prompts with metadata', async () => {
    await writeFile(join(dir, 'a.md'), `---
name: alpha
purpose: planning
description: Alpha prompt
slots: []
---
Alpha content`);

    const registry = new PromptRegistry([dir]);
    await registry.load();
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('alpha');
    expect(list[0].purpose).toBe('planning');
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run src/core/prompts/PromptRegistry.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement PromptRegistry**

```typescript
// src/core/prompts/PromptRegistry.ts
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { getDebugLogger } from '../DebugLogger.js';

export interface PromptMetadata {
  name: string;
  purpose: string;
  description: string;
  slots: string[];
  temperature?: number;
}

interface PromptTemplate {
  metadata: PromptMetadata;
  body: string;
}

export class PromptRegistry {
  private directories: string[];
  private templates: Map<string, PromptTemplate> = new Map();

  constructor(directories: string[]) {
    this.directories = directories;
  }

  async load(): Promise<void> {
    const log = getDebugLogger();

    // Load in reverse order so earlier directories override later ones
    for (let i = this.directories.length - 1; i >= 0; i--) {
      const dir = this.directories[i];
      if (!existsSync(dir)) continue;

      try {
        const files = await readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const content = await readFile(join(dir, file), 'utf-8');
          const parsed = this.parse(content, file);
          if (parsed) {
            this.templates.set(parsed.metadata.name, parsed);
          }
        }
      } catch (err) {
        log.warn('PromptRegistry', `Failed to load from ${dir}`, { error: String(err) });
      }
    }
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  get(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  render(name: string, vars: Record<string, string>): string {
    const template = this.templates.get(name);
    if (!template) return '';

    let result = template.body;
    // Substitute all {{slot}} placeholders
    result = result.replace(/\{\{(\w+)\}\}/g, (_match, slot) => {
      if (vars[slot] !== undefined) return vars[slot];
      const log = getDebugLogger();
      log.warn('PromptRegistry', `Missing slot '${slot}' in prompt '${name}'`);
      return '';
    });
    return result;
  }

  list(): PromptMetadata[] {
    return Array.from(this.templates.values()).map(t => t.metadata);
  }

  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const [name, template] of this.templates) {
      if (!template.body.trim()) {
        errors.push(`${name}: empty template body`);
      }
      // Check declared slots appear in body
      for (const slot of template.metadata.slots) {
        if (!template.body.includes(`{{${slot}}}`)) {
          errors.push(`${name}: declared slot '${slot}' not found in template body`);
        }
      }
      // Check undeclared slots in body
      const usedSlots = [...template.body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
      for (const used of usedSlots) {
        if (!template.metadata.slots.includes(used)) {
          errors.push(`${name}: undeclared slot '${used}' found in template body`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  private parse(content: string, filename: string): PromptTemplate | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    try {
      const yaml = this.parseYamlSimple(frontmatterMatch[1]);
      const body = frontmatterMatch[2].trim();
      return {
        metadata: {
          name: yaml.name || basename(filename, '.md'),
          purpose: yaml.purpose || 'unknown',
          description: yaml.description || '',
          slots: Array.isArray(yaml.slots) ? yaml.slots : [],
          temperature: yaml.temperature !== undefined ? Number(yaml.temperature) : undefined,
        },
        body,
      };
    } catch {
      return null;
    }
  }

  /** Minimal YAML parser for frontmatter — handles flat key-value and simple arrays */
  private parseYamlSimple(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');
    let currentKey = '';
    let currentArray: string[] | null = null;

    for (const line of lines) {
      const kvMatch = line.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        if (currentArray && currentKey) {
          result[currentKey] = currentArray;
          currentArray = null;
        }
        currentKey = kvMatch[1];
        const value = kvMatch[2].trim();
        if (value === '' || value === '[]') {
          currentArray = [];
        } else {
          result[currentKey] = value;
        }
      } else if (line.match(/^\s+-\s+(.+)$/) && currentArray !== null) {
        const itemMatch = line.match(/^\s+-\s+(.+)$/);
        if (itemMatch) currentArray.push(itemMatch[1].trim());
      }
    }
    if (currentArray && currentKey) {
      result[currentKey] = currentArray;
    }
    return result;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/core/prompts/PromptRegistry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/prompts/PromptRegistry.ts src/core/prompts/PromptRegistry.test.ts
git commit -m "feat: PromptRegistry — loads, caches, and renders prompt templates from .md files"
```

---

### Task 9: Extract Inline Prompts to Files

Move the 8 simpler prompts (everything except the dynamic iteration prompt) to `prompts/` files.

**Files to create in `prompts/`:**

1. `queen-system.md`
2. `worker-system.md`
3. `task-planning.md`
4. `discovery-wave-planning.md`
5. `discovery-aggregation.md`
6. `result-evaluation.md`
7. `verification.md`
8. `skill-guidance.md`

**Files to modify:**
- `src/core/queen/Queen.ts` — replace `getDefaultSystemPrompt()` with registry call
- `src/core/queen/TaskPlanner.ts` — replace `TASK_PLANNING_PROMPT` constant with registry call
- `src/core/worker/iterationPrompt.ts` — replace `buildToolSystemPrompt()` static parts with registry call
- `src/core/worker/verifiers.ts` — replace UnifiedVerifier's inline prompt with registry call
- `src/core/queen/DiscoveryCoordinator.ts` — replace inline system messages with registry calls
- `src/core/queen/ResultEvaluator.ts` — replace `buildEvaluatorPrompt()` inline with registry call
- `src/bootstrap.ts` — create PromptRegistry, pass to components

**Step 1: Create prompt files**

Extract each inline prompt to a `.md` file with frontmatter. The body should contain the static text with `{{slot}}` placeholders where dynamic content was interpolated. Keep the exact wording — this is extraction, not rewriting.

Example for `verification.md`:

```markdown
---
name: verification
purpose: verification
description: Unified verification and reflexion prompt for task results
slots:
  - date
  - taskDescription
  - successCriteria
  - toolInfo
  - toolOutputInfo
  - toolFailureInfo
  - output
---
Evaluate this task result AND provide strategic next-step guidance if incomplete.

## Current Date
{{date}}

## Task Description
{{taskDescription}}

## Success Criteria
{{successCriteria}}

## Tool Usage
{{toolInfo}}
{{toolOutputInfo}}{{toolFailureInfo}}
## Task Result
{{output}}

## Instructions
...rest of prompt...
```

**Step 2: Wire PromptRegistry into bootstrap**

In `bootstrap.ts`, create the registry with the prompt directories and call `load()`. Pass it to Queen, TaskPlanner, and other consumers via options.

```typescript
const promptRegistry = new PromptRegistry([
  join(process.cwd(), '.personalagent', 'prompts'),
  join(homeDir, '.personalagent', 'prompts'),
  join(process.cwd(), 'prompts'),
]);
await promptRegistry.load();
```

**Step 3: Replace inline prompts with registry calls**

In each consumer file, replace the inline template literal with:
```typescript
const prompt = this.promptRegistry.render('verification', {
  date: today,
  taskDescription: this.taskDescription,
  successCriteria: this.successCriteria,
  toolInfo,
  toolOutputInfo,
  toolFailureInfo,
  output: result.output,
});
```

**Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass — rendered output should be equivalent to previous inline strings

**Step 5: Commit**

```bash
git add prompts/ src/core/queen/ src/core/worker/ src/bootstrap.ts
git commit -m "feat: extract 8 inline prompts to versioned .md files via PromptRegistry"
```

---

### Task 10: Dynamic Iteration Prompt Sections

`buildIterationPrompt()` in `iterationPrompt.ts` is ~200 lines of conditional sections. Split the static text into section templates while keeping conditional logic in code.

**Files:**
- Create: `prompts/sections/` directory
- Create section templates: `scratchpad.md`, `retained-results.md`, `dependency-results.md`, `feedback.md`, `convergence.md`, `reflexion.md`, `warnings.md`
- Create: `prompts/iteration-base.md`
- Modify: `src/core/worker/iterationPrompt.ts`

**Step 1: Create section templates**

Each section template has frontmatter and `{{slot}}` placeholders. Example:

```markdown
---
name: section-scratchpad
purpose: execution
description: Worker reasoning notes from prior iterations
slots:
  - entries
---
## Scratchpad (your private reasoning notes)
{{entries}}

Use `@scratchpad{your note here}` in your response to save reasoning for future iterations.
```

**Step 2: Create iteration-base.md**

```markdown
---
name: iteration-base
purpose: execution
description: Base template for worker iteration prompts
slots:
  - taskDescription
  - successCriteria
  - sections
  - instructions
---
## Task
{{taskDescription}}

## Success Criteria
{{successCriteria}}

{{sections}}

## Instructions
{{instructions}}
```

**Step 3: Refactor buildIterationPrompt()**

Refactor to:
1. Load section templates via registry
2. For each section, check if data exists → render section template → collect
3. Join sections, render base template with collected sections

The function signature stays the same. Only the implementation changes.

**Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add prompts/sections/ prompts/iteration-base.md src/core/worker/iterationPrompt.ts
git commit -m "feat: split iteration prompt into section templates — text in files, logic in code"
```

---

### Task 11: Config Integration for Prompt Directories

**Files:**
- Modify: `src/config/ConfigSchema.ts` (add `prompts.directories` to schema)
- Modify: `src/config/defaults.ts` (set default directories)

**Step 1: Add to config schema**

In `ConfigSchema.ts`, extend the prompts section:

```typescript
const PromptsConfigSchema = z.object({
  queen: PromptConfigSchema.optional(),
  worker: PromptConfigSchema.optional(),
  research: PromptConfigSchema.optional(),
  directories: z.array(z.string()).optional(),
}).default({});
```

**Step 2: Update defaults**

In `defaults.ts`, add `directories: ['./prompts']` to the prompts section.

**Step 3: Wire into bootstrap**

Update bootstrap to read `config.prompts.directories` and pass to PromptRegistry constructor.

**Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/config/ConfigSchema.ts src/config/defaults.ts src/bootstrap.ts
git commit -m "feat: configurable prompt directories — project/user/built-in resolution"
```

---

### Task 12: Prompt Validation

**Files:**
- Modify: `src/core/prompts/PromptRegistry.ts` (validate() already written in Task 8)
- Test: `src/core/prompts/PromptRegistry.test.ts`

**Step 1: Write validation tests**

```typescript
it('should detect undeclared slots', async () => {
  await writeFile(join(dir, 'bad.md'), `---
name: bad
purpose: execution
description: Bad prompt
slots:
  - declared
---
{{declared}} and {{undeclared}}`);

  const registry = new PromptRegistry([dir]);
  await registry.load();
  const result = registry.validate();
  expect(result.valid).toBe(false);
  expect(result.errors).toContainEqual(expect.stringContaining('undeclared'));
});

it('should detect empty templates', async () => {
  await writeFile(join(dir, 'empty.md'), `---
name: empty
purpose: execution
description: Empty
slots: []
---
`);

  const registry = new PromptRegistry([dir]);
  await registry.load();
  const result = registry.validate();
  expect(result.valid).toBe(false);
  expect(result.errors).toContainEqual(expect.stringContaining('empty'));
});
```

**Step 2: Run tests**

Run: `npx vitest run src/core/prompts/PromptRegistry.test.ts`
Expected: PASS (validate() was implemented in Task 8)

**Step 3: Add npm script**

In `package.json`, add:
```json
"prompts:validate": "tsx scripts/validate-prompts.ts"
```

Create `scripts/validate-prompts.ts`:
```typescript
import { PromptRegistry } from '../src/core/prompts/PromptRegistry.js';
import { join } from 'path';

async function main() {
  const registry = new PromptRegistry([join(process.cwd(), 'prompts')]);
  await registry.load();
  const result = registry.validate();

  if (result.valid) {
    console.log(`✓ All ${registry.list().length} prompts valid`);
  } else {
    console.error('Prompt validation errors:');
    for (const error of result.errors) {
      console.error(`  ✗ ${error}`);
    }
    process.exit(1);
  }
}

main();
```

**Step 4: Run validation**

Run: `npm run prompts:validate`
Expected: All prompts valid

**Step 5: Commit**

```bash
git add src/core/prompts/PromptRegistry.test.ts scripts/validate-prompts.ts package.json
git commit -m "feat: prompt validation CLI — catches slot mismatches and empty templates"
```

---

## Success Criteria (Overall)

1. **Phase 1:** BudgetGuard triggers `budget_exhausted` exit (proven by test). Queen suppresses replan at <15% budget. Dead code removed. Task interface has no `conversationSummary`/`userPreferences`.
2. **Phase 2:** `LLMVerifier` deleted. `DimensionalVerifier` merged into `UnifiedVerifier`. RalphLoop verification is ~5 lines, not 20.
3. **Phase 3:** Zero inline prompt strings >50 tokens in source code. All prompts in `prompts/*.md`. `buildIterationPrompt()` uses section templates. Prompts overridable via config directories. `npm run prompts:validate` works.
4. **All phases:** All tests pass. Each task commits independently. No regressions.

---

## What This Plan Does NOT Do

- Execution modes (instant/quick/standard/deep) — deferred
- Active cost routing (cheaper models for simple tasks) — deferred
- Memory summarization — deferred
- Skill execution in Queen — deferred
- v0.2.0 branch merge — only sparse descriptions cherry-picked
