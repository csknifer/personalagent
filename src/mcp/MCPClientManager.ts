/**
 * MCP Client Manager — connects to external MCP servers and adapts
 * their tools into the internal ToolDefinition/ToolResult format.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPExternalServer, MCPToolFilter } from '../config/types.js';
import type { ToolDefinition } from '../providers/Provider.js';
import { mcpToToolResult, type ToolResult } from './MCPAdapter.js';
import { getDebugLogger } from '../core/DebugLogger.js';

interface ConnectedServer {
  config: MCPExternalServer;
  client: Client;
  tools: ToolDefinition[];
}

export class MCPClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private log = getDebugLogger();

  /**
   * Connect to all enabled external servers.
   * Errors for individual servers are caught and logged — they do not
   * prevent initialization of other servers.
   */
  async connect(serverConfigs: MCPExternalServer[]): Promise<void> {
    const enabled = serverConfigs.filter(s => s.enabled);
    if (enabled.length === 0) return;

    const results = await Promise.allSettled(
      enabled.map(cfg => this.connectOne(cfg))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    if (succeeded > 0 || failed > 0) {
      this.log.info('MCPClientManager', `Connected to ${succeeded}/${enabled.length} external MCP servers${failed > 0 ? ` (${failed} failed)` : ''}`);
    }
  }

  private async connectOne(cfg: MCPExternalServer): Promise<void> {
    try {
      const client = new Client(
        { name: 'personalagent', version: '0.1.0' },
        { capabilities: {} }
      );

      let transport;
      if (cfg.transport === 'stdio') {
        if (!cfg.command) {
          throw new Error(`stdio server "${cfg.name}" missing 'command' field`);
        }
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: cfg.env ? { ...process.env, ...cfg.env } as Record<string, string> : undefined,
          cwd: cfg.cwd,
          stderr: 'pipe',
        });
      } else if (cfg.transport === 'http') {
        if (!cfg.url) {
          throw new Error(`http server "${cfg.name}" missing 'url' field`);
        }
        transport = new StreamableHTTPClientTransport(new URL(cfg.url));
      } else {
        throw new Error(`Unknown transport "${cfg.transport}" for server "${cfg.name}"`);
      }

      await client.connect(transport);

      const { tools: sdkTools } = await client.listTools();

      const tools: ToolDefinition[] = sdkTools.map(t => ({
        name: cfg.namespace ? `${cfg.name}__${t.name}` : t.name,
        description: t.description ?? '',
        parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      }));

      // Apply per-server tool filtering (allowlist / blocklist)
      const filteredTools = this.applyToolFilter(tools, cfg.toolFilter);

      this.servers.set(cfg.name, { config: cfg, client, tools: filteredTools });

      const filterNote = filteredTools.length < tools.length
        ? ` (${tools.length - filteredTools.length} filtered out)`
        : '';
      this.log.info('MCPClientManager', `Connected to "${cfg.name}" — ${filteredTools.length} tool(s)${filterNote}: ${filteredTools.map(t => t.name).join(', ')}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('MCPClientManager', `Failed to connect to "${cfg.name}": ${msg}`);
      throw err; // Re-throw so Promise.allSettled captures it
    }
  }

  /**
   * Return all discovered tool definitions across all connected servers.
   */
  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      defs.push(...server.tools);
    }
    return defs;
  }

  /**
   * Execute a tool by name. Searches all connected servers.
   * Returns null if no server has a tool with the given name.
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    for (const server of this.servers.values()) {
      const match = server.tools.find(t => t.name === name);
      if (!match) continue;

      // Resolve actual tool name on remote (strip namespace prefix if used)
      const remoteName = server.config.namespace
        ? name.slice(server.config.name.length + 2) // strip "serverName__"
        : name;

      try {
        // Pass the configured timeout directly to the MCP SDK's callTool().
        // The SDK has its own DEFAULT_REQUEST_TIMEOUT_MSEC (60s) that fires
        // as MCP error -32001 if not overridden. By passing our server timeout,
        // we let long-running external tools (e.g. google-search under load)
        // complete without the SDK killing them prematurely.
        const result = await server.client.callTool(
          { name: remoteName, arguments: args },
          undefined, // resultSchema — use default
          { timeout: server.config.timeout },
        );

        return mcpToToolResult(result as Parameters<typeof mcpToToolResult>[0]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `External tool "${name}" failed: ${msg}` };
      }
    }

    return null; // Tool not found in any external server
  }

  /**
   * Whether any connected server has a tool with the given name.
   */
  hasTool(name: string): boolean {
    for (const server of this.servers.values()) {
      if (server.tools.some(t => t.name === name)) return true;
    }
    return false;
  }

  /**
   * Get status of all connected servers.
   */
  getStatus(): Array<{ name: string; toolCount: number; tools: string[] }> {
    return Array.from(this.servers.entries()).map(([name, s]) => ({
      name,
      toolCount: s.tools.length,
      tools: s.tools.map(t => t.name),
    }));
  }

  /**
   * Apply per-server tool allow/blocklist filtering.
   * Allowlist: if set, ONLY matching tools pass through.
   * Blocklist: if set, matching tools are removed.
   * Blocklist is applied after allowlist.
   */
  private applyToolFilter(tools: ToolDefinition[], filter?: MCPToolFilter): ToolDefinition[] {
    if (!filter) return tools;

    let result = tools;

    if (filter.allowlist && filter.allowlist.length > 0) {
      const allowed = new Set(filter.allowlist);
      result = result.filter(t => {
        // Match against both the full (possibly namespaced) name and the raw name
        const rawName = t.name.includes('__') ? t.name.split('__').slice(1).join('__') : t.name;
        return allowed.has(t.name) || allowed.has(rawName);
      });
    }

    if (filter.blocklist && filter.blocklist.length > 0) {
      const blocked = new Set(filter.blocklist);
      result = result.filter(t => {
        const rawName = t.name.includes('__') ? t.name.split('__').slice(1).join('__') : t.name;
        return !blocked.has(t.name) && !blocked.has(rawName);
      });
    }

    return result;
  }

  /**
   * Disconnect all clients and kill any spawned processes.
   */
  async close(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.values()).map(s => s.client.close())
    );
    this.servers.clear();
  }
}
