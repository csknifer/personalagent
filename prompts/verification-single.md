# Single-Criterion Verification Prompt

This is the prompt template used by `UnifiedVerifier` when a task has one success criterion. The canonical source is `src/core/worker/verificationPrompts.ts` (SINGLE_VERIFICATION_TEMPLATE).

## Template Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `{{today}}` | Runtime | Current date (ISO format) |
| `{{taskDescription}}` | Task | What the worker was asked to do |
| `{{successCriteria}}` | Task | How completion is measured |
| `{{toolInfo}}` | Result | Which tools were used |
| `{{toolOutputInfo}}` | Result | Summaries of tool outputs |
| `{{toolFailureInfo}}` | Result | Tools where ALL calls failed |
| `{{taskResult}}` | Result | The worker's output text |

## Key Behaviors

- **Strict for code/data tasks**: ALL criteria must be fully satisfied
- **Lenient for research tasks**: substantive findings with real data = complete
- **Tool output trust**: data from successful tool calls is treated as real
- **Reflexion**: on failure, provides a `nextAction` for strategic guidance
- **Confidence scoring**: 0.0-1.0 representing quality, not just pass/fail
