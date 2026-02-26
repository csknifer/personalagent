/**
 * Read/write manager for mcp.json configuration files.
 *
 * Provides CRUD operations on the ecosystem-standard mcp.json format,
 * used by the `pa mcp add|remove|list|get` CLI commands.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { expandPath } from './interpolate.js';
import { MCPJsonFileSchema } from './ConfigSchema.js';
import type { MCPJsonFile, MCPJsonServerEntry } from './types.js';

export type MCPScope = 'user' | 'project';

const PATHS: Record<MCPScope, string> = {
  user: '~/.personalagent/mcp.json',
  project: './.personalagent/mcp.json',
};

export class MCPConfigManager {
  /**
   * Get the resolved filesystem path for a scope.
   */
  static getPath(scope: MCPScope): string {
    return expandPath(PATHS[scope]);
  }

  /**
   * Read the mcp.json file for a scope. Returns empty mcpServers if file doesn't exist.
   */
  static async read(scope: MCPScope): Promise<MCPJsonFile> {
    const path = this.getPath(scope);
    if (!existsSync(path)) return { mcpServers: {} };
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8'));
      return MCPJsonFileSchema.parse(raw);
    } catch {
      return { mcpServers: {} };
    }
  }

  /**
   * Write the mcp.json file for a scope.
   */
  static async write(scope: MCPScope, data: MCPJsonFile): Promise<void> {
    const path = this.getPath(scope);
    const dir = dirname(path);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  /**
   * Add or update a server in the specified scope's mcp.json.
   */
  static async addServer(name: string, entry: MCPJsonServerEntry, scope: MCPScope): Promise<void> {
    const data = await this.read(scope);
    data.mcpServers[name] = entry;
    await this.write(scope, data);
  }

  /**
   * Remove a server from the specified scope's mcp.json.
   * Returns true if the server was found and removed.
   */
  static async removeServer(name: string, scope: MCPScope): Promise<boolean> {
    const data = await this.read(scope);
    if (!(name in data.mcpServers)) return false;
    delete data.mcpServers[name];
    await this.write(scope, data);
    return true;
  }

  /**
   * Get a single server entry from the specified scope.
   */
  static async getServer(name: string, scope: MCPScope): Promise<MCPJsonServerEntry | null> {
    const data = await this.read(scope);
    return data.mcpServers[name] ?? null;
  }

  /**
   * List all servers across both scopes with source info.
   * Project scope entries override user scope entries with the same name.
   */
  static async listAll(): Promise<Array<{
    name: string;
    entry: MCPJsonServerEntry;
    scope: MCPScope;
  }>> {
    const byName = new Map<string, { name: string; entry: MCPJsonServerEntry; scope: MCPScope }>();

    for (const scope of ['user', 'project'] as MCPScope[]) {
      const data = await this.read(scope);
      for (const [name, entry] of Object.entries(data.mcpServers)) {
        byName.set(name, { name, entry, scope });
      }
    }

    return Array.from(byName.values());
  }
}
