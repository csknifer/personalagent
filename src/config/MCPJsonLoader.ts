/**
 * Loader for ecosystem-standard mcp.json configuration files.
 *
 * Reads mcp.json from user (~/.personalagent/mcp.json) and project
 * (./.personalagent/mcp.json) scopes, converts the `mcpServers` object
 * format to the internal MCPExternalServer[] array, and merges them
 * (project scope wins on name collision).
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { MCPJsonFileSchema } from './ConfigSchema.js';
import { interpolateEnvVars, expandPath } from './interpolate.js';
import type { MCPExternalServer, MCPJsonFile, MCPJsonServerEntry } from './types.js';

const USER_MCP_JSON = '~/.personalagent/mcp.json';
const PROJECT_MCP_JSON = './.personalagent/mcp.json';

export class MCPJsonLoader {
  /**
   * Load mcp.json files from both scopes and merge them.
   * Project scope overrides user scope on name collision.
   */
  static async loadMCPServers(): Promise<MCPExternalServer[]> {
    const userServers = await this.loadFile(expandPath(USER_MCP_JSON));
    const projectServers = await this.loadFile(expandPath(PROJECT_MCP_JSON));

    // Merge: project overrides user on name collision
    const merged = new Map<string, MCPExternalServer>();
    for (const s of userServers) merged.set(s.name, s);
    for (const s of projectServers) merged.set(s.name, s);
    return Array.from(merged.values());
  }

  /**
   * Load a single mcp.json file and convert to internal format.
   */
  static async loadFile(path: string): Promise<MCPExternalServer[]> {
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8'));
      const parsed = MCPJsonFileSchema.parse(raw);
      return this.toExternalServers(parsed);
    } catch {
      // Malformed JSON or validation error — skip silently
      return [];
    }
  }

  /**
   * Convert the ecosystem-standard mcpServers object to MCPExternalServer array.
   */
  static toExternalServers(file: MCPJsonFile): MCPExternalServer[] {
    return Object.entries(file.mcpServers).map(([name, entry]) => ({
      name,
      transport: entry.type,
      command: entry.command,
      args: entry.args,
      env: entry.env ? this.interpolateEnv(entry.env) : undefined,
      cwd: entry.cwd,
      url: entry.url,
      enabled: entry.enabled ?? true,
      timeout: entry.timeout ?? 30000,
      namespace: entry.namespace ?? false,
      toolFilter: entry.toolFilter,
    }));
  }

  /**
   * Convert an MCPExternalServer back to the mcp.json entry format.
   */
  static toJsonEntry(server: MCPExternalServer): MCPJsonServerEntry {
    return {
      type: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      enabled: server.enabled,
      timeout: server.timeout,
      namespace: server.namespace,
      toolFilter: server.toolFilter,
    };
  }

  /**
   * Interpolate ${ENV_VAR} references in env values.
   */
  private static interpolateEnv(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      result[k] = interpolateEnvVars(v);
    }
    return result;
  }
}
