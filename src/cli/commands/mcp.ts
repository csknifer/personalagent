/**
 * CLI command handlers for `pa mcp add|remove|list|get`.
 *
 * These are lightweight config-file operations — they do NOT require
 * full bootstrap (no LLM providers, no MCP connections).
 */

import chalk from 'chalk';
import { MCPConfigManager, type MCPScope } from '../../config/MCPConfigManager.js';
import type { MCPJsonServerEntry } from '../../config/types.js';

/* ------------------------------------------------------------------ */
/*  pa mcp add                                                         */
/* ------------------------------------------------------------------ */

export async function mcpAdd(
  name: string,
  cmdArgs: string[],
  options: {
    transport: string;
    env: Record<string, string>;
    scope: string;
    url?: string;
    timeout: string;
    namespace: boolean;
  },
): Promise<void> {
  const scope = options.scope as MCPScope;
  const transport = options.transport as 'stdio' | 'http';

  const entry: MCPJsonServerEntry = {
    type: transport,
    enabled: true,
    timeout: parseInt(options.timeout, 10),
    namespace: options.namespace,
  };

  if (transport === 'stdio') {
    if (cmdArgs.length === 0) {
      console.error(chalk.red('Error: stdio transport requires a command.'));
      console.error(chalk.gray('  Usage: pa mcp add <name> -- <command> [args...]'));
      process.exit(1);
    }
    entry.command = cmdArgs[0];
    entry.args = cmdArgs.slice(1);
  } else if (transport === 'http') {
    if (!options.url) {
      console.error(chalk.red('Error: http transport requires --url <url>'));
      process.exit(1);
    }
    entry.url = options.url;
  }

  if (Object.keys(options.env).length > 0) {
    entry.env = options.env;
  }

  await MCPConfigManager.addServer(name, entry, scope);
  console.log(chalk.green(`✓ Added MCP server "${name}" to ${scope} config`));
  console.log(chalk.gray(`  File: ${MCPConfigManager.getPath(scope)}`));
}

/* ------------------------------------------------------------------ */
/*  pa mcp remove                                                      */
/* ------------------------------------------------------------------ */

export async function mcpRemove(
  name: string,
  options: { scope: string },
): Promise<void> {
  const scope = options.scope as MCPScope;
  const removed = await MCPConfigManager.removeServer(name, scope);

  if (removed) {
    console.log(chalk.green(`✓ Removed MCP server "${name}" from ${scope} config`));
  } else {
    console.error(chalk.yellow(`Server "${name}" not found in ${scope} config`));
    console.error(chalk.gray(`  File: ${MCPConfigManager.getPath(scope)}`));
  }
}

/* ------------------------------------------------------------------ */
/*  pa mcp list                                                        */
/* ------------------------------------------------------------------ */

export async function mcpList(): Promise<void> {
  const jsonServers = await MCPConfigManager.listAll();

  // Also show YAML-configured servers (load config without full bootstrap)
  let yamlOnlyServers: Array<{ name: string; transport: string; enabled: boolean }> = [];
  try {
    const { ConfigLoader } = await import('../../config/ConfigLoader.js');
    const config = await ConfigLoader.load({});
    const jsonNames = new Set(jsonServers.map(s => s.name));
    yamlOnlyServers = config.mcp.servers
      .filter(s => !jsonNames.has(s.name))
      .map(s => ({ name: s.name, transport: s.transport, enabled: s.enabled }));
  } catch {
    // Config load may fail in minimal environments — that's fine
  }

  if (jsonServers.length === 0 && yamlOnlyServers.length === 0) {
    console.log(chalk.gray('No MCP servers configured.'));
    console.log(chalk.gray(`  Add one: pa mcp add <name> -- <command> [args...]`));
    return;
  }

  console.log(chalk.bold('\nMCP Servers:\n'));

  for (const { name, entry, scope } of jsonServers) {
    const status = entry.enabled !== false ? chalk.green('enabled') : chalk.red('disabled');
    const scopeLabel = scope === 'user' ? chalk.blue('user') : chalk.magenta('project');
    const transport = entry.type === 'stdio'
      ? `${entry.command || '?'} ${(entry.args ?? []).join(' ')}`
      : entry.url || '?';

    console.log(`  ${chalk.bold(name)}  ${scopeLabel}  ${status}`);
    console.log(chalk.gray(`    ${entry.type}: ${transport}`));
    if (entry.toolFilter) {
      if (entry.toolFilter.allowlist) console.log(chalk.gray(`    allowlist: ${entry.toolFilter.allowlist.join(', ')}`));
      if (entry.toolFilter.blocklist) console.log(chalk.gray(`    blocklist: ${entry.toolFilter.blocklist.join(', ')}`));
    }
  }

  for (const s of yamlOnlyServers) {
    const status = s.enabled ? chalk.green('enabled') : chalk.red('disabled');
    console.log(`  ${chalk.bold(s.name)}  ${chalk.yellow('yaml')}  ${status}`);
    console.log(chalk.gray(`    ${s.transport}`));
  }

  console.log();
}

/* ------------------------------------------------------------------ */
/*  pa mcp get                                                         */
/* ------------------------------------------------------------------ */

export async function mcpGet(name: string): Promise<void> {
  // Check both scopes
  for (const scope of ['project', 'user'] as MCPScope[]) {
    const entry = await MCPConfigManager.getServer(name, scope);
    if (entry) {
      console.log(chalk.bold(`\nServer: ${name}`));
      console.log(`  Scope: ${scope}`);
      console.log(`  File:  ${MCPConfigManager.getPath(scope)}`);
      console.log(`  Config:`);
      console.log(chalk.gray(JSON.stringify(entry, null, 4).replace(/^/gm, '    ')));
      console.log();
      return;
    }
  }

  console.error(chalk.yellow(`Server "${name}" not found in any mcp.json scope.`));
  console.error(chalk.gray('  Check: pa mcp list'));
}
