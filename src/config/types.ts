/**
 * Configuration types for Personal Agent
 */

export interface CLIOptions {
  provider?: string;
  model?: string;
  config?: string;
  stream?: boolean;
  debug?: boolean;
}

export interface ApiKeys {
  gemini?: string;
  openai?: string;
  anthropic?: string;
  [key: string]: string | undefined;
}

export interface ProviderConfig {
  model: string;
  models?: string[];
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  host?: string; // For Ollama
  type?: string; // Provider type override (e.g., 'openai-compatible')
  apiKey?: string; // Per-provider API key
}

export interface ProvidersConfig {
  default: string;
  gemini?: ProviderConfig;
  openai?: ProviderConfig;
  anthropic?: ProviderConfig;
  ollama?: ProviderConfig;
  [key: string]: ProviderConfig | string | undefined;
}

export interface QueenConfig {
  provider?: string | null;
  model?: string | null;
  systemPrompt?: string | null;
  aggregationOverlapThreshold?: number;
}

export interface WorkerConfig {
  provider?: string | null;
  model?: string | null;
  maxConcurrent: number;
  timeout: number;
}

export interface DimensionalConfig {
  enabled: boolean;
  convergenceThreshold: number;
  passingScore: number;
  stagnationWindow: number;
  observationMasking: boolean;
  maxMaskedOutputLength: number;
  reflexionEnabled: boolean;
  maxRetainedTokens?: number;
}

export interface AdaptiveTimeoutTier {
  maxIterations: number;
  timeout: number;
}

export interface AdaptiveTimeoutConfig {
  enabled: boolean;
  low: AdaptiveTimeoutTier;
  medium: AdaptiveTimeoutTier;
  high: AdaptiveTimeoutTier;
}

export interface UnifiedVerificationConfig {
  enabled: boolean;
}

export interface RalphLoopConfig {
  maxIterations: number;
  verificationStrategy: 'auto' | 'manual' | 'test-based' | 'dimensional';
  dimensional: DimensionalConfig;
  adaptiveTimeout?: AdaptiveTimeoutConfig;
  unifiedVerification?: UnifiedVerificationConfig;
}

export interface MemoryConfig {
  maxMessages: number;
  maxTokens: number;
}

export interface ReplanningConfig {
  enabled: boolean;
  maxReplans: number;
}

export interface EvaluationConfig {
  enabled: boolean;
  maxCycles: number;        // Max outer-loop iterations (default: 2)
  passingThreshold: number; // Minimum score to accept result (0.0–1.0, default: 0.7)
}

export interface StrategyStoreConfig {
  enabled: boolean;
  filePath: string;
  maxAgeDays: number;
}

export interface ProgressiveDiscoveryConfig {
  enabled: boolean;
  maxWaves: number;
  waveTimeout: number;
  totalTimeout: number;
  stoppingThreshold: number;
}

export interface HiveConfig {
  queen: QueenConfig;
  worker: WorkerConfig;
  ralphLoop: RalphLoopConfig;
  memory?: MemoryConfig;
  replanning?: ReplanningConfig;
  evaluation?: EvaluationConfig;
  strategyStore?: StrategyStoreConfig;
  progressiveDiscovery?: ProgressiveDiscoveryConfig;
}

export interface PromptsConfig {
  queen?: {
    system?: string;
    taskPlanning?: string;
  };
  worker?: {
    system?: string;
  };
  research?: {
    system?: string;
  };
}

export interface SkillsConfig {
  enabled: boolean;
  paths: string[];
  autoDiscover: boolean;
}

export interface ShellExecutionConfig {
  enabled: boolean;
  defaultTimeout: number;
  maxTimeout: number;
  blockedPatterns: string[];
  maxOutputLength: number;
}

export interface MCPToolsConfig {
  fileSystem: boolean;
  webSearch: boolean;
  codeExecution: boolean;
  shellExecution: ShellExecutionConfig;
}

/** Per-server tool allow/blocklist */
export interface MCPToolFilter {
  allowlist?: string[];   // if set, ONLY these tools are exposed
  blocklist?: string[];   // if set, these tools are hidden
}

export interface MCPExternalServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  enabled: boolean;
  timeout: number;
  namespace: boolean;
  toolFilter?: MCPToolFilter;
}

/** Ecosystem-standard mcp.json server entry (keyed by name, no `name` field) */
export interface MCPJsonServerEntry {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  enabled?: boolean;
  timeout?: number;
  namespace?: boolean;
  toolFilter?: MCPToolFilter;
}

/** Shape of an mcp.json file */
export interface MCPJsonFile {
  mcpServers: Record<string, MCPJsonServerEntry>;
}

export interface MCPExposeConfig {
  enabled: boolean;
  stdio: { enabled: boolean };
  http: { enabled: boolean; path: string };
}

export interface MCPConfig {
  enabled: boolean;
  tools: MCPToolsConfig;
  sandbox: boolean;
  allowedRoots: string[];
  servers: MCPExternalServer[];
  expose: MCPExposeConfig;
}

export interface CLIConfig {
  theme: 'auto' | 'dark' | 'light';
  showWorkerStatus: boolean;
  verboseWorkerStatus: boolean;
  streamResponses: boolean;
  historyFile: string;
  maxHistorySize: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file: string;
  includeTokenUsage: boolean;
}

export interface ServerConfig {
  port: number;
  host: string;
  cors: boolean;
  staticDir?: string;
  eventThrottleMs: number;
}

export interface Config {
  apiKeys: ApiKeys;
  providers: ProvidersConfig;
  hive: HiveConfig;
  prompts: PromptsConfig;
  skills: SkillsConfig;
  mcp: MCPConfig;
  cli: CLIConfig;
  server: ServerConfig;
  logging: LoggingConfig;
  [key: string]: unknown;
}

// Active runtime config with resolved values
export interface ResolvedConfig extends Config {
  activeProvider: string;
  activeModel: string;
}
