/**
 * Provider factory tests
 *
 * Tests createProvider() and createRoleProvider() — the critical path
 * that resolves config + API keys into provider instances.
 */

import { describe, it, expect } from 'vitest';
import { createProvider, createRoleProvider, TrackedProvider } from './index.js';
import { createMockConfig } from '../test/helpers.js';
import type { ResolvedConfig } from '../config/types.js';

/** Build a config with a specific provider set up */
function configWith(providerName: string, providerConfig: Record<string, unknown>, apiKeys: Record<string, string> = {}): ResolvedConfig {
  return createMockConfig({
    activeProvider: providerName,
    providers: {
      default: providerName,
      [providerName]: providerConfig as any,
    },
    apiKeys,
  });
}

describe('createProvider()', () => {
  describe('error handling', () => {
    it('should throw when provider config is not found', () => {
      const config = createMockConfig({ activeProvider: 'nonexistent' });

      expect(() => createProvider(config)).toThrow('Provider configuration not found: nonexistent');
    });

    it('should throw when gemini API key is missing', () => {
      const config = configWith('gemini', { model: 'gemini-pro' });

      expect(() => createProvider(config)).toThrow('Gemini API key not configured');
    });

    it('should throw when openai API key is missing', () => {
      const config = configWith('openai', { model: 'gpt-4' });

      expect(() => createProvider(config)).toThrow('OpenAI API key not configured');
    });

    it('should throw when anthropic API key is missing', () => {
      const config = configWith('anthropic', { model: 'claude-3' });

      expect(() => createProvider(config)).toThrow('Anthropic API key not configured');
    });

    it('should throw for unknown provider type', () => {
      const config = configWith('unknown', { model: 'some-model', type: 'unknown' });

      expect(() => createProvider(config)).toThrow('Unknown provider type: unknown');
    });

    it('should throw when openai-compatible provider has no baseUrl', () => {
      const config = configWith('custom', { model: 'model', type: 'openai-compatible' }, { custom: 'key-123' });

      expect(() => createProvider(config)).toThrow('baseUrl is required for openai-compatible');
    });

    it('should throw when openai-compatible provider has no API key', () => {
      const config = configWith('custom', { model: 'model', type: 'openai-compatible', baseUrl: 'http://localhost' });

      expect(() => createProvider(config)).toThrow('API key not configured');
    });
  });

  describe('successful creation', () => {
    it('should create a gemini provider with API key from config', () => {
      const config = configWith('gemini', { model: 'gemini-pro' }, { gemini: 'test-key' });

      const provider = createProvider(config);
      expect(provider.name).toBe('gemini');
      expect(provider.model).toBe('gemini-pro');
    });

    it('should create an openai provider', () => {
      const config = configWith('openai', { model: 'gpt-4' }, { openai: 'sk-test' });

      const provider = createProvider(config);
      expect(provider.name).toBe('openai');
      expect(provider.model).toBe('gpt-4');
    });

    it('should create an anthropic provider', () => {
      const config = configWith('anthropic', { model: 'claude-3-sonnet' }, { anthropic: 'sk-ant-test' });

      const provider = createProvider(config);
      expect(provider.name).toBe('anthropic');
      expect(provider.model).toBe('claude-3-sonnet');
    });

    it('should create an ollama provider without API key', () => {
      const config = configWith('ollama', { model: 'llama3' });

      const provider = createProvider(config);
      expect(provider.name).toBe('ollama');
      expect(provider.model).toBe('llama3');
    });

    it('should create an openai-compatible provider with custom baseUrl', () => {
      const config = configWith('custom-llm', {
        model: 'local-model',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8080/v1',
      }, { 'custom-llm': 'key-123' });

      const provider = createProvider(config);
      // OpenAI-compatible providers report as the custom name
      expect(provider.name).toBe('custom-llm');
    });

    it('should use per-provider apiKey over global apiKeys', () => {
      const config = configWith('openai', {
        model: 'gpt-4',
        apiKey: 'per-provider-key',
      }, { openai: 'global-key' });

      // Should not throw — per-provider key is used
      const provider = createProvider(config);
      expect(provider.name).toBe('openai');
    });

    it('should use type override to route to a different provider backend', () => {
      // A provider named "fast" but typed as "openai"
      const config = configWith('fast', { model: 'gpt-4o-mini', type: 'openai' }, { openai: 'sk-test' });

      const provider = createProvider(config);
      expect(provider.name).toBe('openai');
    });
  });

  describe('tracking', () => {
    it('should wrap with TrackedProvider when enableTracking is true', () => {
      const config = configWith('ollama', { model: 'llama3' });

      const provider = createProvider(config, { enableTracking: true });
      expect(provider).toBeInstanceOf(TrackedProvider);
    });

    it('should return raw provider when enableTracking is false', () => {
      const config = configWith('ollama', { model: 'llama3' });

      const provider = createProvider(config, { enableTracking: false });
      expect(provider).not.toBeInstanceOf(TrackedProvider);
    });
  });
});

describe('createRoleProvider()', () => {
  it('should use default provider when role has no overrides', () => {
    const config = configWith('ollama', { model: 'llama3' });

    const provider = createRoleProvider(config, 'queen');
    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe('llama3');
  });

  it('should override provider for queen role', () => {
    const config = createMockConfig({
      activeProvider: 'ollama',
      providers: {
        default: 'ollama',
        ollama: { model: 'llama3' },
        openai: { model: 'gpt-4' },
      },
      apiKeys: { openai: 'sk-test' },
      hive: {
        queen: { provider: 'openai', model: null, systemPrompt: null },
        worker: { provider: null, model: null, maxConcurrent: 4, timeout: 30000 },
        ralphLoop: { maxIterations: 3, verificationStrategy: 'auto' as const, dimensional: { enabled: true, convergenceThreshold: 0.05, passingScore: 0.8, stagnationWindow: 2, observationMasking: true, maxMaskedOutputLength: 200, reflexionEnabled: true } },
      },
    });

    const provider = createRoleProvider(config, 'queen');
    expect(provider.name).toBe('openai');
  });

  it('should override model for worker role', () => {
    const config = createMockConfig({
      activeProvider: 'openai',
      providers: {
        default: 'openai',
        openai: { model: 'gpt-4' },
      },
      apiKeys: { openai: 'sk-test' },
      hive: {
        queen: { provider: null, model: null, systemPrompt: null },
        worker: { provider: null, model: 'gpt-4o-mini', maxConcurrent: 4, timeout: 30000 },
        ralphLoop: { maxIterations: 3, verificationStrategy: 'auto' as const, dimensional: { enabled: true, convergenceThreshold: 0.05, passingScore: 0.8, stagnationWindow: 2, observationMasking: true, maxMaskedOutputLength: 200, reflexionEnabled: true } },
      },
    });

    const provider = createRoleProvider(config, 'worker');
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('gpt-4o-mini');
  });

  it('should fall back to default when role provider config is missing', () => {
    const config = createMockConfig({
      activeProvider: 'ollama',
      providers: {
        default: 'ollama',
        ollama: { model: 'llama3' },
      },
      hive: {
        queen: { provider: 'nonexistent', model: null, systemPrompt: null },
        worker: { provider: null, model: null, maxConcurrent: 4, timeout: 30000 },
        ralphLoop: { maxIterations: 3, verificationStrategy: 'auto' as const, dimensional: { enabled: true, convergenceThreshold: 0.05, passingScore: 0.8, stagnationWindow: 2, observationMasking: true, maxMaskedOutputLength: 200, reflexionEnabled: true } },
      },
    });

    // Queen points to 'nonexistent' which has no config — should throw
    expect(() => createRoleProvider(config, 'queen')).toThrow('Provider configuration not found');
  });
});
