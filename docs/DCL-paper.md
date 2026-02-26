# Dimensional Convergence Loop (DCL)

## A Novel Verification Architecture for Iterative Agentic Systems

**Version:** 1.0
**Date:** 2026-02-22
**Context:** Personal Agent Framework — Ralph Loop Enhancement

---

## 1. Abstract

The Dimensional Convergence Loop (DCL) is a verification architecture for iterative agent systems that decomposes task verification into independent criteria, tracks per-criterion convergence trajectories, enables selective re-execution, and provides gradient-like directional feedback. DCL replaces flat "pass/fail + feedback string" verification with a multi-dimensional scoring system that gives agents actionable, structured information about what's working, what's failing, and whether the loop is making progress. For single-criterion tasks where dimensional decomposition isn't possible, DCL falls back to Reflexion-style strategic self-reflection.

---

## 2. Motivation

### 2.1 The Problem with Flat Verification

Standard iterative agent loops (e.g., ReAct, external verification loops) follow this pattern:

```
Execute -> Verify -> {pass: return | fail: retry with feedback}
```

The verification step produces a single verdict: `{complete: boolean, confidence: number, feedback: string}`. This creates several problems:

1. **All-or-nothing feedback** — The agent knows it failed but not *which parts* failed. A 5-criterion task where 4/5 criteria pass still gets a flat "incomplete" verdict.

2. **Full re-execution** — Each retry re-generates the *entire* output, including parts that already passed. This wastes tokens and risks regressing on previously-passing criteria.

3. **No convergence awareness** — The loop cannot distinguish between a productive trajectory (scores improving) and a stagnating one (same mistakes repeated). All 10 iterations may be burned with no detection.

4. **Token waste from previous attempts** — Each iteration includes all previous attempts in context. Tool outputs (JSON blobs, API responses) can be thousands of tokens but carry little reusable reasoning value.

5. **Undirected feedback** — Raw feedback strings lack strategic analysis. The agent gets "needs more detail" but no structured guidance on *what kind* of detail or *what strategy change* would help.

### 2.2 Design Goals

DCL addresses each problem:

| Problem | DCL Solution |
|---------|-------------|
| All-or-nothing feedback | Per-criterion independent scoring |
| Full re-execution | Selective focus on failing criteria only |
| No convergence awareness | Per-criterion trajectory tracking with signal detection |
| Token waste | Observation masking strips verbose tool outputs |
| Undirected feedback | Convergence state + Reflexion strategic guidance |

---

## 3. Related Work

### 3.1 Reflexion (Shinn et al., 2023)

Reflexion adds a self-reflection step after task failure where the agent generates a short verbal "reflection" analyzing what went wrong. This reflection is prepended to subsequent attempts. DCL incorporates Reflexion as a fallback for single-criterion tasks where dimensional decomposition isn't applicable.

**Key difference:** Reflexion operates on the entire task outcome as a unit. DCL decomposes verification into independent dimensions, providing more granular signal.

### 3.2 Language Agent Tree Search (LATS)

LATS explores multiple execution paths simultaneously using tree search with LLM-based value functions. DCL operates within a single sequential loop (lower cost) but shares the principle of using structured evaluation to guide exploration.

### 3.3 MemGPT / Memory Systems

MemGPT manages context windows through tiered memory (working memory, archival memory, recall memory). DCL's observation masking is conceptually similar — it manages what information persists across iterations — but operates at the verification/feedback level rather than the memory architecture level.

### 3.4 Chain-of-Thought / ReAct

Standard CoT and ReAct provide reasoning traces but don't structure verification feedback. DCL is orthogonal to and compatible with these approaches — it operates at the verification layer, not the reasoning layer.

---

## 4. Architecture Overview

```
Task with Success Criteria
         |
         v
   parseSuccessCriteria()
         |
    +---------+
    | Multi?  |
    +----+----+
    Yes  |  No
     |   |   |
     v   |   v
   DCL   | Reflexion
   Path  | Fallback
     |   |   |
     v   v   v
  Ralph Loop (iterate)
     |
     v
  Execute (with tools)
     |
     v
  +--+----+----+
  |  DCL? | Std |
  +--+----+----+
     |         |
     v         v
  Dimensional  Standard
  Verifier     Verifier
     |         |
     v         v
  Per-criterion  Flat
  scores        verdict
     |         |
     v         v
  Convergence  Raw
  Tracker      feedback
     |         |
     v         v
  Enhanced Iteration Prompt
  (masking + convergence state + selective focus)
```

### 4.1 Decision Logic

```
if dimensionalConfig is provided:
    criteria = parseSuccessCriteria(task.successCriteria)
    if criteria.length > 1:
        mode = DCL (DimensionalVerifier + ConvergenceTracker)
    elif criteria.length == 1 and reflexionEnabled:
        mode = Reflexion (standard verifier + generateReflexion)
    else:
        mode = Standard
else:
    mode = Standard (backward compatible)
```

---

## 5. Components

### 5.1 parseSuccessCriteria

**Purpose:** Determine whether a task has multiple independent success criteria (activating DCL) or a single criterion (activating Reflexion fallback).

**Algorithm:**
1. Try numbered list: `1. ...`, `1) ...` patterns (multi-line regex)
2. Try bullet points: `- ...`, `* ...` patterns
3. Try semicolons: split on `;`
4. Fallback: single-element array with the full text

**Returns:** `string[]` — one element per independent criterion.

```typescript
function parseSuccessCriteria(criteria: string): string[]
```

**Examples:**
```
"1. Implement API\n2. Write tests" -> ["Implement API", "Write tests"]
"- Fast; - Correct; - Clean"       -> ["Fast", "Correct", "Clean"]
"Task completes successfully"       -> ["Task completes successfully"]
```

### 5.2 DimensionalVerifier

**Purpose:** Replace standard flat verification with per-criterion independent evaluation.

**Interface:** Implements the existing `Verifier` interface, returning `DimensionalVerification extends Verification`.

**Mechanism:**
1. Builds a prompt listing all criteria with instructions to evaluate each independently
2. Sends to LLM, requesting JSON response with per-criterion `{name, score, passed, feedback}`
3. Parses response with robust JSON extraction (regex match for `{...}` block)
4. Returns `DimensionalVerification` with `dimensions: CriterionScore[]`

**Key design decisions:**
- **One LLM call, not N calls** — All criteria evaluated in a single prompt. This replaces (not adds to) the existing verification call, so there's zero additional cost vs standard verification.
- **Strict evaluation** — The prompt instructs `complete=true` only if ALL criteria pass (score >= passingScore).
- **Graceful degradation** — On parse error, returns `complete: false` with zero scores. On provider error, returns error dimensions for all criteria.

```typescript
interface DimensionalVerification extends Verification {
  dimensions?: CriterionScore[];
}

interface CriterionScore {
  name: string;
  score: number;     // 0.0 - 1.0
  passed: boolean;   // score >= passingScore
  feedback: string;  // dimension-specific feedback
}
```

### 5.3 ConvergenceTracker

**Purpose:** Track per-criterion score trajectories and detect convergence/divergence/stagnation patterns.

**Pure data structure — no LLM calls.** Receives `CriterionScore[]` after each verification and maintains internal history.

**Signals:**
- `converging` — Score increasing (latest > previous)
- `diverging` — Score decreasing for 2+ consecutive iterations
- `stagnating` — Score delta below `convergenceThreshold` for `stagnationWindow` consecutive iterations
- `unknown` — Fewer than 2 data points

**State:**
```typescript
interface ConvergenceState {
  history: Map<string, number[]>;           // criterion -> score trajectory
  signals: Map<string, ConvergenceSignal>;  // criterion -> current signal
  bestIteration: Map<string, { iteration: number; score: number }>;
  overallTrend: ConvergenceSignal;          // majority vote across criteria
}
```

**Overall trend calculation:** Majority vote across all criterion signals. Ties resolved: converging > stagnating > diverging > unknown.

**API:**
```typescript
class ConvergenceTracker {
  record(dimensions: CriterionScore[]): void;
  getSignal(name: string): ConvergenceSignal;
  getState(): ConvergenceState;
  getFailingCriteria(passingScore: number): string[];
  reset(): void;
}
```

### 5.4 Observation Masking

**Purpose:** Reduce token waste from previous attempts by truncating verbose tool outputs while preserving reasoning text.

**Mechanism:**
1. Truncate ` ```json ... ``` ` code blocks that exceed `maxMaskedOutputLength`
2. Truncate large inline JSON objects (200+ chars) that exceed the limit
3. Preserve all non-JSON reasoning text intact

**Token savings:** Typically 40-60% reduction on previous-attempt sections, depending on tool usage.

```typescript
function maskObservations(attempt: string, maxOutputLength: number = 200): string
```

**Applied in:** `buildIterationPrompt()` when `context.observationMaskingEnabled` is true.

### 5.5 Reflexion Fallback

**Purpose:** Provide strategic self-reflection for single-criterion tasks where dimensional decomposition isn't meaningful.

**Mechanism:** One extra LLM call per failed iteration that generates a short (2-4 sentence) strategic analysis:
1. What the core failure was
2. What specific strategy change would fix it
3. What approach to avoid

**Activation:** Only for single-criterion tasks when `reflexionEnabled` is true in config.

**Fallback:** If the LLM call fails, returns the raw verification feedback string.

```typescript
async function generateReflexion(
  provider: LLMProvider,
  task: Task,
  attempt: string,
  feedback: string
): Promise<string>
```

### 5.6 Enhanced Iteration Prompt

The `buildIterationPrompt()` function is enhanced to incorporate DCL state:

1. **Observation masking** — Previous attempts have verbose tool outputs truncated
2. **Convergence State section** — Shows per-criterion signals and score trajectories
3. **Strategic Guidance section** — Includes Reflexion output when available
4. **Selective Focus instructions** — Directs agent to focus ONLY on failing criteria, preserving passing work

**Example enhanced prompt sections:**

```
## Convergence State
- accuracy: 0.4 -> 0.6 -> 0.7 (converging)
- completeness: 0.8 -> 0.85 -> 0.9 (converging) [PASSED]
- error_handling: 0.3 -> 0.3 -> 0.31 (stagnating)

## Strategic Guidance
The error handling criterion is stagnating. The core issue is missing
try-catch blocks around async operations. Focus on wrapping all database
calls with proper error recovery.

## Instructions
Focus on improving ONLY these failing criteria:
- error_handling (current: 0.31, target: 0.8)
Preserve your existing work on: accuracy, completeness
```

---

## 6. Configuration

```yaml
hive:
  ralphLoop:
    maxIterations: 10
    verificationStrategy: auto  # 'auto' | 'manual' | 'test-based' | 'dimensional'
    dimensional:
      enabled: true
      convergenceThreshold: 0.05    # Delta below which = stagnating
      passingScore: 0.8             # Per-criterion pass threshold
      stagnationWindow: 2           # Consecutive iterations for stagnation detection
      observationMasking: true      # Strip verbose tool outputs from context
      maxMaskedOutputLength: 200    # Max chars for masked output blocks
      reflexionEnabled: true        # Reflexion fallback for single-criterion tasks
```

**Backward compatibility:** When `dimensionalConfig` is not provided to `ralphLoop()`, all DCL features are disabled and behavior is identical to the pre-DCL code. This is enforced by checking `dclConfig` existence before parsing criteria.

---

## 7. Integration Points

### 7.1 Type System

```typescript
// Core types (src/core/types.ts)
type ConvergenceSignal = 'converging' | 'diverging' | 'stagnating' | 'unknown';

interface CriterionScore {
  name: string;
  score: number;
  passed: boolean;
  feedback: string;
}

interface DimensionalVerification extends Verification {
  dimensions?: CriterionScore[];
}

interface ConvergenceState {
  history: Map<string, number[]>;
  signals: Map<string, ConvergenceSignal>;
  bestIteration: Map<string, { iteration: number; score: number }>;
  overallTrend: ConvergenceSignal;
}
```

### 7.2 Config Chain

```
config.yaml -> ConfigSchema (Zod) -> ResolvedConfig -> Queen -> WorkerPool -> Worker -> ralphLoop()
                                                                                         ^
                                                            dimensionalConfig flows here --+
```

### 7.3 Verifier Interface Compatibility

`DimensionalVerification extends Verification` — any code expecting a `Verification` object works unchanged. The `dimensions` field is optional and only present when DCL is active.

---

## 8. Implementation Guide

For another coding agent to replicate DCL in a different agentic framework:

### Step 1: Define Types
Add `CriterionScore`, `DimensionalVerification`, `ConvergenceSignal`, and `ConvergenceState` types. Ensure `DimensionalVerification` extends your existing verification type.

### Step 2: Criteria Parser
Implement `parseSuccessCriteria()` that splits task success criteria into independent evaluable criteria. Support numbered lists, bullet points, and semicolons. Return a single-element array for plain text.

### Step 3: Convergence Tracker
Implement a pure data structure that:
- Records per-criterion scores per iteration
- Computes signals (converging/diverging/stagnating/unknown) from score trajectories
- Tracks best iteration per criterion
- Reports failing criteria below threshold
- Computes overall trend via majority vote

### Step 4: Dimensional Verifier
Implement a verifier that:
- Takes a list of criteria and passing score
- Prompts LLM to evaluate each criterion independently (single call)
- Parses JSON response with per-criterion scores
- Returns extended verification with dimensions
- Degrades gracefully on parse/provider errors

### Step 5: Observation Masking
Implement a function that truncates verbose output blocks (JSON, tool results) while preserving reasoning text. Apply to previous attempts in the iteration prompt.

### Step 6: Reflexion Fallback
Implement a function that generates strategic self-reflection (2-4 sentences) for single-criterion task failures. Falls back to raw feedback on error.

### Step 7: Loop Integration
In your main loop:
1. Parse criteria at init time
2. Route to DCL (multi-criteria) or Reflexion (single-criterion) or standard (no config)
3. After each failed verification, record dimensional scores and update convergence state
4. Build iteration prompts with convergence state, observation masking, and selective focus

### Step 8: Configuration
Add configuration for: enabled, convergenceThreshold, passingScore, stagnationWindow, observationMasking, maxMaskedOutputLength, reflexionEnabled. All should have sensible defaults.

---

## 9. Evaluation Approach

### 9.1 Metrics

- **Iteration efficiency** — Iterations to completion for multi-criteria tasks (DCL vs standard)
- **Token consumption** — Total tokens per task completion (observation masking should reduce this)
- **Regression rate** — How often previously-passing criteria regress in subsequent iterations
- **Stagnation detection** — Does the loop detect stagnating criteria early?
- **Backward compatibility** — No change in behavior when DCL is disabled

### 9.2 Test Scenarios

- Multi-criteria task where all criteria pass on first try -> DCL should not add overhead
- Multi-criteria task where 1/3 criteria fails -> DCL should focus retry on failing criterion
- Single-criterion task that fails -> Reflexion should generate strategic guidance
- Task with verbose tool outputs -> Observation masking should reduce token count
- Stagnating loop -> ConvergenceTracker should detect stagnation within `stagnationWindow`

---

## 10. Limitations and Future Work

### 10.1 Current Limitations

1. **Criteria parsing is heuristic** — Complex success criteria that don't follow numbered/bullet/semicolon patterns will be treated as a single criterion, falling back to Reflexion rather than DCL.

2. **Single verification call** — All criteria are evaluated in one LLM call. For tasks with many (10+) criteria, the LLM may not evaluate each with sufficient depth. A future version could batch criteria into groups.

3. **No tree search** — DCL operates within a single sequential loop. It doesn't explore multiple execution paths simultaneously. Combining DCL with LATS-style tree search could be powerful but would significantly increase complexity and cost.

4. **Convergence signals are reactive** — Stagnation is detected after it occurs (within `stagnationWindow`). Predictive convergence modeling (extrapolating future trajectories) is not implemented.

5. **Reflexion quality depends on LLM** — The quality of strategic guidance from `generateReflexion` varies with the underlying model. Weaker models may produce generic rather than actionable reflections.

### 10.2 Future Directions

- **Adaptive strategy switching** — Automatically switch strategies when stagnation is detected (e.g., increase temperature, change prompt structure, or terminate early)
- **Cross-task convergence learning** — Use convergence patterns from completed tasks to predict stagnation in new tasks
- **Hierarchical criteria** — Support nested criteria with weighted importance
- **Dynamic masking thresholds** — Adjust observation masking aggressiveness based on remaining context window budget

---

## 11. File Reference

| File | Contents |
|------|----------|
| `src/core/types.ts` | `ConvergenceSignal`, `CriterionScore`, `DimensionalVerification`, `ConvergenceState` |
| `src/config/types.ts` | `DimensionalConfig` interface, `RalphLoopConfig` extension |
| `src/config/ConfigSchema.ts` | `DimensionalConfigSchema` (Zod), updated `RalphLoopConfigSchema` |
| `config/default.yaml` | Default dimensional config values |
| `src/core/worker/RalphLoop.ts` | `parseSuccessCriteria`, `maskObservations`, `ConvergenceTracker`, `DimensionalVerifier`, `generateReflexion`, enhanced `ralphLoop()` and `buildIterationPrompt()` |
| `src/core/worker/Worker.ts` | `dimensionalConfig` pass-through |
| `src/core/worker/WorkerPool.ts` | `dimensionalConfig` pass-through |
| `src/core/queen/Queen.ts` | Reads `config.hive.ralphLoop.dimensional` and passes to worker pool |
| `src/core/worker/RalphLoop.test.ts` | 33 new tests covering all DCL components |
