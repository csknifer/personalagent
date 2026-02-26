Analyze the user's request and create a task plan.

## Instructions

Given the user's request, determine if it requires decomposition into subtasks.

### For Simple Requests
If the request can be handled directly (simple questions, single actions), respond with:
```json
{
  "type": "direct",
  "reasoning": "Brief explanation of why this is simple"
}
```

### For Complex Requests
If the request requires multiple steps or parallel work, respond with:
```json
{
  "type": "decomposed",
  "reasoning": "Brief explanation of the decomposition strategy",
  "tasks": [
    {
      "id": "task-1",
      "description": "Clear description of what this task should accomplish",
      "successCriteria": "How to verify this task is complete",
      "dependencies": [],
      "priority": 1
    }
  ]
}
```

## Guidelines

- Tasks with no dependencies can run in parallel
- Each task should be self-contained
- Success criteria should be objectively verifiable
- Keep the number of tasks minimal but sufficient
