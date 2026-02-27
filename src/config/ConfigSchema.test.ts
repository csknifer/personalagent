import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  ApiKeysSchema,
  ProviderConfigSchema,
  ProvidersConfigSchema,
  HiveConfigSchema,
  CLIConfigSchema,
  LoggingConfigSchema,
  SkillsConfigSchema,
  MCPConfigSchema,
} from './ConfigSchema.js';

describe('ApiKeysSchema', () => {
  it('accepts empty object', () => {
    const result = ApiKeysSchema.parse({});
    expect(result).toEqual({});
  });

  it('accepts valid API keys', () => {
    const result = ApiKeysSchema.parse({
      gemini: 'key1',
      openai: 'key2',
      anthropic: 'key3',
      tavily: 'key4',
    });
    expect(result.gemini).toBe('key1');
    expect(result.openai).toBe('key2');
  });

  it('allows partial keys', () => {
    const result = ApiKeysSchema.parse({ gemini: 'only-gemini' });
    expect(result.gemini).toBe('only-gemini');
    expect(result.openai).toBeUndefined();
  });
});

describe('ProviderConfigSchema', () => {
  it('requires model field', () => {
    expect(() => ProviderConfigSchema.parse({})).toThrow();
  });

  it('accepts valid provider config', () => {
    const result = ProviderConfigSchema.parse({ model: 'gpt-4o' });
    expect(result.model).toBe('gpt-4o');
    expect(result.temperature).toBe(0.7); // default
  });

  it('validates temperature range', () => {
    expect(() => ProviderConfigSchema.parse({ model: 'test', temperature: -1 })).toThrow();
    expect(() => ProviderConfigSchema.parse({ model: 'test', temperature: 3 })).toThrow();
  });

  it('validates maxTokens is positive', () => {
    expect(() => ProviderConfigSchema.parse({ model: 'test', maxTokens: 0 })).toThrow();
    expect(() => ProviderConfigSchema.parse({ model: 'test', maxTokens: -100 })).toThrow();
  });

  it('allows optional fields', () => {
    const result = ProviderConfigSchema.parse({
      model: 'test',
      temperature: 1.0,
      maxTokens: 4096,
      baseUrl: 'https://api.example.com',
    });
    expect(result.temperature).toBe(1.0);
    expect(result.maxTokens).toBe(4096);
  });
});

describe('HiveConfigSchema', () => {
  it('provides defaults for empty object', () => {
    const result = HiveConfigSchema.parse({});
    expect(result.worker.maxConcurrent).toBe(4);
    expect(result.worker.timeout).toBe(300000);
    expect(result.ralphLoop.maxIterations).toBe(5);
    expect(result.ralphLoop.verificationStrategy).toBe('auto');
  });

  it('accepts custom worker config', () => {
    const result = HiveConfigSchema.parse({
      worker: { maxConcurrent: 8, timeout: 60000 },
    });
    expect(result.worker.maxConcurrent).toBe(8);
    expect(result.worker.timeout).toBe(60000);
  });

  it('validates worker maxConcurrent is positive integer', () => {
    expect(() => HiveConfigSchema.parse({ worker: { maxConcurrent: 0 } })).toThrow();
    expect(() => HiveConfigSchema.parse({ worker: { maxConcurrent: -1 } })).toThrow();
  });
});

describe('CLIConfigSchema', () => {
  it('provides defaults', () => {
    const result = CLIConfigSchema.parse({});
    expect(result.theme).toBe('auto');
    expect(result.showWorkerStatus).toBe(true);
    expect(result.streamResponses).toBe(true);
    expect(result.maxHistorySize).toBe(1000);
  });

  it('validates theme enum', () => {
    expect(() => CLIConfigSchema.parse({ theme: 'invalid' })).toThrow();
  });

  it('accepts valid overrides', () => {
    const result = CLIConfigSchema.parse({
      theme: 'dark',
      showWorkerStatus: false,
      streamResponses: false,
    });
    expect(result.theme).toBe('dark');
    expect(result.showWorkerStatus).toBe(false);
  });
});

describe('LoggingConfigSchema', () => {
  it('provides defaults', () => {
    const result = LoggingConfigSchema.parse({});
    expect(result.level).toBe('info');
    expect(result.includeTokenUsage).toBe(true);
  });

  it('validates log level enum', () => {
    expect(() => LoggingConfigSchema.parse({ level: 'verbose' })).toThrow();
  });
});

describe('SkillsConfigSchema', () => {
  it('provides defaults', () => {
    const result = SkillsConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.autoDiscover).toBe(true);
    expect(result.paths).toEqual(['./skills', '~/.personalagent/skills']);
  });
});

describe('MCPConfigSchema', () => {
  it('provides defaults', () => {
    const result = MCPConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.tools.fileSystem).toBe(true);
    expect(result.tools.webSearch).toBe(true);
    expect(result.tools.codeExecution).toBe(true);
    expect(result.tools.shellExecution.enabled).toBe(true);
    expect(result.tools.shellExecution.defaultTimeout).toBe(30000);
    expect(result.tools.shellExecution.maxTimeout).toBe(300000);
    expect(result.tools.shellExecution.blockedPatterns).toEqual([]);
    expect(result.tools.shellExecution.maxOutputLength).toBe(50000);
  });
});

describe('ConfigSchema (full)', () => {
  it('requires providers field', () => {
    expect(() => ConfigSchema.parse({})).toThrow();
  });

  it('accepts minimal valid config', () => {
    const result = ConfigSchema.parse({
      providers: {
        default: 'gemini',
      },
    });
    expect(result.providers.default).toBe('gemini');
    expect(result.hive.worker.maxConcurrent).toBe(4);
    expect(result.mcp.enabled).toBe(true);
  });

  it('accepts any string as provider default', () => {
    const result = ConfigSchema.parse({
      providers: { default: 'custom-provider' },
    });
    expect(result.providers.default).toBe('custom-provider');
  });

  it('accepts full config', () => {
    const result = ConfigSchema.parse({
      apiKeys: { gemini: 'key' },
      providers: {
        default: 'gemini',
        gemini: { model: 'gemini-pro', temperature: 0.5 },
      },
      hive: {
        queen: { provider: 'gemini' },
        worker: { maxConcurrent: 2 },
        ralphLoop: { maxIterations: 5 },
      },
      cli: { theme: 'dark' },
      logging: { level: 'debug' },
    });
    expect(result.apiKeys.gemini).toBe('key');
    expect(result.providers.gemini?.model).toBe('gemini-pro');
    expect(result.hive.ralphLoop.maxIterations).toBe(5);
  });
});

describe('Extensible provider system', () => {
  it('allows custom provider keys to pass through ProvidersConfigSchema', () => {
    const result = ProvidersConfigSchema.parse({
      default: 'grok',
      grok: { model: 'grok-2', baseUrl: 'https://api.x.ai/v1', type: 'openai-compatible' },
    });
    expect(result.default).toBe('grok');
    expect((result as Record<string, unknown>).grok).toBeDefined();
  });

  it('allows custom API keys to pass through ApiKeysSchema', () => {
    const result = ApiKeysSchema.parse({
      gemini: 'gem-key',
      grok: 'xai-key',
    });
    expect(result.gemini).toBe('gem-key');
    expect((result as Record<string, unknown>).grok).toBe('xai-key');
  });

  it('accepts type and apiKey in ProviderConfigSchema', () => {
    const result = ProviderConfigSchema.parse({
      model: 'grok-2',
      type: 'openai-compatible',
      apiKey: 'xai-key',
      baseUrl: 'https://api.x.ai/v1',
    });
    expect(result.type).toBe('openai-compatible');
    expect(result.apiKey).toBe('xai-key');
  });

  it('accepts custom provider in full ConfigSchema', () => {
    const result = ConfigSchema.parse({
      apiKeys: { grok: 'xai-key' },
      providers: {
        default: 'grok',
        grok: {
          model: 'grok-2',
          type: 'openai-compatible',
          baseUrl: 'https://api.x.ai/v1',
          models: ['grok-2', 'grok-2-mini'],
        },
      },
    });
    expect(result.providers.default).toBe('grok');
    expect((result.apiKeys as Record<string, unknown>).grok).toBe('xai-key');
  });
});
