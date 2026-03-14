/**
 * Queen Agent - The orchestrator of the hive
 */

import { Memory } from './Memory.js';
import { WorkerPool, createWorkerPool } from '../worker/WorkerPool.js';
import type { Message, Task, TokenUsage, AgentEvent, AgentEventHandler, WorkerState, AgentPhase } from '../types.js';
import { ToolEffectivenessTracker } from './ToolEffectivenessTracker.js';
import { StrategyStore } from './StrategyStore.js';
import { DiscoveryCoordinator } from './DiscoveryCoordinator.js';
import { DelegateTasksHandler } from './DelegateTasksHandler.js';
import type { DelegateTasksInput } from './DelegateTasksHandler.js';
import type { LLMProvider, ToolDefinition, ToolCall, TrackedChatOptions, StreamChunk } from '../../providers/index.js';
import { isTrackedProvider, wrapWithTracking } from '../../providers/index.js';
import type { ResolvedConfig } from '../../config/types.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { SkillLoader } from '../../skills/SkillLoader.js';
import { getProgressTracker } from '../progress/ProgressTracker.js';
import { estimateTokenCount, formatErrorMessage } from '../utils.js';
import { getDebugLogger } from '../DebugLogger.js';
import { truncateToolResult, callWithTimeout } from '../worker/RalphLoop.js';

const STREAM_TIMEOUT_MS = 60_000; // 60s per-chunk timeout for streaming

/**
 * Internal tool definition for delegate_tasks — included in LLM tool list
 * alongside MCP tools, but intercepted in executeToolCalls() before MCP dispatch.
 */
const DELEGATE_TASKS_TOOL: ToolDefinition = {
  name: 'delegate_tasks',
  description: 'Spawn parallel worker agents to execute tasks concurrently. Each worker iterates with external verification until objectively complete. Use when you need to research multiple topics, investigate from different angles, or do parallel work that benefits from independent verification. Set discoveryMode to true for investigative research that may need multiple follow-up waves.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What the worker should do' },
            successCriteria: { type: 'string', description: 'How to verify the task is complete' },
          },
          required: ['description', 'successCriteria'],
        },
        description: 'Tasks to execute in parallel (1-10)',
        minItems: 1,
        maxItems: 10,
      },
      discoveryMode: {
        type: 'boolean',
        description: 'Run multi-wave progressive discovery with follow-up waves based on findings. Use for deep research on a person, company, or topic.',
      },
      background: {
        type: 'boolean',
        description: 'Execute workers in background. Returns immediately with a delegation ID. Results injected into context when workers complete.',
      },
    },
    required: ['tasks'],
  },
};

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
  try {
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
  } finally {
    // Clean up the underlying iterator (closes HTTP connections, etc.)
    await iterator.return?.();
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
}

export class Queen {
  private provider: LLMProvider;
  private memory: Memory;
  private workerPool: WorkerPool;
  private mcpServer?: MCPServer;
  private skillLoader?: SkillLoader;
  private config: ResolvedConfig;
  private eventHandler?: AgentEventHandler;
  private currentTasks: Task[] = [];
  private currentSkillContext?: { name: string; instructions: string; resources?: Map<string, string> };
  private toolTracker: ToolEffectivenessTracker = new ToolEffectivenessTracker();
  private strategyStore?: StrategyStore;
  private discoveryCoordinator?: DiscoveryCoordinator;
  private delegateHandler!: DelegateTasksHandler;

  constructor(options: QueenOptions) {
    this.provider = options.provider;
    this.mcpServer = options.mcpServer;
    this.skillLoader = options.skillLoader;
    this.config = options.config;
    this.memory = new Memory({
      maxMessages: options.config.hive.memory?.maxMessages,
      maxTokens: options.config.hive.memory?.maxTokens,
    });
    this.eventHandler = options.onEvent;
    this.strategyStore = options.strategyStore;

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
      const discoveryProvider = isTrackedProvider(options.provider)
        ? options.provider.withPurpose('planning')
        : wrapWithTracking(options.provider, { defaultPurpose: 'planning' });
      this.discoveryCoordinator = new DiscoveryCoordinator({
        provider: discoveryProvider,
        workerPool: this.workerPool,
        config: discoveryConfig,
      });
    }

    // Create delegate_tasks handler
    this.delegateHandler = new DelegateTasksHandler({
      workerPool: this.workerPool,
      discoveryCoordinator: this.discoveryCoordinator,
      eventHandler: (event: AgentEvent) => this.emitEvent(event),
    });

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

    // Always enter direct execution — Queen decides dynamically
    // whether to use delegate_tasks tool for parallel work
    const log = getDebugLogger();
    log.debug('Queen', 'Processing request', { userMessage: userMessage.slice(0, 100), memoryMessages: this.memory.getMessageCount(), memoryTokens: this.memory.getTotalTokensUsed() });

    this.emitPhaseChange('executing', 'Processing request...');

    let result: { content: string; tokenUsage?: TokenUsage };

    try {
      result = await this.handleDirectRequest();
    } catch (error) {
      // Ensure phase resets even on unrecoverable errors
      const cleanMessage = formatErrorMessage(error);
      this.emitEvent({ type: 'error', error: cleanMessage });
      result = { content: `Error: ${cleanMessage}` };
    } finally {
      this.emitPhaseChange('idle', 'Request complete');
      this.currentSkillContext = undefined;
    }

    // Add assistant response to memory with token count
    log.info('Queen', 'Request complete', { tokenUsage: result.tokenUsage, responseLength: result.content.length });
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
   * Load skill context for the current message if a skill matches
   */
  private async loadSkillContext(userMessage: string): Promise<void> {
    if (!this.skillLoader) return;

    const matchedSkill = this.skillLoader.matchSkills(userMessage)?.[0];
    if (!matchedSkill) return;

    try {
      const loadedSkill = await this.skillLoader.loadSkill(matchedSkill.id);
      if (loadedSkill?.content) {
        this.currentSkillContext = {
          name: loadedSkill.metadata.name,
          instructions: loadedSkill.content,
          resources: loadedSkill.resources,
        };

        this.emitEvent({ 
          type: 'thinking', 
          content: `Using ${loadedSkill.metadata.name} skill for guidance...` 
        });
      }
    } catch {
      // Continue without skill context if loading fails
      this.currentSkillContext = undefined;
    }
  }

  /**
   * Handle a simple request directly with MCP tool support and skill context
   */
  private async handleDirectRequest(): Promise<{ content: string; tokenUsage?: TokenUsage }> {
    const mcpTools = this.mcpServer?.getToolDefinitions() ?? [];
    const tools = [...mcpTools, DELEGATE_TASKS_TOOL];
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
    maxToolRounds: number = 10,
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
      // Inject completed background delegation results before each LLM call
      const bgResults = this.delegateHandler.collectCompletedResults();
      if (bgResults.length > 0) {
        const bgMessage: Message = {
          role: 'user' as const,
          content: bgResults.join('\n\n'),
          timestamp: new Date(),
        };
        currentMessages = [...currentMessages, bgMessage];
      }

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

      finalOutput += response.content;

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

      // No tool calls — we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // No MCP server and no delegate_tasks calls — we're done
      const hasDelegateTasks = response.toolCalls.some(tc => tc.name === 'delegate_tasks');
      if (!this.mcpServer && !hasDelegateTasks) {
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

    // Wait for pending background delegations before returning final response
    if (this.delegateHandler.hasPendingDelegations) {
      const maxWaitMs = 300_000; // 5 minutes max
      const start = Date.now();
      while (this.delegateHandler.hasPendingDelegations && Date.now() - start < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const finalBgResults = this.delegateHandler.collectCompletedResults();
      if (finalBgResults.length > 0) {
        // Make one more LLM call to incorporate background results
        const bgMessage: Message = {
          role: 'user' as const,
          content: finalBgResults.join('\n\n'),
          timestamp: new Date(),
        };
        currentMessages = [...currentMessages, bgMessage];
        const response = await callWithTimeout(
          trackedProvider.withPurpose('tool_followup').chat(currentMessages, { tools, purpose: 'tool_followup' }),
          STREAM_TIMEOUT_MS,
          'LLM call',
        );
        finalOutput = response.content; // Replace with synthesized version incorporating background results
      }
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
    if (!this.mcpServer && !toolCalls.some(tc => tc.name === 'delegate_tasks')) return [];

    const mcpServer = this.mcpServer;
    const settled = await Promise.allSettled(
      toolCalls.map(async (toolCall) => {
        try {
          // Intercept delegate_tasks — Queen-internal tool
          if (toolCall.name === 'delegate_tasks') {
            const input = toolCall.arguments as unknown as DelegateTasksInput;
            const result = await this.delegateHandler.execute(input, {
              skillContext: this.currentSkillContext ? {
                name: this.currentSkillContext.name,
                instructions: this.currentSkillContext.instructions,
                resources: this.currentSkillContext.resources,
              } : undefined,
              toolEffectivenessHints: (desc: string) => {
                const pattern = this.toolTracker.classifyTaskPattern(desc);
                return this.toolTracker.getHints(pattern) ?? undefined;
              },
              strategyHints: this.strategyStore ? (desc: string) => {
                const pattern = this.toolTracker.classifyTaskPattern(desc);
                return this.strategyStore!.buildStrategyHints(pattern) ?? undefined;
              } : undefined,
            });
            return { toolCallId: toolCall.id, name: toolCall.name, result };
          }

          if (!mcpServer) {
            return { toolCallId: toolCall.id, name: toolCall.name, result: 'Error: No MCP server available' };
          }
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
   * Stream a message response as an async generator of StreamChunks.
   * Streams via provider.chatStream() with tool support including delegate_tasks.
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

    // Snapshot message count so we can roll back streaming tool messages on fallback
    const messageCountAfterUser = this.memory.getMessageCount();
    let fullResponse = '';

    try {
      // Check for matching skills and load context
      await this.loadSkillContext(userMessage);

      // Always enter streaming direct execution — Queen decides dynamically
      // whether to use delegate_tasks tool for parallel work
      this.emitPhaseChange('executing', 'Streaming response...');

      const mcpTools = this.mcpServer?.getToolDefinitions() ?? [];
      const tools = [...mcpTools, DELEGATE_TASKS_TOOL];
      const messages = this.prepareDirectMessages(this.memory.getContextMessages(), tools);

      const trackedProvider = isTrackedProvider(this.provider)
        ? this.provider.withPurpose('direct')
        : wrapWithTracking(this.provider, { defaultPurpose: 'direct' });

      // Stream with end-to-end tool support
      let currentMessages = [...messages];
      let allStreamedText = ''; // Accumulates text across all tool rounds
      let toolRound = 0;
      const maxToolRounds = 10;
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
        const hasDelegateTasksCalls = pendingToolCalls.some(tc => tc.name === 'delegate_tasks');
        if (pendingToolCalls.length === 0 || (!this.mcpServer && !hasDelegateTasksCalls)) {
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

        // Track total accumulated text across all rounds for the final memory entry.
        // Reset the per-round buffer so the next streaming round starts fresh,
        // but preserve the full text for the final assistant message.
        allStreamedText += fullResponse;
        fullResponse = '';
        currentMessages = [...currentMessages, assistantToolMsg, userToolResultMsg];
      }

      // Combine all streamed text across rounds
      fullResponse = allStreamedText + fullResponse;

      // Fallback: if no text was produced at all, use non-streaming path
      if (!fullResponse.trim()) {
        // Roll back any tool interaction messages added during the failed streaming attempt
        // to prevent duplicate/incoherent messages when the fallback adds its own
        this.memory.truncateTo(messageCountAfterUser);
        this.emitEvent({ type: 'thinking', content: 'Finalizing response...' });
        const fallbackResult = await this.handleDirectRequest();
        fullResponse = fallbackResult.content;
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
    return `You are the Queen agent, the intelligent orchestrator of a multi-agent system. You have access to tools for searching, reading files, fetching URLs, and executing commands. You also have a delegate_tasks tool for spawning parallel worker agents.

## How to Work

1. **Start with your own tools** — do a quick search, read a file, or fetch a URL to understand the request.
2. **Delegate when parallelism helps** — use delegate_tasks to spawn workers for independent research threads, multi-angle investigations, or any work that benefits from parallel execution with verification.
3. **Synthesize results** — after workers complete, combine their findings into a unified response.

## When to Use delegate_tasks

USE delegate_tasks WHEN:
- Researching a person, company, or topic from multiple angles
- The user asks for "deep research", "investigate", "full profile", or "comprehensive analysis"
- You need information from 2+ independent sources or search strategies
- Tasks are independent and benefit from parallel execution
- Set discoveryMode to true for investigative research that may need multiple follow-up waves

HANDLE DIRECTLY (without delegate_tasks) WHEN:
- Simple questions, greetings, follow-ups, or conversational responses
- A single tool call is sufficient (one search, one file read, one URL fetch)
- You already have the answer from conversation context
- The user is asking about something you just retrieved

You can gather initial context with your own tools first, then delegate deeper work. For example: do a quick search to understand the landscape, then delegate specific research threads to workers.

Use background: true when you want to continue working while workers execute. Background results will be provided when workers complete.

## Delegation Quality

Each worker task must be independently completable with NO conversation history:
- **Self-contained descriptions**: Include all necessary context in the task description itself
- **Specific success criteria**: Not "good quality" but "Includes current data with source; covers at least 3 key metrics"
- **Independent tasks**: Each worker should be able to complete its task without knowing what other workers are doing

## Result Synthesis

When combining worker outputs into a final response:
- **Unified voice**: Never reference "workers", "tasks", or internal implementation — write as if you personally gathered all information
- **Deduplicate**: Include overlapping information once with the best sourcing
- **Resolve contradictions**: Note discrepancies and explain which source is more authoritative
- **Acknowledge gaps**: If any tasks failed, mention what information is missing
- **Preserve sources**: Keep URLs and references from worker outputs

## File Operations

NEVER use write_file unless the user explicitly asks you to create or save a file. Research output, summaries, and reports should always be returned as text in your response — not saved to disk.

## Communication Style

- Write clearly and concisely
- Structure long responses with headers and bullet points
- When presenting research findings, cite sources and note confidence levels
- Never reference internal implementation details (workers, tasks, agents) to the user
- Present results as if you personally gathered all the information
- Prioritize accuracy over completeness — don't fabricate to fill gaps`;
  }
}
