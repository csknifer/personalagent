/**
 * Provider factory and exports
 */

import { GeminiProvider } from './GeminiProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { TrackedProvider, wrapWithTracking } from './TrackedProvider.js';
import type { LLMProvider } from './Provider.js';
import type { ResolvedConfig } from '../config/types.js';

export { LLMProvider } from './Provider.js';
export { GeminiProvider } from './GeminiProvider.js';
export { OpenAIProvider } from './OpenAIProvider.js';
export { AnthropicProvider } from './AnthropicProvider.js';
export { OllamaProvider } from './OllamaProvider.js';
export { TrackedProvider, wrapWithTracking, isTrackedProvider } from './TrackedProvider.js';
export type { TrackedProviderOptions, TrackedChatOptions } from './TrackedProvider.js';

export type { ChatOptions, ChatResponse, StreamChunk, ToolDefinition, ToolCall } from './Provider.js';

import type { ProviderConfig } from '../config/types.js';

/**
 * Get provider config with proper typing
 */
function getProviderConfig(config: ResolvedConfig, name: string): ProviderConfig | undefined {
  const providerCfg = config.providers[name as keyof typeof config.providers];
  if (typeof providerCfg === 'object' && providerCfg !== null && 'model' in providerCfg) {
    return providerCfg as ProviderConfig;
  }
  return undefined;
}

export interface CreateProviderOptions {
  /** Enable progress tracking for LLM calls */
  enableTracking?: boolean;
}

/**
 * Create an LLM provider based on configuration
 */
export function createProvider(config: ResolvedConfig, options?: CreateProviderOptions): LLMProvider {
  const providerName = config.activeProvider;
  const providerConfig = getProviderConfig(config, providerName);

  if (!providerConfig) {
    throw new Error(`Provider configuration not found: ${providerName}`);
  }

  let provider: LLMProvider;
  const resolvedType = providerConfig.type ?? providerName;

  switch (resolvedType) {
    case 'gemini': {
      const apiKey = providerConfig.apiKey || config.apiKeys.gemini;
      if (!apiKey) {
        throw new Error('Gemini API key not configured. Set GEMINI_API_KEY environment variable or add to config.');
      }
      provider = new GeminiProvider({
        apiKey,
        model: providerConfig.model,
        temperature: providerConfig.temperature,
        maxTokens: providerConfig.maxTokens,
        models: providerConfig.models,
      });
      break;
    }

    case 'openai': {
      const apiKey = providerConfig.apiKey || config.apiKeys.openai;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or add to config.');
      }
      provider = new OpenAIProvider({
        apiKey,
        model: providerConfig.model,
        temperature: providerConfig.temperature,
        maxTokens: providerConfig.maxTokens,
        baseUrl: providerConfig.baseUrl || undefined,
        models: providerConfig.models,
      });
      break;
    }

    case 'openai-compatible': {
      const apiKey = providerConfig.apiKey || config.apiKeys[providerName];
      if (!apiKey) {
        throw new Error(`API key not configured for provider '${providerName}'. Set apiKey in provider config or add to apiKeys.`);
      }
      if (!providerConfig.baseUrl) {
        throw new Error(`baseUrl is required for openai-compatible provider '${providerName}'.`);
      }
      provider = new OpenAIProvider({
        apiKey,
        model: providerConfig.model,
        temperature: providerConfig.temperature,
        maxTokens: providerConfig.maxTokens,
        baseUrl: providerConfig.baseUrl,
        models: providerConfig.models,
        providerName,
      });
      break;
    }

    case 'anthropic': {
      const apiKey = providerConfig.apiKey || config.apiKeys.anthropic;
      if (!apiKey) {
        throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY environment variable or add to config.');
      }
      provider = new AnthropicProvider({
        apiKey,
        model: providerConfig.model,
        temperature: providerConfig.temperature,
        maxTokens: providerConfig.maxTokens,
        models: providerConfig.models,
      });
      break;
    }

    case 'ollama': {
      provider = new OllamaProvider({
        model: providerConfig.model,
        host: providerConfig.host,
        temperature: providerConfig.temperature,
        models: providerConfig.models,
      });
      break;
    }

    default:
      throw new Error(`Unknown provider type: ${resolvedType}`);
  }

  // Wrap with tracking if enabled
  if (options?.enableTracking) {
    return wrapWithTracking(provider);
  }

  return provider;
}

/**
 * Create a provider for a specific role (queen or worker)
 * Falls back to default provider if not specified
 */
export function createRoleProvider(
  config: ResolvedConfig,
  role: 'queen' | 'worker',
  options?: CreateProviderOptions
): LLMProvider {
  const roleConfig = role === 'queen' ? config.hive.queen : config.hive.worker;
  
  // If role has specific provider/model, create a modified config
  if (roleConfig.provider || roleConfig.model) {
    const modifiedConfig = { ...config };
    
    if (roleConfig.provider) {
      modifiedConfig.activeProvider = roleConfig.provider;
    }
    
    if (roleConfig.model) {
      const currentProviderConfig = getProviderConfig(modifiedConfig, modifiedConfig.activeProvider);
      if (currentProviderConfig) {
        modifiedConfig.providers = {
          ...modifiedConfig.providers,
          [modifiedConfig.activeProvider]: {
            ...currentProviderConfig,
            model: roleConfig.model,
          },
        };
        modifiedConfig.activeModel = roleConfig.model;
      }
    }
    
    return createProvider(modifiedConfig, options);
  }
  
  return createProvider(config, options);
}
