/**
 * Task planning and decomposition for the Queen agent
 */

import type { Task, TaskPlan, TaskStatus, TaskComplexity, ReplanContext, EvaluationReplanContext } from '../types.js';
import type { LLMProvider } from '../../providers/index.js';
import type { AdaptiveTimeoutConfig } from '../../config/types.js';

interface TaskPlannerOptions {
  maxTasksPerPlan?: number;
  adaptiveTimeout?: AdaptiveTimeoutConfig;
}

const TASK_PLANNING_PROMPT = `Analyze the user's request and create a task plan.

## Instructions

Determine if the request should be handled directly or decomposed into parallel subtasks.

### Handle Directly ("direct") when:
- Single-topic question or request (e.g., "what is X?", "search for Y", "read file Z")
- Greetings, conversational responses, follow-ups to previous answers
- Needs only 1 tool call or no tools at all
- A single coherent topic, even if complex (e.g., "What is quantum computing and how does it work?" — one topic, one search)

### Decompose ("decomposed") when:
- 2+ DISTINCT information needs requiring different sources or tools
- Multi-part questions about different subjects
- Independent subtasks that benefit from parallel execution

**Decompose these:**
- "What's the Roblox stock price and what do analysts think?" → task 1: current price data (web_search), task 2: analyst opinions (web_search + fetch_url)
- "Research competitors A, B, and C" → one task per competitor (parallel web_search)
- "Summarize this article and find related news" → task 1: read and summarize, task 2: search for related articles

**Keep direct:**
- "What's the weather in NYC?" → one search
- "What is X and how does it work?" → one topic, one search is enough
- "Read the README and tell me about the project" → one file read + explanation

### Response Format

For direct:
\`\`\`json
{
  "type": "direct",
  "reasoning": "Brief explanation"
}
\`\`\`

For decomposed:
\`\`\`json
{
  "type": "decomposed",
  "reasoning": "Brief explanation of the decomposition strategy",
  "conversationSummary": "2-3 sentence summary of relevant conversation context that workers need to understand references",
  "userPreferences": ["prefers concise answers", "technical audience"],
  "tasks": [
    {
      "id": "task-1",
      "description": "Self-contained description with ALL context needed. Workers have no conversation history — include names, URLs, specific details.",
      "successCriteria": "Specific, verifiable criteria. Use semicolons for multiple criteria: Current price obtained; At least one source cited; Includes percentage change",
      "dependencies": [],
      "priority": 1,
      "estimatedComplexity": "low|medium|high"
    }
  ]
}
\`\`\`

## Key Rules
- Maximum 5 tasks per plan
- Each task must be **self-contained**: a worker with no context should understand exactly what to do
- **Success criteria must be verifiable**: not "good analysis" but "Includes at least 3 data points; Sources cited; Covers pros and cons"
- Tasks with dependencies: use the "dependencies" array (e.g., task-2 depends on task-1). Only add dependencies when the output of one task is genuinely needed as input for another
- Consider conversation context for interpreting follow-up references ("also", "that", "those", "it")
- **estimatedComplexity**: "low" for simple lookups (single search/fetch), "medium" for multi-step research, "high" for deep analysis requiring multiple sources and synthesis
- When decomposing, include a **conversationSummary** (2-3 sentences of relevant context from conversation history) and **userPreferences** (array of inferred user preferences like "prefers bullet points") in the top-level JSON. Workers have no conversation history — this gives them necessary context.
`;

export class TaskPlanner {
  private provider: LLMProvider;
  private maxTasksPerPlan: number;
  private customPrompt?: string;
  private adaptiveTimeout?: AdaptiveTimeoutConfig;

  constructor(provider: LLMProvider, options: TaskPlannerOptions = {}) {
    this.provider = provider;
    this.maxTasksPerPlan = options.maxTasksPerPlan ?? 5;
    this.adaptiveTimeout = options.adaptiveTimeout;
  }

  /**
   * Set a custom planning prompt
   */
  setCustomPrompt(prompt: string): void {
    this.customPrompt = prompt;
  }

  /**
   * Analyze a user request and create a task plan
   */
  async plan(
    userRequest: string,
    conversationContext?: string,
    options?: { toolNames?: string[]; toolDescriptions?: string[]; skillContext?: string },
  ): Promise<TaskPlan> {
    let prompt = this.customPrompt || TASK_PLANNING_PROMPT;

    if (options?.toolNames && options.toolNames.length > 0) {
      const toolList = options.toolNames.map((name, i) =>
        `- **${name}**: ${options.toolDescriptions?.[i] ?? ''}`
      ).join('\n');
      prompt += `\n## Available Worker Tools\nWorkers can use these tools to complete tasks:\n${toolList}\nMention specific tools in task descriptions where they would help.\n`;
    }

    if (options?.skillContext) {
      prompt += `\n## Active Skill\n${options.skillContext}\n`;
    }

    if (conversationContext) {
      prompt += `\n## Recent Conversation Context\n${conversationContext}\n`;
    }

    prompt += `\n## User Request:\n${userRequest}`;
    const { getDebugLogger } = await import('../DebugLogger.js');
    const log = getDebugLogger();
    log.debug('TaskPlanner', 'Planning request', { promptLength: prompt.length, request: userRequest.slice(0, 100) });

    try {
      const response = await this.provider.complete(prompt);
      const plan = this.parseTaskPlan(response);
      log.info('TaskPlanner', `Plan result: ${plan.type}`, {
        reasoning: plan.reasoning,
        taskCount: plan.tasks?.length ?? 0,
        tasks: plan.tasks?.map(t => ({ desc: t.description.slice(0, 80), criteria: t.successCriteria.slice(0, 80) })),
      });
      return plan;
    } catch (error) {
      log.error('TaskPlanner', 'Planning failed', { error: String(error) });
      // If planning fails, default to direct handling
      return {
        type: 'direct',
        reasoning: 'Planning failed, handling directly',
      };
    }
  }

  /**
   * Replan after worker failures — produces a revised task plan carrying forward
   * completed results and avoiding strategies that already failed.
   */
  async replan(ctx: ReplanContext): Promise<TaskPlan> {
    const { getDebugLogger } = await import('../DebugLogger.js');
    const log = getDebugLogger();
    log.info('TaskPlanner', `Replanning (attempt ${ctx.replanNumber})`, {
      failureReason: ctx.failureReason,
      completedCount: ctx.completedTasks.length,
      failedCount: ctx.failedTasks.length,
      cancelledCount: ctx.cancelledTaskIds.length,
    });

    let prompt = this.customPrompt || TASK_PLANNING_PROMPT;

    // Add tool context
    if (ctx.toolNames && ctx.toolNames.length > 0) {
      const toolList = ctx.toolNames.map((name, i) =>
        `- **${name}**: ${ctx.toolDescriptions?.[i] ?? ''}`
      ).join('\n');
      prompt += `\n## Available Worker Tools\n${toolList}\n`;
    }

    if (ctx.skillContext) {
      prompt += `\n## Active Skill\n${ctx.skillContext}\n`;
    }

    if (ctx.conversationContext) {
      prompt += `\n## Recent Conversation Context\n${ctx.conversationContext}\n`;
    }

    // Add replanning context
    prompt += `\n## REPLANNING CONTEXT (Attempt ${ctx.replanNumber})\n`;
    prompt += `The previous plan failed. You must create a REVISED plan.\n\n`;
    prompt += `**Failure reason:** ${ctx.failureReason}\n\n`;

    if (ctx.completedTasks.length > 0) {
      prompt += `### Already Completed Tasks (DO NOT redo these)\n`;
      for (const t of ctx.completedTasks) {
        prompt += `- **${t.description}** — ${t.success ? 'succeeded' : 'failed'}`;
        if (t.findings && t.findings.length > 0) {
          prompt += `\n  Key findings:\n${t.findings.map(f => `    - ${f}`).join('\n')}\n`;
        } else {
          prompt += `: ${t.outputSummary.slice(0, 300)}\n`;
        }
      }
      prompt += `\n`;
    }

    if (ctx.failedTasks.length > 0) {
      prompt += `### Failed Tasks (need alternative approach)\n`;
      for (const t of ctx.failedTasks) {
        prompt += `- **${t.description}**\n`;
        if (t.exitReason) prompt += `  Exit reason: ${t.exitReason}\n`;
        if (t.bestScore !== undefined) prompt += `  Best score: ${(t.bestScore * 100).toFixed(0)}%\n`;
        if (t.failedTools && t.failedTools.length > 0) {
          prompt += `  Failed tools: ${t.failedTools.join(', ')}\n`;
        }
        if (t.findings && t.findings.length > 0) {
          prompt += `  Partial findings:\n${t.findings.map(f => `    - ${f}`).join('\n')}\n`;
        } else if (t.outputSummary) {
          prompt += `  Partial output: ${t.outputSummary.slice(0, 300)}\n`;
        }
      }
      prompt += `\n`;
    }

    if (ctx.cancelledTaskIds.length > 0) {
      prompt += `### Cancelled Tasks: ${ctx.cancelledTaskIds.join(', ')}\n\n`;
    }

    prompt += `### Replanning Rules\n`;
    prompt += `- DO NOT recreate tasks that already completed successfully\n`;
    prompt += `- If tools failed (auth/quota), avoid those specific tools in the revised plan\n`;
    prompt += `- Try a fundamentally different approach, not the same thing again\n`;
    prompt += `- You may produce fewer tasks since some work is already done\n`;
    prompt += `- If the task is truly impossible, return a "direct" plan and explain why\n\n`;

    prompt += `## User Request:\n${ctx.originalRequest}`;

    try {
      const response = await this.provider.complete(prompt);
      const plan = this.parseTaskPlan(response);
      log.info('TaskPlanner', `Replan result: ${plan.type}`, {
        reasoning: plan.reasoning,
        taskCount: plan.tasks?.length ?? 0,
      });
      return plan;
    } catch (error) {
      log.error('TaskPlanner', 'Replanning failed', { error: String(error) });
      return {
        type: 'direct',
        reasoning: 'Replanning failed, handling directly with partial results',
      };
    }
  }

  /**
   * Replan after a post-aggregation evaluation found quality gaps.
   * Produces targeted tasks that address the evaluator's feedback
   * without redoing work that was already completed successfully.
   */
  async evaluationReplan(ctx: EvaluationReplanContext): Promise<TaskPlan> {
    const { getDebugLogger } = await import('../DebugLogger.js');
    const log = getDebugLogger();
    log.info('TaskPlanner', `Evaluation replan (cycle ${ctx.cycleNumber})`, {
      score: ctx.evaluation.score,
      missingAspects: ctx.evaluation.missingAspects,
    });

    let prompt = this.customPrompt || TASK_PLANNING_PROMPT;

    // Add tool context
    if (ctx.toolNames && ctx.toolNames.length > 0) {
      const toolList = ctx.toolNames.map((name, i) =>
        `- **${name}**: ${ctx.toolDescriptions?.[i] ?? ''}`
      ).join('\n');
      prompt += `\n## Available Worker Tools\n${toolList}\n`;
    }

    if (ctx.skillContext) {
      prompt += `\n## Active Skill\n${ctx.skillContext}\n`;
    }

    if (ctx.conversationContext) {
      prompt += `\n## Recent Conversation Context\n${ctx.conversationContext}\n`;
    }

    // Add evaluation-specific replanning context
    prompt += `\n## EVALUATION REPLAN (Cycle ${ctx.cycleNumber})\n`;
    prompt += `The response was evaluated and found **insufficient**. Create targeted tasks to address the gaps.\n\n`;

    prompt += `**Evaluator Score:** ${(ctx.evaluation.score * 100).toFixed(0)}%\n`;
    prompt += `**Evaluator Feedback:** ${ctx.evaluation.feedback}\n\n`;

    if (ctx.evaluation.missingAspects.length > 0) {
      prompt += `**Missing Aspects (PRIMARY DIRECTIVE — address these specifically):**\n`;
      for (const aspect of ctx.evaluation.missingAspects) {
        prompt += `- ${aspect}\n`;
      }
      prompt += `\n`;
    }

    // Prior result (truncated)
    const maxPriorLen = 800;
    const truncatedPrior = ctx.priorResult.length > maxPriorLen
      ? ctx.priorResult.slice(0, maxPriorLen) + '\n... [truncated]'
      : ctx.priorResult;
    prompt += `### Current Response (to be improved)\n${truncatedPrior}\n\n`;

    if (ctx.priorTaskSummaries.length > 0) {
      prompt += `### Already Completed Tasks (DO NOT redo these)\n`;
      for (const t of ctx.priorTaskSummaries) {
        prompt += `- **${t.description}**: ${t.success ? 'succeeded' : 'failed'}`;
        if (t.findings && t.findings.length > 0) {
          prompt += ` — findings: ${t.findings.slice(0, 3).join('; ')}`;
        }
        prompt += '\n';
      }
      prompt += `\n`;
    }

    prompt += `### Evaluation Replan Rules\n`;
    prompt += `- Target the **missing aspects** specifically — don't redo completed work\n`;
    prompt += `- Create focused tasks that fill the identified gaps\n`;
    prompt += `- If the gaps cannot be filled by workers (e.g., subjective opinion requested), return a "direct" plan\n`;
    prompt += `- Keep tasks minimal — only what's needed to address the feedback\n\n`;

    prompt += `## User Request:\n${ctx.originalRequest}`;

    try {
      const response = await this.provider.complete(prompt);
      const plan = this.parseTaskPlan(response);
      log.info('TaskPlanner', `Evaluation replan result: ${plan.type}`, {
        reasoning: plan.reasoning,
        taskCount: plan.tasks?.length ?? 0,
      });
      return plan;
    } catch (error) {
      log.error('TaskPlanner', 'Evaluation replanning failed', { error: String(error) });
      return {
        type: 'direct',
        reasoning: 'Evaluation replanning failed, keeping current result',
      };
    }
  }

  /**
   * Parse the LLM response into a TaskPlan
   */
  private parseTaskPlan(response: string): TaskPlan {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;

      const parsed = JSON.parse(jsonStr.trim());

      // Validate plan type
      if (parsed.type !== 'direct' && parsed.type !== 'decomposed') {
        return {
          type: 'direct',
          reasoning: `Unknown plan type '${String(parsed.type)}', handling directly`,
        };
      }

      if (parsed.type === 'decomposed' && Array.isArray(parsed.tasks)) {
        // Extract conversation context for workers (capped)
        const conversationSummary = typeof parsed.conversationSummary === 'string'
          ? parsed.conversationSummary.slice(0, 800) || undefined
          : undefined;
        const userPreferences = Array.isArray(parsed.userPreferences)
          ? parsed.userPreferences.map(String).filter(Boolean).slice(0, 5)
          : undefined;

        // Validate and convert tasks
        const tasks: Task[] = parsed.tasks
          .slice(0, this.maxTasksPerPlan)
          .map((t: Record<string, unknown>, index: number) => {
            if (!t.description || String(t.description).trim() === '') {
              this.warnField(index, 'empty description');
            }
            if (!t.successCriteria || String(t.successCriteria).trim() === '') {
              this.warnField(index, 'missing successCriteria, defaulting to "Task completed"');
            }
            if (t.dependencies !== undefined && !Array.isArray(t.dependencies)) {
              this.warnField(index, 'invalid dependencies (expected array), defaulting to []');
            }
            // Extract complexity and compute adaptive timeout overrides
            const rawComplexity = String(t.estimatedComplexity || 'medium').toLowerCase();
            const complexity: TaskComplexity = (rawComplexity === 'low' || rawComplexity === 'high') ? rawComplexity : 'medium';
            const timeoutOverrides = this.getComplexityOverrides(complexity);

            return {
              id: String(t.id || `task-${index + 1}`),
              description: String(t.description || ''),
              successCriteria: String(t.successCriteria || 'Task completed'),
              dependencies: Array.isArray(t.dependencies)
                ? t.dependencies.map(String)
                : [],
              priority: Number(t.priority) || index + 1,
              status: 'pending' as TaskStatus,
              createdAt: new Date(),
              estimatedComplexity: complexity,
              conversationSummary,
              userPreferences: userPreferences?.length ? userPreferences : undefined,
              ...timeoutOverrides,
            };
          });

        return {
          type: 'decomposed',
          reasoning: String(parsed.reasoning || ''),
          tasks,
        };
      }

      return {
        type: 'direct',
        reasoning: String(parsed.reasoning || 'Simple request'),
      };
    } catch {
      // If parsing fails, default to direct
      return {
        type: 'direct',
        reasoning: 'Could not parse plan, handling directly',
      };
    }
  }

  /**
   * Map task complexity to iteration/timeout overrides using adaptive timeout config.
   * Returns empty object if adaptive timeout is disabled.
   */
  private getComplexityOverrides(complexity: TaskComplexity): { maxIterationsOverride?: number; timeoutOverride?: number } {
    if (!this.adaptiveTimeout?.enabled) return {};

    const tier = this.adaptiveTimeout[complexity];
    if (!tier) return {};

    return {
      maxIterationsOverride: tier.maxIterations,
      timeoutOverride: tier.timeout,
    };
  }

  private warnField(taskIndex: number, message: string): void {
    // Fire-and-forget: log warning without blocking
    import('../DebugLogger.js').then(({ getDebugLogger }) => {
      getDebugLogger().warn('TaskPlanner', `Task ${taskIndex}: ${message}`);
    }).catch(() => {});
  }

  /**
   * Get tasks that are ready to execute (no pending dependencies)
   */
  getReadyTasks(tasks: Task[]): Task[] {
    const completedIds = new Set(
      tasks.filter(t => t.status === 'completed').map(t => t.id)
    );

    return tasks.filter(task => {
      if (task.status !== 'pending') return false;
      return task.dependencies.every(dep => completedIds.has(dep));
    });
  }

  /**
   * Check if all tasks are complete
   */
  allTasksComplete(tasks: Task[]): boolean {
    return tasks.every(t => 
      t.status === 'completed' || t.status === 'cancelled'
    );
  }

  /**
   * Check if any task has failed
   */
  hasFailedTasks(tasks: Task[]): boolean {
    return tasks.some(t => t.status === 'failed');
  }

  /**
   * Get task by ID
   */
  getTask(tasks: Task[], id: string): Task | undefined {
    return tasks.find(t => t.id === id);
  }

  /**
   * Update task status
   */
  updateTaskStatus(tasks: Task[], id: string, status: TaskStatus): Task[] {
    return tasks.map(task => {
      if (task.id === id) {
        return {
          ...task,
          status,
          completedAt: status === 'completed' ? new Date() : undefined,
        };
      }
      return task;
    });
  }
}
