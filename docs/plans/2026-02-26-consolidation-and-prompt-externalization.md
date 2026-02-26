# Consolidation & Prompt Externalization — v0.2.2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten the existing framework — wire up partially-integrated systems, consolidate the verification layer, and externalize all LLM prompts into versioned markdown files. The result is a framework where everything that exists actually works together, the verification path is one system with one interface, and prompts are iterable without recompiling.

**Context:** This follows the robustness layer (v0.2.1) which added failure taxonomy, cost tracking, budget guards, tool memory, discovery coordination, and structured feedback. Those features are implemented but some are partially integrated. The v0.2.0-overhaul branch has useful ideas (sparse descriptions) that never merged.

**Approach:** Bottom-up — wire orphans first, consolidate verification second, externalize prompts third. Each phase produces a working, testable system.

**Tech Stack:** TypeScript (ES2022, strict), Vitest, Zod, existing provider abstraction. No new dependencies.

---

## Phase 1: Tighten What Exists

Make existing code deliver on its promises. No new abstractions.

---

### Task 1: Enforce BudgetGuard in RalphLoop

BudgetGuard tracks cost but the early-termination path may not fire reliably. The full chain needs verification: TrackedProvider emits cost → CostRegistry.calculateCost() → BudgetGuard.recordCost() → isExhausted() → `budget_exhausted` exit.

**Files:**
- Modify: `src/core/worker/RalphLoop.ts` (verify cost recording path, lines ~372-379)
- Modify: `src/core/cost/BudgetGuard.ts` (add `remainingBudget()` and `percentUsed()` methods)
- Test: `src/core/worker/RalphLoop.test.ts` (add test: worker stops when budget exhausted)
- Test: `src/core/cost/BudgetGuard.test.ts` (add tests for new methods)

**Acceptance criteria:**
- A RalphLoop test with a low budget limit demonstrates early termination with `exitReason: 'budget_exhausted'`
- BudgetGuard exposes remaining budget percentage for downstream consumers

---

### Task 2: Surface BudgetGuard Status to Queen

Queen dispatches workers but never receives cost feedback. After WorkerPool completes, Queen should check remaining budget before deciding to replan.

**Files:**
- Modify: `src/core/queen/Queen.ts` (check budget after worker pool completes, before replanning decision)
- Modify: `src/core/queen/EscalationClassifier.ts` (add `remainingBudgetPercent` to EscalationContext)
- Test: `src/core/queen/Queen.integration.test.ts` (test: Queen skips replan when budget nearly exhausted)

**Acceptance criteria:**
- EscalationClassifier considers remaining budget — if <15% remaining, prefer `accept_partial` over `replan`
- Queen logs budget status after worker pool execution

---

### Task 3: Clean Up Dead Code and Artifacts

Remove orphaned branches, untracked files, and any truly dead exports.

**Files:**
- Delete: orphaned `worktree-agent-*` git branches (10+)
- Delete: `dns_resolution_guide.md`, `jose_ibarra_jr_profile.md`, `python_vs_rust_web_scraping.md` (test artifacts in repo root)
- Audit: grep for exported functions with zero importers across `src/`

**Acceptance criteria:**
- Only `master`, `feat/robustness-and-progressive-discovery`, and `v0.2.0-overhaul` branches remain
- No untracked non-project files in repo root
- Any dead exports identified and removed

---

### Task 4: Cherry-Pick Sparse Task Descriptions

From v0.2.0 commit `cd8f653`: task descriptions contain only the goal + non-discoverable context. No conversation summaries or style preferences bloating planner output.

**Files:**
- Modify: `src/core/queen/TaskPlanner.ts` (update TASK_PLANNING_PROMPT rules for task descriptions)
- Modify: `src/types.ts` or wherever Task interface lives (remove `conversationSummary` and `userPreferences` from Task if present)
- Test: `src/core/queen/TaskPlanner.test.ts` (verify planner output doesn't include summary/preferences fields)

**Acceptance criteria:**
- Task descriptions in planner output are minimal: goal + non-obvious context only
- `conversationSummary` and `userPreferences` removed from Task interface (if still there)
- Existing tests still pass

---

## Phase 2: Consolidate Verification

Reduce the verification layer from multiple classes with different interfaces to one entry point.

---

### Task 5: Remove LLMVerifier

UnifiedVerifier supersedes LLMVerifier (same verification + reflexion in 1 LLM call instead of 2). Remove the legacy path.

**Files:**
- Modify: `src/core/worker/verifiers.ts` (remove LLMVerifier class)
- Modify: `src/core/worker/RalphLoop.ts` (remove any references to LLMVerifier)
- Modify: `src/config/ConfigSchema.ts` (remove 'llm' from verification strategy options if present)
- Test: `src/core/worker/RalphLoop.test.ts` (update tests that explicitly use LLMVerifier)

**Acceptance criteria:**
- No LLMVerifier class exists
- UnifiedVerifier is the sole LLM-based verifier
- All 538+ tests pass

---

### Task 6: Merge DimensionalVerifier Into UnifiedVerifier

Make dimensional evaluation a mode within UnifiedVerifier, not a separate class. When success criteria have multiple semicolon-separated items, UnifiedVerifier automatically switches to per-criterion evaluation internally.

**Files:**
- Modify: `src/core/worker/verifiers.ts` (UnifiedVerifier gains dimensional mode)
- Modify: `src/core/worker/dimensional.ts` (becomes internal implementation detail, not standalone verifier)
- Modify: `src/core/worker/RalphLoop.ts` (remove verifier selection branching at lines ~409-420)
- Test: `src/core/worker/verifiers.test.ts` or existing test files (test both single and multi-criterion paths through UnifiedVerifier)

**Acceptance criteria:**
- One Verifier interface, one UnifiedVerifier class
- Multi-criterion tasks automatically get per-criterion scoring
- Single-criterion tasks get the existing fast path
- Convergence tracking still works for multi-criterion tasks
- `useDCL` flag removed from RalphLoop

---

### Task 7: Simplify RalphLoop Verifier Selection

After Tasks 5-6, RalphLoop no longer needs branching logic to choose verifiers. Collapse the selection to: create UnifiedVerifier, pass it the task. The verifier decides internally.

**Files:**
- Modify: `src/core/worker/RalphLoop.ts` (simplify verification section)
- Test: `src/core/worker/RalphLoop.test.ts` (verify both single and multi-criterion tasks work through simplified path)

**Acceptance criteria:**
- RalphLoop creates one verifier instance, no conditional branching
- All existing verification tests pass through the unified path
- Code is shorter and the mental model is simpler

---

## Phase 3: Prompt Externalization

Every LLM prompt lives in a versioned `.md` file, loadable at runtime, with template slots for dynamic content.

---

### Task 8: Build PromptRegistry

A module that loads, caches, and renders prompt templates from `.md` files.

**Files:**
- Create: `src/core/prompts/PromptRegistry.ts`
- Create: `src/core/prompts/PromptRegistry.test.ts`
- Modify: `src/config/ConfigSchema.ts` (add `prompts.directory` config option)

**Implementation:**

```typescript
interface PromptMetadata {
  name: string;
  purpose: string;              // planning | execution | verification | aggregation | discovery
  temperature?: number;         // hint for consumers
  description: string;
  slots: string[];              // declared template variables
}

class PromptRegistry {
  constructor(directories: string[])       // resolution order: first found wins
  async load(): Promise<void>              // load all .md files from directories
  get(name: string): PromptTemplate        // returns parsed template
  render(name: string, vars: Record<string, string>): string  // substitute {{slots}}
  has(name: string): boolean
  list(): PromptMetadata[]
}
```

**Behavior:**
- Loads `.md` files with YAML frontmatter from configured directories
- Resolution order: project (`./prompts`) → user (`~/.personalagent/prompts`) → built-in (package `prompts/`)
- `render()` substitutes `{{slotName}}` placeholders with provided values
- Validates that all declared slots are provided (warns on missing, doesn't crash)
- Falls back to empty string for missing prompts (graceful degradation)
- Caches parsed templates in memory

**Acceptance criteria:**
- PromptRegistry loads `.md` files with frontmatter
- `render()` substitutes slots correctly
- Missing slots produce warnings, not crashes
- Resolution order respects project → user → built-in priority

---

### Task 9: Extract Inline Prompts to Files

Move all hardcoded prompts to `prompts/` directory as `.md` files with frontmatter and template slots.

**Files to create/update in `prompts/`:**

1. **`queen-system.md`** — from `Queen.getDefaultSystemPrompt()` + `defaults.ts`
   - Slots: `{{skillSummaries}}`
2. **`worker-system.md`** — from `iterationPrompt.buildToolSystemPrompt()`
   - Slots: `{{date}}`, `{{toolDescriptions}}`, `{{researchStrategy}}`, `{{codeStrategy}}`
3. **`task-planning.md`** — from `TaskPlanner.TASK_PLANNING_PROMPT`
   - Slots: `{{tools}}`, `{{skillContext}}`, `{{conversationContext}}`, `{{userMessage}}`
4. **`discovery-wave-planning.md`** — from `DiscoveryCoordinator.planNextWave()` system message
   - Slots: `{{waveNumber}}`, `{{maxWaves}}`, `{{previousFindings}}`, `{{gapAnalysis}}`
5. **`discovery-aggregation.md`** — from `DiscoveryCoordinator.aggregate()` system message
   - Slots: `{{originalQuery}}`, `{{waveFindings}}`
6. **`result-evaluation.md`** — from `ResultEvaluator.buildEvaluatorPrompt()`
   - Slots: `{{originalRequest}}`, `{{aggregatedResult}}`, `{{taskSummaries}}`
7. **`verification.md`** — from UnifiedVerifier's prompt
   - Slots: `{{task}}`, `{{successCriteria}}`, `{{output}}`, `{{toolFailureFacts}}`
8. **`skill-guidance.md`** — from `Queen.buildSkillGuidanceMessage()`
   - Slots: `{{skillName}}`, `{{skillContent}}`, `{{skillResources}}`

**Files to modify:**
- Each source file that currently contains inline prompts (listed above)
- Replace inline strings with `promptRegistry.render('name', { ... })` calls

**Acceptance criteria:**
- All 8 prompt files exist in `prompts/` with valid frontmatter
- Source files no longer contain large inline prompt strings
- Existing tests still pass (rendering produces equivalent output)

---

### Task 10: Handle Dynamic Iteration Prompt

`buildIterationPrompt()` in `iterationPrompt.ts` is ~400 lines of conditional sections. This can't be a flat template — it needs compositional rendering.

**Approach:** Split into a base template + section templates.

**Files:**
- Create: `prompts/iteration-base.md` — the structural skeleton with `{{sections}}` slot
- Create: `prompts/sections/` directory with individual section templates:
  - `scratchpad.md` — worker reasoning notes
  - `retained-results.md` — critical tool output
  - `dependency-results.md` — outputs from completed dependencies
  - `feedback.md` — verification feedback from prior iterations
  - `convergence.md` — dimensional convergence state
  - `reflexion.md` — strategic guidance
  - `warnings.md` — stall detection, data integrity, budget
- Modify: `src/core/worker/iterationPrompt.ts` — refactor to load base + sections, compose conditionally

**Behavior:**
- `buildIterationPrompt()` becomes a composition function:
  1. Load base template
  2. For each active section, check if data exists, load section template, render it
  3. Join rendered sections, inject into base template's `{{sections}}` slot
- Conditional logic stays in TypeScript (which sections to include)
- Prompt text lives in files (what each section says)

**Acceptance criteria:**
- `iterationPrompt.ts` is significantly shorter (conditionals remain, text doesn't)
- Section templates are individually editable
- Output of `buildIterationPrompt()` is functionally equivalent to current output
- RalphLoop tests pass without modification

---

### Task 11: Config Integration for Prompt Directories

Allow users to override prompts at project and user level.

**Files:**
- Modify: `src/config/ConfigSchema.ts` (add `prompts.directories` array to schema)
- Modify: `src/config/defaults.ts` (default: `['./prompts']`)
- Modify: `src/bootstrap.ts` (create PromptRegistry with configured directories, pass to Queen/Worker constructors)

**Resolution order:**
1. Project-level: `./.personalagent/prompts/`
2. User-level: `~/.personalagent/prompts/`
3. Built-in: `./prompts/` (shipped with package)

**Acceptance criteria:**
- Config schema accepts `prompts.directories` array
- PromptRegistry loads from all configured directories in priority order
- User can override any prompt by placing a file with the same name in their directory

---

### Task 12: Prompt Validation and Developer Experience

Add tooling to help with prompt development.

**Files:**
- Modify: `src/core/prompts/PromptRegistry.ts` (add `validate()` method)
- Create: CLI subcommand or script: `npm run prompts:validate`

**Behavior:**
- `validate()` checks all loaded prompts for:
  - Valid YAML frontmatter
  - All declared slots appear in template body
  - No undeclared slots in template body (typo detection)
  - No empty templates
- CLI command runs validation and reports issues

**Acceptance criteria:**
- `validate()` catches common prompt errors
- Developer can run validation before committing prompt changes

---

## Success Criteria (Overall)

1. **Phase 1:** BudgetGuard actually enforces limits. Queen considers budget in replanning. Dead code removed. Task descriptions are sparse.
2. **Phase 2:** One Verifier interface, one UnifiedVerifier class. RalphLoop verification is a straight line, not a decision tree.
3. **Phase 3:** Zero inline prompt strings in source code. All prompts in versioned `.md` files. Prompts are overridable at project and user level. A developer can change any prompt without touching TypeScript.
4. **All phases:** 538+ tests pass. No regressions. Each phase can be committed and reviewed independently.

---

## What This Plan Does NOT Do

- **Execution modes** (instant/quick/standard/deep) — deferred to a future plan. The prompt system makes this easier to build later.
- **Active cost routing** (cheaper models for simple tasks) — deferred. BudgetGuard enforcement is the prerequisite.
- **Memory summarization** — deferred. MemoryStore is wired in; summarization is a separate concern.
- **Skill execution in Queen** — deferred. Skills as context injection works; full execution is a separate design.
- **v0.2.0 branch merge** — only sparse descriptions are cherry-picked. The rest stays on the branch as reference.
