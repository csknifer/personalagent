/**
 * Shared bootstrap logic for both CLI and web server entry points.
 * Initializes config, providers, MCP server, skills, history, and shutdown handlers.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ConfigLoader } from './config/ConfigLoader.js';
import { createRoleProvider } from './providers/index.js';
import { createMCPServer } from './mcp/MCPServer.js';
import { killAllTrackedProcesses } from './mcp/tools/index.js';
import { MCPClientManager } from './mcp/MCPClientManager.js';
import { MCPProtocolServer } from './mcp/MCPProtocolServer.js';
import { createSkillLoader } from './skills/SkillLoader.js';
import { createSkillTracker } from './skills/SkillTracker.js';
import { HistoryManager } from './core/HistoryManager.js';
import { getShutdownManager } from './core/ShutdownManager.js';
import { getDebugLogger } from './core/DebugLogger.js';
import { StrategyStore } from './core/queen/StrategyStore.js';
import { MemoryStore } from './core/memory/MemoryStore.js';
import type { ResolvedConfig, CLIOptions } from './config/types.js';
import type { LLMProvider } from './providers/index.js';
import type { MCPServer } from './mcp/MCPServer.js';
import type { MCPClientManager as MCPClientManagerType } from './mcp/MCPClientManager.js';
import type { SkillLoader } from './skills/SkillLoader.js';
import type { SkillTracker } from './skills/SkillTracker.js';
import type { ShutdownManager } from './core/ShutdownManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BootstrapOptions {
  config?: string;
  provider?: string;
  model?: string;
  stream?: boolean;
  debug?: boolean;
  silent?: boolean;
}

export interface BootstrapResult {
  config: ResolvedConfig;
  queenProvider: LLMProvider;
  workerProvider: LLMProvider;
  mcpServer: MCPServer;
  mcpClientManager: MCPClientManagerType;
  mcpProtocolServer: MCPProtocolServer | null;
  skillLoader: SkillLoader | null;
  skillTracker: SkillTracker | null;
  historyManager: HistoryManager;
  shutdownManager: ShutdownManager;
  strategyStore: StrategyStore | null;
  memoryStore: MemoryStore | null;
}

/**
 * Initialize all core components needed by both CLI and web server.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  // Load configuration with overrides
  const config = await ConfigLoader.load({
    config: options.config,
    provider: options.provider,
    model: options.model,
    stream: options.stream,
    debug: options.debug,
  });

  // Enable debug logger if needed
  if (config.logging.level === 'debug') {
    const debugLog = getDebugLogger();
    debugLog.enable('debug');
    if (!options.silent) {
      console.log(`\x1b[90m[DEBUG] Debug logging to: ${debugLog.getLogFile()}\x1b[0m\n`);
    }
  }

  // Create LLM providers for Queen and Workers
  const queenProvider = createRoleProvider(config, 'queen');
  const workerProvider = createRoleProvider(config, 'worker');

  // Create MCP Server for tool integration
  const mcpServer = createMCPServer(config);

  // Initialize SkillLoader and SkillTracker if skills are enabled
  let skillLoader: SkillLoader | null = null;
  let skillTracker: SkillTracker | null = null;
  if (config.skills.enabled) {
    const builtInSkillsPath = join(__dirname, 'skills', 'built-in');
    const allSkillPaths = [builtInSkillsPath, ...config.skills.paths];

    skillLoader = createSkillLoader(allSkillPaths, config.skills.autoDiscover);

    const discoveredSkills = await skillLoader.discoverSkills();
    if (!options.silent && config.logging.level === 'debug' && discoveredSkills.length > 0) {
      console.log(`\x1b[36m\u2139 Discovered ${discoveredSkills.length} skill(s): ${discoveredSkills.map(s => s.metadata.name).join(', ')}\x1b[0m\n`);
    }

    skillTracker = createSkillTracker();
    await skillTracker.load();
  }

  // Create history manager for persistent conversations
  const historyManager = new HistoryManager(config.cli.historyFile, config.cli.maxHistorySize);

  // Connect to external MCP servers
  const mcpClientManager = new MCPClientManager();
  if (config.mcp.enabled && config.mcp.servers && config.mcp.servers.length > 0) {
    await mcpClientManager.connect(config.mcp.servers);
    mcpServer.setClientManager(mcpClientManager);
  }

  // Create protocol server if exposure is enabled
  let mcpProtocolServer: MCPProtocolServer | null = null;
  if (config.mcp.expose?.enabled) {
    mcpProtocolServer = new MCPProtocolServer(mcpServer);
  }

  // Initialize cross-session strategy store if enabled
  let strategyStore: StrategyStore | null = null;
  const storeConfig = config.hive.strategyStore;
  if (storeConfig?.enabled) {
    const filePath = storeConfig.filePath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
    strategyStore = new StrategyStore(filePath);
    await strategyStore.load();
  }

  // Initialize cross-session memory store
  const memoryDir = join(
    (process.env.HOME || process.env.USERPROFILE || '.'),
    '.personalagent',
    'memory',
  );
  let memoryStore: MemoryStore | null = null;
  try {
    memoryStore = new MemoryStore(memoryDir);
    // Apply mild decay on startup and prune very weak memories
    await memoryStore.applyDecay(0.95);
    await memoryStore.prune(0.05);
  } catch {
    // Memory store is non-critical — continue without it
    memoryStore = null;
  }

  // Set up graceful shutdown
  const shutdownManager = getShutdownManager();

  shutdownManager.register('history', () => historyManager.save(), 10);
  if (skillTracker) {
    shutdownManager.register('skillTracker', () => skillTracker!.flush(), 10);
  }
  if (strategyStore) {
    shutdownManager.register('strategyStore', () => strategyStore!.save(), 10);
  }
  if (mcpProtocolServer) {
    shutdownManager.register('mcpProtocolServer', () => mcpProtocolServer!.close(), 2);
  }
  shutdownManager.register('trackedProcesses', () => killAllTrackedProcesses(), 15);
  shutdownManager.register('mcpClientManager', () => mcpClientManager.close(), 1);
  shutdownManager.register('mcpServer', () => mcpServer.close(), 0);
  shutdownManager.attachSignalHandlers();

  return {
    config,
    queenProvider,
    workerProvider,
    mcpServer,
    mcpClientManager,
    mcpProtocolServer,
    skillLoader,
    skillTracker,
    historyManager,
    shutdownManager,
    strategyStore,
    memoryStore,
  };
}
