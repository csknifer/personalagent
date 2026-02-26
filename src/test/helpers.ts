/**
 * Shared test helpers
 */

import type { Message, TokenUsage, Task, TaskResult, Verification, Verifier } from '../core/types.js';
import { LLMProvider, ChatOptions, ChatResponse, StreamChunk, ToolDefinition, ToolCall } from '../providers/Provider.js';
import { LLMCallLogger } from '../core/progress/LLMCallLogger.js';
import { ProgressTracker } from '../core/progress/ProgressTracker.js';
import type { ResolvedConfig } from '../config/types.js';

/**
 * MockProvider - Configurable mock LLM provider for testing
 */
export class MockProvider extends LLMProvider {
  readonly name: string;
  readonly model: string;

  /** Configurable responses - shifted off in order */
  responses: string[];
  /** Default response when responses array is empty */
  defaultResponse: string;
  /** Default token usage returned */
  defaultTokenUsage: TokenUsage;
  /** Track all chat calls */
  chatCalls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  /** Track all complete calls */
  completeCalls: Array<{ prompt: string; options?: ChatOptions }> = [];
  /** Optional tool calls to return (static — same for every call) */
  toolCallsToReturn?: ChatResponse['toolCalls'];
  /** Queue of tool calls — shifted off per chat() call. Takes priority over toolCallsToReturn. */
  toolCallsQueue: Array<ChatResponse['toolCalls']>;
  /** Whether this provider supports tools */
  private _supportsTools: boolean;
  /** Available models */
  private _availableModels: string[];
  /** If set, chat() will throw this error */
  errorToThrow?: Error;
  /** Optional delay in ms before chat() resolves (useful for cancellation tests) */
  chatDelay?: number;

  constructor(options: {
    name?: string;
    model?: string;
    responses?: string[];
    defaultResponse?: string;
    defaultTokenUsage?: TokenUsage;
    supportsTools?: boolean;
    availableModels?: string[];
    chatDelay?: number;
  } = {}) {
    super();
    this.name = options.name ?? 'mock';
    this.model = options.model ?? 'mock-model';
    this.responses = options.responses ?? [];
    this.defaultResponse = options.defaultResponse ?? 'Mock response';
    this.defaultTokenUsage = options.defaultTokenUsage ?? { input: 10, output: 20, total: 30 };
    this._supportsTools = options.supportsTools ?? false;
    this._availableModels = options.availableModels ?? ['mock-model'];
    this.toolCallsQueue = [];
    this.chatDelay = options.chatDelay;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    this.chatCalls.push({ messages, options });

    if (this.chatDelay) {
      await new Promise(r => setTimeout(r, this.chatDelay));
    }

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    const content = this.responses.length > 0
      ? this.responses.shift()!
      : this.defaultResponse;

    // toolCallsQueue takes priority: shift the next entry (undefined = no tools for this call)
    const toolCalls = this.toolCallsQueue.length > 0
      ? this.toolCallsQueue.shift()
      : this.toolCallsToReturn;

    return {
      content,
      tokenUsage: { ...this.defaultTokenUsage },
      toolCalls,
      finishReason: toolCalls ? 'tool_calls' : 'stop',
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await this.chat(messages, options);
    if (response.content) {
      yield { type: 'text', content: response.content };
    }
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield { type: 'tool_call', toolCall: tc };
      }
    }
    yield { type: 'done' };
  }

  supportsTools(): boolean {
    return this._supportsTools;
  }

  getAvailableModels(): string[] {
    return this._availableModels;
  }

  /** Reset call tracking */
  reset(): void {
    this.chatCalls = [];
    this.completeCalls = [];
    this.errorToThrow = undefined;
    this.toolCallsToReturn = undefined;
    this.toolCallsQueue = [];
  }
}

/**
 * Create a fresh LLMCallLogger for test isolation
 */
export function createTestLogger(): LLMCallLogger {
  return new LLMCallLogger();
}

/**
 * Create a fresh ProgressTracker for test isolation
 */
export function createTestProgressTracker(): ProgressTracker {
  return new ProgressTracker();
}

/**
 * AlwaysPassVerifier - Verifier that immediately marks results as complete
 */
export class AlwaysPassVerifier implements Verifier {
  async check(_result: TaskResult): Promise<Verification> {
    return { complete: true, confidence: 1.0 };
  }
}

/**
 * AlwaysFailVerifier - Verifier that always returns incomplete
 */
export class AlwaysFailVerifier implements Verifier {
  async check(_result: TaskResult): Promise<Verification> {
    return { complete: false, confidence: 0, feedback: 'Not done yet' };
  }
}

/**
 * MockMCPServer - Minimal mock for MCP tool execution in tests
 */
export class MockMCPServer {
  toolDefinitions: ToolDefinition[];
  executeResults: Map<string, { success: boolean; data?: unknown; error?: string }>;
  executeCalls: ToolCall[] = [];

  constructor(options: {
    toolDefinitions?: ToolDefinition[];
    defaultResult?: { success: boolean; data?: unknown; error?: string };
  } = {}) {
    this.toolDefinitions = options.toolDefinitions ?? [];
    this.executeResults = new Map();
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefinitions;
  }

  async executeToolCall(toolCall: ToolCall): Promise<{ success: boolean; data?: unknown; error?: string }> {
    this.executeCalls.push(toolCall);
    const result = this.executeResults.get(toolCall.name);
    return result ?? { success: true, data: { result: 'mock tool result' } };
  }
}

/**
 * Create a minimal valid ResolvedConfig for testing
 */
export function createMockConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    activeProvider: 'mock',
    activeModel: 'mock-model',
    apiKeys: {},
    providers: {
      default: 'mock',
      mock: { model: 'mock-model' },
    },
    hive: {
      queen: { provider: null, model: null, systemPrompt: null },
      worker: { provider: null, model: null, maxConcurrent: 4, timeout: 30000 },
      ralphLoop: { maxIterations: 3, verificationStrategy: 'auto' as const, dimensional: { enabled: true, convergenceThreshold: 0.05, passingScore: 0.8, stagnationWindow: 2, observationMasking: true, maxMaskedOutputLength: 200, reflexionEnabled: true } },
      memory: { maxMessages: 100, maxTokens: 100000 },
    },
    prompts: {},
    skills: { enabled: false, paths: [], autoDiscover: false },
    mcp: { enabled: false, tools: { fileSystem: false, webSearch: false, codeExecution: false, shellExecution: { enabled: false, defaultTimeout: 30000, maxTimeout: 300000, blockedPatterns: [], maxOutputLength: 50000 } }, sandbox: false, allowedRoots: [], servers: [], expose: { enabled: false, stdio: { enabled: true }, http: { enabled: true, path: '/mcp' } } },
    cli: { theme: 'auto', showWorkerStatus: false, verboseWorkerStatus: false, streamResponses: false, historyFile: '', maxHistorySize: 100 },
    server: { port: 3100, host: 'localhost', cors: true, eventThrottleMs: 250 },
    logging: { level: 'error', file: '', includeTokenUsage: false },
    ...overrides,
  };
}

/**
 * Create a Task with sensible defaults for testing
 */
export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Test task',
    successCriteria: 'Task completes successfully',
    dependencies: [],
    priority: 1,
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}
