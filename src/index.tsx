#!/usr/bin/env node

import 'dotenv/config';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './cli/App.js';
import { bootstrap } from './bootstrap.js';
import type { CLIOptions } from './config/types.js';

const program = new Command();

program
  .name('personalagent')
  .description('A rich CLI-based chat agent with hive architecture')
  .version('0.1.0')
  .option('-p, --provider <provider>', 'LLM provider name (e.g., gemini, openai, anthropic, ollama, or custom)')
  .option('-m, --model <model>', 'Model to use')
  .option('-c, --config <path>', 'Path to config file')
  .option('--no-stream', 'Disable response streaming')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (options: CLIOptions) => {
    try {
      const result = await bootstrap({
        config: options.config,
        provider: options.provider,
        model: options.model,
        stream: options.stream,
        debug: options.debug,
      });

      // Render the CLI application
      const { waitUntilExit } = render(
        <App
          config={result.config}
          queenProvider={result.queenProvider}
          workerProvider={result.workerProvider}
          mcpServer={result.mcpServer}
          skillLoader={result.skillLoader}
          skillTracker={result.skillTracker}
          historyManager={result.historyManager}
          strategyStore={result.strategyStore}
        />
      );

      await waitUntilExit();

      // Run any remaining shutdown cleanups
      if (!result.shutdownManager.getIsShuttingDown()) {
        await result.shutdownManager.shutdown('normal_exit');
      }
    } catch (error) {
      console.error('Failed to start Personal Agent:', error);
      process.exit(1);
    }
  });

// Web UI server subcommand
program
  .command('serve')
  .description('Start the web UI server')
  .option('--port <port>', 'Server port', '3100')
  .option('--host <host>', 'Server host', 'localhost')
  .option('-p, --provider <provider>', 'LLM provider name')
  .option('-m, --model <model>', 'Model to use')
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      const result = await bootstrap({
        config: options.config,
        provider: options.provider,
        model: options.model,
        debug: options.debug,
      });

      const { startServer } = await import('./server/index.js');
      await startServer(result, {
        port: parseInt(options.port, 10),
        host: options.host,
      });
    } catch (error) {
      console.error('Failed to start web server:', error);
      process.exit(1);
    }
  });

// MCP management subcommands — config-only, no bootstrap needed
const mcpCmd = program
  .command('mcp')
  .description('Manage MCP servers');

mcpCmd
  .command('add <name>')
  .description('Add an MCP server')
  .option('-t, --transport <type>', 'Transport type (stdio or http)', 'stdio')
  .option('-e, --env <KEY=VAL>', 'Environment variable (repeatable)', collectKeyVal, {})
  .option('-s, --scope <scope>', 'Config scope (user or project)', 'project')
  .option('--url <url>', 'Server URL (for http transport)')
  .option('--timeout <ms>', 'Connection timeout in ms', '30000')
  .option('--namespace', 'Prefix tool names with server name', false)
  .argument('[cmdArgs...]', 'Command and arguments (for stdio transport, after --)')
  .action(async (name: string, cmdArgs: string[], options: Record<string, unknown>) => {
    const { mcpAdd } = await import('./cli/commands/mcp.js');
    await mcpAdd(name, cmdArgs, options as Parameters<typeof mcpAdd>[2]);
  });

mcpCmd
  .command('remove <name>')
  .description('Remove an MCP server')
  .option('-s, --scope <scope>', 'Config scope (user or project)', 'project')
  .action(async (name: string, options: Record<string, unknown>) => {
    const { mcpRemove } = await import('./cli/commands/mcp.js');
    await mcpRemove(name, options as Parameters<typeof mcpRemove>[1]);
  });

mcpCmd
  .command('list')
  .description('List all configured MCP servers')
  .action(async () => {
    const { mcpList } = await import('./cli/commands/mcp.js');
    await mcpList();
  });

mcpCmd
  .command('get <name>')
  .description('Show details of an MCP server')
  .action(async (name: string) => {
    const { mcpGet } = await import('./cli/commands/mcp.js');
    await mcpGet(name);
  });

// Helper to collect repeatable --env KEY=VAL options
function collectKeyVal(val: string, acc: Record<string, string>): Record<string, string> {
  const eqIdx = val.indexOf('=');
  if (eqIdx === -1) {
    acc[val] = '';
  } else {
    acc[val.slice(0, eqIdx)] = val.slice(eqIdx + 1);
  }
  return acc;
}

// MCP server subcommand — runs as a subprocess for MCP clients
program
  .command('mcp-server')
  .description('Run as an MCP server over stdio (for use as a subprocess by MCP clients like Claude Desktop)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      const result = await bootstrap({
        config: options.config,
        debug: options.debug,
        silent: true, // Prevent any console output from corrupting stdio transport
      });

      // Force-create protocol server if not already enabled via config
      let protocolServer = result.mcpProtocolServer;
      if (!protocolServer) {
        const { MCPProtocolServer } = await import('./mcp/MCPProtocolServer.js');
        protocolServer = new MCPProtocolServer(result.mcpServer);
        result.shutdownManager.register('mcpProtocolServer', () => protocolServer!.close(), 2);
      }

      await protocolServer.serveStdio();
    } catch (error) {
      // Write to stderr only — stdout is owned by the MCP transport
      process.stderr.write(`Failed to start MCP server: ${error}\n`);
      process.exit(1);
    }
  });

program.parse();
