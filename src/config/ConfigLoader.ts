/**
 * Configuration loader with multi-layer merging
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema } from './ConfigSchema.js';
import { defaultConfig } from './defaults.js';
import { interpolateConfig, expandPath, expandConfigPaths } from './interpolate.js';
import { MCPJsonLoader } from './MCPJsonLoader.js';
import type { Config, ResolvedConfig, CLIOptions } from './types.js';

// Config file locations
const GLOBAL_CONFIG_PATH = '~/.personalagent/config.yaml';
const PROJECT_CONFIG_PATH = './.personalagent/config.yaml';

export class ConfigLoader {
  /**
   * Load and merge configuration from all sources
   */
  static async load(cliOptions: CLIOptions = {}): Promise<ResolvedConfig> {
    // Start with defaults
    let config: Config = structuredClone(defaultConfig);

    // Layer 2: Global config
    const globalConfigPath = expandPath(GLOBAL_CONFIG_PATH);
    if (existsSync(globalConfigPath)) {
      const globalConfig = await this.loadYamlFile(globalConfigPath);
      config = this.mergeConfigs(config, globalConfig);
    }

    // Layer 3: Project config
    const projectConfigPath = expandPath(PROJECT_CONFIG_PATH);
    if (existsSync(projectConfigPath)) {
      const projectConfig = await this.loadYamlFile(projectConfigPath);
      config = this.mergeConfigs(config, projectConfig);
    }

    // Layer 4: Custom config file (if specified)
    if (cliOptions.config) {
      const customConfigPath = expandPath(cliOptions.config);
      if (existsSync(customConfigPath)) {
        const customConfig = await this.loadYamlFile(customConfigPath);
        config = this.mergeConfigs(config, customConfig);
      } else {
        throw new Error(`Config file not found: ${cliOptions.config}`);
      }
    }

    // Layer 5: Environment variables
    config = this.applyEnvOverrides(config);

    // Layer 6: CLI options
    config = this.applyCLIOverrides(config, cliOptions);

    // Layer 7: mcp.json files (user + project scope, ecosystem-standard format)
    const mcpJsonServers = await MCPJsonLoader.loadMCPServers();
    if (mcpJsonServers.length > 0) {
      // Merge by name: mcp.json wins on collision, YAML-only servers preserved
      const byName = new Map(config.mcp.servers.map(s => [s.name, s]));
      for (const jsonServer of mcpJsonServers) {
        byName.set(jsonServer.name, jsonServer);
      }
      config.mcp.servers = Array.from(byName.values());
    }

    // Interpolate any remaining env vars in strings
    config = interpolateConfig(config);

    // Expand paths
    config = expandConfigPaths(config);

    // Validate
    const validated = ConfigSchema.parse(config);

    // Resolve active provider and model
    return this.resolveConfig(validated as Config);
  }

  /**
   * Load and parse a YAML config file
   */
  private static async loadYamlFile(filePath: string): Promise<Partial<Config>> {
    const content = await readFile(filePath, 'utf-8');
    return parseYaml(content) || {};
  }

  /**
   * Deep merge two config objects
   */
  private static mergeConfigs(base: Config, override: Partial<Config>): Config {
    const result = structuredClone(base);
    
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      
      const baseValue = (result as Record<string, unknown>)[key];
      
      if (this.isPlainObject(value) && this.isPlainObject(baseValue)) {
        (result as Record<string, unknown>)[key] = this.deepMerge(
          baseValue as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else {
        (result as Record<string, unknown>)[key] = value;
      }
    }
    
    return result;
  }

  /**
   * Deep merge helper for nested objects
   */
  private static deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...base };
    
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      
      if (this.isPlainObject(value) && this.isPlainObject(result[key])) {
        result[key] = this.deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  /**
   * Check if value is a plain object
   */
  private static isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Apply environment variable overrides
   */
  private static applyEnvOverrides(config: Config): Config {
    const result = structuredClone(config);

    // API keys from environment
    if (process.env.GEMINI_API_KEY) {
      result.apiKeys.gemini = process.env.GEMINI_API_KEY;
    }
    if (process.env.OPENAI_API_KEY) {
      result.apiKeys.openai = process.env.OPENAI_API_KEY;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      result.apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
    }
    // Provider override
    if (process.env.PA_PROVIDER) {
      result.providers.default = process.env.PA_PROVIDER;
    }

    // Model override (default)
    if (process.env.PA_MODEL) {
      const providerConfig = result.providers[result.providers.default];
      if (providerConfig && typeof providerConfig === 'object' && 'model' in providerConfig) {
        providerConfig.model = process.env.PA_MODEL;
      }
    }

    // Queen agent configuration
    if (process.env.PA_QUEEN_PROVIDER) {
      result.hive.queen.provider = process.env.PA_QUEEN_PROVIDER;
    }
    if (process.env.PA_QUEEN_MODEL) {
      result.hive.queen.model = process.env.PA_QUEEN_MODEL;
    }

    // Worker agent configuration
    if (process.env.PA_WORKER_PROVIDER) {
      result.hive.worker.provider = process.env.PA_WORKER_PROVIDER;
    }
    if (process.env.PA_WORKER_MODEL) {
      result.hive.worker.model = process.env.PA_WORKER_MODEL;
    }

    // Temperature override
    if (process.env.PA_TEMPERATURE) {
      const temp = parseFloat(process.env.PA_TEMPERATURE);
      if (!isNaN(temp) && temp >= 0 && temp <= 2) {
        // Apply to all provider configs
        for (const [key, value] of Object.entries(result.providers)) {
          if (key !== 'default' && value && typeof value === 'object' && 'model' in value) {
            (value as { temperature?: number }).temperature = temp;
          }
        }
      }
    }

    // Max tokens override
    if (process.env.PA_MAX_TOKENS) {
      const maxTokens = parseInt(process.env.PA_MAX_TOKENS, 10);
      if (!isNaN(maxTokens) && maxTokens > 0) {
        for (const [key, value] of Object.entries(result.providers)) {
          if (key !== 'default' && value && typeof value === 'object' && 'model' in value) {
            (value as { maxTokens?: number }).maxTokens = maxTokens;
          }
        }
      }
    }

    // Max workers override
    if (process.env.PA_MAX_WORKERS) {
      const maxWorkers = parseInt(process.env.PA_MAX_WORKERS, 10);
      if (!isNaN(maxWorkers) && maxWorkers > 0) {
        result.hive.worker.maxConcurrent = maxWorkers;
      }
    }

    // Worker timeout override
    if (process.env.PA_WORKER_TIMEOUT) {
      const timeout = parseInt(process.env.PA_WORKER_TIMEOUT, 10);
      if (!isNaN(timeout) && timeout > 0) {
        result.hive.worker.timeout = timeout;
      }
    }

    // Ralph Loop max iterations
    if (process.env.PA_RALPH_MAX_ITERATIONS) {
      const maxIter = parseInt(process.env.PA_RALPH_MAX_ITERATIONS, 10);
      if (!isNaN(maxIter) && maxIter > 0) {
        result.hive.ralphLoop.maxIterations = maxIter;
      }
    }

    // Ollama host
    if (process.env.OLLAMA_HOST) {
      const ollamaCfg = result.providers.ollama;
      if (ollamaCfg && typeof ollamaCfg === 'object' && 'model' in ollamaCfg) {
        ollamaCfg.host = process.env.OLLAMA_HOST;
      }
    }

    // Server configuration
    if (process.env.PA_SERVER_PORT) {
      const port = parseInt(process.env.PA_SERVER_PORT, 10);
      if (!isNaN(port) && port > 0) {
        result.server.port = port;
      }
    }
    if (process.env.PA_SERVER_HOST) {
      result.server.host = process.env.PA_SERVER_HOST;
    }

    // Debug mode
    if (process.env.PA_DEBUG === 'true' || process.env.PA_DEBUG === '1') {
      result.logging.level = 'debug';
    }

    // Log level override
    if (process.env.PA_LOG_LEVEL) {
      const level = process.env.PA_LOG_LEVEL;
      if (['debug', 'info', 'warn', 'error'].includes(level)) {
        result.logging.level = level as 'debug' | 'info' | 'warn' | 'error';
      }
    }

    return result;
  }

  /**
   * Apply CLI option overrides
   */
  private static applyCLIOverrides(config: Config, options: CLIOptions): Config {
    const result = structuredClone(config);

    if (options.provider) {
      result.providers.default = options.provider;
    }

    if (options.model) {
      const providerConfig = result.providers[result.providers.default];
      if (providerConfig && typeof providerConfig === 'object' && 'model' in providerConfig) {
        providerConfig.model = options.model;
      }
    }

    if (options.stream === false) {
      result.cli.streamResponses = false;
    }

    if (options.debug) {
      result.logging.level = 'debug';
    }

    return result;
  }

  /**
   * Resolve the final config with active provider/model
   */
  private static resolveConfig(config: Config): ResolvedConfig {
    const activeProvider = config.providers.default;
    const providerConfig = config.providers[activeProvider];
    const activeModel = (providerConfig && typeof providerConfig === 'object' && 'model' in providerConfig)
      ? providerConfig.model
      : 'unknown';

    return {
      ...config,
      activeProvider,
      activeModel,
    };
  }
}
