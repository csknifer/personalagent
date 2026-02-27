/**
 * Ralph Loop Implementation
 *
 * The Ralph Loop pattern enables agents to continuously iterate on tasks
 * until they are objectively complete, rather than stopping when the AI
 * subjectively thinks it's "done."
 *
 * Key principles:
 * - External verification (not AI self-assessment)
 * - Objective completion criteria
 * - Iteration with feedback
 * - Timeout/iteration limits
 */

import type { Message, Task, TaskResult, TokenUsage, AgentEventHandler, ToolExecutionEvent, DimensionalVerification, Verifier } from '../types.js';
import type { LLMProvider, ToolDefinition, ToolCall, TrackedChatOptions } from '../../providers/index.js';
import { TrackedProvider, isTrackedProvider } from '../../providers/index.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import { getProgressTracker } from '../progress/ProgressTracker.js';
import { getDebugLogger } from '../DebugLogger.js';
import type { BudgetGuard } from '../cost/BudgetGuard.js';
import type { CostRegistry } from '../cost/CostRegistry.js';

// Internal imports from split modules
import { DEFAULT_CALL_TIMEOUT, DEFAULT_TOOL_TIMEOUT, truncateToolResult, yieldToEventLoop, callWithTimeout, computeStringSimilarity, classifyToolError, extractFindings, extractScratchpad, extractRetentionMarkers, extractSignals } from './ralphUtils.js';
import type { RalphLoopOptions, RalphLoopContext } from './verifiers.js';
import { UnifiedVerifier } from './verifiers.js';
import type { UnifiedVerificationResult } from './verifiers.js';
import { parseSuccessCriteria, maskObservations, ConvergenceTracker, DimensionalVerifier, generateReflexion, generateDimensionalReflexion } from './dimensional.js';
import { buildIterationPrompt, buildToolSystemPrompt } from './iterationPrompt.js';

// ============================================================
// Barrel re-exports — preserves the public API for all importers
// ============================================================
export { truncateToolResult, computeStringSimilarity, callWithTimeout, classifyToolError, extractFindings } from './ralphUtils.js';
export { UnifiedVerifier, TestBasedVerifier } from './verifiers.js';
export type { UnifiedVerificationResult } from './verifiers.js';
export type { RalphLoopOptions, RalphLoopContext } from './verifiers.js';
export { parseSuccessCriteria, maskObservations, ConvergenceTracker, DimensionalVerifier, generateReflexion, generateDimensionalReflexion } from './dimensional.js';
export { buildIterationPrompt, buildToolSystemPrompt } from './iterationPrompt.js';

/**
 * Execute a task using the Ralph Loop pattern
 */
export async function ralphLoop(
  provider: LLMProvider,
  task: Task,
  options: RalphLoopOptions
): Promise<TaskResult> {
  const {
    maxIterations,
    timeout,
    verifier,
    mcpServer,
    onProgress,
    onEvent,
    workerId,
    callTimeout = DEFAULT_CALL_TIMEOUT,
    toolTimeout = DEFAULT_TOOL_TIMEOUT,
    dimensionalConfig: dclConfig,
    signal,
    budgetGuard,
    costRegistry,
  } = options;

  const startTime = Date.now();
  const context: RalphLoopContext = {
    task,
    iteration: 0,
    previousAttempts: [],
    feedback: [],
    findings: [],
    workerId,
    toolCalls: 0,
    llmCalls: 0,
    consecutiveAllToolFailures: 0,
    // Phase 2: Worker scratchpad & selective retention
    scratchpad: [],
    retainedToolResults: new Map(),
    maxRetainedTokens: dclConfig?.maxRetainedTokens ?? 5000,
  };

  // --- DCL initialization ---
  // DCL features only activate when dimensionalConfig is explicitly provided
  const criteria = dclConfig ? parseSuccessCriteria(task.successCriteria) : [];
  const isMultiCriteria = criteria.length > 1;
  const useDCL = dclConfig?.enabled !== false && isMultiCriteria;
  const useReflexion = !!dclConfig && dclConfig.reflexionEnabled !== false;

  let convergenceTracker: ConvergenceTracker | undefined;
  if (useDCL) {
    convergenceTracker = new ConvergenceTracker({
      stagnationThreshold: dclConfig?.convergenceThreshold,
      stagnationWindow: dclConfig?.stagnationWindow,
    });
  }

  // Set observation masking on context (only when DCL config is present)
  if (dclConfig && dclConfig.observationMasking !== false) {
    context.observationMaskingEnabled = true;
    context.maxMaskedOutputLength = dclConfig.maxMaskedOutputLength;
  }

  const log = getDebugLogger();
  log.debug('RalphLoop', 'Starting', {
    taskId: task.id,
    maxIterations,
    timeout,
    criteria: criteria.length,
    useDCL,
    useReflexion,
    workerId,
  });

  // Tool definitions are fetched fresh each iteration (see below) so that
  // auto-unregistered tools (e.g. web_search after Tavily quota exhaustion)
  // are removed from the LLM's system prompt and stop wasting tool rounds.

  let totalTokens: TokenUsage = { input: 0, output: 0, total: 0 };

  // Wrap provider with tracking if not already wrapped
  const trackedProvider = isTrackedProvider(provider)
    ? provider.withWorkerId(workerId || '')
    : new TrackedProvider(provider, { defaultPurpose: 'execution', workerId });

  // Helper to emit detailed progress
  const emitProgress = (status: string) => {
    onProgress?.(context.iteration, status);

    // Emit to global tracker
    try {
      getProgressTracker().handleEvent({
        type: 'worker_progress',
        workerId: workerId || 'unknown',
        iteration: context.iteration,
        status,
      });
    } catch {
      // Ignore if tracker not available
    }
  };

  while (context.iteration < maxIterations) {
    // Check cancellation signal
    if (signal?.aborted) {
      emitProgress('cancelled');
      return {
        success: false,
        output: context.bestOutput ?? (context.previousAttempts[context.previousAttempts.length - 1] || ''),
        findings: context.findings.length > 0 ? context.findings : undefined,
        error: 'Task cancelled',
        iterations: context.iteration,
        tokenUsage: totalTokens,
        exitReason: 'cancelled',
        bestScore: context.bestScore,
      };
    }

    // Check timeout
    if (Date.now() - startTime > timeout) {
      emitProgress('timeout');
      return {
        success: false,
        output: context.bestOutput ?? (context.previousAttempts[context.previousAttempts.length - 1] || ''),
        findings: context.findings.length > 0 ? context.findings : undefined,
        error: 'Ralph Loop timeout exceeded',
        iterations: context.iteration,
        tokenUsage: totalTokens,
        exitReason: 'timeout',
        bestScore: context.bestScore,
      };
    }

    // Check budget exhaustion
    if (budgetGuard?.isExhausted()) {
      log.warn('RalphLoop', 'Budget exhausted — aborting loop', {
        workerId,
        iteration: context.iteration,
        bestScore: context.bestScore,
      });
      emitProgress('budget exhausted - returning best result');
      return {
        success: false,
        output: context.bestOutput ?? (context.previousAttempts[context.previousAttempts.length - 1] || ''),
        findings: context.findings.length > 0 ? context.findings : undefined,
        error: `Budget exhausted after ${context.iteration} iterations`,
        iterations: context.iteration,
        tokenUsage: totalTokens,
        exitReason: 'budget_exhausted',
        bestScore: context.bestScore,
      };
    }

    // Update budget status on context for iteration prompt
    if (budgetGuard?.isEnabled()) {
      const status = budgetGuard.status();
      context.budgetStatus = { percentUsed: status.percentUsed, remaining: status.remaining };
    }

    context.iteration++;
    log.info('RalphLoop', `--- Iteration ${context.iteration}/${maxIterations} ---`, { workerId, taskId: task.id });
    emitProgress(`executing (iteration ${context.iteration}/${maxIterations})`);

    // Refresh tool definitions each iteration so auto-unregistered tools
    // (e.g. web_search after Tavily quota exhaustion) disappear from the
    // LLM's prompt and stop wasting tool rounds on "Unknown tool" errors.
    const tools = mcpServer?.getToolDefinitions();

    // Execute the task with tools
    const attempt = await executeIterationWithTools(
      trackedProvider,
      context,
      tools,
      mcpServer,
      onProgress,
      onEvent,
      maxIterations,
      callTimeout,
      toolTimeout,
      signal
    );
    // Apply observation masking to compress verbose tool outputs for context efficiency
    const maskedOutput = context.observationMaskingEnabled
      ? maskObservations(
          attempt.output,
          context.maxMaskedOutputLength,
          new Set(context.retainedToolResults.keys()),
        )
      : attempt.output;
    context.previousAttempts.push(maskedOutput);

    // --- Extract and accumulate findings from this iteration (use raw output, not masked) ---
    const iterationFindings = extractFindings(attempt.output);
    for (const finding of iterationFindings) {
      if (!context.findings.includes(finding)) {
        context.findings.push(finding);
      }
    }
    // Cap total findings to prevent unbounded prompt growth
    if (context.findings.length > 30) {
      context.findings = context.findings.slice(-30);
    }

    // --- Extract and accumulate scratchpad entries (working memory) ---
    const scratchpadEntries = extractScratchpad(attempt.output);
    for (const entry of scratchpadEntries) {
      if (!context.scratchpad.includes(entry)) {
        context.scratchpad.push(entry);
      }
    }
    if (context.scratchpad.length > 20) {
      context.scratchpad = context.scratchpad.slice(-20);
    }

    // --- Selective observation retention ---
    const retentionMarkers = extractRetentionMarkers(attempt.output);
    if (retentionMarkers.length > 0 && attempt.toolOutputSummary) {
      // Match markers against tool output summaries from this iteration
      for (const marker of retentionMarkers) {
        // Look for tool outputs that contain the marker ID
        const matchingOutput = attempt.toolOutputSummary
          .split('\n')
          .find(line => line.includes(marker));
        if (matchingOutput) {
          // Budget-aware: check total retained size
          let currentSize = 0;
          for (const val of context.retainedToolResults.values()) {
            currentSize += val.length;
          }
          if (currentSize + matchingOutput.length <= context.maxRetainedTokens * 4) {
            context.retainedToolResults.set(marker, matchingOutput);
          }
        }
      }
    }

    // --- Worker-to-Queen signal extraction ---
    const signals = extractSignals(attempt.output, workerId || '', task.id);
    for (const signal of signals) {
      onEvent?.({ type: 'worker_signal', signal });
    }

    // --- Structural tool failure tracking ---
    context.lastToolFailures = attempt.toolFailures;

    // Track consecutive iterations where ALL tool calls failed
    if (attempt.toolFailures && attempt.toolFailures.length > 0 && attempt.toolsUsed && attempt.toolsUsed.length > 0) {
      // Check if ALL tools that were used also appear in failures
      const failedToolNames = new Set(attempt.toolFailures.map(f => f.tool));
      const allFailed = attempt.toolsUsed.every(t => failedToolNames.has(t));
      if (allFailed) {
        context.consecutiveAllToolFailures++;
      } else {
        context.consecutiveAllToolFailures = 0;
      }
    } else if (!attempt.toolFailures || attempt.toolFailures.length === 0) {
      // No failures this round — reset
      context.consecutiveAllToolFailures = 0;
    }

    // --- Pre-verification short-circuit: total tool failure ---
    // If tools have completely failed for 2+ consecutive iterations, stop immediately.
    // No amount of iteration will fix a broken tool layer — this is infrastructure failure, not strategy failure.
    if (context.consecutiveAllToolFailures >= 2) {
      const failureDetails = attempt.toolFailures!.map(f => `${f.tool}: ${f.error}`).join('; ');
      log.warn('RalphLoop', 'Total tool failure — aborting loop (infrastructure failure, not strategy failure)', {
        workerId,
        iteration: context.iteration,
        consecutiveFailures: context.consecutiveAllToolFailures,
        failedTools: failureDetails.slice(0, 200),
      });
      emitProgress('tools unavailable - aborting');
      return {
        success: false,
        output: context.bestOutput || `Unable to complete task: all tools failed across ${context.consecutiveAllToolFailures} consecutive attempts. Errors: ${failureDetails}`,
        findings: context.findings.length > 0 ? context.findings : undefined,
        error: `Total tool failure: all tool calls failed for ${context.consecutiveAllToolFailures} consecutive iterations`,
        iterations: context.iteration,
        tokenUsage: totalTokens,
        exitReason: 'total_tool_failure',
        bestScore: context.bestScore,
        toolFailures: attempt.toolFailures,
      };
    }

    // --- Stall detection: detect when consecutive attempts are nearly identical ---
    if (context.previousAttempts.length >= 2) {
      const current = context.previousAttempts[context.previousAttempts.length - 1];
      const previous = context.previousAttempts[context.previousAttempts.length - 2];
      const similarity = computeStringSimilarity(current, previous);

      if (similarity > 0.90) {
        context.stallCount = (context.stallCount ?? 0) + 1;
        if (context.stallCount >= 2) {
          // Stalled 2+ times — return best attempt
          log.warn('RalphLoop', 'Stall detected, exiting loop', { similarity, stallCount: context.stallCount, workerId });
          emitProgress('stalled - returning best result');
          return {
            success: false,
            output: context.bestOutput ?? current,
            findings: context.findings.length > 0 ? context.findings : undefined,
            error: 'Loop stalled: repeated similar outputs without progress',
            iterations: context.iteration,
            tokenUsage: totalTokens,
            exitReason: 'stall',
            bestScore: context.bestScore,
          };
        }
        // First stall: flag for prompt change in next iteration
        context.stallDetected = true;
      } else {
        context.stallCount = 0;
        context.stallDetected = false;
      }
    }

    log.debug('RalphLoop', `Iteration ${context.iteration} result`, {
      success: attempt.success,
      outputLength: attempt.output.length,
      outputPreview: attempt.output.slice(0, 300),
      error: attempt.error,
      tokens: attempt.tokenUsage,
    });

    // Update token usage
    if (attempt.tokenUsage) {
      totalTokens.input += attempt.tokenUsage.input;
      totalTokens.output += attempt.tokenUsage.output;
      totalTokens.total += attempt.tokenUsage.total;

      // Record cost on budget guard if both cost tracking components are wired
      if (budgetGuard && costRegistry) {
        const cost = costRegistry.calculateCost(
          trackedProvider.name,
          trackedProvider.model,
          attempt.tokenUsage,
        );
        budgetGuard.recordCost(cost);
      }
    }

    // Skip verification if the execution itself failed — no point asking
    // the verifier to evaluate an error result (a naive verifier could
    // mark it "complete" and the loop would return a failed attempt as success).
    if (!attempt.success) {
      const errorMsg = attempt.error || 'Execution failed';
      let enrichedFeedback = errorMsg;
      if (errorMsg.includes('timed out')) {
        enrichedFeedback += '. Try a simpler approach or break the problem into smaller steps.';
      } else if (errorMsg.includes('Error:') || errorMsg.includes('error')) {
        enrichedFeedback += '. Check tool parameters and try alternative tools or approaches.';
      }
      context.feedback.push(enrichedFeedback);
      emitProgress(`execution error - ${errorMsg.slice(0, 100)} (iteration ${context.iteration}/${maxIterations})`);
      continue;
    }

    // Verify the result
    emitProgress('verifying result...');

    // Use a verification-specific provider wrapper
    const verificationProvider = trackedProvider.withPurpose('verification');

    // Choose verifier: DCL dimensional > custom > default UnifiedVerifier
    let activeVerifier: Verifier;
    let useUnifiedVerifier = false;
    if (useDCL) {
      activeVerifier = new DimensionalVerifier(
        verificationProvider,
        criteria,
        dclConfig?.passingScore,
      );
    } else if (!verifier) {
      activeVerifier = new UnifiedVerifier(verificationProvider, task.description, task.successCriteria);
      useUnifiedVerifier = true;
    } else {
      activeVerifier = verifier;
    }

    context.llmCalls++; // Count verification call
    const verification = await activeVerifier.check(attempt);

    log.info('RalphLoop', `Verification result (iter ${context.iteration}/${maxIterations})`, {
      complete: verification.complete,
      confidence: verification.confidence,
      feedback: verification.feedback?.slice(0, 200),
      tokens: totalTokens,
      workerId,
    });

    // --- Best-output tracking: keep the highest-confidence result ---
    if (verification.confidence > (context.bestScore ?? 0)) {
      context.bestScore = verification.confidence;
      context.bestOutput = attempt.output;
    }

    if (verification.complete) {
      emitProgress(`completed (confidence: ${(verification.confidence * 100).toFixed(0)}%)`);
      return {
        success: true,
        output: attempt.output,
        findings: context.findings.length > 0 ? context.findings : undefined,
        iterations: context.iteration,
        tokenUsage: totalTokens,
        bestScore: verification.confidence,
      };
    }

    // --- Sustained hopelessness exit ---
    const hopelessThreshold = (dclConfig?.passingScore ?? 0.8) * 0.3;
    // Give more iterations when tools are failing — the worker needs time to adapt
    const hopelessMinIter = (context.lastToolFailures?.length ?? 0) > 0 ? 5 : 4;
    if (context.iteration >= hopelessMinIter && (context.bestScore ?? 0) < hopelessThreshold) {
      log.warn('RalphLoop', 'Sustained low quality — task appears unachievable', {
        workerId,
        iteration: context.iteration,
        bestScore: context.bestScore,
        hopelessThreshold,
      });
      emitProgress('quality too low - aborting');
      return {
        success: false,
        output: context.bestOutput ?? attempt.output,
        findings: context.findings.length > 0 ? context.findings : undefined,
        error: `Task not achievable: best score ${((context.bestScore ?? 0) * 100).toFixed(0)}% after ${context.iteration} iterations (need ${((dclConfig?.passingScore ?? 0.8) * 100).toFixed(0)}%)`,
        iterations: context.iteration,
        tokenUsage: totalTokens,
        exitReason: 'hopelessness',
        bestScore: context.bestScore,
      };
    }

    // --- DCL: Record dimensional scores and update context ---
    const dimVerification = verification as DimensionalVerification;
    if (useDCL && convergenceTracker && dimVerification.dimensions) {
      convergenceTracker.record(dimVerification.dimensions);
      context.convergenceState = convergenceTracker.getState();
      context.failingCriteria = convergenceTracker.getFailingCriteria(dclConfig?.passingScore);

      // Early exit on sustained divergence — quality is getting worse
      if (context.convergenceState.overallTrend === 'diverging' && context.iteration >= 3) {
        log.warn('RalphLoop', 'Divergence detected, returning best iteration output', { workerId, iteration: context.iteration });
        emitProgress('diverging - returning best result');
        return {
          success: false,
          output: context.bestOutput ?? attempt.output,
          findings: context.findings.length > 0 ? context.findings : undefined,
          error: 'Stopped: quality diverging across iterations',
          iterations: context.iteration,
          tokenUsage: totalTokens,
          exitReason: 'divergence',
          bestScore: context.bestScore,
        };
      }

      // Build dimensional feedback string
      const dimFeedback = dimVerification.dimensions
        .filter(d => !d.passed)
        .map(d => `[${d.name}] (${d.score.toFixed(2)}): ${d.feedback}`)
        .join('\n');
      context.feedback.push(dimFeedback || verification.feedback || '');

      emitProgress(`incomplete - ${context.failingCriteria.length}/${criteria.length} criteria failing (iteration ${context.iteration}/${maxIterations})`);
    } else {
      // Standard feedback path
      if (verification.feedback) {
        context.feedback.push(verification.feedback);
      }
      emitProgress(`incomplete - ${verification.feedback || 'retrying'} (iteration ${context.iteration}/${maxIterations})`);
    }

    // --- Reflexion: generate strategic guidance after failed verification ---
    // UnifiedVerifier provides nextAction inline (no extra LLM call needed).
    // DCL keeps separate dimensional reflexion (per-criterion guidance is more valuable).
    if (!verification.complete) {
      if (useUnifiedVerifier) {
        // UnifiedVerifier already included nextAction — use it directly
        const unifiedResult = verification as UnifiedVerificationResult;
        if (unifiedResult.nextAction) {
          context.reflexionGuidance = unifiedResult.nextAction;
        }
      } else if (useReflexion) {
        context.llmCalls++;
        if (useDCL && dimVerification.dimensions) {
          context.reflexionGuidance = await generateDimensionalReflexion(
            verificationProvider,
            task,
            attempt.output,
            dimVerification.dimensions,
            context.convergenceState,
          );
        } else {
          context.reflexionGuidance = await generateReflexion(
            verificationProvider,
            task,
            attempt.output,
            verification.feedback || '',
          );
        }
      }
    }
  }

  // Max iterations reached — return best output if available
  const lastOutput = context.previousAttempts[context.previousAttempts.length - 1] || '';
  log.warn('RalphLoop', 'Max iterations reached', {
    iterations: context.iteration,
    tokens: totalTokens,
    workerId,
    hasBestOutput: !!context.bestOutput,
    bestScore: context.bestScore,
    lastFeedback: context.feedback[context.feedback.length - 1]?.slice(0, 200),
  });
  emitProgress('max iterations reached');
  return {
    success: false,
    output: context.bestOutput ?? lastOutput,
    findings: context.findings.length > 0 ? context.findings : undefined,
    error: 'Max iterations reached without completion',
    iterations: context.iteration,
    tokenUsage: totalTokens,
    exitReason: 'max_iterations',
    bestScore: context.bestScore,
  };
}

/**
 * Execute a single iteration of the Ralph Loop with tool support
 */
async function executeIterationWithTools(
  provider: LLMProvider | TrackedProvider,
  context: RalphLoopContext,
  tools: ToolDefinition[] | undefined,
  mcpServer: MCPServer | undefined,
  onProgress?: (iteration: number, status: string) => void,
  onEvent?: AgentEventHandler,
  maxIterations: number = 10,
  callTimeout: number = DEFAULT_CALL_TIMEOUT,
  toolTimeout: number = DEFAULT_TOOL_TIMEOUT,
  signal?: AbortSignal
): Promise<TaskResult> {
  const prompt = buildIterationPrompt(context);

  // Add tool instructions to the prompt if tools are available
  const systemPrompt = tools && tools.length > 0
    ? buildToolSystemPrompt(tools)
    : undefined;

  // Helper to emit tool events
  const emitToolEvent = (event: ToolExecutionEvent) => {
    onEvent?.({ type: 'tool_execution', event });
    try {
      getProgressTracker().handleEvent({ type: 'tool_execution', event });
    } catch {
      // Ignore if tracker not available
    }
  };

  try {
    let messages: Message[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt, timestamp: new Date() });
    }
    messages.push({ role: 'user', content: prompt, timestamp: new Date() });

    onProgress?.(context.iteration, `LLM call (iteration ${context.iteration}/${maxIterations})`);
    context.llmCalls++;

    // Yield to the event loop so the UI can render the progress update above
    await yieldToEventLoop();

    // Initial response with purpose tracking
    const chatOptions: TrackedChatOptions = {
      tools,
      purpose: 'execution',
      workerId: context.workerId,
    };
    const response = await callWithTimeout(
      provider.chat(messages, chatOptions),
      callTimeout,
      `LLM call (iteration ${context.iteration})`,
      signal
    );
    let totalTokens = response.tokenUsage || { input: 0, output: 0, total: 0 };

    // Accumulate ALL meaningful content across tool rounds (not just the last message)
    const contentParts: string[] = [];
    const toolsUsed: string[] = [];
    const toolOutputSummaries: string[] = [];
    const toolFailures: Array<{ tool: string; error: string; category?: import('../types.js').ToolErrorCategory }> = [];
    // Track per-tool success/failure counts to distinguish partial from total failure
    const toolCallCounts = new Map<string, { succeeded: number; failed: number }>();
    if (response.content) contentParts.push(response.content);

    // Handle tool calls with multi-round support (max 5 tool rounds per iteration)
    let currentResponse = response;
    let toolRound = 0;
    const maxToolRounds = 5;

    while (currentResponse.toolCalls && currentResponse.toolCalls.length > 0 && mcpServer && toolRound < maxToolRounds) {
      toolRound++;
      onProgress?.(context.iteration, `tool round ${toolRound}/${maxToolRounds}`);

      // Track tool names used
      for (const tc of currentResponse.toolCalls) {
        if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
      }

      const toolResults = await executeToolCallsWithEvents(
        currentResponse.toolCalls,
        mcpServer,
        onProgress,
        context,
        emitToolEvent,
        toolTimeout,
        signal
      );

      // Collect tool output summaries for the verifier and track per-call success/failure
      for (const tr of toolResults) {
        toolOutputSummaries.push(`[${tr.name}]: ${tr.result}`);
        const counts = toolCallCounts.get(tr.name) || { succeeded: 0, failed: 0 };
        if (tr.result.startsWith('Error:')) {
          counts.failed++;
          toolFailures.push({ tool: tr.name, error: tr.result.slice(0, 200), category: classifyToolError(tr.result) });
        } else {
          counts.succeeded++;
        }
        toolCallCounts.set(tr.name, counts);
      }

      // Build structured follow-up messages with tool call/result metadata
      // so providers can emit the correct API-specific format
      messages = [
        ...messages,
        {
          role: 'assistant' as const,
          content: currentResponse.content || '',
          timestamp: new Date(),
          toolCalls: currentResponse.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            ...(tc.providerMetadata ? { providerMetadata: tc.providerMetadata } : {}),
          })),
        },
        {
          role: 'user' as const,
          content: '',
          timestamp: new Date(),
          toolResults: toolResults.map(tr => ({
            toolCallId: tr.toolCallId,
            toolName: tr.name,
            result: tr.result,
          })),
        },
      ];

      onProgress?.(context.iteration, `LLM follow-up (tool round ${toolRound})`);
      context.llmCalls++;

      // Yield so UI can render progress
      await yieldToEventLoop();

      // Get next response with tool_followup purpose
      const followupOptions: TrackedChatOptions = {
        tools,
        purpose: 'tool_followup',
        workerId: context.workerId,
      };
      currentResponse = await callWithTimeout(
        provider.chat(messages, followupOptions),
        callTimeout,
        `LLM follow-up (tool round ${toolRound})`,
        signal
      );

      // Accumulate content from each round
      if (currentResponse.content) contentParts.push(currentResponse.content);

      if (currentResponse.tokenUsage) {
        totalTokens.input += currentResponse.tokenUsage.input;
        totalTokens.output += currentResponse.tokenUsage.output;
        totalTokens.total += currentResponse.tokenUsage.total;
      }
    }

    // --- Force text summary when tools were used but no text was produced ---
    // Some models (especially Gemini) use tool rounds making tool calls without
    // ever generating a text response. This can happen when:
    // 1. All maxToolRounds are exhausted (model keeps wanting more tools)
    // 2. Model returns empty content + no tool calls mid-way through
    // In either case, make one final LLM call WITHOUT tools to force synthesis.
    const hasTextContent = contentParts.some(p => p.trim().length > 0);
    if (!hasTextContent && toolRound > 0 && messages.length > 1) {
      const log = getDebugLogger();
      log.info('RalphLoop', 'No text output after tool rounds — forcing summary call', {
        workerId: context.workerId,
        toolRounds: toolRound,
      });

      messages.push({
        role: 'user' as const,
        content: 'You have used all available tool rounds. Now provide your complete response based on the tool results above. Synthesize the information into a clear, well-structured answer. Do NOT request any more tool calls.',
        timestamp: new Date(),
      });

      onProgress?.(context.iteration, 'generating summary...');
      context.llmCalls++;

      await yieldToEventLoop();

      // Call WITHOUT tools to prevent further tool-calling
      const summaryOptions: TrackedChatOptions = {
        purpose: 'execution',
        workerId: context.workerId,
      };
      const summaryResponse = await callWithTimeout(
        provider.chat(messages, summaryOptions),
        callTimeout,
        `LLM forced summary (after ${toolRound} tool rounds)`,
        signal
      );

      if (summaryResponse.content) {
        contentParts.push(summaryResponse.content);
      }
      if (summaryResponse.tokenUsage) {
        totalTokens.input += summaryResponse.tokenUsage.input;
        totalTokens.output += summaryResponse.tokenUsage.output;
        totalTokens.total += summaryResponse.tokenUsage.total;
      }
    }

    // Use the last substantial content, or combine all parts if last is too short
    const lastPart = contentParts[contentParts.length - 1] || '';
    const finalOutput = lastPart.length > 100
      ? lastPart
      : contentParts.join('\n\n');

    // Only report tools as "failed" if ALL calls to that tool failed (no successes).
    // Partial failures (e.g. fetch_url to site A fails but site B works) should NOT
    // cause the verifier to reject data from the successful calls.
    const totallyFailedTools = new Set<string>();
    for (const [toolName, counts] of toolCallCounts) {
      if (counts.failed > 0 && counts.succeeded === 0) {
        totallyFailedTools.add(toolName);
      }
    }
    const effectiveFailures = toolFailures.filter(f => totallyFailedTools.has(f.tool));

    return {
      success: true,
      output: finalOutput,
      tokenUsage: totalTokens,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      toolOutputSummary: toolOutputSummaries.length > 0 ? toolOutputSummaries.join('\n') : undefined,
      toolFailures: effectiveFailures.length > 0 ? effectiveFailures : undefined,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onProgress?.(context.iteration, `error: ${err.message}`);
    return {
      success: false,
      output: '',
      error: err.message,
      exitReason: err.message.includes('cancelled') ? 'cancelled' : 'execution_error',
    };
  }
}

/**
 * Execute tool calls in parallel with event emission and per-tool timeout.
 */
async function executeToolCallsWithEvents(
  toolCalls: ToolCall[],
  mcpServer: MCPServer,
  onProgress: ((iteration: number, status: string) => void) | undefined,
  context: RalphLoopContext,
  emitToolEvent: (event: ToolExecutionEvent) => void,
  toolTimeout: number = DEFAULT_TOOL_TIMEOUT,
  signal?: AbortSignal
): Promise<Array<{ toolCallId: string; name: string; result: string }>> {
  onProgress?.(context.iteration, `executing ${toolCalls.length} tool(s)`);

  const executeOne = async (toolCall: ToolCall): Promise<{ toolCallId: string; name: string; result: string }> => {
    const startTime = Date.now();

    // Emit tool start event
    emitToolEvent({
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      status: 'started',
      workerId: context.workerId,
    });

    const toolLog = getDebugLogger();
    const argsPreview = Object.entries(toolCall.arguments).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(', ');
    toolLog.debug('RalphLoop', `Tool call: ${toolCall.name}(${argsPreview})`, { workerId: context.workerId });

    try {
      const result = await callWithTimeout(
        mcpServer.executeToolCall(toolCall),
        toolTimeout,
        `Tool: ${toolCall.name}`,
        signal
      );
      const durationMs = Date.now() - startTime;

      const resultStr = result.success
        ? truncateToolResult(JSON.stringify(result.data, null, 2))
        : result.data
          ? `Error: ${result.error || 'command failed'}\n${truncateToolResult(JSON.stringify(result.data, null, 2))}`
          : `Error: ${result.error || 'unknown error'}`;
      context.toolCalls++;

      toolLog.debug('RalphLoop', `Tool result: ${toolCall.name} → ${result.success ? 'OK' : 'FAIL'} (${durationMs}ms)`, {
        workerId: context.workerId,
        resultPreview: resultStr.slice(0, 200),
      });

      // Emit tool complete event
      emitToolEvent({
        toolName: toolCall.name,
        arguments: toolCall.arguments,
        status: result.success ? 'completed' : 'failed',
        workerId: context.workerId,
        durationMs,
        error: result.success ? undefined : result.error,
        resultPreview: resultStr.slice(0, 500),
      });

      return { toolCallId: toolCall.id, name: toolCall.name, result: resultStr };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const durationMs = Date.now() - startTime;

      toolLog.warn('RalphLoop', `Tool exception: ${toolCall.name} threw after ${durationMs}ms`, {
        workerId: context.workerId,
        error: err.message,
      });

      // Emit tool failed event
      emitToolEvent({
        toolName: toolCall.name,
        arguments: toolCall.arguments,
        status: 'failed',
        workerId: context.workerId,
        durationMs,
        error: err.message,
      });

      return { toolCallId: toolCall.id, name: toolCall.name, result: `Error: ${err.message}` };
    }
  };

  // Execute all tool calls in parallel
  const settled = await Promise.allSettled(toolCalls.map(executeOne));
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { toolCallId: toolCalls[i].id, name: toolCalls[i].name, result: `Error: ${(s as PromiseRejectedResult).reason}` }
  );
}

/**
 * Create a simple Ralph Loop runner for a task
 */
export function createRalphLoopRunner(
  provider: LLMProvider,
  options: Partial<RalphLoopOptions> = {}
) {
  const defaultOptions: RalphLoopOptions = {
    maxIterations: options.maxIterations ?? 10,
    timeout: options.timeout ?? 300000, // 5 minutes
    verifier: options.verifier,
    mcpServer: options.mcpServer,
    onProgress: options.onProgress,
    onEvent: options.onEvent,
    workerId: options.workerId,
    callTimeout: options.callTimeout,
    dimensionalConfig: options.dimensionalConfig,
    budgetGuard: options.budgetGuard,
    costRegistry: options.costRegistry,
  };

  return async (task: Task): Promise<TaskResult> => {
    return ralphLoop(provider, task, defaultOptions);
  };
}
