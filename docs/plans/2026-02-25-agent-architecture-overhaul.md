# Agent Architecture Overhaul — v0.2.0

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform PersonalAgent from a uniform-pipeline hive into a composable, adaptive agent framework where execution depth matches task complexity, prompts are minimal, verification is task-appropriate, and the foundation is clean enough to pivot into any specialty.

**Architecture:** Introduce an execution mode system that composes pipeline stages (planning → execution → verification → aggregation) with different depths per mode. Strip prompt bloat. Add filesystem-as-memory for code tasks. Build a core tools layer alongside MCP. Make the Queen adaptive rather than uniform.

**Tech Stack:** TypeScript (ES2022, strict), Vitest, Zod, existing provider abstraction. Clean break from v0.1.0 config schemas.

---

## Phase 1: Foundation Cleanup (Tier 1)

These changes are surgical, low-risk, and set the stage for everything else. Each can be committed independently.

---

### Task 1: Purpose-Aware Temperature in TrackedProvider

The system uses a single temperature for all LLM calls regardless of purpose. Verification needs near-zero temperature for consistency. Planning and aggregation need low temperature for faithfulness. Execution can be higher.

**Files:**
- Modify: `src/providers/TrackedProvider.ts:57-84` (chat method)
- Modify: `src/providers/Provider.ts:8` (ChatOptions interface)
- Modify: `src/config/defaults.ts` (add purposeTemperature defaults)
- Modify: `src/config/ConfigSchema.ts` (add Zod schema for purpose temperatures)
- Test: `src/providers/TrackedProvider.test.ts`

**Step 1: Write the failing test**

```typescript
// src/providers/TrackedProvider.test.ts
describe('TrackedProvider purpose-aware temperature', () => {
  it('should override temperature based on purpose', async () => {
    const mockProvider = createMockProvider();
    const tracked = new TrackedProvider(mockProvider, tracker, {
      purposeTemperature: {
        verification: 0.1,
        planning: 0.2,
        aggregation: 0.2,
        execution: 0.7,
        direct: 0.7,
        tool_followup: 0.5,
      }
    });

    await tracked.chat(messages, { purpose: 'verification' });

    expect(mockProvider.chat).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({ temperature: 0.1 })
    );
  });

  it('should fall back to provider default when no purpose temperature set', async () => {
    const mockProvider = createMockProvider();
    const tracked = new TrackedProvider(mockProvider, tracker);

    await tracked.chat(messages, { purpose: 'verification' });

    // Should NOT override temperature — no purposeTemperature config
    expect(mockProvider.chat).toHaveBeenCalledWith(
      messages,
      expect.not.objectContaining({ temperature: 0.1 })
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/TrackedProvider.test.ts -v`
Expected: FAIL — TrackedProvider constructor doesn't accept purposeTemperature config

**Step 3: Implement**

In `src/providers/Provider.ts`, add to the `ChatOptions` interface:
```typescript
export interface PurposeTemperatureMap {
  verification?: number;
  planning?: number;
  aggregation?: number;
  execution?: number;
  direct?: number;
  tool_followup?: number;
}
```

In `src/providers/TrackedProvider.ts`, accept `purposeTemperature` in constructor options. In the `chat` method (~line 57), before calling `this.provider.chat()`, check if `options.purpose` has a matching temperature override:
```typescript
const effectiveOptions = { ...options };
if (this.purposeTemperature && options.purpose) {
  const override = this.purposeTemperature[options.purpose];
  if (override !== undefined) {
    effectiveOptions.temperature = override;
  }
}
```

In `src/config/defaults.ts`, add defaults:
```typescript
purposeTemperature: {
  verification: 0.1,
  planning: 0.2,
  aggregation: 0.2,
  execution: 0.7,
  direct: 0.7,
  tool_followup: 0.5,
}
```

In `src/config/ConfigSchema.ts`, add Zod schema:
```typescript
const PurposeTemperatureSchema = z.object({
  verification: z.number().min(0).max(2).optional(),
  planning: z.number().min(0).max(2).optional(),
  aggregation: z.number().min(0).max(2).optional(),
  execution: z.number().min(0).max(2).optional(),
  direct: z.number().min(0).max(2).optional(),
  tool_followup: z.number().min(0).max(2).optional(),
}).optional();
```

Wire the config through `bootstrap.ts` where TrackedProvider is created.

**Step 4: Run tests**

Run: `npx vitest run src/providers/TrackedProvider.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add src/providers/TrackedProvider.ts src/providers/Provider.ts src/config/defaults.ts src/config/ConfigSchema.ts src/providers/TrackedProvider.test.ts src/bootstrap.ts
git commit -m "feat: purpose-aware temperature overrides in TrackedProvider"
```

---

### Task 2: Strip Prompt Verbosity

The worker prompt stack has massive redundancy: data integrity warnings appear 4x, "how to think" instructions waste tokens, and meta-process instructions compete with the actual task for attention. The CLAUDE.md study shows less instruction = better performance.

**Files:**
- Modify: `prompts/worker-system.md` (if it exists, otherwise the system prompt is built in code)
- Modify: `src/core/worker/iterationPrompt.ts:11-92` (buildToolSystemPrompt)
- Modify: `src/core/worker/iterationPrompt.ts:97-285` (buildIterationPrompt)
- Test: `src/core/worker/iterationPrompt.test.ts` (create if doesn't exist)

**Step 1: Write the failing test**

```typescript
// src/core/worker/iterationPrompt.test.ts
describe('buildToolSystemPrompt', () => {
  it('should contain data integrity warning exactly once', () => {
    const prompt = buildToolSystemPrompt(mockTools);
    const matches = prompt.match(/NEVER fabricate/gi) ?? [];
    expect(matches.length).toBe(1);
  });

  it('should not contain behavioral instructions (how to think)', () => {
    const prompt = buildToolSystemPrompt(mockTools);
    expect(prompt).not.toContain('Read feedback carefully');
    expect(prompt).not.toContain("Don't repeat the same approach");
    expect(prompt).not.toContain('Keep what worked');
  });

  it('should be under 800 tokens for typical tool set', () => {
    const prompt = buildToolSystemPrompt(mockTools);
    // Rough estimate: 1 token ≈ 4 chars
    expect(prompt.length).toBeLessThan(3200);
  });
});

describe('buildIterationPrompt', () => {
  it('should not duplicate data integrity warnings from system prompt', () => {
    const prompt = buildIterationPrompt(mockContext);
    const matches = prompt.match(/NEVER fabricate/gi) ?? [];
    expect(matches.length).toBe(0); // Handled in system prompt
  });

  it('should include task, criteria, and feedback only', () => {
    const prompt = buildIterationPrompt(mockContextWithFeedback);
    expect(prompt).toContain(mockContext.task.description);
    expect(prompt).toContain(mockContext.task.successCriteria);
    expect(prompt).toContain('feedback text here');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/worker/iterationPrompt.test.ts -v`
Expected: FAIL — current prompts have redundant warnings and behavioral instructions

**Step 3: Rewrite the prompts**

**New `buildToolSystemPrompt`** — stripped to essentials:
```
You are a task-focused worker agent. Complete your assigned task using the available tools.

Current Date: [ISO date]

## Tools
[tool definitions — name + description only]

## Rules
- ONLY present data from actual tool results. Never fabricate data.
- If a tool fails, report what could not be retrieved.
- Cite sources with URLs from tool results.

## Output Format
End your response with:
## KEY FINDINGS
- [Up to 10 concise findings from tool results]
```

Remove: all "Tool Strategy" guidance (the model knows how to use tools), all "Output Quality" instructions (redundant with criteria), Scratchpad format instructions (move to iteration prompt only when iteration > 1), Data Retention format (move to iteration prompt only when needed).

**New `buildIterationPrompt`** — context-sensitive, only include sections that have content:

```
## Task
[description]

## Success Criteria
[criteria]

[ONLY if iteration > 1:]
## Feedback
[most recent verification feedback only — not all 3]

## Guidance
[reflexion nextAction — one line]

[ONLY if findings exist:]
## Established Findings
[findings list]

[ONLY if scratchpad exists:]
## Scratchpad
[scratchpad entries]

[ONLY if stall detected:]
## ⚠ Try a different approach — your last two outputs were nearly identical.

[ONLY if dependency context exists:]
## Context from Prerequisites
[dependency outputs]
```

Remove: conversation summary (workers should get it in task description or not at all), user preferences list (planner should encode these in the task description), tool effectiveness hints (marginal value, high token cost), session strategy notes (marginal value), previous attempt full text (replaced by feedback + findings), verbose tool failure lists (simplify to one line per failure).

**Step 4: Run tests**

Run: `npx vitest run src/core/worker/iterationPrompt.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass. Some RalphLoop tests may need mock prompt adjustments.

**Step 6: Commit**

```bash
git add src/core/worker/iterationPrompt.ts src/core/worker/iterationPrompt.test.ts
git commit -m "refactor: strip prompt bloat — single data integrity warning, remove behavioral instructions"
```

---

### Task 3: Confidence-Based "I Don't Know" Response

When all workers fail or the best verification score is very low, the Queen should return an honest failure instead of synthesizing garbage from partial/failed results.

**Files:**
- Modify: `src/core/queen/Queen.ts:772-816` (aggregateResults method)
- Test: `src/core/queen/Queen.test.ts`

**Step 1: Write the failing test**

```typescript
describe('Queen aggregateResults', () => {
  it('should return honest failure when all workers failed', async () => {
    const results: TaskResult[] = [
      { success: false, output: 'Tool failures...', task: mockTask1 },
      { success: false, output: 'Could not retrieve...', task: mockTask2 },
    ];

    const response = await queen.aggregateResults(results, 'What is X?');

    expect(response.output).toContain('could not');
    expect(response.output).not.toContain('Based on my research');
    expect(response.metadata?.honest_failure).toBe(true);
  });

  it('should return honest failure when best score is below threshold', async () => {
    const results: TaskResult[] = [
      { success: true, output: 'Vague result...', task: mockTask1, verificationScore: 0.15 },
    ];

    const response = await queen.aggregateResults(results, 'What is X?');

    expect(response.metadata?.honest_failure).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queen/Queen.test.ts -t "honest failure" -v`
Expected: FAIL

**Step 3: Implement**

In `Queen.ts` `aggregateResults`, add early return before the current "no successful results" logic:

```typescript
// All failed → honest failure
if (successful.length === 0) {
  const toolsAttempted = results
    .flatMap(r => r.toolsUsed ?? [])
    .filter((v, i, a) => a.indexOf(v) === i);

  return {
    output: `I searched for this but couldn't find reliable information.\n\n` +
            `**What I tried:** ${toolsAttempted.join(', ') || 'No tools available'}\n` +
            `**What went wrong:** ${failed.map(f => f.error || 'Task did not produce verified results').join('; ')}`,
    tokenUsage: totalTokens,
    metadata: { honest_failure: true },
  };
}

// Best score too low → honest partial failure
const bestScore = Math.max(...successful.map(r => r.verificationScore ?? 0.5));
if (bestScore < (this.config.honestFailureThreshold ?? 0.25)) {
  return {
    output: `I found some information but I'm not confident in its accuracy.\n\n` +
            successful.map(r => r.output).join('\n\n') +
            `\n\n*Note: These results scored low on verification. You may want to verify independently.*`,
    tokenUsage: totalTokens,
    metadata: { honest_failure: true, bestScore },
  };
}
```

Add `honestFailureThreshold` to config defaults (0.25) and ConfigSchema.

**Step 4: Run tests**

Run: `npx vitest run src/core/queen/Queen.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/queen/Queen.ts src/core/queen/Queen.test.ts src/config/defaults.ts src/config/ConfigSchema.ts
git commit -m "feat: honest failure responses when workers can't produce reliable results"
```

---

### Task 4: Remove Evaluation Loop (Simplify to Single Verification Layer)

The evaluation loop runs verification *on top of* the Ralph Loop's verification. This is double-paying for quality assurance. Keep the Ralph Loop's per-task verification (it's closer to the work), remove the post-aggregation evaluation loop.

**Files:**
- Modify: `src/core/queen/Queen.ts:1147-1275` (remove runEvaluationLoop)
- Modify: `src/core/queen/Queen.ts` (remove call to runEvaluationLoop in processMessage)
- Modify: `src/config/defaults.ts` (remove evaluation config)
- Modify: `src/config/ConfigSchema.ts` (remove evaluation schema)
- Test: `src/core/queen/Queen.test.ts`

**Step 1: Write the test**

```typescript
describe('Queen processMessage', () => {
  it('should not run evaluation loop on decomposed results', async () => {
    const queen = createTestQueen();
    const evaluateSpy = vi.spyOn(queen as any, 'runEvaluationLoop');

    await queen.processMessage('Complex multi-part question');

    expect(evaluateSpy).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test — should fail since evaluation loop still exists**

**Step 3: Remove**

- Delete the `runEvaluationLoop` method entirely from Queen.ts
- Delete the `evaluateResult` and `buildEvaluatorPrompt` helper methods
- Remove the call to `runEvaluationLoop` in `processMessage` (around line 185-190)
- Remove the call in `streamMessage` if present
- Remove evaluation-related config (`evaluation.enabled`, `evaluation.maxCycles`, `evaluation.threshold`)
- Remove from ConfigSchema

**Step 4: Run tests**

Run: `npm test`
Expected: All pass. Some integration tests that tested evaluation may need removal.

**Step 5: Commit**

```bash
git add src/core/queen/Queen.ts src/config/defaults.ts src/config/ConfigSchema.ts src/core/queen/Queen.test.ts
git commit -m "refactor: remove evaluation loop — single verification layer via Ralph Loop only"
```

---

## Phase 2: Smarter Verification & Memory (Tier 2)

These changes improve quality within the existing architecture. Each builds on Phase 1's cleaner foundation.

---

### Task 5: Pass Original User Message to Verifier

The verifier currently checks output against planner-written success criteria only. It should also see the user's original message to catch cases where criteria are technically met but the answer is wrong.

**Files:**
- Modify: `src/core/worker/verifiers.ts:186-239` (UnifiedVerifier check method)
- Modify: `src/core/worker/RalphLoop.ts:361-383` (pass original message to verifier)
- Modify: `src/core/types.ts` (add `originalUserMessage` to Task type or VerificationContext)
- Modify: `src/core/queen/TaskPlanner.ts` (propagate original message to tasks)
- Test: `src/core/worker/verifiers.test.ts`

**Step 1: Write the failing test**

```typescript
describe('UnifiedVerifier', () => {
  it('should include original user message in verification prompt', async () => {
    const verifier = new UnifiedVerifier(mockProvider);
    const chatSpy = vi.spyOn(mockProvider, 'chat');

    await verifier.check({
      output: 'Roblox game platform is popular...',
      task: {
        description: 'Research Roblox stock price',
        successCriteria: 'Current price obtained',
        originalUserMessage: 'What\'s happening with Roblox?',
      },
      toolsUsed: ['web_search'],
    });

    const prompt = chatSpy.mock.calls[0][0];
    const content = prompt.map(m => m.content).join(' ');
    expect(content).toContain("What's happening with Roblox?");
  });
});
```

**Step 2-4: Implement and test**

Add `originalUserMessage?: string` to the Task interface in `src/core/types.ts`. In TaskPlanner.ts, propagate `userMessage` to each generated task. In the UnifiedVerifier prompt, add a new section:

```
## Original User Request
[originalUserMessage]

Evaluate whether the result addresses what the user actually asked, not just the success criteria.
```

**Step 5: Commit**

```bash
git commit -m "feat: verifier checks output against original user message, not just criteria"
```

---

### Task 6: Conversation Summarization Before Memory Trimming

Memory currently deletes oldest messages when over budget. It should summarize them first, preserving meaning. The `context.summary` and `context.keyPoints` fields already exist but are never populated.

**Files:**
- Modify: `src/core/queen/Memory.ts:202-221` (trimIfNeeded method)
- Create: `src/core/queen/MemorySummarizer.ts` (small module for summarization)
- Modify: `src/core/queen/Queen.ts` (inject provider into Memory for summarization)
- Test: `src/core/queen/Memory.test.ts`

**Step 1: Write the failing test**

```typescript
describe('Memory trimming with summarization', () => {
  it('should summarize messages before trimming', async () => {
    const memory = new Memory({
      maxMessages: 5,
      summarizer: mockSummarizer,
    });

    // Add 7 messages to trigger trim
    for (let i = 0; i < 7; i++) {
      memory.addMessage({ role: 'user', content: `Message ${i}` });
    }

    expect(mockSummarizer.summarize).toHaveBeenCalled();
    expect(memory.getSummary()).toBeTruthy();
    expect(memory.getMessages().length).toBeLessThanOrEqual(5);
  });

  it('should include summary in context messages when present', () => {
    const memory = new Memory({ maxMessages: 5 });
    memory.setSummary('User previously discussed authentication and prefers TypeScript.');

    const context = memory.getContextMessages();
    expect(context[0].content).toContain('authentication');
  });
});
```

**Step 2-4: Implement**

Create `MemorySummarizer`:
```typescript
// src/core/queen/MemorySummarizer.ts
export class MemorySummarizer {
  constructor(private provider: LLMProvider) {}

  async summarize(messages: Message[], existingSummary?: string): Promise<{
    summary: string;
    keyPoints: string[];
  }> {
    const prompt = existingSummary
      ? `Update this conversation summary with the new messages:\n\nExisting summary: ${existingSummary}\n\nNew messages:\n${this.formatMessages(messages)}\n\nProvide updated summary (2-3 sentences) and key facts as JSON: { "summary": "...", "keyPoints": ["..."] }`
      : `Summarize this conversation segment (2-3 sentences) and extract key facts:\n\n${this.formatMessages(messages)}\n\nJSON: { "summary": "...", "keyPoints": ["..."] }`;

    const response = await this.provider.complete(prompt);
    return JSON.parse(response);
  }
}
```

In `Memory.trimIfNeeded()`, before removing messages, call summarizer on the messages about to be removed. Store result in `this.context.summary` and `this.context.keyPoints`. In `getContextMessages()`, if summary exists, prepend a system message: `"Conversation context (summarized): {summary}. Key facts: {keyPoints.join('; ')}"`.

**Important:** Summarization is async but `addMessage` is sync. Change `trimIfNeeded` to queue a summarization task that runs before the next `getContextMessages()` call, or make `addMessage` async. The cleaner approach: make `addMessage` async and await summarization when trim triggers.

**Step 5: Commit**

```bash
git commit -m "feat: summarize old messages before trimming — preserves conversation meaning"
```

---

### Task 7: Worker Discovery Signals

Workers currently can't communicate discoveries to each other. Implement the `discovery` signal so the Queen can broadcast relevant findings to running workers.

**Files:**
- Modify: `src/core/types.ts` (formalize WorkerSignal type)
- Modify: `src/core/worker/Worker.ts` (emit discovery signals)
- Modify: `src/core/worker/WorkerPool.ts` (relay signals between workers)
- Modify: `src/core/worker/iterationPrompt.ts` (inject discoveries into prompt)
- Test: `src/core/worker/WorkerPool.test.ts`

**Step 1: Write the failing test**

```typescript
describe('WorkerPool discovery signals', () => {
  it('should relay discovery from one worker to others', async () => {
    const pool = new WorkerPool({ maxConcurrent: 4 });
    const tasks = [
      { id: 'task-1', description: 'Research Roblox stock' },
      { id: 'task-2', description: 'Research Roblox analyst opinions' },
    ];

    const results = await pool.executeTasks(tasks, provider, mcpServer);

    // Worker 1 discovers something, worker 2 should receive it
    // (Verified by checking worker 2's prompt includes discovery context)
    // This test verifies the mechanism exists, not the LLM behavior
    expect(pool.getDiscoveries()).toHaveLength(expect.any(Number));
  });
});
```

**Step 2-4: Implement**

Define signal type in `src/core/types.ts`:
```typescript
export interface WorkerDiscovery {
  fromTaskId: string;
  content: string;       // "Found conflicting data: source A says X, source B says Y"
  relevantTo?: string[]; // task IDs this is relevant to, or undefined for all
  timestamp: number;
}
```

In `Worker.ts`, after each Ralph Loop iteration, scan the output for discovery patterns (contradictions, unexpected findings, scope changes). Emit a `discovery` event.

In `WorkerPool.ts`, listen for discovery events. For each discovery, inject it into the `context.discoveries` array of other running workers. The discovery gets picked up in the next iteration's prompt via `buildIterationPrompt`.

In `iterationPrompt.ts`, add an optional section:
```
[ONLY if discoveries exist:]
## Discoveries from Other Workers
- [Worker researching X found: conflicting data about Y]
```

Keep this lightweight — max 3 most recent discoveries, max 100 chars each.

**Step 5: Commit**

```bash
git commit -m "feat: worker discovery signals — cross-worker awareness during execution"
```

---

### Task 8: Worker Escalation Tool

Workers currently can't ask the user for clarification. Add an `escalate` mechanism that pauses the worker, surfaces the question through the Queen, and resumes with the answer.

**Files:**
- Create: `src/core/worker/EscalationHandler.ts`
- Modify: `src/core/worker/RalphLoop.ts` (detect escalation in worker output)
- Modify: `src/core/queen/Queen.ts` (handle escalation events)
- Modify: `src/core/types.ts` (add Escalation types)
- Modify: `src/mcp/MCPServer.ts` (register `request_clarification` tool)
- Test: `src/core/worker/EscalationHandler.test.ts`

**Step 1: Write the failing test**

```typescript
describe('EscalationHandler', () => {
  it('should pause worker when escalation tool is called', async () => {
    const handler = new EscalationHandler();
    const escalation = {
      taskId: 'task-1',
      question: 'The user asked about Roblox — did they mean the stock or the game platform?',
      options: ['Stock (RBLX)', 'Game platform', 'Both'],
    };

    const promise = handler.escalate(escalation);

    expect(handler.isPending('task-1')).toBe(true);

    handler.resolve('task-1', 'Stock (RBLX)');
    const answer = await promise;

    expect(answer).toBe('Stock (RBLX)');
    expect(handler.isPending('task-1')).toBe(false);
  });
});
```

**Step 2-4: Implement**

Register `request_clarification` as an MCP tool:
```typescript
{
  name: 'request_clarification',
  description: 'Ask the user a clarifying question when the task is ambiguous. Use sparingly — only when you genuinely cannot proceed without clarification.',
  parameters: {
    question: { type: 'string', description: 'The question to ask the user' },
    options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (optional)' },
  }
}
```

When this tool is called during `executeIterationWithTools` in RalphLoop:
1. The tool execution returns a special `{ type: 'escalation', question, options }` result
2. RalphLoop pauses (awaits a Promise)
3. The worker emits an `escalation` event with the question
4. WorkerPool relays to Queen
5. Queen surfaces to the user (via CLI or WebSocket)
6. User responds
7. Queen resolves the promise with the user's answer
8. RalphLoop injects the answer into the tool result and continues

For the CLI frontend: `useQueen.ts` hook handles escalation events by prompting the user via the Ink input.

For the web frontend: WebSocket sends an `escalation` message type; the frontend shows an inline prompt.

**Step 5: Commit**

```bash
git commit -m "feat: worker escalation tool — workers can ask users for clarification"
```

---

## Phase 3: Composable Execution Pipeline (Tier 3)

This is the architectural core. Everything above feeds into this.

---

### Task 9: Execution Mode System

Replace the binary "direct vs decomposed" decision with a spectrum of execution modes. Each mode composes pipeline stages differently. The planner selects the mode. Projects can define custom modes.

**Files:**
- Create: `src/core/execution/ExecutionMode.ts` (mode definitions)
- Create: `src/core/execution/ExecutionPipeline.ts` (composable pipeline)
- Create: `src/core/execution/modes/` (directory for built-in modes)
- Create: `src/core/execution/modes/instant.ts`
- Create: `src/core/execution/modes/quick.ts`
- Create: `src/core/execution/modes/standard.ts`
- Create: `src/core/execution/modes/deep.ts`
- Create: `src/core/execution/modes/continuous.ts`
- Modify: `src/core/queen/Queen.ts` (use pipeline instead of direct if/else)
- Modify: `src/core/queen/TaskPlanner.ts` (select mode, not just direct/decomposed)
- Modify: `src/core/queen/FastClassifier.ts` (map to modes)
- Modify: `src/config/defaults.ts` (mode configs)
- Modify: `src/config/ConfigSchema.ts` (mode schemas)
- Test: `src/core/execution/ExecutionPipeline.test.ts`

**Step 1: Define the mode interface**

```typescript
// src/core/execution/ExecutionMode.ts
export interface ExecutionMode {
  name: string;
  description: string;

  /** Max tool-call rounds per LLM call */
  maxToolRounds: number;

  /** Whether to decompose into parallel tasks */
  decompose: boolean;

  /** Ralph Loop config overrides */
  ralphLoop: {
    enabled: boolean;
    maxIterations: number;
    verifier: 'none' | 'unified' | 'dimensional';
    reflexion: boolean;
  };

  /** Whether to aggregate multi-worker results with LLM */
  llmAggregation: boolean;

  /** Memory strategy for iterations */
  memoryStrategy: 'context' | 'filesystem' | 'hybrid';
}
```

**Step 2: Define built-in modes**

```typescript
// src/core/execution/modes/instant.ts
export const instant: ExecutionMode = {
  name: 'instant',
  description: 'Single LLM call, no tools, no verification',
  maxToolRounds: 0,
  decompose: false,
  ralphLoop: { enabled: false, maxIterations: 1, verifier: 'none', reflexion: false },
  llmAggregation: false,
  memoryStrategy: 'context',
};

// src/core/execution/modes/quick.ts
export const quick: ExecutionMode = {
  name: 'quick',
  description: 'Tools available, no verification, single pass',
  maxToolRounds: 5,
  decompose: false,
  ralphLoop: { enabled: false, maxIterations: 1, verifier: 'none', reflexion: false },
  llmAggregation: false,
  memoryStrategy: 'context',
};

// src/core/execution/modes/standard.ts
export const standard: ExecutionMode = {
  name: 'standard',
  description: 'Tools + lightweight verification, up to 3 iterations',
  maxToolRounds: 5,
  decompose: true,
  ralphLoop: { enabled: true, maxIterations: 3, verifier: 'unified', reflexion: false },
  llmAggregation: true,
  memoryStrategy: 'context',
};

// src/core/execution/modes/deep.ts
export const deep: ExecutionMode = {
  name: 'deep',
  description: 'Full Ralph Loop with dimensional verification and reflexion',
  maxToolRounds: 5,
  decompose: true,
  ralphLoop: { enabled: true, maxIterations: 10, verifier: 'dimensional', reflexion: true },
  llmAggregation: true,
  memoryStrategy: 'context',
};

// src/core/execution/modes/continuous.ts
export const continuous: ExecutionMode = {
  name: 'continuous',
  description: 'Filesystem-as-memory, fresh context each iteration, for code/file tasks',
  maxToolRounds: 20,  // Much higher — continuous work needs long tool chains
  decompose: false,   // Single worker, continuous context
  ralphLoop: { enabled: true, maxIterations: 15, verifier: 'unified', reflexion: false },
  llmAggregation: false,
  memoryStrategy: 'filesystem',
};
```

**Step 3: Write the pipeline**

```typescript
// src/core/execution/ExecutionPipeline.ts
export class ExecutionPipeline {
  constructor(
    private queen: Queen,
    private workerPool: WorkerPool,
    private modes: Map<string, ExecutionMode>,
  ) {}

  async execute(
    message: string,
    mode: ExecutionMode,
    context: PipelineContext,
  ): Promise<PipelineResult> {
    // 1. If decompose, plan tasks
    // 2. If !decompose, create single task from message
    // 3. For each task, run with mode's Ralph Loop config
    // 4. If llmAggregation, synthesize. Otherwise concatenate.
    // 5. Return result with metadata about which mode was used
  }
}
```

**Step 4: Update TaskPlanner to select modes**

Change TaskPlanner output from `{ type: 'direct' | 'decomposed' }` to `{ mode: string, tasks?: Task[] }`. Update the planning prompt:

```
Select an execution mode:
- "instant": Greetings, simple knowledge, math. No tools needed.
- "quick": Single lookup, one tool call. No verification needed.
- "standard": Research needing 2+ sources. Decompose + verify.
- "deep": Complex multi-criteria research. Full verification + reflexion.
- "continuous": Code editing, file manipulation. Long tool chains, filesystem memory.
```

Update FastClassifier to map directly to modes:
- Greetings → instant
- Short single questions → quick
- Everything else → uncertain (use LLM planner)

**Step 5: Update Queen.ts**

Replace the `if (plan.type === 'direct')` / `else` branching with:
```typescript
const pipeline = new ExecutionPipeline(this, this.workerPool, this.modes);
const result = await pipeline.execute(message, selectedMode, pipelineContext);
```

This is the biggest refactor. The existing `executeDirectRequest` becomes the `quick` mode handler. The existing `handleDecomposedRequest` becomes the `standard`/`deep` mode handler. The new `continuous` mode gets a new handler (Task 11).

**Step 6: Write comprehensive tests**

```typescript
describe('ExecutionPipeline', () => {
  it('instant mode: single LLM call, no tools', async () => { ... });
  it('quick mode: tools available, no verification', async () => { ... });
  it('standard mode: decompose + verify', async () => { ... });
  it('deep mode: dimensional verification + reflexion', async () => { ... });
  it('continuous mode: filesystem memory, high tool rounds', async () => { ... });
  it('custom mode: user-defined mode works', async () => { ... });
});
```

**Step 7: Commit**

```bash
git commit -m "feat: composable execution mode system — instant/quick/standard/deep/continuous"
```

---

### Task 10: Sparse Task Descriptions

The CLAUDE.md study shows that over-specifying tasks hurts performance. Rewrite the planner to produce minimal task descriptions: the goal, success criteria, and only non-obvious context.

**Files:**
- Modify: `src/core/queen/TaskPlanner.ts:14-79` (TASK_PLANNING_PROMPT)
- Modify: `prompts/task-planning.md`
- Test: `src/core/queen/TaskPlanner.test.ts`

**Step 1: Write the failing test**

```typescript
describe('TaskPlanner sparse descriptions', () => {
  it('should produce task descriptions under 200 words', async () => {
    const plan = await planner.plan('Research Roblox stock and analyst opinions');

    if (plan.type === 'decomposed') {
      for (const task of plan.tasks) {
        const wordCount = task.description.split(/\s+/).length;
        expect(wordCount).toBeLessThan(200);
      }
    }
  });

  it('should not include conversationSummary or userPreferences in task', async () => {
    const plan = await planner.plan('Research Roblox stock');

    if (plan.type === 'decomposed') {
      for (const task of plan.tasks) {
        expect(task).not.toHaveProperty('conversationSummary');
        expect(task).not.toHaveProperty('userPreferences');
      }
    }
  });
});
```

**Step 2-4: Implement**

Rewrite TASK_PLANNING_PROMPT to instruct:
```
Task descriptions must be minimal:
- The goal (what to find/do)
- Success criteria (how to verify)
- ONLY non-obvious context the worker can't discover from tools

Do NOT include:
- Information available in the repository or via search
- Style/formatting preferences (the worker knows how to format)
- Conversation history summaries (if context is needed, include the specific fact, not a summary)
```

Remove `conversationSummary` and `userPreferences` from the task schema. If the planner needs to pass a specific fact from conversation, it goes into the task description itself — not a separate field.

**Step 5: Commit**

```bash
git commit -m "refactor: sparse task descriptions — minimal context, max signal-to-noise"
```

---

### Task 11: Filesystem-as-Memory Ralph Loop Variant

For the `continuous` execution mode, implement a Ralph Loop variant where memory lives in files, not context. Each iteration gets fresh context and reads the filesystem to understand progress.

**Files:**
- Create: `src/core/execution/FilesystemMemory.ts`
- Modify: `src/core/worker/RalphLoop.ts` (support `memoryStrategy: 'filesystem'`)
- Modify: `src/core/worker/iterationPrompt.ts` (filesystem-aware prompt)
- Test: `src/core/execution/FilesystemMemory.test.ts`

**Step 1: Write the failing test**

```typescript
describe('FilesystemMemory', () => {
  it('should write progress to a file after each iteration', async () => {
    const fsMemory = new FilesystemMemory(tempDir);

    await fsMemory.recordIteration({
      iteration: 1,
      output: 'Implemented login endpoint',
      findings: ['Created src/auth/login.ts', 'Added POST /api/login route'],
      status: 'in_progress',
    });

    const progress = await fsMemory.readProgress();
    expect(progress.iterations).toHaveLength(1);
    expect(progress.status).toBe('in_progress');
  });

  it('should provide fresh context prompt from filesystem state', async () => {
    const fsMemory = new FilesystemMemory(tempDir);
    await fsMemory.recordIteration({ iteration: 1, output: '...', findings: ['...'], status: 'in_progress' });

    const prompt = await fsMemory.buildContextPrompt();

    // Should reference the progress file, not carry forward raw output
    expect(prompt).toContain('progress');
    expect(prompt.length).toBeLessThan(500); // Minimal — just pointers to files
  });
});
```

**Step 2-4: Implement**

`FilesystemMemory` writes to a `.personalagent/workspace/` directory:
- `progress.md` — current status, completed steps, remaining work
- `findings.md` — accumulated discoveries
- `scratchpad.md` — worker's reasoning notes

Each iteration:
1. Worker reads these files via MCP tools (naturally, as part of task execution)
2. Worker writes updates to these files
3. RalphLoop records the iteration summary to `progress.md`
4. Next iteration starts with **fresh context** — no `previousAttempts` array, no `feedback` array
5. The iteration prompt for filesystem mode is minimal: task + criteria + "Read progress.md to understand current state"

The key insight: **the worker discovers its own progress through tools, just like reading any other file.** No special prompt engineering needed.

In `RalphLoop.ts`, check `mode.memoryStrategy`:
```typescript
if (memoryStrategy === 'filesystem') {
  // Don't accumulate context arrays
  // Write iteration result to filesystem instead
  await this.fsMemory.recordIteration({ ... });
  // Build minimal prompt for next iteration
  context.previousAttempts = []; // Always empty — progress is on disk
  context.feedback = [];         // Always empty — feedback is in progress.md
}
```

**Step 5: Commit**

```bash
git commit -m "feat: filesystem-as-memory Ralph Loop — fresh context each iteration, progress on disk"
```

---

### Task 12: Core Tools Layer

Add first-class tools with richer semantics alongside MCP. These tools understand agent workflows (Edit requires prior Read, Glob sorts by relevance).

**Files:**
- Create: `src/core/tools/CoreToolRegistry.ts`
- Create: `src/core/tools/EditTool.ts`
- Create: `src/core/tools/GlobTool.ts`
- Create: `src/core/tools/GrepTool.ts`
- Create: `src/core/tools/ReadTool.ts`
- Modify: `src/mcp/MCPServer.ts` (integrate core tools alongside MCP tools)
- Test: `src/core/tools/CoreToolRegistry.test.ts`
- Test: `src/core/tools/EditTool.test.ts`

**Step 1: Define the core tool interface**

```typescript
// src/core/tools/CoreToolRegistry.ts
export interface CoreTool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;

  /** Pre-conditions that must be met before this tool can be called */
  preconditions?: (context: ToolContext) => { ok: boolean; error?: string };

  /** Execute the tool */
  execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  /** Files that have been read in this session */
  readFiles: Set<string>;
  /** Current working directory */
  cwd: string;
  /** Allowed filesystem roots */
  allowedRoots: string[];
}
```

**Step 2: Implement EditTool with preconditions**

```typescript
// src/core/tools/EditTool.ts
export const editTool: CoreTool = {
  name: 'edit_file',
  description: 'Make surgical string replacements in a file. The file must have been read first.',
  parameters: {
    file_path: { type: 'string', description: 'Absolute path to the file' },
    old_string: { type: 'string', description: 'Exact text to replace (must be unique in file)' },
    new_string: { type: 'string', description: 'Replacement text' },
  },

  preconditions: (context) => ({
    ok: context.readFiles.has(context.currentParams.file_path as string),
    error: 'You must read the file before editing it. Use read_file first.',
  }),

  execute: async (params, context) => {
    // Validate old_string is unique in file
    // Perform replacement
    // Return diff preview
  },
};
```

**Step 3: Integrate with MCPServer**

Core tools register first, MCP tools register after. If an MCP tool has the same name as a core tool, core tool wins (core tools are opinionated, MCP tools are generic).

```typescript
// In MCPServer.ts
registerCoreTools(coreRegistry: CoreToolRegistry) {
  for (const tool of coreRegistry.getTools()) {
    this.tools.set(tool.name, {
      ...tool,
      execute: async (params) => {
        const precheck = tool.preconditions?.(this.toolContext);
        if (precheck && !precheck.ok) {
          return { error: precheck.error };
        }
        return tool.execute(params, this.toolContext);
      },
    });
  }
}
```

**Step 4-5: Test and commit**

```bash
git commit -m "feat: core tools layer with preconditions — edit requires read, richer semantics"
```

---

### Task 13: Cost-Awareness Layer

Add a cost model so the system applies proportional effort. Simple tasks don't burn tokens on verification. Complex tasks get full machinery.

**Files:**
- Create: `src/core/execution/CostModel.ts`
- Modify: `src/core/execution/ExecutionPipeline.ts` (cost-aware mode selection)
- Modify: `src/config/defaults.ts` (cost budgets)
- Test: `src/core/execution/CostModel.test.ts`

**Step 1: Define cost model**

```typescript
// src/core/execution/CostModel.ts
export interface CostEstimate {
  estimatedCalls: number;       // LLM calls
  estimatedInputTokens: number; // Total input tokens
  estimatedOutputTokens: number;
  estimatedCost: number;        // USD estimate
}

export class CostModel {
  /** Estimate cost of running a mode for a task */
  estimate(mode: ExecutionMode, taskCount: number): CostEstimate {
    const callsPerTask = mode.ralphLoop.enabled
      ? mode.ralphLoop.maxIterations * 2 // execution + verification per iteration
      : 1;
    const totalCalls = (taskCount * callsPerTask)
      + (mode.decompose ? 1 : 0)           // planning call
      + (mode.llmAggregation ? 1 : 0);     // aggregation call

    return {
      estimatedCalls: totalCalls,
      estimatedInputTokens: totalCalls * 4000, // rough average
      estimatedOutputTokens: totalCalls * 1000,
      estimatedCost: this.priceEstimate(totalCalls),
    };
  }

  /** Check if a mode exceeds the per-request budget */
  exceedsBudget(estimate: CostEstimate, budget: CostBudget): boolean {
    return estimate.estimatedCalls > budget.maxCallsPerRequest
      || estimate.estimatedCost > budget.maxCostPerRequest;
  }

  /** Suggest a cheaper mode that fits the budget */
  suggestDowngrade(mode: ExecutionMode, budget: CostBudget): ExecutionMode | null { ... }
}
```

The pipeline checks cost before execution:
```typescript
const estimate = this.costModel.estimate(mode, tasks.length);
if (this.costModel.exceedsBudget(estimate, this.config.costBudget)) {
  const cheaper = this.costModel.suggestDowngrade(mode, this.config.costBudget);
  if (cheaper) mode = cheaper;
}
```

Config defaults:
```yaml
costBudget:
  maxCallsPerRequest: 30
  maxCostPerRequest: 0.50  # USD
  enabled: false            # Opt-in — doesn't restrict by default
```

**Step 2-5: Test and commit**

```bash
git commit -m "feat: cost-awareness layer — proportional effort based on task value"
```

---

## Phase 4: Config Migration & Integration

---

### Task 14: Config Schema v0.2.0

Clean break from v0.1.0. New config schema reflecting execution modes, purpose temperatures, cost budgets, and removed evaluation loop.

**Files:**
- Modify: `src/config/ConfigSchema.ts` (new schema)
- Modify: `src/config/defaults.ts` (new defaults)
- Create: `src/config/migrate.ts` (v0.1.0 → v0.2.0 migration)
- Test: `src/config/ConfigSchema.test.ts`

**Key changes:**
- Remove: `evaluation.*` config (eval loop removed)
- Remove: `hive.ralphLoop.dimensional.*` as top-level (moved into mode definitions)
- Add: `executionModes.*` (custom mode definitions)
- Add: `purposeTemperature.*` (per-purpose temperature overrides)
- Add: `costBudget.*` (cost awareness)
- Add: `honestFailureThreshold` (confidence floor)
- Restructure: `hive.ralphLoop.*` becomes defaults that modes can override

```bash
git commit -m "feat: config schema v0.2.0 — execution modes, purpose temps, cost budgets"
```

---

### Task 15: Integration Testing

End-to-end tests that verify the full pipeline works across modes.

**Files:**
- Modify: `src/core/queen/Queen.integration.test.ts`

**Tests:**
```typescript
describe('Queen v0.2.0 integration', () => {
  it('instant mode: greeting produces response in 1 LLM call', async () => { ... });
  it('quick mode: simple lookup uses tools, no verification', async () => { ... });
  it('standard mode: multi-part question decomposes and verifies', async () => { ... });
  it('deep mode: complex research uses dimensional verification', async () => { ... });
  it('continuous mode: code task uses filesystem memory', async () => { ... });
  it('honest failure: all workers fail, returns failure message', async () => { ... });
  it('escalation: ambiguous task surfaces question to user', async () => { ... });
  it('discovery: worker broadcasts finding to sibling workers', async () => { ... });
  it('sparse descriptions: task descriptions are under 200 words', async () => { ... });
  it('cost budget: downgrades mode when budget exceeded', async () => { ... });
  it('purpose temperature: verification uses low temperature', async () => { ... });
  it('memory summarization: old messages summarized before trim', async () => { ... });
});
```

```bash
git commit -m "test: v0.2.0 integration tests across all execution modes"
```

---

## Execution Order & Dependencies

```
Phase 1 (independent, do in order):
  Task 1: Purpose temperatures      ← no dependencies
  Task 2: Strip prompt verbosity     ← no dependencies
  Task 3: Honest failure responses   ← no dependencies
  Task 4: Remove evaluation loop     ← no dependencies

Phase 2 (builds on Phase 1):
  Task 5: User message in verifier   ← needs Task 4 done (simplified verifier)
  Task 6: Memory summarization       ← independent
  Task 7: Discovery signals          ← independent
  Task 8: Escalation tool            ← independent
  (Tasks 6, 7, 8 can run in parallel)

Phase 3 (builds on Phase 1 + 2):
  Task 9: Execution mode system      ← needs Tasks 1-4 done (clean pipeline)
  Task 10: Sparse task descriptions  ← needs Task 9 (modes determine description style)
  Task 11: Filesystem-as-memory      ← needs Task 9 (continuous mode)
  Task 12: Core tools layer          ← needs Task 9 (modes reference tool configs)
  Task 13: Cost-awareness            ← needs Task 9 (modes are what gets costed)
  (Tasks 10-13 can run in parallel after Task 9)

Phase 4 (final):
  Task 14: Config migration          ← needs all above
  Task 15: Integration tests         ← needs all above
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Prompt stripping breaks existing behavior | Run full test suite after Task 2. Compare output quality on 10 sample queries before/after. |
| Execution modes add complexity | Each mode is a simple config object, not a class hierarchy. Easy to understand, modify, delete. |
| Filesystem memory is slow | Only used in `continuous` mode. File I/O is fast for small progress files. Workers already use file tools. |
| Discovery signals add noise | Capped at 3 discoveries, 100 chars each. Minimal token cost. Can be disabled per-mode. |
| Escalation breaks streaming | Escalation pauses the worker, not the stream. Other workers continue. Queen buffers partial results. |
| Cost model is inaccurate | Estimates only, not hard limits. `enabled: false` by default. Uses conservative multipliers. |

---

## What This Achieves

After all 15 tasks, PersonalAgent v0.2.0 will:

1. **Apply proportional effort** — greetings don't burn tokens, research gets verification, code gets filesystem memory
2. **Have minimal prompts** — workers receive the task, criteria, and feedback. Nothing else.
3. **Verify against user intent** — not just planner-written criteria
4. **Know when to say "I don't know"** — honest failure over fabricated confidence
5. **Let workers talk** — discovery signals and escalation to users
6. **Preserve conversation meaning** — summarization before memory trimming
7. **Use consistent verification** — one layer, not two
8. **Support code tasks natively** — continuous mode with filesystem memory and long tool chains
9. **Be cost-aware** — optional budgets prevent runaway token usage
10. **Have opinionated core tools** — Edit requires Read, preconditions enforce safety
11. **Be a clean foundation** — execution modes are composable, new specialties define new modes
