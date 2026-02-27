/**
 * Core types for the Personal Agent system
 */

import type { ClassifiedFailure } from './failures.js';

// Tool call/result types for structured provider communication
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider-specific metadata (e.g. Gemini thought_signature) */
  providerMetadata?: Record<string, unknown>;
}

export interface ToolResultEntry {
  toolCallId: string;
  toolName: string;
  result: string;
}

// Message types for conversation
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
  /** Present on assistant messages that requested tool calls */
  toolCalls?: ToolCallInfo[];
  /** Present on user messages that carry tool results */
  toolResults?: ToolResultEntry[];
}

export interface MessageMetadata {
  tokenCount?: number;
  model?: string;
  provider?: string;
  workerId?: string;
  skill?: string;
}

// Skill context for worker tasks
export interface SkillContext {
  name: string;
  instructions: string;
  resources?: Map<string, string>;
}

// Task complexity estimation for adaptive timeout
export type TaskComplexity = 'low' | 'medium' | 'high';

// Task types for hive architecture
export interface Task {
  id: string;
  description: string;
  successCriteria: string;
  dependencies: string[];
  priority: number;
  status: TaskStatus;
  result?: TaskResult;
  skillContext?: SkillContext;
  /** Truncated outputs from completed dependency tasks, keyed by task ID */
  dependencyResults?: Map<string, string>;
  createdAt: Date;
  completedAt?: Date;
  /** Planner-estimated complexity for adaptive timeout */
  estimatedComplexity?: TaskComplexity;
  /** Per-task iteration limit override (from complexity estimate) */
  maxIterationsOverride?: number;
  /** Per-task timeout override in ms (from complexity estimate) */
  timeoutOverride?: number;
  /** Tool effectiveness hints from session history */
  toolEffectivenessHints?: string;
  /** Cross-session strategy hints */
  strategyHints?: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export type FailureExitReason =
  | 'total_tool_failure' | 'hopelessness' | 'stall'
  | 'divergence' | 'timeout' | 'max_iterations'
  | 'cancelled' | 'execution_error' | 'budget_exhausted';

export type ToolErrorCategory =
  | 'auth' | 'quota' | 'network' | 'not_found' | 'timeout' | 'unknown';

export interface TaskResult {
  success: boolean;
  output: string;
  /** Structured key findings extracted from worker output across iterations */
  findings?: string[];
  error?: string;
  iterations?: number;
  tokenUsage?: TokenUsage;
  /** Names of tools that were called during execution */
  toolsUsed?: string[];
  /** Condensed summary of tool outputs from the iteration */
  toolOutputSummary?: string;
  /** Structured list of tool failures (programmatically detected, not LLM-interpreted) */
  toolFailures?: Array<{ tool: string; error: string; category?: ToolErrorCategory }>;
  /** Typed reason for failure — avoids parsing error strings */
  exitReason?: FailureExitReason;
  /** Highest verifier confidence score achieved (0.0–1.0) */
  bestScore?: number;
  /** Structured failure classification (only present when !success) */
  failure?: ClassifiedFailure;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

// Task planning types
export interface TaskPlan {
  type: 'direct' | 'decomposed';
  reasoning: string;
  tasks?: Task[];
  discoveryMode?: boolean;
}

// Replanning context types
export interface CompletedTaskSummary {
  taskId: string;
  description: string;
  success: boolean;
  outputSummary: string;       // truncated ~500 chars
  /** Structured key findings for replanning context */
  findings?: string[];
  exitReason?: FailureExitReason;
  bestScore?: number;
  failedTools?: string[];
  /** Structured failure classification — passed through for partial progress preservation */
  failure?: ClassifiedFailure;
}

export interface ReplanContext {
  originalRequest: string;
  failureReason: string;
  completedTasks: CompletedTaskSummary[];
  failedTasks: CompletedTaskSummary[];
  cancelledTaskIds: string[];
  replanNumber: number;
  conversationContext?: string;
  toolNames?: string[];
  toolDescriptions?: string[];
  skillContext?: string;
}

// Evaluation types for Evaluator-Optimizer outer loop
export interface EvaluationResult {
  pass: boolean;
  score: number;          // 0.0–1.0
  feedback: string;       // Actionable feedback for the replanner when failing
  missingAspects: string[]; // Specific gaps identified (empty if pass)
}

export interface EvaluationReplanContext {
  originalRequest: string;
  priorResult: string;          // The aggregated response from the prior cycle
  evaluation: EvaluationResult;
  cycleNumber: number;
  priorTaskSummaries: CompletedTaskSummary[];
  conversationContext?: string;
  toolNames?: string[];
  toolDescriptions?: string[];
  skillContext?: string;
}

// Verification types for Ralph Loop
export interface Verification {
  complete: boolean;
  feedback?: string;
  confidence: number;
  tokenUsage?: TokenUsage;
}

export interface Verifier {
  check(result: TaskResult): Promise<Verification>;
}

// DCL (Dimensional Convergence Loop) types
export type ConvergenceSignal = 'converging' | 'diverging' | 'stagnating' | 'unknown';

export interface CriterionScore {
  name: string;
  score: number;       // 0.0-1.0
  passed: boolean;     // score >= threshold (default 0.8)
  feedback: string;    // dimension-specific feedback
}

export interface DimensionalVerification extends Verification {
  dimensions?: CriterionScore[];
}

export interface ConvergenceState {
  history: Map<string, number[]>;
  signals: Map<string, ConvergenceSignal>;
  bestIteration: Map<string, { iteration: number; score: number }>;
  overallTrend: ConvergenceSignal;
}

// Worker signal types (worker-to-queen communication)
export interface WorkerSignal {
  workerId: string;
  taskId: string;
  type: 'scope_change' | 'discovery' | 'blocked';
  payload: string;
  timestamp: Date;
}

// Worker types
export interface WorkerState {
  id: string;
  status: 'idle' | 'working' | 'verifying' | 'completed' | 'failed';
  currentTask?: Task;
  iteration: number;
  maxIterations: number;
  startedAt?: Date;
  currentAction?: string;  // e.g., "Searching web...", "Executing tool: fetch_url"
  toolCalls: number;
  llmCalls: number;
}

// Phase types for progress tracking
export type AgentPhase = 'idle' | 'planning' | 'executing' | 'verifying' | 'aggregating' | 'replanning' | 'evaluating' | 'discovering';

// LLM call purpose for tracking
export type LLMCallPurpose = 'planning' | 'execution' | 'verification' | 'tool_followup' | 'aggregation' | 'direct' | 'replanning' | 'evaluation' | 'discovery';

// LLM call event details
export interface LLMCallEvent {
  callId: string;
  provider: string;
  model?: string;
  purpose: LLMCallPurpose;
  status: 'started' | 'completed' | 'failed';
  tokens?: TokenUsage;
  durationMs?: number;
  workerId?: string;
}

// Tool execution event details
export interface ToolExecutionEvent {
  toolName: string;
  arguments?: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  workerId?: string;
  durationMs?: number;
  error?: string;
  resultPreview?: string;
}

// Progressive Discovery types
export interface Finding {
  content: string;
  source: string;
  confidence: number;
  wave: number;
  tags: string[];
}

export interface WaveResult {
  waveNumber: number;
  tasks: Task[];
  results: Map<string, TaskResult>;
  findings: Finding[];
  duration: number;
}

export type WaveDecision =
  | { action: 'continue'; tasks: Task[]; reasoning: string }
  | { action: 'sufficient'; reasoning: string }
  | { action: 'pivot'; tasks: Task[]; reasoning: string; abandonedDirections: string[] };

// Event types for CLI updates
export type AgentEvent =
  | { type: 'message'; message: Message }
  | { type: 'thinking'; content: string }
  | { type: 'worker_spawned'; workerId: string; task: Task }
  | { type: 'worker_progress'; workerId: string; iteration: number; status: string }
  | { type: 'worker_completed'; workerId: string; result: TaskResult }
  | { type: 'worker_state_change'; workerId: string; state: WorkerState }
  | { type: 'task_completed'; task: Task }
  | { type: 'error'; error: string }
  // New granular progress events
  | { type: 'phase_change'; phase: AgentPhase; description?: string }
  | { type: 'step_progress'; workerId: string; step: number; totalSteps: number; description: string }
  | { type: 'tool_execution'; event: ToolExecutionEvent }
  | { type: 'llm_call'; event: LLMCallEvent }
  | { type: 'replan_triggered'; reason: string; replanNumber: number; cancelledTaskIds: string[] }
  | { type: 'evaluation_complete'; cycleNumber: number; score: number; pass: boolean; feedback?: string }
  | { type: 'worker_signal'; signal: WorkerSignal }
  | { type: 'discovery_wave_start'; waveNumber: number; taskCount: number; reasoning: string }
  | { type: 'discovery_wave_complete'; waveNumber: number; newFindings: string[]; totalFindings: number }
  | { type: 'discovery_decision'; waveNumber: number; decision: 'continue' | 'sufficient' | 'pivot'; reasoning: string };

export type AgentEventHandler = (event: AgentEvent) => void;

// Progress state for tracking overall agent progress
export interface ProgressState {
  phase: AgentPhase;
  workers: Map<string, WorkerProgress>;
  llmCalls: LLMCallStats;
  startedAt?: Date;
  lastActivity?: Date;
}

export interface WorkerProgress {
  id: string;
  taskDescription: string;
  status: 'queued' | 'working' | 'verifying' | 'completed' | 'failed';
  iteration: number;
  maxIterations: number;
  currentAction?: string;
  toolCalls: number;
  llmCalls: number;
  startedAt?: Date;
}

export interface LLMCallStats {
  total: number;
  byPurpose: Record<LLMCallPurpose, number>;
  byProvider: Record<string, number>;
  totalTokens: TokenUsage;
}
