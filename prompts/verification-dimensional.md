# Dimensional (Multi-Criteria) Verification Prompt

This is the prompt template used by `UnifiedVerifier` when a task has multiple success criteria (separated by semicolons). The canonical source is `src/core/worker/verificationPrompts.ts` (DIMENSIONAL_VERIFICATION_TEMPLATE).

## Template Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `{{today}}` | Runtime | Current date (ISO format) |
| `{{taskDescription}}` | Task | What the worker was asked to do |
| `{{taskResult}}` | Result | The worker's output text |
| `{{toolOutputInfo}}` | Result | Summaries of tool outputs |
| `{{toolFailureInfo}}` | Result | Tools where ALL calls failed |
| `{{criteriaList}}` | Task | Numbered list of success criteria |

## Key Behaviors

- **Per-criterion scoring**: each criterion gets an independent 0.0-1.0 score
- **Strict threshold**: complete=true only when ALL criteria score >= 0.8
- **Exact name matching**: dimension names must match criterion text exactly
- **Convergence tracking**: scores feed into the DCL convergence tracker across iterations
