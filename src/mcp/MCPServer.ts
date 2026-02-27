/**
 * MCP Server Implementation
 * Exposes tools, resources, and prompts to LLM agents
 */

import {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  existsTool,
  deleteFileTool,
  createDirectoryTool,
  getFileSystemToolDefinitions,
  fetchUrlTool,
  getFetchUrlToolDefinition,
  executeCommandTool,
  getShellExecutionToolDefinitions,
  globTool,
  grepTool,
  editFileTool,
  getCodeIntelligenceToolDefinitions,
} from './tools/index.js';
import type { SandboxConfig } from './tools/index.js';
import type { ResolvedConfig } from '../config/types.js';
import type { ToolDefinition, ToolCall } from '../providers/Provider.js';
import type { MCPClientManager } from './MCPClientManager.js';

interface MCPServerOptions {
  config: ResolvedConfig;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export class MCPServer {
  private config: ResolvedConfig;
  private tools: Map<string, ToolHandler> = new Map();
  private clientManager?: MCPClientManager;

  constructor(options: MCPServerOptions) {
    this.config = options.config;
    this.registerDefaultTools();
  }

  /**
   * Register default tools based on configuration
   */
  private registerDefaultTools(): void {
    const toolsConfig = this.config.mcp.tools;
    const mcpConfig = this.config.mcp;

    // Compute effective sandbox config
    const sandboxConfig: SandboxConfig = {
      enabled: mcpConfig.sandbox,
      allowedRoots: mcpConfig.allowedRoots.length > 0
        ? mcpConfig.allowedRoots
        : [process.cwd()],
    };

    // File system tools
    if (toolsConfig.fileSystem) {
      this.registerTool('read_file', async (args) => {
        return readFileTool(args.path as string, sandboxConfig);
      });

      this.registerTool('write_file', async (args) => {
        return writeFileTool(args.path as string, args.content as string, true, sandboxConfig);
      });

      this.registerTool('list_directory', async (args) => {
        return listDirectoryTool(args.path as string, sandboxConfig);
      });

      this.registerTool('file_exists', async (args) => {
        return existsTool(args.path as string, sandboxConfig);
      });

      this.registerTool('delete_file', async (args) => {
        return deleteFileTool(args.path as string, sandboxConfig);
      });

      this.registerTool('create_directory', async (args) => {
        return createDirectoryTool(args.path as string, sandboxConfig);
      });
    }

    // URL fetching tool (no API key required)
    if (toolsConfig.webSearch) {
      this.registerTool('fetch_url', async (args) => {
        return fetchUrlTool(args.url as string);
      });
    }

    // Shell execution tools
    if (toolsConfig.codeExecution) {
      const shellConfig = toolsConfig.shellExecution;
      this.registerTool('execute_command', async (args) => {
        return executeCommandTool(args.command as string, {
          cwd: args.cwd as string | undefined,
          timeout: args.timeout as number | undefined,
          shellConfig,
          sandbox: sandboxConfig,
        });
      });
    }

    // Code intelligence tools (gated on fileSystem since they read/write files)
    if (toolsConfig.fileSystem) {
      this.registerTool('glob', async (args) => {
        return globTool(args.pattern as string, {
          cwd: args.cwd as string | undefined,
          ignore: args.ignore as string[] | undefined,
          sandbox: sandboxConfig,
        });
      });

      this.registerTool('grep', async (args) => {
        return grepTool(args.pattern as string, args.path as string, {
          include: args.include as string | undefined,
          ignoreCase: args.ignoreCase as boolean | undefined,
          maxResults: args.maxResults as number | undefined,
          contextLines: args.contextLines as number | undefined,
          sandbox: sandboxConfig,
        });
      });

      this.registerTool('edit_file', async (args) => {
        return editFileTool(
          args.path as string,
          args.old_string as string,
          args.new_string as string,
          {
            replaceAll: args.replace_all as boolean | undefined,
            sandbox: sandboxConfig,
          },
        );
      });
    }
  }

  /**
   * Inject a connected MCPClientManager to provide external tool aggregation.
   * Called by bootstrap after the client manager connects.
   */
  setClientManager(manager: MCPClientManager): void {
    this.clientManager = manager;
  }

  /**
   * Register a custom tool
   */
  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  /**
   * Unregister a tool
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // First check built-in tools
    const handler = this.tools.get(name);
    if (handler) {
      try {
        return await handler(args);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          success: false,
          error: `Tool execution failed: ${err.message}`,
        };
      }
    }

    // Delegate to external servers if not found locally
    if (this.clientManager) {
      const result = await this.clientManager.executeTool(name, args);
      if (result !== null) return result;
    }

    return {
      success: false,
      error: `Unknown tool: ${name}`,
    };
  }

  /**
   * Execute a tool call from an LLM
   */
  async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    return this.executeTool(toolCall.name, toolCall.arguments);
  }

  /**
   * Get all available tool definitions
   */
  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    const toolsConfig = this.config.mcp.tools;

    if (toolsConfig.fileSystem) {
      definitions.push(...getFileSystemToolDefinitions());
    }

    if (toolsConfig.webSearch) {
      definitions.push(getFetchUrlToolDefinition());
    }

    if (toolsConfig.codeExecution) {
      definitions.push(...getShellExecutionToolDefinitions());
    }

    if (toolsConfig.fileSystem) {
      definitions.push(...getCodeIntelligenceToolDefinitions());
    }

    // Merge in external tools (built-in names win on collision)
    if (this.clientManager) {
      const builtinNames = new Set(definitions.map(d => d.name));
      for (const ext of this.clientManager.getToolDefinitions()) {
        if (!builtinNames.has(ext.name)) {
          definitions.push(ext);
        }
      }
    }

    return definitions;
  }

  /**
   * Get list of available tool names
   */
  getAvailableTools(): string[] {
    const names = Array.from(this.tools.keys());
    if (this.clientManager) {
      for (const def of this.clientManager.getToolDefinitions()) {
        if (!names.includes(def.name)) {
          names.push(def.name);
        }
      }
    }
    return names;
  }

  /**
   * Check if a tool is available
   */
  hasTool(name: string): boolean {
    return this.tools.has(name) || (this.clientManager?.hasTool(name) ?? false);
  }

  /**
   * Close the server and release resources
   */
  close(): void {
    this.tools.clear();
  }

  /**
   * Get server status
   */
  getStatus(): {
    enabled: boolean;
    toolCount: number;
    availableTools: string[];
  } {
    return {
      enabled: this.config.mcp.enabled,
      toolCount: this.tools.size,
      availableTools: this.getAvailableTools(),
    };
  }
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Create an MCP server with configuration
 */
export function createMCPServer(config: ResolvedConfig): MCPServer {
  return new MCPServer({ config });
}
