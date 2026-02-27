import { describe, it, expect } from 'vitest';
import { UnifiedVerifier } from './verifiers.js';
import { MockProvider } from '../../test/helpers.js';

describe('UnifiedVerifier', () => {
  it('should use single-criterion path for simple criteria', async () => {
    const provider = new MockProvider({
      defaultResponse: JSON.stringify({
        complete: true, confidence: 0.95,
        feedback: 'All good', nextAction: undefined,
      }),
    });
    const verifier = new UnifiedVerifier(
      provider,
      'Find stock price',
      'Current AAPL stock price included',
    );
    const result = await verifier.check({ success: true, output: 'AAPL: $150', iterations: 1, tokenUsage: { input: 0, output: 0, total: 0 } });
    expect(result.complete).toBe(true);
    expect(result.dimensions).toBeUndefined(); // single criterion, no dimensions
  });

  it('should use dimensional path for multi-criterion tasks', async () => {
    const provider = new MockProvider({
      defaultResponse: JSON.stringify({
        complete: false, feedback: 'Missing criterion 2',
        dimensions: [
          { name: 'Price data', score: 0.9, passed: true, feedback: 'Good' },
          { name: 'Analyst opinions', score: 0.3, passed: false, feedback: 'Missing' },
        ],
      }),
    });
    const verifier = new UnifiedVerifier(
      provider,
      'Research AAPL',
      'Price data; Analyst opinions',  // semicolon = multi-criterion
    );
    const result = await verifier.check({ success: true, output: 'AAPL: $150', iterations: 1, tokenUsage: { input: 0, output: 0, total: 0 } });
    expect(result.complete).toBe(false);
    expect(result.dimensions).toHaveLength(2);
    // Confidence should be pessimistic (min of scores)
    expect(result.confidence).toBe(0.3);
  });

  it('should compute confidence as min score for dimensional path', async () => {
    const provider = new MockProvider({
      defaultResponse: JSON.stringify({
        complete: true, feedback: 'All criteria met',
        dimensions: [
          { name: 'Price data', score: 0.95, passed: true, feedback: 'Good' },
          { name: 'Analyst opinions', score: 0.85, passed: true, feedback: 'Good' },
          { name: 'Trend analysis', score: 0.9, passed: true, feedback: 'Good' },
        ],
      }),
    });
    const verifier = new UnifiedVerifier(
      provider,
      'Research AAPL',
      'Price data; Analyst opinions; Trend analysis',
    );
    const result = await verifier.check({ success: true, output: 'Full analysis', iterations: 1, tokenUsage: { input: 0, output: 0, total: 0 } });
    expect(result.confidence).toBe(0.85); // min of 0.95, 0.85, 0.9
  });
});
