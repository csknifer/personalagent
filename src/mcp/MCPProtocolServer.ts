/**
 * MCP Protocol Server — wraps the internal MCPServer and exposes it
 * as a real MCP server via the official protocol (stdio or HTTP transport).
 *
 * Uses the low-level Server class from the SDK to avoid Zod schema
 * requirements, since internal tool definitions use plain JSON Schema.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServer } from './MCPServer.js';
import { toolResultToMCP } from './MCPAdapter.js';
import { getDebugLogger } from '../core/DebugLogger.js';

export class MCPProtocolServer {
  private internalServer: MCPServer;
  private log = getDebugLogger();

  constructor(internalServer: MCPServer) {
    this.internalServer = internalServer;
  }

  /**
   * Create a new low-level MCP Server instance with tool handlers wired
   * to the internal MCPServer facade.
   */
  private createSDKServer(): Server {
    const server = new Server(
      { name: 'personalagent', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    // Handle tools/list — return all tool definitions
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const defs = this.internalServer.getToolDefinitions();
      return {
        tools: defs.map(def => ({
          name: def.name,
          description: def.description,
          inputSchema: {
            type: 'object' as const,
            ...(def.parameters as Record<string, unknown>),
          },
        })),
      };
    });

    // Handle tools/call — execute a tool and convert the result
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await this.internalServer.executeTool(name, args ?? {});
      return toolResultToMCP(result) as CallToolResult;
    });

    return server;
  }

  /**
   * Serve via stdio transport (for `pa mcp-server` subcommand).
   * Blocks until stdin closes.
   */
  async serveStdio(): Promise<void> {
    const server = this.createSDKServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.log.info('MCPProtocolServer', 'Serving via stdio transport');

    // Block until stdin closes (the parent process disconnects)
    await new Promise<void>((resolve) => {
      process.stdin.on('end', resolve);
      process.stdin.on('close', resolve);
    });

    await server.close();
  }

  /**
   * Handle a single HTTP request using the Streamable HTTP transport.
   * Each request gets a fresh stateless transport.
   * Call this from the HTTP server for requests matching the MCP path.
   */
  async serveHTTP(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = this.createSDKServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    await server.connect(transport);

    try {
      // Collect the request body
      const body = await new Promise<string>((resolve, reject) => {
        let data = '';
        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });

      const parsedBody = body ? JSON.parse(body) : undefined;
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('MCPProtocolServer', `HTTP request failed: ${msg}`);

      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    } finally {
      await server.close();
    }
  }

  /**
   * Close is a no-op since we create fresh Server instances per connection.
   */
  async close(): Promise<void> {
    // Nothing to clean up — each transport creates its own Server
  }
}
