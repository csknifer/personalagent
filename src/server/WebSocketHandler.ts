/**
 * WebSocket connection handler that bridges a browser client to a Queen instance.
 * Handles streaming, event throttling, and state synchronization.
 */

import type { WebSocket } from 'ws';
import { Queen } from '../core/queen/Queen.js';
import { formatErrorMessage } from '../core/utils.js';
import { getProgressTracker } from '../core/progress/ProgressTracker.js';
import type { BootstrapResult } from '../bootstrap.js';
import type {
  AgentEvent,
  WorkerState,
  AgentPhase,
  LLMCallStats,
  Message,
} from '../core/types.js';
import type {
  ClientMessage,
  ServerMessage,
  SerializedWorkerState,
  SerializedWorkerResult,
  SerializedToolCall,
  WorkerLogEntry,
  AppState,
} from './protocol.js';
import {
  serializeMessage,
  serializeWorkerState,
} from './protocol.js';

export class WebSocketHandler {
  private queen: Queen;
  private ws: WebSocket;
  private bootstrap: BootstrapResult;
  private sessionId: string;

  // State tracking
  private messages: Message[] = [];
  private workers: WorkerState[] = [];
  private phase: AgentPhase = 'idle';
  private reasoning: string | null = null;
  private isProcessing = false;
  private llmStats: LLMCallStats | null = null;
  private ownsHistory = false;

  // Worker result tracking (persisted across worker snapshots)
  private workerResults: Map<string, SerializedWorkerResult> = new Map();
  // Tool call history per worker (keyed by workerId)
  private workerToolHistory: Map<string, SerializedToolCall[]> = new Map();
  // Activity log per worker (keyed by workerId)
  private workerActivityLogs: Map<string, WorkerLogEntry[]> = new Map();

  // Throttling for high-frequency events
  private throttleMs: number;
  private pendingWorkers: WorkerState[] | null = null;
  private pendingReasoning: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ws: WebSocket, bootstrap: BootstrapResult) {
    this.ws = ws;
    this.bootstrap = bootstrap;
    this.throttleMs = bootstrap.config.server.eventThrottleMs;
    this.sessionId = crypto.randomUUID();

    this.queen = new Queen({
      provider: bootstrap.queenProvider,
      workerProvider: bootstrap.workerProvider,
      mcpServer: bootstrap.mcpServer,
      config: bootstrap.config,
      skillLoader: bootstrap.skillLoader ?? undefined,
      strategyStore: bootstrap.strategyStore ?? undefined,
      memoryStore: bootstrap.memoryStore ?? undefined,
      onEvent: (event) => this.handleAgentEvent(event),
    });

    // Attach history manager — only the first connection owns history persistence
    if (bootstrap.historyManager) {
      this.ownsHistory = bootstrap.historyManager.attach(this.queen.getMemory());
      if (this.ownsHistory) {
        bootstrap.historyManager.load().then((loaded) => {
          if (loaded) {
            const memory = this.queen.getMemory();
            const restored = memory.getMessages().filter(m => m.role !== 'system');
            if (restored.length > 0) {
              this.messages = restored;
            }
          }
          this.sendStateSnapshot();
        });
      } else {
        // Another connection already owns history — start fresh
        this.sendStateSnapshot();
      }
    } else {
      this.sendStateSnapshot();
    }
  }

  start(): void {
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(msg).catch(err => {
          this.send({ type: 'error', error: formatErrorMessage(err) });
        });
      } catch (err) {
        this.send({ type: 'error', error: 'Invalid message format' });
      }
    });

    this.ws.on('close', () => {
      this.cleanup();
    });

    this.ws.on('error', () => {
      this.cleanup();
    });
  }

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'send_message':
        await this.handleSendMessage(msg.id, msg.content);
        break;

      case 'clear_conversation':
        this.queen.clearConversation();
        this.messages = [];
        this.workers = [];
        this.workerResults.clear();
        this.workerToolHistory.clear();
        this.workerActivityLogs.clear();
        this.phase = 'idle';
        this.reasoning = null;
        this.isProcessing = false;
        this.bootstrap.historyManager?.markDirty();
        this.sendStateSnapshot();
        break;

      case 'get_state':
        this.sendStateSnapshot();
        break;

      case 'ping':
        this.send({ type: 'pong' });
        break;
    }
  }

  private async handleSendMessage(messageId: string, content: string): Promise<void> {
    if (this.isProcessing) {
      this.send({ type: 'error', error: 'Already processing a message', messageId });
      return;
    }

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: new Date(),
    };
    this.messages.push(userMessage);
    this.isProcessing = true;
    this.reasoning = null;

    // Notify client of state change
    this.send({
      type: 'agent_event',
      event: { type: 'phase_change', phase: 'executing' },
    });

    try {
      // Always stream for the web UI
      let accumulated = '';

      for await (const chunk of this.queen.streamMessage(content)) {
        if (chunk.type === 'text' && chunk.content) {
          accumulated += chunk.content;
          this.send({ type: 'stream_chunk', messageId, chunk });
        } else if (chunk.type === 'tool_call') {
          this.send({ type: 'stream_chunk', messageId, chunk });
        }
        // 'done' → loop ends
      }

      const response = accumulated.trim() || 'I was unable to generate a response. Please try rephrasing your question.';

      const assistantMessage: Message = {
        role: 'assistant',
        content: response,
        timestamp: new Date(),
        metadata: {
          model: this.bootstrap.queenProvider.model,
          provider: this.bootstrap.queenProvider.name,
        },
      };

      this.messages.push(assistantMessage);

      // Send completion
      this.send({
        type: 'message_complete',
        messageId,
        message: serializeMessage(assistantMessage),
      });

      this.bootstrap.historyManager?.markDirty();

      // Clear completed workers
      this.workers = this.workers.filter(w => w.status === 'working' || w.status === 'verifying');
    } catch (error) {
      const errMsg = formatErrorMessage(error);
      this.send({ type: 'error', error: errMsg, messageId });

      // Add error message to history
      const errorMessage: Message = {
        role: 'assistant',
        content: `Error: ${errMsg}`,
        timestamp: new Date(),
      };
      this.messages.push(errorMessage);
    } finally {
      this.isProcessing = false;
      this.phase = 'idle';
      this.reasoning = null;
      this.flushPending();

      // Refresh stats
      try {
        this.llmStats = getProgressTracker().getLLMCallStats();
      } catch { /* ignore */ }

      this.send({
        type: 'agent_event',
        event: { type: 'phase_change', phase: 'idle' },
      });
    }
  }

  // ─── Agent Event Handling ─────────────────────────────────────────

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        this.reasoning = event.content;
        this.pendingReasoning = event.content;
        this.scheduleFlush();
        break;

      case 'phase_change':
        this.phase = event.phase;
        this.send({
          type: 'agent_event',
          event: { type: 'phase_change', phase: event.phase, description: event.description },
        });
        this.refreshStats();
        break;

      case 'worker_spawned':
        this.workers = [
          ...this.workers.filter(w => w.id !== event.workerId),
          {
            id: event.workerId,
            status: 'working',
            currentTask: event.task,
            iteration: 0,
            maxIterations: 10,
            toolCalls: 0,
            llmCalls: 0,
          },
        ];
        this.pendingWorkers = null; // Reset pending since we just set fresh state
        this.send({
          type: 'agent_event',
          event: {
            type: 'worker_spawned',
            workerId: event.workerId,
            taskDescription: event.task.description,
          },
        });
        this.sendWorkerSnapshot();
        break;

      case 'worker_completed': {
        // Build result for the frontend (no truncation — frontend handles overflow)
        const resultSummary: SerializedWorkerResult = {
          success: event.result.success,
          summary: event.result.success
            ? event.result.output
            : (event.result.error || event.result.output || 'No output'),
          error: event.result.error,
          iterations: event.result.iterations,
          toolsUsed: event.result.toolsUsed,
          bestOutput: !event.result.success && event.result.output
            ? event.result.output
            : undefined,
          toolErrors: event.result.toolFailures,
          exitReason: event.result.exitReason,
          bestScore: event.result.bestScore,
        };

        // Store result for inclusion in worker snapshots
        this.workerResults.set(event.workerId, resultSummary);

        this.workers = this.workers.map(w =>
          w.id === event.workerId
            ? { ...w, status: (event.result.success ? 'completed' : 'failed') as WorkerState['status'] }
            : w
        );
        this.pendingWorkers = null;
        this.send({
          type: 'agent_event',
          event: {
            type: 'worker_completed',
            workerId: event.workerId,
            success: event.result.success,
            result: resultSummary,
          },
        });
        this.sendWorkerSnapshot();
        this.refreshStats();
        break;
      }

      case 'worker_state_change':
        // High-frequency — buffer
        const updated = (this.pendingWorkers ?? this.workers).map(w =>
          w.id === event.workerId ? event.state : w
        );
        this.pendingWorkers = updated;
        this.scheduleFlush();
        break;

      case 'worker_progress': {
        // High-frequency — buffer
        const progUpdated = (this.pendingWorkers ?? this.workers).map(w =>
          w.id === event.workerId
            ? { ...w, iteration: event.iteration, currentAction: event.status }
            : w
        );
        this.pendingWorkers = progUpdated;
        this.scheduleFlush();

        // Push meaningful status changes to activity log
        const status = event.status;
        if (status.startsWith('executing (iteration')) {
          this.pushActivityLog(event.workerId, {
            timestamp: new Date().toISOString(),
            type: 'iteration_start',
            content: status,
            metadata: { iteration: event.iteration },
          });
        } else if (status.startsWith('verifying') || status.startsWith('completed') || status.startsWith('incomplete') || status.startsWith('stalled') || status.startsWith('quality') || status.startsWith('diverging')) {
          this.pushActivityLog(event.workerId, {
            timestamp: new Date().toISOString(),
            type: status.startsWith('verifying') ? 'verification' : status.startsWith('incomplete') ? 'feedback' : 'status',
            content: status,
            metadata: { iteration: event.iteration },
          });
        }
        break;
      }

      case 'tool_execution': {
        const te = event.event;
        const wId = te.workerId;
        if (wId) {
          // Track tool call history
          if (te.status === 'started') {
            const history = this.workerToolHistory.get(wId) || [];
            history.push({
              toolName: te.toolName,
              arguments: te.arguments,
              status: 'started',
              timestamp: new Date().toISOString(),
            });
            // Cap at 50 entries per worker
            if (history.length > 50) history.splice(0, history.length - 50);
            this.workerToolHistory.set(wId, history);

            this.pushActivityLog(wId, {
              timestamp: new Date().toISOString(),
              type: 'tool_call',
              content: `Calling ${te.toolName}`,
              metadata: te.arguments ? { arguments: te.arguments } : undefined,
            });
          } else {
            // Update the last matching entry with completion info
            const history = this.workerToolHistory.get(wId);
            if (history) {
              for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].toolName === te.toolName && history[i].status === 'started') {
                  history[i].status = te.status;
                  history[i].durationMs = te.durationMs;
                  history[i].error = te.error;
                  history[i].resultPreview = te.resultPreview;
                  break;
                }
              }
            }

            this.pushActivityLog(wId, {
              timestamp: new Date().toISOString(),
              type: 'tool_result',
              content: te.status === 'completed'
                ? `${te.toolName} completed (${te.durationMs}ms)`
                : `${te.toolName} failed: ${te.error || 'unknown'}`,
              metadata: { durationMs: te.durationMs, status: te.status },
            });
          }
        }
        break;
      }

      case 'llm_call':
        if (event.event.status === 'completed') {
          this.refreshStats();
        }
        break;

      case 'replan_triggered':
        // Send immediately (not throttled) — important UI event
        this.send({
          type: 'agent_event',
          event: {
            type: 'replan_triggered',
            reason: event.reason,
            replanNumber: event.replanNumber,
            cancelledTaskIds: event.cancelledTaskIds,
          },
        });
        break;

      case 'evaluation_complete':
        // Send immediately (not throttled) — important UI event
        this.send({
          type: 'agent_event',
          event: {
            type: 'evaluation_complete',
            cycleNumber: event.cycleNumber,
            score: event.score,
            pass: event.pass,
            feedback: event.feedback,
          },
        });
        break;

      case 'discovery_wave_start':
        this.send({
          type: 'agent_event',
          event: {
            type: 'discovery_wave',
            waveNumber: event.waveNumber,
            status: 'started',
            taskCount: event.taskCount,
            reasoning: event.reasoning,
          },
        });
        break;

      case 'discovery_wave_complete':
        this.send({
          type: 'agent_event',
          event: {
            type: 'discovery_wave',
            waveNumber: event.waveNumber,
            status: 'completed',
            findings: event.newFindings,
            totalFindings: event.totalFindings,
          },
        });
        break;

      case 'discovery_decision':
        this.send({
          type: 'agent_event',
          event: {
            type: 'discovery_wave',
            waveNumber: event.waveNumber,
            status: 'decision',
            decision: event.decision,
            reasoning: event.reasoning,
          },
        });
        break;

      case 'error':
        this.send({ type: 'agent_event', event: { type: 'error', error: event.error } });
        break;
    }
  }

  // ─── Throttling ───────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPending(), this.throttleMs);
    }
  }

  private flushPending(): void {
    this.flushTimer = null;

    if (this.pendingWorkers !== null) {
      this.workers = this.pendingWorkers;
      this.pendingWorkers = null;
      this.sendWorkerSnapshot();
    }

    if (this.pendingReasoning !== null) {
      this.send({
        type: 'agent_event',
        event: { type: 'thinking', content: this.pendingReasoning },
      });
      this.pendingReasoning = null;
    }
  }

  private sendWorkerSnapshot(): void {
    this.send({
      type: 'agent_event',
      event: {
        type: 'worker_update',
        workers: this.workers.map(w => {
          const serialized = serializeWorkerState(w);
          // Attach stored result if available
          const result = this.workerResults.get(w.id);
          if (result) {
            serialized.result = result;
          }
          // Attach tool history
          const toolHistory = this.workerToolHistory.get(w.id);
          if (toolHistory && toolHistory.length > 0) {
            serialized.toolHistory = toolHistory;
          }
          // Attach activity log
          const activityLog = this.workerActivityLogs.get(w.id);
          if (activityLog && activityLog.length > 0) {
            serialized.activityLog = activityLog;
          }
          return serialized;
        }),
      },
    });
  }

  private pushActivityLog(workerId: string, entry: WorkerLogEntry): void {
    const log = this.workerActivityLogs.get(workerId) || [];
    log.push(entry);
    // Cap at 100 entries per worker
    if (log.length > 100) log.splice(0, log.length - 100);
    this.workerActivityLogs.set(workerId, log);
  }

  private refreshStats(): void {
    try {
      this.llmStats = getProgressTracker().getLLMCallStats();
      this.send({
        type: 'agent_event',
        event: { type: 'stats_update', llmStats: this.llmStats },
      });
    } catch { /* ignore */ }
  }

  // ─── State Snapshot ───────────────────────────────────────────────

  private sendStateSnapshot(): void {
    const config = this.bootstrap.config;
    const state: AppState = {
      messages: this.messages
        .filter(m => m.role !== 'system')
        .map(serializeMessage),
      workers: this.workers.map(serializeWorkerState),
      phase: this.phase,
      isProcessing: this.isProcessing,
      reasoning: this.reasoning,
      llmStats: this.llmStats,
      config: {
        provider: config.hive.queen.provider || config.activeProvider,
        model: config.hive.queen.model || config.activeModel,
        workerProvider: config.hive.worker.provider || config.activeProvider,
        workerModel: config.hive.worker.model || 'default',
        maxWorkers: config.hive.worker.maxConcurrent,
      },
    };

    this.send({ type: 'state_snapshot', state });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private cleanup(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Detach history so a new connection can re-attach its own Memory
    if (this.ownsHistory && this.bootstrap.historyManager) {
      this.bootstrap.historyManager.detach().catch(() => {});
    }
    // Stop in-flight workers to prevent resource leaks after disconnect
    this.queen.shutdown();
  }
}
