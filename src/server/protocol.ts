/**
 * WebSocket protocol types shared between server and web client.
 * Defines the typed message format for client-server communication.
 */

import type { Message, WorkerState } from '../core/types.js';
import type { AgentPhase, MessageMetadata, LLMCallStats, StreamChunk } from '../shared/protocol.types.js';

// ─── Client → Server Messages ───────────────────────────────────────

export type ClientMessage =
  | { type: 'send_message'; id: string; content: string }
  | { type: 'clear_conversation' }
  | { type: 'get_state' }
  | { type: 'ping' };

// ─── Server → Client Messages ───────────────────────────────────────

export type ServerMessage =
  | { type: 'stream_chunk'; messageId: string; chunk: StreamChunk }
  | { type: 'message_complete'; messageId: string; message: SerializedMessage }
  | { type: 'agent_event'; event: SerializedAgentEvent }
  | { type: 'state_snapshot'; state: AppState }
  | { type: 'error'; error: string; messageId?: string }
  | { type: 'pong' };

// ─── Serialized Types (Dates → ISO strings) ─────────────────────────

export interface SerializedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string; // ISO 8601
  metadata?: MessageMetadata;
}

export interface SerializedToolCall {
  toolName: string;
  arguments?: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  durationMs?: number;
  error?: string;
  resultPreview?: string;
  timestamp: string;
}

export interface WorkerLogEntry {
  timestamp: string;
  type: 'iteration_start' | 'tool_call' | 'tool_result' | 'verification' | 'feedback' | 'status';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SerializedWorkerResult {
  success: boolean;
  summary: string;
  error?: string;
  iterations?: number;
  toolsUsed?: string[];
  bestOutput?: string;
  toolErrors?: Array<{ tool: string; error: string }>;
  exitReason?: string;
  bestScore?: number;
}

export interface SerializedWorkerState {
  id: string;
  status: 'idle' | 'working' | 'verifying' | 'completed' | 'failed';
  currentTask?: {
    id: string;
    description: string;
    successCriteria: string;
    priority: number;
    status: string;
  };
  iteration: number;
  maxIterations: number;
  startedAt?: string; // ISO 8601
  currentAction?: string;
  toolCalls: number;
  llmCalls: number;
  result?: SerializedWorkerResult;
  toolHistory?: SerializedToolCall[];
  activityLog?: WorkerLogEntry[];
}

export interface AppState {
  messages: SerializedMessage[];
  workers: SerializedWorkerState[];
  phase: AgentPhase;
  isProcessing: boolean;
  reasoning: string | null;
  llmStats: LLMCallStats | null;
  config: {
    provider: string;
    model: string;
    workerProvider: string;
    workerModel: string;
    maxWorkers: number;
  };
}

// Serialized agent event — mirrors AgentEvent but with serializable dates
export type SerializedAgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'phase_change'; phase: AgentPhase; description?: string }
  | { type: 'worker_spawned'; workerId: string; taskDescription: string }
  | { type: 'worker_completed'; workerId: string; success: boolean; result?: SerializedWorkerResult }
  | { type: 'worker_update'; workers: SerializedWorkerState[] }
  | { type: 'stats_update'; llmStats: LLMCallStats }
  | { type: 'replan_triggered'; reason: string; replanNumber: number; cancelledTaskIds: string[] }
  | { type: 'evaluation_complete'; cycleNumber: number; score: number; pass: boolean; feedback?: string }
  | { type: 'error'; error: string };

// ─── Serialization Helpers ──────────────────────────────────────────

export function serializeMessage(msg: Message): SerializedMessage {
  return {
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    metadata: msg.metadata,
  };
}

export function serializeWorkerState(ws: WorkerState): SerializedWorkerState {
  return {
    id: ws.id,
    status: ws.status,
    currentTask: ws.currentTask
      ? {
          id: ws.currentTask.id,
          description: ws.currentTask.description,
          successCriteria: ws.currentTask.successCriteria,
          priority: ws.currentTask.priority,
          status: ws.currentTask.status,
        }
      : undefined,
    iteration: ws.iteration,
    maxIterations: ws.maxIterations,
    startedAt: ws.startedAt?.toISOString(),
    currentAction: ws.currentAction,
    toolCalls: ws.toolCalls,
    llmCalls: ws.llmCalls,
  };
}
