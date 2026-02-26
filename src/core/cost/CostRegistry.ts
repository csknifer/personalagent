/**
 * Static registry of per-provider LLM pricing with cost calculation.
 */

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface ModelPricing {
  /** Cost in USD per 1 million input tokens */
  inputPer1M: number;
  /** Cost in USD per 1 million output tokens */
  outputPer1M: number;
}

export interface ProviderPricing {
  [model: string]: ModelPricing;
}

export interface CostRegistryOptions {
  overrides?: Record<string, ProviderPricing>;
}

const SELF_HOSTED_PROVIDERS = new Set(['ollama']);

const DEFAULT_PRICING: Record<string, ProviderPricing> = {
  openai: {
    'gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.0 },
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
    'gpt-4.1': { inputPer1M: 2.0, outputPer1M: 8.0 },
    'gpt-4.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60 },
    'gpt-4.1-nano': { inputPer1M: 0.10, outputPer1M: 0.40 },
    default: { inputPer1M: 2.50, outputPer1M: 10.0 },
  },
  anthropic: {
    'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'claude-haiku-4-5-20251001': { inputPer1M: 0.80, outputPer1M: 4.0 },
    'claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0 },
    default: { inputPer1M: 3.0, outputPer1M: 15.0 },
  },
  gemini: {
    'gemini-2.0-flash': { inputPer1M: 0.10, outputPer1M: 0.40 },
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
    'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.60 },
    default: { inputPer1M: 0.15, outputPer1M: 0.60 },
  },
  ollama: {
    default: { inputPer1M: 0, outputPer1M: 0 },
  },
};

export class CostRegistry {
  private readonly pricing: Record<string, ProviderPricing>;

  constructor(options?: CostRegistryOptions) {
    // Deep clone defaults then apply overrides
    this.pricing = structuredClone(DEFAULT_PRICING);

    if (options?.overrides) {
      for (const [provider, models] of Object.entries(options.overrides)) {
        if (!this.pricing[provider]) {
          this.pricing[provider] = {};
        }
        for (const [model, pricing] of Object.entries(models)) {
          this.pricing[provider][model] = pricing;
        }
      }
    }
  }

  /**
   * Calculate the cost in USD for a given provider, model, and token usage.
   * Returns 0 for self-hosted providers or unknown providers without pricing.
   */
  calculateCost(provider: string, model: string, usage: TokenUsage): number {
    if (SELF_HOSTED_PROVIDERS.has(provider)) {
      return 0;
    }

    const providerPricing = this.pricing[provider];
    if (!providerPricing) {
      return 0;
    }

    const modelPricing = providerPricing[model] ?? providerPricing['default'];
    if (!modelPricing) {
      return 0;
    }

    const inputCost = (usage.input / 1_000_000) * modelPricing.inputPer1M;
    const outputCost = (usage.output / 1_000_000) * modelPricing.outputPer1M;

    return inputCost + outputCost;
  }
}
