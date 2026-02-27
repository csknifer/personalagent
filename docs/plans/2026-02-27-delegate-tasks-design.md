# delegate_tasks Tool — Claude Code-Style Agent Architecture

**Date:** 2026-02-27
**Status:** Approved
**Goal:** Replace the upfront FastClassifier + TaskPlanner decomposition pipeline with a Claude Code-style architecture where the Queen always reasons first and dynamically delegates to parallel workers via a `delegate_tasks` tool.

---

## Problem

Research tasks that should use parallel workers are being handled directly by the Queen because:

1. **FastClassifier** short-circuits messages under 50 tokens as "direct" — most research queries are short
2. **TaskPlanner prompt** says "single coherent topic" = direct — "Research person X" is one topic
3. **Discovery mode** is disabled by default, so even correct decomposition loses multi-wave capability

The core issue is architectural: upfront prediction of task decomposition before any work starts is inherently fragile. Claude Code solves this by letting the main agent reason dynamically and delegate when it discovers the need.

---

## Design

### New Execution Flow

**Before:**
```
User message → FastClassifier → TaskPlanner → either direct OR decomposed
```

**After:**
```
User message → Queen direct execution (always)
  → Queen reasons with tools (search, fetch, read, etc.)
  → Queen calls delegate_tasks when she decides parallel work helps
  → Workers execute with RalphLoop verification
  → Results flow back to Queen as tool results
  → Queen synthesizes and responds
```

The Queen always enters direct mode. No pre-classification. No upfront planning step.

### The `delegate_tasks` Tool

**Definition:**
```
name: delegate_tasks
description: Spawn parallel worker agents to execute tasks concurrently.
  Each worker iterates with external verification until objectively complete.
  Use when you need to research multiple topics, investigate from different
  angles, or do parallel work that benefits from independent verification.

parameters:
  tasks: array of { description: string, successCriteria: string }
    Required. 1-10 tasks to execute in parallel.
  discoveryMode: boolean (default false)
    When true, runs multi-wave progressive discovery with follow-up waves
    based on findings and knowledge graph extraction.
  background: boolean (default false)
    When true, workers execute in background. Returns immediately with a
    delegation ID. Results are injected into context when workers complete.
```

**Implementation:** Queen-internal tool — intercepted in `executeToolCalls()` before hitting MCP. The tool definition appears in the LLM's tool list, but execution is handled by Queen directly since it needs access to `WorkerPool` and `DiscoveryCoordinator`.

### Foreground Execution (default)

1. Queen's tool-call loop encounters `delegate_tasks` call
2. Handler validates tasks, creates `Task[]` objects
3. If `discoveryMode: true` and `DiscoveryCoordinator` available → delegate to it
4. Otherwise → `WorkerPool.executeTasks()` runs tasks in parallel with RalphLoop
5. `AggregationHeuristic` decides whether to concatenate or LLM-synthesize results
6. Structured result summary returned to Queen as tool result
7. Queen continues reasoning

### Background Execution

1. Queen calls `delegate_tasks` with `background: true`
2. Tool returns immediately with delegation ID: `"Delegated 3 tasks (id: d-abc123). Workers executing."`
3. Queen continues streaming/reasoning with other tools
4. Workers execute concurrently in the background
5. When workers complete, results are injected as a system message into Queen's context on her next LLM call
6. If Queen finishes her reasoning before workers complete, `processMessage()` waits for pending background delegations before returning the final response

### Result Format

Worker results are returned to the Queen as a structured summary, not raw output dumps:

```
## Worker Results (3 tasks, 2 succeeded, 1 failed)

### Task: "Research social media presence"
Status: completed (3 iterations)
Findings:
- Active LinkedIn profile, Senior Engineer at Acme Corp
- Twitter account with 2.3k followers, posts about AI/ML

### Task: "Search public records"
Status: completed (2 iterations)
Findings:
- Property records in Tampa, FL
- Business registration for consulting LLC

### Task: "Search academic publications"
Status: failed - no results found
```

For discovery mode, the `DiscoveryCoordinator` result (which includes knowledge graph synthesis) is returned directly.

### Queen System Prompt Changes

Add delegation guidance to the Queen's system prompt:

```
You have access to a delegate_tasks tool that spawns parallel worker agents.
Each worker iterates with verification until objectively complete.

USE delegate_tasks WHEN:
- Researching a person, company, or topic (multiple search angles in parallel)
- The user asks for "deep research", "investigate", "full profile"
- You need information from 2+ independent sources or angles
- Tasks are independent and benefit from parallel execution
- Set discoveryMode: true for investigative/research tasks that may need
  multiple follow-up waves

HANDLE DIRECTLY WHEN:
- Simple questions, greetings, follow-ups
- Single tool call needed (one search, one file read)
- You already have the answer from conversation context
- The user is asking about something you just retrieved

You can gather initial context with your own tools first, then delegate
deeper work. For example: do a quick search to understand the landscape,
then delegate specific research threads to workers.

Use background: true when you want to continue working while workers execute.
Background results will be provided when workers complete.
```

### `executeDirectRequest()` Changes

- Raise `maxToolRounds` from 5 to 10 — enough for: orient → delegate → reason → delegate again → synthesize
- Add `delegate_tasks` interception in `executeToolCalls()` before MCP dispatch
- Track background delegations; wait for pending ones before returning final response

---

## What Gets Removed

- **`FastClassifier.ts`** + **`FastClassifier.test.ts`** — no longer needed
- **`TaskPlanner.plan()` call** in `processMessage()` / `streamMessage()` — Queen decides via tool use
- **`plan.type` branching logic** in `processMessage()` / `streamMessage()` — only one path now
- **`handleDecomposedRequest()`** — responsibilities absorbed by `delegate_tasks` handler

## What Stays As-Is

- **`WorkerPool`**, **`Worker`**, **`RalphLoop`** — workers still do verified parallel work
- **`DiscoveryCoordinator`** + **`KnowledgeGraph`** — triggered via `discoveryMode: true`
- **`AggregationHeuristic`** — used inside `delegate_tasks` to combine results
- **All MCP tools** — Queen keeps her full toolset
- **`Memory`**, **`HistoryManager`** — conversation persistence unchanged

## What Gets Modified

- **`Queen.processMessage()`** — simplified to always enter direct execution
- **`Queen.streamMessage()`** — same simplification
- **`Queen.executeDirectRequest()`** — raise maxToolRounds, add delegate_tasks interception
- **`Queen.executeToolCalls()`** — intercept `delegate_tasks` before MCP dispatch
- **Queen system prompt** — add delegation guidance
- **`TaskPlanner`** — `plan()` becomes unused; keep `replan()` / `evaluationReplan()` for adaptive replanning within worker execution

---

## Comparison to Claude Code Architecture

| Aspect | Claude Code | Our Design |
|--------|-------------|------------|
| Pre-classification | None | None (removing FastClassifier) |
| Delegation mechanism | `Task` tool call | `delegate_tasks` tool call |
| Main agent always sees message | Yes | Yes |
| Sub-agents isolated context | Yes | Yes (workers get task description only) |
| Sub-agent iteration | Own agentic loop | RalphLoop with external verification (advantage) |
| Results flow back as | Tool result | Tool result |
| Background execution | Supported (background: true) | Supported (background: true) |
| Recursive sub-agents | No | No (workers can't spawn workers) |
| Multi-wave discovery | No equivalent | DiscoveryCoordinator + KnowledgeGraph (advantage) |

Our additions (RalphLoop verification, KnowledgeGraph, multi-wave discovery) are enhancements on top of the same fundamental pattern — not deviations from it.

---

## Future Considerations (Not in Scope)

- **Resume specific workers** — like Claude Code's `resume` parameter for sub-agents
- **Worker-to-Queen escalation** — workers requesting clarification mid-task
- **Progressive discovery as default** — consider `progressiveDiscovery.enabled: true` by default
