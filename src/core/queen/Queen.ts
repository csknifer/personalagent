/**
 * Queen Agent - The orchestrator of the hive
 */

import { Memory } from './Memory.js';
import { TaskPlanner } from './TaskPlanner.js';
import { WorkerPool, createWorkerPool } from '../worker/WorkerPool.js';
import type { Message, Task, TaskPlan, TaskResult, TokenUsage, AgentEvent, AgentEventHandler, WorkerState, AgentPhase, CompletedTaskSummary, EvaluationResult } from '../types.js';
import { classifyEscalation } from './EscalationClassifier.js';
import { buildEvaluatorPrompt, parseEvaluationResult } from './ResultEvaluator.js';
import { classifyFast } from './FastClassifier.js';
import { shouldSynthesizeWithLLM } from './AggregationHeuristic.js';
import { ToolEffectivenessTracker } from './ToolEffectivenessTracker.js';
import { StrategyStore } from './StrategyStore.js';
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import type { LLMProvider, ChatOptions, ToolDefinition, ToolCall, TrackedChatOptions, StreamChunk } from '../../providers/index.js';
import { TrackedProvider, isTrackedProvider, wrapWithTracking } from '../../providers/index.js';
import type { ResolvedConfig } from '../../config/types.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { SkillLoader, Skill } from '../../skills/SkillLoader.js';
import { getProgressTracker } from '../progress/ProgressTracker.js';
import { estimateTokenCount, formatErrorMessage } from '../utils.js';
import { getDebugLogger } from '../DebugLogger.js';
import { truncateToolResult, callWithTimeout } from '../worker/RalphLoop.js';

const STREAM_TIMEOUT_MS = 60_000; // 60s per-chunk timeout for streaming

/**
 * Wraps an async iterable with a per-chunk timeout. If no chunk arrives
 * within `timeoutMs`, the iteration throws a timeout error.
 */
async function* streamWithTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  label: string,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out — no response after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (result.done) break;
    yield result.value;
  }
}

interface QueenOptions {
  provider: LLMProvider;
  workerProvider?: LLMProvider;
  mcpServer?: MCPServer;
  config: ResolvedConfig;
  skillLoader?: SkillLoader;
  systemPrompt?: string;
  onEvent?: AgentEventHandler;
  strategyStore?: StrategyStore;
  memoryStore?: MemoryStore;
}

export class Queen {
  private provider: LLMProvider;
  private memory: Memory;
  private taskPlanner: TaskPlanner;
  private workerPool: WorkerPool;
  private mcpServer?: MCPServer;
  private skillLoader?: SkillLoader;
  private config: ResolvedConfig;
  private eventHandler?: AgentEventHandler;
  private currentTasks: Task[] = [];
  private currentSkillContext?: { name: string; instructions: string; resources?: Map<string, string> };
  private toolTracker: ToolEffectivenessTracker = new ToolEffectivenessTracker();
  private strategyStore?: StrategyStore;
  private memoryStore?: MemoryStore;
  private discoveryCoordinator?: DiscoveryCoordinator;

  constructor(options: QueenOptions) {
    this.provider = options.provider;
    this.mcpServer = options.mcpServer;
    this.skillLoader = options.skillLoader;
    this.config = options.config;
    this.memory = new Memory({
      maxMessages: options.config.hive.memory?.maxMessages,
      maxTokens: options.config.hive.memory?.maxTokens,
    });
    const planningProvider = isTrackedProvider(options.provider)
      ? options.provider.withPurpose('planning')
      : wrapWithTracking(options.provider, { defaultPurpose: 'planning' });
    this.taskPlanner = new TaskPlanner(planningProvider, {
      adaptiveTimeout: options.config.hive.ralphLoop.adaptiveTimeout,
    });
    this.eventHandler = options.onEvent;
    this.strategyStore = options.strategyStore;
    this.memoryStore = options.memoryStore;

    // Create worker pool with worker provider and MCP tools (fallback to queen provider)
    const workerProvider = options.workerProvider || options.provider;
    this.workerPool = createWorkerPool(workerProvider, {
      maxWorkers: options.config.hive.worker.maxConcurrent,
      maxIterations: options.config.hive.ralphLoop.maxIterations,
      timeout: options.config.hive.worker.timeout,
      mcpServer: options.mcpServer,
      dimensionalConfig: options.config.hive.ralphLoop.dimensional,
      onEvent: (event: AgentEvent) => this.emitEvent(event),
      onWorkerStateChange: (workerId: string, state: WorkerState) => {
        this.emitEvent({ type: 'worker_state_change', workerId, state });
      },
    });

    // Create discovery coordinator if enabled
    const discoveryConfig = options.config.hive.progressiveDiscovery;
    if (discoveryConfig?.enabled) {
      this.discoveryCoordinator = new DiscoveryCoordinator({
        provider: planningProvider,
        workerPool: this.workerPool,
        config: discoveryConfig,
      });
    }

    // Set system prompt with skill awareness
    const baseSystemPrompt = options.systemPrompt || 
      options.config.prompts.queen?.system ||
      this.getDefaultSystemPrompt();
    
    // Add skill summaries to system prompt if available
    const skillSummaries = this.skillLoader?.getSkillSummaries();
    const systemPrompt = skillSummaries 
      ? `${baseSystemPrompt}\n\n## Available Skills\n\n${skillSummaries}`
      : baseSystemPrompt;
    
    this.memory.setSystemMessage(systemPrompt);
  }

  /**
   * Process a user message and generate a response
   */
  async processMessage(userMessage: string): Promise<string> {
    // Initialize progress tracker for this request
    try {
      getProgressTracker().startRequest();
    } catch {
      // Ignore if tracker not available
    }

    // Add user message to memory with estimated token count
    this.memory.addMessage({
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
      metadata: {
        tokenCount: estimateTokenCount(userMessage),
      },
    });

    this.emitEvent({ type: 'thinking', content: 'Analyzing request...' });

    // Check for matching skills and load context
    await this.loadSkillContext(userMessage);

    // Emit planning phase
    this.emitPhaseChange('planning', 'Analyzing and planning task...');

    // Plan the task
    const log = getDebugLogger();
    log.debug('Queen', 'Planning task', { userMessage: userMessage.slice(0, 100), memoryMessages: this.memory.getMessageCount(), memoryTokens: this.memory.getTotalTokensUsed() });

    let conversationContext = this.buildConversationContext();
    const tools = this.mcpServer?.getToolDefinitions();

    // Query relevant memories and prepend to conversation context
    const memoryContext = await this.queryRelevantMemories(userMessage);
    if (memoryContext) {
      const prefix = `## Relevant Memories\n${memoryContext}\n\n`;
      conversationContext = conversationContext ? prefix + conversationContext : prefix;
    }

    const planOptions = {
      toolNames: tools?.map(t => t.name),
      toolDescriptions: tools?.map(t => t.description),
      skillContext: this.currentSkillContext
        ? `Skill: ${this.currentSkillContext.name}\n${this.currentSkillContext.instructions.slice(0, 500)}`
        : undefined,
    };

    // Fast heuristic classifier: skip LLM planning call for obviously simple messages
    let plan: TaskPlan | undefined;
    const fcConfig = this.config.hive.queen.fastClassifier;
    if (fcConfig && fcConfig.enabled !== false) {
      const classification = classifyFast(userMessage, conversationContext, {
        enabled: true,
        maxTokensForDirect: fcConfig.maxTokensForDirect ?? 50,
        maxTokensForUncertain: fcConfig.maxTokensForUncertain ?? 200,
      });
      if (classification.decision === 'direct') {
        plan = { type: 'direct', reasoning: `Fast: ${classification.reason}` };
        log.info('Queen', `Fast classifier: direct (${classification.reason}, confidence: ${classification.confidence})`);
      }
    }

    if (!plan) {
      plan = await this.taskPlanner.plan(userMessage, conversationContext, planOptions);
    }

    log.info('Queen', `Plan: ${plan.type}`, { reasoning: plan.reasoning, taskCount: plan.tasks?.length ?? 0, tasks: plan.tasks?.map(t => t.description.slice(0, 80)) });

    // Diagnostic: show what the planner decided
    this.emitEvent({ type: 'thinking', content: `Plan: ${plan.type}${plan.reasoning ? ` — ${plan.reasoning}` : ''}` });

    let result: { content: string; tokenUsage?: TokenUsage };

    if (plan.type === 'direct') {
      // Emit executing phase for direct requests
      this.emitPhaseChange('executing', 'Handling request directly...');
      log.debug('Queen', 'Direct request path');
      result = await this.handleDirectRequest(userMessage);
    } else {
      // Emit executing phase for decomposed requests
      const taskSummary = plan.tasks?.map(t => t.description.slice(0, 60)).join(' | ') || '';
      this.emitPhaseChange('executing', `Executing ${plan.tasks?.length || 0} tasks...`);
      this.emitEvent({ type: 'thinking', content: `Tasks: ${taskSummary}` });
      log.debug('Queen', 'Decomposed request path', { taskCount: plan.tasks?.length });
      result = await this.handleDecomposedRequest(plan, userMessage);

      // If workers returned empty content, fall back to direct handling
      if (!result.content.trim()) {
        this.emitEvent({ type: 'thinking', content: 'Worker returned empty, handling directly...' });
        result = await this.handleDirectRequest(userMessage);
      } else {
        // Run evaluator-optimizer loop on decomposed results
        const taskResultsMap = new Map<string, TaskResult>();
        for (const task of this.currentTasks) {
          if (task.result) taskResultsMap.set(task.id, task.result);
        }
        result = await this.runEvaluationLoop(result, userMessage, this.currentTasks, taskResultsMap);

        // Fire-and-forget: write task outcome to memory store
        this.writeTaskMemory(userMessage, this.currentTasks, taskResultsMap).catch(() => {});
      }
    }

    // Emit idle phase when complete
    log.info('Queen', 'Request complete', { tokenUsage: result.tokenUsage, responseLength: result.content.length });
    this.emitPhaseChange('idle', 'Request complete');

    // Clear skill context after processing
    this.currentSkillContext = undefined;

    // Add assistant response to memory with token count
    const assistantTokenCount = result.tokenUsage?.total ?? estimateTokenCount(result.content);
    this.memory.addMessage({
      role: 'assistant',
      content: result.content,
      timestamp: new Date(),
      metadata: {
        model: this.provider.model,
        provider: this.provider.name,
        tokenCount: assistantTokenCount,
      },
    });

    this.emitEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: result.content,
        timestamp: new Date(),
      },
    });

    return result.content;
  }

  /**
   * Build a condensed conversation context string for the planner.
   * Returns the last few user/assistant exchanges, truncated to stay compact.
   */
  private buildConversationContext(): string | undefined {
    const recent = this.memory.getRecentMessages(12)
      .filter(m => m.role !== 'system');
    if (recent.length <= 1) return undefined; // Only the current message, no history

    // Exclude the last message (the current user request)
    const history = recent.slice(0, -1);
    if (history.length === 0) return undefined;

    // Process in reverse (most recent first) to prioritize recent context
    const lines: string[] = [];

    for (const msg of [...history].reverse()) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const line = `${role}: ${msg.content}`;
      lines.unshift(line); // Prepend to maintain chronological order
    }

    return lines.length > 0 ? lines.join('\n\n') : undefined;
  }

  /**
   * Write a memory note summarizing a successful decomposed task outcome.
   * Fire-and-forget: errors are logged but never propagate.
   */
  private async writeTaskMemory(userMessage: string, tasks: Task[], results: Map<string, TaskResult>): Promise<void> {
    if (!this.memoryStore) return;
    try {
      const successful = [...results.values()].filter(r => r.success);
      if (successful.length === 0) return;

      const keywords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      const taskSummary = tasks.map(t => t.description).join('; ');
      const id = `task-${Date.now()}`;

      await this.memoryStore.write({
        id,
        content: `Request: ${userMessage}\nDecomposition: ${tasks.length} tasks — ${taskSummary}\nOutcome: ${successful.length}/${tasks.length} succeeded.`,
        tags: ['task-outcome', ...keywords],
        source: 'queen-aggregation',
      });
    } catch (err) {
      const log = getDebugLogger();
      log.warn('Queen', `Failed to write task memory: ${String(err)}`);
    }
  }

  /**
   * Query the MemoryStore for notes relevant to the current user message.
   * Reinforces accessed memories. Returns empty string if nothing found or on error.
   */
  private async queryRelevantMemories(userMessage: string): Promise<string> {
    if (!this.memoryStore) return '';
    try {
      const keywords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      if (keywords.length === 0) return '';
      const memories = await this.memoryStore.queryByTags(keywords);
      if (memories.length === 0) return '';
      const top = memories.slice(0, 3);
      for (const mem of top) {
        await this.memoryStore.read(mem.id, { reinforce: true });
      }
      return top.map(m => m.content).join('\n---\n');
    } catch (err) {
      const log = getDebugLogger();
      log.warn('Queen', `Failed to query memories: ${String(err)}`);
      return '';
    }
  }

  /**
   * Load skill context for the current message if a skill matches
   */
  private async loadSkillContext(userMessage: string): Promise<void> {
    if (!this.skillLoader) return;

    const matchedSkill = this.skillLoader.matchSkills(userMessage)?.[0];
    if (!matchedSkill) return;

    try {
      const loadedSkill = await this.skillLoader.loadSkill(matchedSkill.id);
      if (loadedSkill?.content) {
        // Extract a condensed version of skill instructions (first ~2KB)
        const condensedInstructions = this.condenseSkillContent(loadedSkill.content);
        
        this.currentSkillContext = {
          name: loadedSkill.metadata.name,
          instructions: condensedInstructions,
          resources: loadedSkill.resources,
        };

        this.emitEvent({ 
          type: 'thinking', 
          content: `Using ${loadedSkill.metadata.name} skill for guidance...` 
        });
      }
    } catch (error) {
      // Continue without skill context if loading fails
      this.currentSkillContext = undefined;
    }
  }

  /**
   * Return skill content as-is — no truncation.
   */
  private condenseSkillContent(content: string): string {
    return content;
  }

  /**
   * Handle a simple request directly with MCP tool support and skill context
   */
  private async handleDirectRequest(userMessage: string): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    const tools = this.mcpServer?.getToolDefinitions();
    const messages = this.prepareDirectMessages(this.memory.getContextMessages(), tools);

    try {
      return await this.executeDirectRequest(messages, tools);
    } catch (error) {
      const cleanMessage = formatErrorMessage(error);
      this.emitEvent({ type: 'error', error: cleanMessage });
      throw error instanceof Error ? error : new Error(cleanMessage);
    }
  }

  /**
   * Shared tool-call loop used by both streaming and non-streaming paths.
   * Executes up to maxToolRounds of tool calls, stores each interaction in
   * memory, and returns the final LLM response.
   */
  private async executeDirectRequest(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    maxToolRounds: number = 5,
  ): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    const log = getDebugLogger();
    const trackedProvider = isTrackedProvider(this.provider)
      ? this.provider.withPurpose('direct')
      : wrapWithTracking(this.provider, { defaultPurpose: 'direct' });

    let currentMessages = [...messages];
    let finalOutput = '';
    let totalTokenUsage: TokenUsage | undefined;
    let round = 0;

    while (round <= maxToolRounds) {
      const purpose = round === 0 ? 'direct' : 'tool_followup';
      const provider = round === 0
        ? trackedProvider
        : trackedProvider.withPurpose('tool_followup');
      const chatOptions: TrackedChatOptions = { tools, purpose };
      const response = await callWithTimeout(
        provider.chat(currentMessages, chatOptions),
        STREAM_TIMEOUT_MS,
        'LLM call',
      );

      finalOutput = response.content;

      // Accumulate token usage
      if (response.tokenUsage) {
        totalTokenUsage = totalTokenUsage
          ? {
              input: totalTokenUsage.input + response.tokenUsage.input,
              output: totalTokenUsage.output + response.tokenUsage.output,
              total: totalTokenUsage.total + response.tokenUsage.total,
            }
          : { ...response.tokenUsage };
      }

      // No tool calls or no MCP server — we're done
      if (!response.toolCalls || response.toolCalls.length === 0 || !this.mcpServer) {
        break;
      }

      round++;
      if (round > maxToolRounds) break;

      const toolResults = await this.executeToolCalls(response.toolCalls);
      log.debug('Queen', `Tool round ${round}`, { tools: response.toolCalls.map(tc => tc.name).join(', ') });

      this.emitToolDiagnostics(response.toolCalls, toolResults);
      const { assistantToolMsg, userToolResultMsg } = this.buildToolInteractionMessages(
        response.content, response.toolCalls, toolResults,
      );

      // Append to working message list for next LLM call
      currentMessages = [...currentMessages, assistantToolMsg, userToolResultMsg];
    }

    return { content: finalOutput, tokenUsage: totalTokenUsage };
  }

  /**
   * Prepare messages for a direct LLM call: emit tool-availability diagnostic
   * and inject skill guidance into the system message if present.
   * Shared by both streaming and non-streaming paths.
   */
  private prepareDirectMessages(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
  ): Message[] {
    // Emit available tools diagnostic
    const toolNames = tools?.map(t => t.name).join(', ') || 'none';
    this.emitEvent({ type: 'thinking', content: `Tools available: ${toolNames}` });

    // Inject skill guidance into system message position
    if (this.currentSkillContext) {
      const skillGuidance = this.buildSkillGuidanceMessage();
      const systemIdx = messages.findIndex(m => m.role === 'system');
      if (systemIdx >= 0) {
        return messages.map((m, i) =>
          i === systemIdx
            ? { ...m, content: m.content + '\n\n' + skillGuidance }
            : m
        );
      }
    }
    return messages;
  }

  /**
   * Emit tool call summary and tool result preview diagnostics.
   * Shared by both streaming and non-streaming paths.
   */
  private emitToolDiagnostics(
    toolCalls: ToolCall[],
    toolResults: Array<{ toolCallId: string; name: string; result: string }>,
  ): void {
    const toolCallSummary = toolCalls.map(tc => {
      const args = tc.arguments.query || tc.arguments.url || tc.arguments.path || '';
      return `${tc.name}(${String(args).slice(0, 50)})`;
    }).join(', ');
    this.emitEvent({ type: 'thinking', content: `Calling: ${toolCallSummary}` });

    for (const tr of toolResults) {
      const preview = tr.result.slice(0, 80).replace(/\n/g, ' ');
      this.emitEvent({ type: 'thinking', content: `${tr.name} → ${tr.result.length} chars: ${preview}...` });
    }
  }

  /**
   * Build assistant tool-call and user tool-result message pair,
   * store both in memory, and return them for appending to working message lists.
   * Shared by both streaming and non-streaming paths.
   */
  private buildToolInteractionMessages(
    content: string,
    toolCalls: ToolCall[],
    toolResults: Array<{ toolCallId: string; name: string; result: string }>,
  ): { assistantToolMsg: Message; userToolResultMsg: Message } {
    const assistantToolMsg: Message = {
      role: 'assistant' as const,
      content,
      timestamp: new Date(),
      toolCalls: toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.providerMetadata ? { providerMetadata: tc.providerMetadata } : {}),
      })),
    };
    const userToolResultMsg: Message = {
      role: 'user' as const,
      content: '',
      timestamp: new Date(),
      toolResults: toolResults.map(tr => ({
        toolCallId: tr.toolCallId,
        toolName: tr.name,
        result: tr.result,
      })),
    };
    this.memory.addMessage(assistantToolMsg);
    this.memory.addMessage(userToolResultMsg);
    return { assistantToolMsg, userToolResultMsg };
  }

  /**
   * Build skill guidance message for injection into conversation
   */
  private buildSkillGuidanceMessage(): string {
    if (!this.currentSkillContext) return '';

    let message = `## Skill Guidance: ${this.currentSkillContext.name}\n\n`;
    message += `Follow these skill instructions to help with the user's request:\n\n`;
    message += this.currentSkillContext.instructions;

    // Add resources if available
    if (this.currentSkillContext.resources && this.currentSkillContext.resources.size > 0) {
      message += '\n\n## Skill Resources\n\n';
      for (const [name, content] of this.currentSkillContext.resources) {
        message += `### ${name}\n${content}\n\n`;
      }
    }

    return message;
  }

  /**
   * Execute tool calls via MCP server (parallel)
   */
  private async executeToolCalls(toolCalls: ToolCall[]): Promise<Array<{ toolCallId: string; name: string; result: string }>> {
    if (!this.mcpServer) return [];

    const mcpServer = this.mcpServer;
    const settled = await Promise.allSettled(
      toolCalls.map(async (toolCall) => {
        try {
          const result = await mcpServer.executeToolCall(toolCall);
          const resultStr = result.success
            ? truncateToolResult(JSON.stringify(result.data, null, 2))
            : `Error: ${result.error}`;
          return { toolCallId: toolCall.id, name: toolCall.name, result: resultStr };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          return { toolCallId: toolCall.id, name: toolCall.name, result: `Error: ${err.message}` };
        }
      })
    );

    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { toolCallId: toolCalls[i].id, name: toolCalls[i].name, result: `Error: ${(s as PromiseRejectedResult).reason}` }
    );
  }

  /**
   * Handle a complex request by dispatching to workers via WorkerPool.
   * Supports adaptive replanning: when workers fail mid-flight, the Queen
   * can classify the failure, cancel dependents, and spawn revised tasks.
   */
  private async handleDecomposedRequest(plan: TaskPlan, originalRequest: string): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    if (!plan.tasks || plan.tasks.length === 0) {
      return this.handleDirectRequest(originalRequest);
    }

    // Add skill context to tasks if available
    if (this.currentSkillContext) {
      for (const task of plan.tasks) {
        task.skillContext = {
          name: this.currentSkillContext.name,
          instructions: this.currentSkillContext.instructions,
          resources: this.currentSkillContext.resources,
        };
      }
    }

    // Inject tool effectiveness hints from session history
    for (const task of plan.tasks) {
      const pattern = this.toolTracker.classifyTaskPattern(task.description);
      const hints = this.toolTracker.getHints(pattern);
      if (hints) {
        task.toolEffectivenessHints = hints;
      }
      // Inject cross-session strategy hints
      if (this.strategyStore) {
        const strategyHints = this.strategyStore.buildStrategyHints(pattern);
        if (strategyHints) {
          task.strategyHints = strategyHints;
        }
      }
    }

    // Delegate to DiscoveryCoordinator for multi-wave investigative requests
    if (plan.discoveryMode && this.discoveryCoordinator) {
      const tools = this.mcpServer?.getToolDefinitions();
      const discoveryResult = await this.discoveryCoordinator.execute(
        originalRequest,
        plan,
        {
          eventHandler: (event) => this.emitEvent(event),
          skillContext: this.currentSkillContext ? {
            name: this.currentSkillContext.name,
            instructions: this.currentSkillContext.instructions,
            resources: this.currentSkillContext.resources,
          } : undefined,
          conversationContext: this.buildConversationContext(),
          toolNames: tools?.map(t => t.name),
          toolDescriptions: tools?.map(t => t.description),
        },
      );

      this.emitPhaseChange('idle');
      return { content: discoveryResult.content };
    }

    this.currentTasks = plan.tasks;
    this.emitEvent({
      type: 'thinking',
      content: `Decomposed into ${plan.tasks.length} tasks${this.currentSkillContext ? ` (using ${this.currentSkillContext.name} skill)` : ''}: ${plan.reasoning}`,
    });

    // Emit worker spawned events for each task
    for (const task of plan.tasks) {
      this.emitEvent({ type: 'worker_spawned', workerId: task.id, task });
    }

    // Replanning state
    const replanConfig = this.config.hive.replanning;
    const replanEnabled = replanConfig?.enabled ?? false;
    const maxReplans = replanConfig?.maxReplans ?? 1;
    let replanCount = 0;
    let replanTriggered = false;
    let replanReason = '';
    const cancelledTaskIds: string[] = [];

    // All results across original + replanned waves
    const allResults = new Map<string, TaskResult>();
    let allTasks = [...plan.tasks];

    const log = getDebugLogger();

    try {
      // Wire up mid-flight callback for adaptive replanning
      if (replanEnabled) {
        this.workerPool.setOnTaskComplete((taskId, result) => {
          allResults.set(taskId, result);

          if (!result.success && replanCount < maxReplans && !replanTriggered) {
            // Find dependent tasks for this one
            const dependentTaskIds = allTasks
              .filter(t => t.dependencies.includes(taskId))
              .map(t => t.id);

            const decision = classifyEscalation({
              result,
              replanCount,
              maxReplans,
              dependentTaskIds,
            });

            if (decision.action === 'replan') {
              log.info('Queen', `Escalation: ${decision.reason}`, {
                taskId,
                exitReason: result.exitReason,
                dependentTaskIds,
              });

              // Cancel dependent tasks immediately
              for (const depId of dependentTaskIds) {
                const cancelled = this.workerPool.cancelTask(depId);
                if (cancelled) {
                  cancelledTaskIds.push(depId);
                  log.info('Queen', `Cancelled dependent task ${depId}`);
                }
              }

              replanTriggered = true;
              replanReason = decision.reason;
            }
          }
        });
      }

      // Execute original tasks
      const resultsMap = await this.workerPool.executeTasks(plan.tasks);

      // Merge results
      for (const [id, result] of resultsMap) {
        allResults.set(id, result);
      }

      // Update task statuses and emit completion events
      for (const task of plan.tasks) {
        const result = allResults.get(task.id);
        if (result) {
          task.status = result.success ? 'completed' : 'failed';
          task.result = result;
          this.emitEvent({ type: 'worker_completed', workerId: task.id, result });
        }
      }

      // --- Adaptive replanning ---
      if (replanTriggered && replanCount < maxReplans) {
        replanCount++;
        log.info('Queen', `Replanning triggered (attempt ${replanCount}/${maxReplans})`, { reason: replanReason });
        this.emitPhaseChange('replanning', replanReason);
        this.emitEvent({
          type: 'replan_triggered',
          reason: replanReason,
          replanNumber: replanCount,
          cancelledTaskIds,
        });

        // Build summaries for the planner
        const completedSummaries: CompletedTaskSummary[] = [];
        const failedSummaries: CompletedTaskSummary[] = [];

        for (const task of allTasks) {
          const result = allResults.get(task.id);
          if (!result) continue;

          const summary: CompletedTaskSummary = {
            taskId: task.id,
            description: task.description,
            success: result.success,
            outputSummary: result.output || '',
            findings: result.findings,
            exitReason: result.exitReason,
            bestScore: result.bestScore,
            failedTools: result.toolFailures?.map(f => f.tool),
            failure: result.failure,
          };

          if (result.success) {
            completedSummaries.push(summary);
          } else {
            failedSummaries.push(summary);
          }
        }

        // Get tool info for the replanner
        const tools = this.mcpServer?.getToolDefinitions();

        const revisedPlan = await this.taskPlanner.replan({
          originalRequest,
          failureReason: replanReason,
          completedTasks: completedSummaries,
          failedTasks: failedSummaries,
          cancelledTaskIds,
          replanNumber: replanCount,
          conversationContext: this.buildConversationContext(),
          toolNames: tools?.map(t => t.name),
          toolDescriptions: tools?.map(t => t.description),
          skillContext: this.currentSkillContext
            ? `Skill: ${this.currentSkillContext.name}\n${this.currentSkillContext.instructions.slice(0, 500)}`
            : undefined,
        });

        if (revisedPlan.type === 'decomposed' && revisedPlan.tasks && revisedPlan.tasks.length > 0) {
          // Re-ID new tasks to avoid collisions
          const newTasks = revisedPlan.tasks.map(t => ({
            ...t,
            id: `r${replanCount}-${t.id}`,
            skillContext: this.currentSkillContext ? {
              name: this.currentSkillContext.name,
              instructions: this.currentSkillContext.instructions,
              resources: this.currentSkillContext.resources,
            } : undefined,
          }));

          // Emit worker spawned events for new tasks
          for (const task of newTasks) {
            this.emitEvent({ type: 'worker_spawned', workerId: task.id, task });
          }

          this.emitPhaseChange('executing', `Re-executing ${newTasks.length} revised tasks`);

          // Reset replan trigger for next wave
          replanTriggered = false;

          // Execute new wave
          const newResultsMap = await this.workerPool.executeTasks(newTasks);

          // Merge results and emit completion events
          for (const task of newTasks) {
            const result = newResultsMap.get(task.id);
            if (result) {
              allResults.set(task.id, result);
              task.status = result.success ? 'completed' : 'failed';
              task.result = result;
              this.emitEvent({ type: 'worker_completed', workerId: task.id, result });
            }
          }

          allTasks = [...allTasks, ...newTasks];
        } else {
          log.info('Queen', 'Replanner returned direct plan — proceeding with partial results');
        }
      }

      // Clear the mid-flight callback
      this.workerPool.setOnTaskComplete(undefined);

      // Build final task-result pairs for aggregation
      const finalPairs: Array<{ task: Task; result: TaskResult }> = [];
      for (const task of allTasks) {
        const result = allResults.get(task.id);
        if (result) finalPairs.push({ task, result });
      }

      // Record tool effectiveness for session learning
      for (const task of allTasks) {
        const result = allResults.get(task.id);
        if (result) {
          const pattern = this.toolTracker.classifyTaskPattern(task.description);
          this.toolTracker.recordResult(
            pattern,
            result.toolsUsed || [],
            result.toolFailures || [],
            result.iterations || 0,
          );
        }
      }

      // Persist session tool data to cross-session strategy store
      if (this.strategyStore) {
        this.strategyStore.ingestSessionData(this.toolTracker.getAllData());
      }

      // Aggregate all results
      return this.aggregateResults(originalRequest, finalPairs);
    } catch (error) {
      // Always clean up
      this.workerPool.setOnTaskComplete(undefined);

      const err = error instanceof Error ? error : new Error(String(error));
      this.emitEvent({
        type: 'error',
        error: `Task execution failed: ${err.message}`,
      });

      // Fall back to direct handling
      return this.handleDirectRequest(originalRequest);
    }
  }

  /**
   * Aggregate worker results into a final response
   */
  private async aggregateResults(originalRequest: string, taskResults: Array<{ task: Task; result: TaskResult }>): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    // Sum token usage from all worker results
    const workerTokens: TokenUsage = { input: 0, output: 0, total: 0 };
    for (const { result } of taskResults) {
      if (result.tokenUsage) {
        workerTokens.input += result.tokenUsage.input;
        workerTokens.output += result.tokenUsage.output;
        workerTokens.total += result.tokenUsage.total;
      }
    }

    // Filter successful vs failed results
    const successful = taskResults.filter(({ result }) => result.success && result.output.trim());
    const failed = taskResults.filter(({ result }) => !result.success || !result.output.trim());

    if (successful.length === 0) {
      // Surface partial work and structured errors instead of a generic message
      const parts: string[] = ['I wasn\'t able to fully complete your request. Here\'s what happened:\n'];

      for (const { task, result } of failed) {
        parts.push(`**${task.description}**`);
        if (result.output && result.output.trim()) {
          parts.push(`Partial output:\n${result.output.trim()}\n`);
        }
        if (result.toolFailures && result.toolFailures.length > 0) {
          parts.push(`Tool errors: ${result.toolFailures.map(f => `${f.tool} (${f.error})`).join(', ')}`);
        } else if (result.error) {
          parts.push(`Error: ${result.error}`);
        }
        parts.push('');
      }

      return { content: parts.join('\n'), tokenUsage: workerTokens };
    }

    if (successful.length === 1 && failed.length === 0) {
      return { content: successful[0].result.output, tokenUsage: workerTokens };
    }

    // Conditional aggregation: skip LLM synthesis for disjoint topics
    if (successful.length >= 2 && failed.length === 0) {
      const decision = shouldSynthesizeWithLLM(
        successful.map(({ task, result }) => ({
          description: task.description,
          output: result.output,
          dependencies: task.dependencies,
        })),
        this.config.hive.queen.aggregationOverlapThreshold ?? 0.15,
      );
      if (!decision.shouldSynthesize) {
        const log = getDebugLogger();
        log.info('Queen', `Skipping LLM synthesis: ${decision.reason}`);
        const content = successful
          .map(({ task, result }) => `## ${task.description}\n\n${result.output}`)
          .join('\n\n---\n\n');
        return { content, tokenUsage: workerTokens };
      }
    }

    // Emit aggregating phase
    this.emitPhaseChange('aggregating', `Synthesizing ${successful.length} task results...`);

    // Build labeled task results — include structured findings when available
    const taskResultsSection = successful
      .map(({ task, result }) => {
        let section = `### Task: ${task.description}\n`;
        if (result.findings && result.findings.length > 0) {
          section += `**Key Findings:**\n${result.findings.map(f => `- ${f}`).join('\n')}\n\n`;
        }
        section += result.output;
        return section;
      })
      .join('\n\n');

    const failedSection = failed.length > 0
      ? `\n\n### Failed Tasks\n${failed.map(({ task, result }) => `- **${task.description}**: ${result.error || 'No output produced'}`).join('\n')}`
      : '';

    const synthesisPrompt = `Synthesize these worker results into a unified response to the user's request.

## Original Request
${originalRequest}

## Task Results
${taskResultsSection}${failedSection}

## Synthesis Instructions
1. **Unified voice**: Write as if one knowledgeable agent answered the entire question. Never reference "workers", "tasks", or "agents".
2. **Deduplicate**: If multiple results cover the same information, include it once with the best sourcing.
3. **Resolve conflicts**: If results provide contradictory data, note the discrepancy and explain which source is more authoritative.
4. **Acknowledge gaps**: If any tasks failed, mention what information is missing rather than silently omitting it.
5. **Preserve sources**: Keep URLs and references from the results.
6. **Match format**: Questions → direct answers. Comparisons → structured comparison. Lists → organized lists.`;

    // Use tracked provider for aggregation call
    const chatOptions: TrackedChatOptions = {
      purpose: 'aggregation',
    };

    const trackedProvider = isTrackedProvider(this.provider)
      ? this.provider.withPurpose('aggregation')
      : wrapWithTracking(this.provider, { defaultPurpose: 'aggregation' });

    const response = await trackedProvider.chat([
      { role: 'system', content: 'You are producing a unified response from parallel research results. Write as if you personally gathered all the information. Never reference workers, tasks, or the parallel nature of the research. Maintain factual accuracy — do not add information not present in the results.', timestamp: new Date() },
      { role: 'user', content: synthesisPrompt, timestamp: new Date() },
    ], chatOptions);

    // Combine worker + aggregation tokens
    if (response.tokenUsage) {
      workerTokens.input += response.tokenUsage.input;
      workerTokens.output += response.tokenUsage.output;
      workerTokens.total += response.tokenUsage.total;
    }

    return { content: response.content, tokenUsage: workerTokens };
  }

  /**
   * Stream a message response as an async generator of StreamChunks.
   * For direct requests: streams via provider.chatStream() with tool support.
   * For decomposed requests: falls back to non-streaming and yields result as a single text chunk.
   */
  async *streamMessage(userMessage: string): AsyncGenerator<StreamChunk> {
    // Initialize progress tracker
    try {
      getProgressTracker().startRequest();
    } catch {
      // Ignore if tracker not available
    }

    // Add user message to memory
    this.memory.addMessage({
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
      metadata: {
        tokenCount: estimateTokenCount(userMessage),
      },
    });

    this.emitEvent({ type: 'thinking', content: 'Analyzing request...' });

    let fullResponse = '';

    try {
      // Check for matching skills and load context
      await this.loadSkillContext(userMessage);

      // Plan the task (with same planOptions as processMessage)
      this.emitPhaseChange('planning', 'Analyzing and planning task...');
      let conversationContext = this.buildConversationContext();
      const tools = this.mcpServer?.getToolDefinitions();

      // Query relevant memories and prepend to conversation context
      const memoryContext = await this.queryRelevantMemories(userMessage);
      if (memoryContext) {
        const prefix = `## Relevant Memories\n${memoryContext}\n\n`;
        conversationContext = conversationContext ? prefix + conversationContext : prefix;
      }

      const planOptions = {
        toolNames: tools?.map(t => t.name),
        toolDescriptions: tools?.map(t => t.description),
        skillContext: this.currentSkillContext
          ? `Skill: ${this.currentSkillContext.name}\n${this.currentSkillContext.instructions.slice(0, 500)}`
          : undefined,
      };

      // Fast heuristic classifier for streaming path
      let plan: TaskPlan | undefined;
      const fcConfig = this.config.hive.queen.fastClassifier;
      if (fcConfig && fcConfig.enabled !== false) {
        const classification = classifyFast(userMessage, conversationContext, {
          enabled: true,
          maxTokensForDirect: fcConfig.maxTokensForDirect ?? 50,
          maxTokensForUncertain: fcConfig.maxTokensForUncertain ?? 200,
        });
        if (classification.decision === 'direct') {
          plan = { type: 'direct', reasoning: `Fast: ${classification.reason}` };
        }
      }
      if (!plan) {
        plan = await this.taskPlanner.plan(userMessage, conversationContext, planOptions);
      }

      // Diagnostic: show planner decision
      this.emitEvent({ type: 'thinking', content: `Plan: ${plan.type}${plan.reasoning ? ` — ${plan.reasoning}` : ''}` });

      if (plan.type === 'direct') {
        // Stream the direct response path
        this.emitPhaseChange('executing', 'Streaming response...');

        const messages = this.prepareDirectMessages(this.memory.getContextMessages(), tools);

        const trackedProvider = isTrackedProvider(this.provider)
          ? this.provider.withPurpose('direct')
          : wrapWithTracking(this.provider, { defaultPurpose: 'direct' });

        // Stream with end-to-end tool support
        let currentMessages = [...messages];
        let toolRound = 0;
        const maxToolRounds = 5;
        let continueStreaming = true;

        while (continueStreaming && toolRound <= maxToolRounds) {
          const pendingToolCalls: ToolCall[] = [];
          const purpose = toolRound === 0 ? 'direct' : 'tool_followup';
          const streamProvider = toolRound === 0
            ? trackedProvider
            : trackedProvider.withPurpose('tool_followup');

          const stream = streamWithTimeout(
            streamProvider.chatStream(currentMessages, { tools, purpose }),
            STREAM_TIMEOUT_MS,
            'LLM streaming call',
          );
          for await (const chunk of stream) {
            if (chunk.type === 'text' && chunk.content) {
              fullResponse += chunk.content;
              yield chunk;
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              pendingToolCalls.push(chunk.toolCall);
              yield chunk;
            }
          }

          // No tool calls — streaming is complete
          if (pendingToolCalls.length === 0 || !this.mcpServer) {
            continueStreaming = false;
            break;
          }

          // Process tool calls and prepare for next streaming round
          toolRound++;
          if (toolRound > maxToolRounds) break;

          const toolResults = await this.executeToolCalls(pendingToolCalls);
          this.emitToolDiagnostics(pendingToolCalls, toolResults);
          const { assistantToolMsg, userToolResultMsg } = this.buildToolInteractionMessages(
            fullResponse, pendingToolCalls, toolResults,
          );

          // Reset fullResponse for the continuation — the accumulated text from
          // previous rounds is already stored in memory via buildToolInteractionMessages
          fullResponse = '';
          currentMessages = [...currentMessages, assistantToolMsg, userToolResultMsg];
        }

        // Fallback: if no text was produced at all, use non-streaming path
        if (!fullResponse.trim()) {
          this.emitEvent({ type: 'thinking', content: 'Finalizing response...' });
          const fallbackResult = await this.handleDirectRequest(userMessage);
          fullResponse = fallbackResult.content;
          yield { type: 'text', content: fullResponse };
        }
      } else {
        // Decomposed request: fall back to non-streaming
        this.emitPhaseChange('executing', `Executing ${plan.tasks?.length || 0} tasks...`);
        let result = await this.handleDecomposedRequest(plan, userMessage);

        // If workers returned empty content, fall back to direct handling
        if (!result.content.trim()) {
          this.emitEvent({ type: 'thinking', content: 'Worker returned empty, handling directly...' });
          const directResult = await this.handleDirectRequest(userMessage);
          result = directResult;
        } else {
          // Run evaluator-optimizer loop on decomposed results
          const taskResultsMap = new Map<string, TaskResult>();
          for (const task of this.currentTasks) {
            if (task.result) taskResultsMap.set(task.id, task.result);
          }
          result = await this.runEvaluationLoop(result, userMessage, this.currentTasks, taskResultsMap);

          // Fire-and-forget: write task outcome to memory store
          this.writeTaskMemory(userMessage, this.currentTasks, taskResultsMap).catch(() => {});
        }

        fullResponse = result.content;
        yield { type: 'text', content: fullResponse };
      }
    } catch (error) {
      // On any error, yield a clean human-readable message
      const cleanMessage = formatErrorMessage(error);
      this.emitEvent({ type: 'error', error: cleanMessage });
      fullResponse = `Error: ${cleanMessage}`;
      yield { type: 'text', content: fullResponse };
    }

    // Always yield done
    yield { type: 'done' };

    // Always clean up
    this.emitPhaseChange('idle', 'Request complete');
    this.currentSkillContext = undefined;

    // Add assistant message to memory (even if it's an error message)
    this.memory.addMessage({
      role: 'assistant',
      content: fullResponse,
      timestamp: new Date(),
      metadata: {
        model: this.provider.model,
        provider: this.provider.name,
        tokenCount: estimateTokenCount(fullResponse),
      },
    });

    this.emitEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: fullResponse,
        timestamp: new Date(),
      },
    });
  }

  /**
   * Build CompletedTaskSummary[] from tasks with results.
   * Extracted for reuse across replanning and evaluation flows.
   */
  private buildTaskSummaries(tasks: Task[], results: Map<string, TaskResult>): CompletedTaskSummary[] {
    const summaries: CompletedTaskSummary[] = [];
    for (const task of tasks) {
      const result = results.get(task.id);
      if (!result) continue;
      summaries.push({
        taskId: task.id,
        description: task.description,
        success: result.success,
        outputSummary: (result.output || '').slice(0, 500),
        findings: result.findings,
        exitReason: result.exitReason,
        bestScore: result.bestScore,
        failedTools: result.toolFailures?.map(f => f.tool),
      });
    }
    return summaries;
  }

  /**
   * Evaluate a result against the original request using the LLM.
   * Fail-open: on any error, returns { pass: true } to never block a response.
   */
  private async evaluateResult(
    originalRequest: string,
    result: string,
    taskSummaries: CompletedTaskSummary[],
    threshold: number,
  ): Promise<EvaluationResult> {
    const failOpen: EvaluationResult = {
      pass: true,
      score: 0.75,
      feedback: 'Evaluation failed — passing by default',
      missingAspects: [],
    };

    try {
      const prompt = buildEvaluatorPrompt({
        originalRequest,
        aggregatedResult: result,
        taskSummaries,
      });

      // Use tracked provider with 'evaluation' purpose
      const trackedProvider = isTrackedProvider(this.provider)
        ? this.provider.withPurpose('evaluation')
        : wrapWithTracking(this.provider, { defaultPurpose: 'evaluation' });

      const response = await trackedProvider.complete(prompt);
      return parseEvaluationResult(response, threshold);
    } catch (error) {
      const log = getDebugLogger();
      log.warn('Queen', `Evaluation LLM call failed: ${error instanceof Error ? error.message : String(error)}`);
      return failOpen;
    }
  }

  /**
   * Run the Evaluator-Optimizer outer loop on a decomposed result.
   * If evaluation is disabled or the result passes, returns immediately.
   * Otherwise, replans targeting gaps and re-executes workers up to maxCycles times.
   */
  private async runEvaluationLoop(
    initialResult: { content: string; tokenUsage?: TokenUsage },
    originalRequest: string,
    allTasks: Task[],
    allResults: Map<string, TaskResult>,
  ): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    const evalConfig = this.config.hive.evaluation;
    if (!evalConfig?.enabled) return initialResult;

    const maxCycles = evalConfig.maxCycles ?? 2;
    const threshold = evalConfig.passingThreshold ?? 0.7;
    const log = getDebugLogger();

    let currentResult = initialResult;
    // Accumulate tasks/results across evaluation cycles
    let accumulatedTasks = [...allTasks];
    let accumulatedResults = new Map(allResults);

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      // Build summaries from all tasks so far
      const taskSummaries = this.buildTaskSummaries(accumulatedTasks, accumulatedResults);

      if (taskSummaries.length === 0) {
        log.debug('Queen', 'Evaluation skipped: no task summaries');
        return currentResult;
      }

      // Evaluate
      this.emitPhaseChange('evaluating', `Evaluating result quality (cycle ${cycle}/${maxCycles})...`);
      this.emitEvent({ type: 'thinking', content: `Evaluating result quality (cycle ${cycle}/${maxCycles})...` });

      const evaluation = await this.evaluateResult(
        originalRequest,
        currentResult.content,
        taskSummaries,
        threshold,
      );

      // Emit evaluation event
      this.emitEvent({
        type: 'evaluation_complete',
        cycleNumber: cycle,
        score: evaluation.score,
        pass: evaluation.pass,
        feedback: evaluation.feedback,
      });

      log.info('Queen', `Evaluation cycle ${cycle}: score=${(evaluation.score * 100).toFixed(0)}%, pass=${evaluation.pass}`, {
        feedback: evaluation.feedback,
        missingAspects: evaluation.missingAspects,
      });

      // If passing, return current result
      if (evaluation.pass) {
        this.emitEvent({ type: 'thinking', content: `Evaluation passed (score: ${(evaluation.score * 100).toFixed(0)}%)` });
        return currentResult;
      }

      // Not passing — replan targeting gaps
      this.emitEvent({ type: 'thinking', content: `Evaluation failed (score: ${(evaluation.score * 100).toFixed(0)}%): ${evaluation.feedback}` });
      this.emitPhaseChange('replanning', `Addressing evaluation gaps (cycle ${cycle})...`);

      const tools = this.mcpServer?.getToolDefinitions();
      const revisedPlan = await this.taskPlanner.evaluationReplan({
        originalRequest,
        priorResult: currentResult.content,
        evaluation,
        cycleNumber: cycle,
        priorTaskSummaries: taskSummaries,
        conversationContext: this.buildConversationContext(),
        toolNames: tools?.map(t => t.name),
        toolDescriptions: tools?.map(t => t.description),
        skillContext: this.currentSkillContext
          ? `Skill: ${this.currentSkillContext.name}\n${this.currentSkillContext.instructions.slice(0, 500)}`
          : undefined,
      });

      // If planner returns direct or empty, we can't improve further
      if (revisedPlan.type !== 'decomposed' || !revisedPlan.tasks || revisedPlan.tasks.length === 0) {
        log.info('Queen', 'Evaluation replanner returned direct/empty — keeping current result');
        return currentResult;
      }

      // Re-ID tasks to avoid collisions
      const newTasks = revisedPlan.tasks.map(t => ({
        ...t,
        id: `eval${cycle}-${t.id}`,
        skillContext: this.currentSkillContext ? {
          name: this.currentSkillContext.name,
          instructions: this.currentSkillContext.instructions,
          resources: this.currentSkillContext.resources,
        } : undefined,
      }));

      // Emit worker spawned events
      for (const task of newTasks) {
        this.emitEvent({ type: 'worker_spawned', workerId: task.id, task });
      }

      this.emitPhaseChange('executing', `Re-executing ${newTasks.length} tasks for evaluation cycle ${cycle}`);

      // Execute new wave
      const newResultsMap = await this.workerPool.executeTasks(newTasks);

      // Emit completion events and accumulate results
      for (const task of newTasks) {
        const result = newResultsMap.get(task.id);
        if (result) {
          accumulatedResults.set(task.id, result);
          task.status = result.success ? 'completed' : 'failed';
          task.result = result;
          this.emitEvent({ type: 'worker_completed', workerId: task.id, result });
        }
      }
      accumulatedTasks = [...accumulatedTasks, ...newTasks];

      // Build final task-result pairs for re-aggregation (all tasks across all waves)
      const allFinalPairs: Array<{ task: Task; result: TaskResult }> = [];
      for (const task of accumulatedTasks) {
        const result = accumulatedResults.get(task.id);
        if (result) allFinalPairs.push({ task, result });
      }

      // Re-aggregate
      currentResult = await this.aggregateResults(originalRequest, allFinalPairs);
    }

    return currentResult;
  }

  /**
   * Get conversation memory
   */
  getMemory(): Memory {
    return this.memory;
  }

  /**
   * Get current tasks
   */
  getCurrentTasks(): Task[] {
    return [...this.currentTasks];
  }

  /**
   * Clear conversation
   */
  clearConversation(): void {
    this.memory.clear();
    this.currentTasks = [];
  }

  /**
   * Shutdown the Queen and its worker pool
   */
  shutdown(): void {
    this.workerPool.shutdown();
  }

  /**
   * Update the queen provider
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
    const planningProvider = isTrackedProvider(provider)
      ? provider.withPurpose('planning')
      : wrapWithTracking(provider, { defaultPurpose: 'planning' });
    this.taskPlanner = new TaskPlanner(planningProvider, {
      adaptiveTimeout: this.config.hive.ralphLoop.adaptiveTimeout,
    });
  }

  /**
   * Update the worker provider
   */
  setWorkerProvider(provider: LLMProvider): void {
    this.workerPool.setProvider(provider);
  }

  /**
   * Get worker pool statistics
   */
  getWorkerStats(): { totalWorkers: number; activeWorkers: number; queuedTasks: number; maxWorkers: number } {
    return this.workerPool.getStats();
  }

  /**
   * Get current worker states
   */
  getWorkerStates(): WorkerState[] {
    return this.workerPool.getWorkerStates();
  }

  /**
   * Emit an event
   */
  private emitEvent(event: AgentEvent): void {
    // Log worker signals for observability
    if (event.type === 'worker_signal') {
      getDebugLogger().info('Queen', `Worker signal [${event.signal.type}] from ${event.signal.taskId}: ${event.signal.payload.slice(0, 200)}`);
    }

    this.eventHandler?.(event);

    // Also emit to global progress tracker
    try {
      getProgressTracker().handleEvent(event);
    } catch {
      // Ignore if tracker not available
    }
  }

  /**
   * Emit a phase change event
   */
  private emitPhaseChange(phase: AgentPhase, description?: string): void {
    this.emitEvent({ type: 'phase_change', phase, description });
  }

  /**
   * Get default system prompt
   */
  private getDefaultSystemPrompt(): string {
    return `You are the Queen agent, the intelligent orchestrator of a hive-style multi-agent system. You have persistent memory of the full conversation.

## Your Role

You analyze user requests, decide whether to handle them directly or decompose them into parallel subtasks for worker agents, and synthesize results into coherent responses.

## When to Handle Directly
- Simple questions, greetings, follow-ups, single-topic requests
- Anything that needs only one tool call or no tools at all

## When to Decompose
- Requests with 2+ distinct information needs requiring different sources
- Multi-part questions about different subjects
- Independent subtasks that benefit from parallel execution

## Decomposition Quality
- Each subtask must be self-contained — workers have no conversation history
- Success criteria must be specific and verifiable (not "good quality" but "includes 3+ data points with sources")
- Right granularity: don't over-decompose or under-decompose

## Result Synthesis
- Write as if one agent answered — never reference "workers" or "tasks"
- Deduplicate overlapping information, resolve contradictions, acknowledge gaps
- Preserve source URLs and references

## Communication Style
Be helpful, concise, and accurate. Match the user's level of formality.`;
  }
}
