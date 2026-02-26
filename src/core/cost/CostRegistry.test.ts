import { describe, it, expect } from 'vitest';
import { CostRegistry } from './CostRegistry.js';

describe('CostRegistry', () => {
  it('should return cost for known provider and model', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('openai', 'gpt-4o', { input: 1000, output: 500, total: 1500 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it('should calculate correct cost for openai gpt-4o', () => {
    const registry = new CostRegistry();
    // gpt-4o: $2.50/1M input, $10/1M output
    // 1000 input tokens = 1000/1_000_000 * 2.50 = 0.0025
    // 500 output tokens = 500/1_000_000 * 10 = 0.005
    // total = 0.0075
    const cost = registry.calculateCost('openai', 'gpt-4o', { input: 1000, output: 500, total: 1500 });
    expect(cost).toBeCloseTo(0.0075);
  });

  it('should return zero for self-hosted providers', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('ollama', 'llama3', { input: 10000, output: 5000, total: 15000 });
    expect(cost).toBe(0);
  });

  it('should use fallback pricing for unknown models', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('openai', 'gpt-future-9', { input: 1000, output: 500, total: 1500 });
    expect(cost).toBeGreaterThan(0);
  });

  it('should allow custom pricing overrides', () => {
    const registry = new CostRegistry({
      overrides: { 'openai-compatible': { default: { inputPer1M: 0.50, outputPer1M: 1.50 } } },
    });
    const cost = registry.calculateCost('openai-compatible', 'custom-model', { input: 1_000_000, output: 1_000_000, total: 2_000_000 });
    expect(cost).toBeCloseTo(2.0);
  });

  it('should return correct cost for anthropic models', () => {
    const registry = new CostRegistry();
    // claude-sonnet-4-6: $3/1M input, $15/1M output
    const cost = registry.calculateCost('anthropic', 'claude-sonnet-4-6', { input: 1_000_000, output: 1_000_000, total: 2_000_000 });
    expect(cost).toBeCloseTo(18.0);
  });

  it('should return correct cost for gemini models', () => {
    const registry = new CostRegistry();
    // gemini-2.0-flash: $0.10/1M input, $0.40/1M output
    const cost = registry.calculateCost('gemini', 'gemini-2.0-flash', { input: 1_000_000, output: 1_000_000, total: 2_000_000 });
    expect(cost).toBeCloseTo(0.50);
  });

  it('should return 0 for completely unknown provider', () => {
    const registry = new CostRegistry();
    const cost = registry.calculateCost('unknown-provider', 'some-model', { input: 1000, output: 500, total: 1500 });
    expect(cost).toBe(0);
  });

  it('should allow overriding existing provider model pricing', () => {
    const registry = new CostRegistry({
      overrides: { openai: { 'gpt-4o': { inputPer1M: 5.0, outputPer1M: 20.0 } } },
    });
    const cost = registry.calculateCost('openai', 'gpt-4o', { input: 1_000_000, output: 1_000_000, total: 2_000_000 });
    expect(cost).toBeCloseTo(25.0);
  });
});
