/**
 * Custom hook for Queen-based chat with full hive architecture and skill integration
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, WorkerState, AgentEvent, AgentPhase, LLMCallStats } from '../../core/types.js';
import type { LLMProvider } from '../../providers/index.js';
import type { MCPServer } from '../../mcp/MCPServer.js';
import type { ResolvedConfig } from '../../config/types.js';
import type { SkillLoader, Skill } from '../../skills/SkillLoader.js';
import type { SkillTracker } from '../../skills/SkillTracker.js';
import type { HistoryManager } from '../../core/HistoryManager.js';
import type { StrategyStore } from '../../core/queen/StrategyStore.js';
import type { MemoryStore } from '../../core/memory/MemoryStore.js';
import { Queen } from '../../core/queen/Queen.js';
import { getProgressTracker } from '../../core/progress/ProgressTracker.js';
import { getShutdownManager } from '../../core/ShutdownManager.js';

interface UseQueenOptions {
  queenProvider: LLMProvider;
  workerProvider: LLMProvider;
  mcpServer: MCPServer;
  config: ResolvedConfig;
  skillLoader?: SkillLoader;
  skillTracker?: SkillTracker;
  historyManager?: HistoryManager;
  strategyStore?: StrategyStore;
  memoryStore?: MemoryStore;
  onError?: (error: Error) => void;
  onWorkerStateChange?: (workerId: string, state: WorkerState) => void;
}

interface UseQueenReturn {
  messages: Message[];
  isLoading: boolean;
  streamingContent: string;
  workers: WorkerState[];
  reasoning: string | null;
  phase: AgentPhase;
  llmStats: LLMCallStats | null;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  getWorkerStats: () => { totalWorkers: number; activeWorkers: number; queuedTasks: number; maxWorkers: number };
}

export function useQueen({
  queenProvider,
  workerProvider,
  mcpServer,
  config,
  skillLoader,
  skillTracker,
  historyManager,
  strategyStore,
  memoryStore,
  onError,
  onWorkerStateChange,
}: UseQueenOptions): UseQueenReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [workers, setWorkers] = useState<WorkerState[]>([]);
  const workersRef = useRef<WorkerState[]>(workers);
  workersRef.current = workers;
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [llmStats, setLlmStats] = useState<LLMCallStats | null>(null);
  
  // Create Queen instance
  const queenRef = useRef<Queen | null>(null);
  
  useEffect(() => {
    const queen = new Queen({
      provider: queenProvider,
      workerProvider,
      mcpServer,
      config,
      skillLoader,
      strategyStore,
      memoryStore,
      onEvent: handleAgentEvent,
    });
    queenRef.current = queen;

    // Register Queen cleanup with ShutdownManager
    getShutdownManager().register('queen', () => queen.shutdown(), 5);

    // Attach history manager and load persisted history
    if (historyManager) {
      historyManager.attach(queen.getMemory());
      historyManager.load().then((loaded) => {
        if (loaded) {
          // Sync loaded messages into React state
          const memory = queen.getMemory();
          const restored = memory.getMessages().filter(m => m.role !== 'system');
          if (restored.length > 0) {
            setMessages(restored);
            return; // Skip system-prompt-only init below
          }
        }
        // Default: initialize with system message if present
        const systemPrompt = config.prompts.queen?.system;
        if (systemPrompt) {
          setMessages([{
            role: 'system',
            content: systemPrompt,
            timestamp: new Date(),
          }]);
        }
      });
    } else {
      // No history manager — initialize with system message if present
      const systemPrompt = config.prompts.queen?.system;
      if (systemPrompt) {
        setMessages([{
          role: 'system',
          content: systemPrompt,
          timestamp: new Date(),
        }]);
      }
    }

    // Cleanup: shut down old Queen and unregister from ShutdownManager
    return () => {
      queen.shutdown();
      getShutdownManager().unregister('queen');
    };
  }, [queenProvider, workerProvider, mcpServer, config, skillLoader, historyManager, strategyStore, memoryStore]);

  // --- Throttled event handling ---
  // Buffer high-frequency updates and flush to React state at most every 250ms
  // to prevent layout thrashing from rapid re-renders.
  const pendingReasoningRef = useRef<string | null>(null);
  const pendingWorkersRef = useRef<WorkerState[] | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingUpdates = useCallback(() => {
    flushTimerRef.current = null;
    if (pendingReasoningRef.current !== null) {
      setReasoning(pendingReasoningRef.current);
      pendingReasoningRef.current = null;
    }
    if (pendingWorkersRef.current !== null) {
      setWorkers(pendingWorkersRef.current);
      pendingWorkersRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushPendingUpdates, 250);
    }
  }, [flushPendingUpdates]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  // Helper: apply a worker update to the pending buffer (or current state)
  // Uses workersRef to always read the latest state, avoiding stale closure issues
  // when the Queen holds an old handleAgentEvent reference.
  const bufferWorkerUpdate = useCallback(
    (updater: (prev: WorkerState[]) => WorkerState[]) => {
      pendingWorkersRef.current = updater(pendingWorkersRef.current ?? workersRef.current);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'message':
        // Messages are handled separately via processMessage return
        break;

      case 'thinking':
        // Buffer reasoning — will flush on next tick
        pendingReasoningRef.current = event.content;
        scheduleFlush();
        break;

      case 'phase_change':
        // Phase changes are low-frequency and important — apply immediately
        setPhase(event.phase);
        try {
          const stats = getProgressTracker().getLLMCallStats();
          setLlmStats(stats);
        } catch {
          // Ignore if tracker not available
        }
        break;

      case 'worker_spawned':
        // Worker spawn is important — apply immediately
        setWorkers(prev => [
          ...prev.filter(w => w.id !== event.workerId),
          {
            id: event.workerId,
            status: 'working',
            currentTask: event.task,
            iteration: 0,
            maxIterations: 10,
            toolCalls: 0,
            llmCalls: 0,
          },
        ]);
        // Reset pending buffer since we just set fresh state
        pendingWorkersRef.current = null;
        break;

      case 'worker_completed':
        // Completion is important — apply immediately
        setWorkers(prev =>
          prev.map(w =>
            w.id === event.workerId
              ? { ...w, status: event.result?.success === false ? 'failed' as const : 'completed' as const }
              : w
          )
        );
        pendingWorkersRef.current = null;
        try {
          const stats = getProgressTracker().getLLMCallStats();
          setLlmStats(stats);
        } catch {
          // Ignore if tracker not available
        }
        break;

      case 'worker_state_change':
        // High-frequency — buffer
        bufferWorkerUpdate(prev =>
          prev.map(w => (w.id === event.workerId ? event.state : w))
        );
        onWorkerStateChange?.(event.workerId, event.state);
        break;

      case 'worker_progress':
        // High-frequency — buffer
        bufferWorkerUpdate(prev =>
          prev.map(w =>
            w.id === event.workerId
              ? { ...w, iteration: event.iteration, currentAction: event.status }
              : w
          )
        );
        break;

      case 'llm_call':
        // Only update stats on completion (low-frequency)
        if (event.event.status === 'completed') {
          try {
            const stats = getProgressTracker().getLLMCallStats();
            setLlmStats(stats);
          } catch {
            // Ignore if tracker not available
          }
        }
        break;

      case 'error':
        onError?.(new Error(event.error));
        break;
    }
  }, [onError, onWorkerStateChange, scheduleFlush, bufferWorkerUpdate]);

  const sendMessage = useCallback(async (content: string) => {
    if (!queenRef.current) return;

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setStreamingContent('');
    setReasoning(null);

    const startTime = Date.now();

    try {
      let response: string;
      let skillUsed: { id: string; name: string; success: boolean } | null = null;

      // Check for matching skills (for UI metadata and tracking only — routing always goes through Queen)
      const matchedSkill = skillLoader?.matchSkills(content)?.[0];

      if (matchedSkill) {
        setReasoning(`Using ${matchedSkill.metadata.name} skill...`);
        skillUsed = { id: matchedSkill.id, name: matchedSkill.metadata.name, success: true };
      } else {
        skillTracker?.recordUnmatchedQuery(content);
      }

      setPhase('executing');

      if (config.cli.streamResponses) {
        // Streaming path: use Queen.streamMessage()
        let accumulated = '';
        for await (const chunk of queenRef.current.streamMessage(content)) {
          if (chunk.type === 'text' && chunk.content) {
            accumulated += chunk.content;
            setStreamingContent(accumulated);
          } else if (chunk.type === 'tool_call' && chunk.toolCall) {
            // Show tool usage inline while streaming
            const toolNote = `\n[Using tool: ${chunk.toolCall.name}...]\n`;
            setStreamingContent(accumulated + toolNote);
          }
        }
        response = accumulated.trim();
      } else {
        // Non-streaming path: use Queen.processMessage()
        response = await queenRef.current.processMessage(content);
      }

      // Track skill usage
      if (skillUsed && skillTracker) {
        const executionTime = Date.now() - startTime;
        skillTracker.recordInvocation(
          skillUsed.id,
          skillUsed.name,
          content,
          skillUsed.success,
          executionTime
        );
      }

      // Clear streaming content now that we have the final response
      setStreamingContent('');

      // Safety net: if response is empty after all processing, show a fallback
      if (!response.trim()) {
        response = 'I was unable to generate a response. Please try rephrasing your question.';
      }

      // Add assistant message
      const assistantMessage: Message = {
        role: 'assistant',
        content: response,
        timestamp: new Date(),
        metadata: {
          model: queenProvider.model,
          provider: queenProvider.name,
          skill: matchedSkill?.metadata.name,
        },
      };

      setMessages(prev => [...prev, assistantMessage]);

      // Mark history dirty after successful response
      historyManager?.markDirty();

      // Clear completed workers (keep working and verifying, matching server behavior)
      setWorkers(prev => prev.filter(w => w.status === 'working' || w.status === 'verifying'));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err.message}`,
        timestamp: new Date(),
      }]);
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      setReasoning(null);
      setPhase('idle');

      // Always refresh llmStats at end of request so the header counter updates
      try {
        const finalStats = getProgressTracker().getLLMCallStats();
        setLlmStats(finalStats);
      } catch {
        // Ignore if tracker not available
      }
    }
  }, [queenProvider, config.cli.streamResponses, skillLoader, skillTracker, historyManager, onError]);

  const clearMessages = useCallback(() => {
    queenRef.current?.clearConversation();
    const systemPrompt = config.prompts.queen?.system;
    setMessages(systemPrompt ? [{
      role: 'system',
      content: systemPrompt,
      timestamp: new Date(),
    }] : []);
    setWorkers([]);

    // Persist the clear immediately
    if (historyManager) {
      historyManager.markDirty();
      historyManager.save();
    }
  }, [config, historyManager]);

  const getWorkerStats = useCallback(() => {
    return queenRef.current?.getWorkerStats() ?? {
      totalWorkers: 0,
      activeWorkers: 0,
      queuedTasks: 0,
      maxWorkers: config.hive.worker.maxConcurrent,
    };
  }, [config]);

  return {
    messages,
    isLoading,
    streamingContent,
    workers,
    reasoning,
    phase,
    llmStats,
    sendMessage,
    clearMessages,
    getWorkerStats,
  };
}
