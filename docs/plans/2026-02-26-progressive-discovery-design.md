# Progressive Discovery: Multi-Wave Investigative Execution

**Date:** 2026-02-26
**Status:** Approved
**Approach:** Coordinator Pattern (Approach 3)

## Problem

When a user asks "look into Jose Ibarra Jr., 32-33 years old, lives in Florida, used to live in Michigan — create a full investigative profile," the system decomposes into 5 tasks and fires them all simultaneously. Each worker operates in isolation with only the original sparse context. If Worker A discovers the target's full legal name and Tampa address on iteration 2, Workers B-E never learn this — they're already running with the original query.

The result is broad but shallow. What's needed is an investigative workflow: discover broadly, then use findings to dig deeper, then cross-reference and verify.

## Design

### Architecture: DiscoveryCoordinator

A new class `DiscoveryCoordinator` sits between Queen and WorkerPool. Queen detects discovery-worthy requests and delegates to the coordinator. The coordinator runs waves of workers, accumulates findings, and uses an LLM to decide what to investigate next.

```
Queen.handleDecomposedRequest()
  │
  ├─ plan.discoveryMode && config enabled?
  │   ├─ no → existing flat execution (unchanged)
  │   └─ yes → DiscoveryCoordinator.execute()
  │
  DiscoveryCoordinator.execute(request, initialPlan)
    ├─ Wave 1: Broad discovery tasks
    │   └─ Collect findings, emit wave_complete
    ├─ planNextWave(findings) → LLM decides: continue/sufficient/pivot
    ├─ Wave 2: Targeted deep dives using Wave 1 findings
    │   └─ Collect findings, emit wave_complete
    ├─ ... repeat until stopping condition ...
    └─ Final synthesis with discovery-specific aggregation prompt
```

### Key Principle: Existing Infrastructure, New Orchestration

The coordinator reuses:
- **WorkerPool.executeTasks()** for each wave (unchanged)
- **TaskPlanner** for initial decomposition (minor prompt addition)
- **Task.dependencyResults** for injecting discovery context into workers (existing mechanism)
- **TaskResult.findings** for structured finding extraction (existing mechanism)
- **AgentEvent pipeline** for UI visibility (existing pipeline, new event types)
- **RalphLoop** for worker iteration (unchanged)

Nothing in the worker execution path changes.

### Discovery Detection

The TaskPlanner signals `discoveryMode: true` on the plan when the request is investigative. Added to the planning prompt:

> If the request is investigative — researching a person, company, topic in depth, competitive analysis, or any request that says "deep research", "investigate", "full profile" — set discoveryMode: true. For discovery requests, initial tasks should be BROAD discovery rather than targeted deep dives.

Queen checks: `plan.discoveryMode && config.hive.progressiveDiscovery?.enabled`

### Wave Decision Logic

After each wave completes, the coordinator makes one LLM call with accumulated findings, wave history, and budget info. The LLM returns:

- **continue**: New tasks that build on findings (e.g., "Found Tampa address → search Tampa property records")
- **sufficient**: Investigation is comprehensive enough
- **pivot**: Current direction is blocked, try different approach (e.g., "Public records paywalled → pivot to social media + news archives")

The wave planning prompt includes:
- All accumulated findings (tagged, with confidence and source)
- Wave history (what was tried, what worked)
- Abandoned directions (from pivots — don't retry)
- Budget remaining (waves, time, tokens)
- Diminishing returns signal (how many new findings last wave produced)

### Stopping Criteria

**Hard stops** (enforced in code):
- `maxWaves` reached (default: 4)
- `totalTimeout` exceeded (default: 600s)
- Budget exhausted (token cost)

**Soft stops** (LLM decides via prompt context):
- Diminishing returns: last wave produced fewer than `stoppingThreshold` new findings
- Coverage saturation: findings cover all aspects of the request
- High overall confidence

### Finding Accumulation

```typescript
interface Finding {
  content: string;       // "Full name: Jose Antonio Ibarra Jr."
  source: string;        // "w1-task-2" (wave 1, task 2)
  confidence: number;    // from verifier score
  wave: number;          // which wave produced it
  tags: string[];        // auto-extracted: ["name", "identity"]
}
```

Findings are deduplicated by content similarity (>0.85 = duplicate). Each wave's tasks receive all prior findings through the existing `dependencyResults` mechanism:

```typescript
task.dependencyResults.set('discovery-context', formatDiscoveryContext(
  accumulatedFindings, waveHistory, abandonedDirections
));
```

### Context Injection (Wave N → Wave N+1)

Workers in Wave 2+ see a `discovery-context` dependency result containing:
- Structured findings from all prior waves
- What was already searched (avoid duplication)
- Abandoned directions (don't retry)

From the worker's perspective, this looks identical to a completed dependency — no changes to RalphLoop or iterationPrompt needed.

### Event Emission (Autonomous with Visibility)

New events added to `AgentEvent`:

```typescript
| { type: 'discovery_wave_start'; waveNumber: number; taskCount: number; reasoning: string }
| { type: 'discovery_wave_complete'; waveNumber: number; newFindings: string[]; totalFindings: number }
| { type: 'discovery_decision'; waveNumber: number; decision: 'continue' | 'sufficient' | 'pivot'; reasoning: string }
```

New phase: `'discovering'` added to `AgentPhase`.

Events flow through existing pipeline: coordinator → Queen eventHandler → ProgressTracker → WebSocket → web UI.

### UI Rendering

The web UI shows discovery waves in the WorkerPanel area:

```
Discovery Wave 2 of 4
├─ Wave 1: 3 tasks completed, 8 findings
│   "Found full name: Jose Antonio Ibarra Jr."
│   "Tampa, FL address confirmed"
│   ... +6 more
├─ Wave 2: 2 tasks active
│   ├─ w2-task-1: Search Tampa court records... (iter 2/5)
│   └─ w2-task-2: Verify employer... (iter 1/5)
```

No intermediate chat messages — findings accumulate visually. The final synthesized response appears in chat when all waves complete.

### Final Aggregation

Discovery results use a different aggregation prompt:

> You are producing a comprehensive investigative profile based on multi-wave research. Present findings as a structured profile grouped by category (personal info, addresses, employment, associates, records). Note confidence levels and sources. Flag contradictions. Acknowledge gaps.

This produces a "dossier" rather than concatenated search results.

## Configuration

```yaml
# config/default.yaml
progressiveDiscovery:
  enabled: false          # opt-in
  maxWaves: 4             # maximum investigation waves
  waveTimeout: 120000     # per-wave timeout (ms)
  totalTimeout: 600000    # all waves combined (ms)
  stoppingThreshold: 2    # min new findings per wave to suggest continuing
```

## Files Changed

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `Finding`, `WaveResult`, `WaveDecision` types. Add discovery events to `AgentEvent`. Add `'discovering'` phase. Add `discoveryMode` to `TaskPlan`. |
| `src/core/queen/DiscoveryCoordinator.ts` | **NEW.** Core wave loop, finding accumulation, wave planning, context formatting, aggregation. ~250-300 lines. |
| `src/core/queen/Queen.ts` | Create coordinator in constructor (when config enabled). Add delegation check in `handleDecomposedRequest()` (~10 lines). |
| `src/core/queen/TaskPlanner.ts` | Add discoveryMode to planning prompt. Parse `discoveryMode` in `parseTaskPlan()`. |
| `src/config/types.ts` | Add `ProgressiveDiscoveryConfig`. Add to `HiveConfig`. |
| `config/default.yaml` | Add `progressiveDiscovery` section with defaults. |
| `src/server/protocol.ts` | Add `discovery_wave` to `SerializedAgentEvent`. |
| `src/server/WebSocketHandler.ts` | Serialize discovery events. |
| `web/src/hooks/useQueenSocket.ts` | Add discovery state tracking. Handle `discovery_wave` events. |
| `web/src/components/workers/WorkerPanel.tsx` | Show wave number and accumulated findings when discovery is active. |

## Files Unchanged

- `WorkerPool.ts` — used as-is per wave
- `RalphLoop.ts` — workers iterate identically
- `Worker.ts` — no changes
- `iterationPrompt.ts` — discovery context flows through existing `dependencyResults`
- `Memory.ts` / `MemoryStore.ts` — Queen persists after coordinator returns
- All verifiers — unchanged

## Properties

1. **Opt-in** — config flag + planner detection
2. **Non-invasive** — existing decomposed path unchanged
3. **Autonomous** — coordinator runs waves independently, returns final result
4. **Visible** — events show wave progression and findings to the UI in real-time
5. **Bounded** — hard stops on waves, time, and budget
6. **Adaptive** — LLM decides direction at each wave boundary
7. **Reuses existing infrastructure** — no changes to worker execution path
