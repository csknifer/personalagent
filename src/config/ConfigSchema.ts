/**
 * Zod schemas for configuration validation
 */

import { z } from 'zod';

export const ApiKeysSchema = z.object({
  gemini: z.string().optional(),
  openai: z.string().optional(),
  anthropic: z.string().optional(),
  tavily: z.string().optional(),
}).passthrough().default({});

export const ProviderConfigSchema = z.object({
  model: z.string(),
  models: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().positive().optional(),
  baseUrl: z.string().url().optional().nullable(),
  host: z.string().optional(), // For Ollama
  type: z.string().optional(), // Provider type override (e.g., 'openai-compatible')
  apiKey: z.string().optional(), // Per-provider API key
});

export const ProvidersConfigSchema = z.object({
  default: z.string().default('gemini'),
  gemini: ProviderConfigSchema.optional(),
  openai: ProviderConfigSchema.optional(),
  anthropic: ProviderConfigSchema.optional(),
  ollama: ProviderConfigSchema.optional(),
}).passthrough();

export const QueenConfigSchema = z.object({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  aggregationOverlapThreshold: z.number().min(0).max(1).default(0.15).optional(),
});

export const WorkerConfigSchema = z.object({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  maxConcurrent: z.number().int().positive().default(4),
  timeout: z.number().positive().default(300000),
});

export const DimensionalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  convergenceThreshold: z.number().min(0).max(1).default(0.05),
  passingScore: z.number().min(0).max(1).default(0.8),
  stagnationWindow: z.number().int().positive().default(2),
  observationMasking: z.boolean().default(true),
  maxMaskedOutputLength: z.number().int().positive().default(200),
  reflexionEnabled: z.boolean().default(true),
  maxRetainedTokens: z.number().int().positive().default(5000),
});

export const AdaptiveTimeoutTierSchema = z.object({
  maxIterations: z.number().int().positive(),
  timeout: z.number().positive(),
});

export const AdaptiveTimeoutConfigSchema = z.object({
  enabled: z.boolean().default(true),
  low: AdaptiveTimeoutTierSchema.default({ maxIterations: 2, timeout: 60000 }),
  medium: AdaptiveTimeoutTierSchema.default({ maxIterations: 5, timeout: 180000 }),
  high: AdaptiveTimeoutTierSchema.default({ maxIterations: 10, timeout: 300000 }),
});

export const UnifiedVerificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export const RalphLoopConfigSchema = z.object({
  maxIterations: z.number().int().positive().default(10),
  verificationStrategy: z.enum(['auto', 'manual', 'test-based', 'dimensional']).default('auto'),
  dimensional: DimensionalConfigSchema.default({}),
  adaptiveTimeout: AdaptiveTimeoutConfigSchema.default({}),
  unifiedVerification: UnifiedVerificationConfigSchema.default({}),
});

export const MemoryConfigSchema = z.object({
  maxMessages: z.number().int().positive().default(100),
  maxTokens: z.number().int().positive().default(100000),
});

export const ReplanningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxReplans: z.number().int().min(0).max(5).default(1),
});

export const EvaluationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxCycles: z.number().int().min(1).max(5).default(2),
  passingThreshold: z.number().min(0).max(1).default(0.7),
});

export const StrategyStoreConfigSchema = z.object({
  enabled: z.boolean().default(false),
  filePath: z.string().default('~/.personalagent/strategy-store.json'),
  maxAgeDays: z.number().int().positive().default(30),
});

export const ProgressiveDiscoveryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxWaves: z.number().int().min(1).max(10).default(4),
  waveTimeout: z.number().int().positive().default(120000),
  totalTimeout: z.number().int().positive().default(600000),
  stoppingThreshold: z.number().int().min(0).default(2),
});

export const HiveConfigSchema = z.object({
  queen: QueenConfigSchema.default({}),
  worker: WorkerConfigSchema.default({}),
  ralphLoop: RalphLoopConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  replanning: ReplanningConfigSchema.default({}),
  evaluation: EvaluationConfigSchema.default({}),
  strategyStore: StrategyStoreConfigSchema.default({}),
  progressiveDiscovery: ProgressiveDiscoveryConfigSchema.default({}),
});

export const PromptConfigSchema = z.object({
  system: z.string().optional(),
  taskPlanning: z.string().optional(),
});

export const PromptsConfigSchema = z.object({
  queen: PromptConfigSchema.optional(),
  worker: z.object({ system: z.string().optional() }).optional(),
  research: z.object({ system: z.string().optional() }).optional(),
}).default({});

export const SkillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default(['./skills', '~/.personalagent/skills']),
  autoDiscover: z.boolean().default(true),
});

export const ShellExecutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultTimeout: z.number().positive().default(30000),
  maxTimeout: z.number().positive().default(300000),
  blockedPatterns: z.array(z.string()).default([]),
  maxOutputLength: z.number().positive().default(50000),
});

export const MCPToolsConfigSchema = z.object({
  fileSystem: z.boolean().default(true),
  webSearch: z.boolean().default(true),
  codeExecution: z.boolean().default(true),
  shellExecution: ShellExecutionConfigSchema.default({}),
});

export const MCPToolFilterSchema = z.object({
  allowlist: z.array(z.string()).optional(),
  blocklist: z.array(z.string()).optional(),
});

export const MCPExternalServerSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  // stdio fields
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  // http fields
  url: z.string().url().optional(),
  // shared
  enabled: z.boolean().default(true),
  timeout: z.number().positive().default(30000),
  namespace: z.boolean().default(false),
  toolFilter: MCPToolFilterSchema.optional(),
});

/** Ecosystem-standard mcp.json server entry (keyed by name) */
export const MCPJsonServerEntrySchema = z.object({
  type: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().positive().default(30000),
  namespace: z.boolean().default(false),
  toolFilter: MCPToolFilterSchema.optional(),
});

/** Schema for an mcp.json file */
export const MCPJsonFileSchema = z.object({
  mcpServers: z.record(MCPJsonServerEntrySchema).default({}),
});

export const MCPExposeStdioSchema = z.object({
  enabled: z.boolean().default(true),
}).default({});

export const MCPExposeHTTPSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('/mcp'),
}).default({});

export const MCPExposeSchema = z.object({
  enabled: z.boolean().default(false),
  stdio: MCPExposeStdioSchema,
  http: MCPExposeHTTPSchema,
}).default({});

export const MCPConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tools: MCPToolsConfigSchema.default({}),
  sandbox: z.boolean().default(true),
  allowedRoots: z.array(z.string()).default([]),
  servers: z.array(MCPExternalServerSchema).default([]),
  expose: MCPExposeSchema,
});

export const CLIConfigSchema = z.object({
  theme: z.enum(['auto', 'dark', 'light']).default('auto'),
  showWorkerStatus: z.boolean().default(true),
  verboseWorkerStatus: z.boolean().default(false),
  streamResponses: z.boolean().default(true),
  historyFile: z.string().default('~/.personalagent/history.json'),
  maxHistorySize: z.number().int().positive().default(1000),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().default('~/.personalagent/logs/agent.log'),
  includeTokenUsage: z.boolean().default(true),
});

export const ServerConfigSchema = z.object({
  port: z.number().int().positive().default(3100),
  host: z.string().default('localhost'),
  cors: z.boolean().default(true),
  staticDir: z.string().optional(),
  eventThrottleMs: z.number().int().positive().default(250),
});

export const ConfigSchema = z.object({
  apiKeys: ApiKeysSchema.default({}),
  providers: ProvidersConfigSchema,
  hive: HiveConfigSchema.default({}),
  prompts: PromptsConfigSchema.default({}),
  skills: SkillsConfigSchema.default({}),
  mcp: MCPConfigSchema.default({}),
  cli: CLIConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
});

export type ValidatedConfig = z.infer<typeof ConfigSchema>;
