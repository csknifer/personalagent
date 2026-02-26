import { describe, it, expect } from 'vitest';
import { classifyFast, type FastClassifierConfig } from './FastClassifier.js';

const defaultConfig: FastClassifierConfig = {
  enabled: true,
  maxTokensForDirect: 50,
  maxTokensForUncertain: 200,
};

describe('FastClassifier', () => {
  describe('greetings → direct', () => {
    const greetings = ['hi', 'Hello', 'Hey there', 'Thanks!', 'thank you', 'Good morning', 'goodbye', 'bye'];

    for (const greeting of greetings) {
      it(`classifies "${greeting}" as direct`, () => {
        const result = classifyFast(greeting, undefined, defaultConfig);
        expect(result.decision).toBe('direct');
        if (result.decision === 'direct') {
          expect(result.confidence).toBeGreaterThanOrEqual(0.99);
        }
      });
    }
  });

  describe('simple questions → direct', () => {
    const simpleQuestions = [
      'What is the weather?',
      'How does TypeScript work?',
      'Tell me about quantum computing',
      'Why is the sky blue?',
      'Find the latest React docs',
    ];

    for (const q of simpleQuestions) {
      it(`classifies "${q}" as direct`, () => {
        const result = classifyFast(q, undefined, defaultConfig);
        expect(result.decision).toBe('direct');
      });
    }
  });

  describe('multi-topic → uncertain', () => {
    it('detects "and also" conjunction', () => {
      const result = classifyFast('Search for the stock price and also find analyst opinions', undefined, defaultConfig);
      expect(result.decision).toBe('uncertain');
    });

    it('detects multiple question marks', () => {
      const result = classifyFast('What is the weather in NYC? What about London?', undefined, defaultConfig);
      expect(result.decision).toBe('uncertain');
    });

    it('detects enumerated lists', () => {
      const result = classifyFast('1. Find the stock price\n2. Get analyst opinions\n3. Summarize the news', undefined, defaultConfig);
      expect(result.decision).toBe('uncertain');
    });

    it('detects comparison requests', () => {
      const result = classifyFast('Compare React versus Vue for building SPAs', undefined, defaultConfig);
      expect(result.decision).toBe('uncertain');
    });

    it('detects bullet point lists', () => {
      const result = classifyFast('- Research competitor A\n- Research competitor B', undefined, defaultConfig);
      expect(result.decision).toBe('uncertain');
    });
  });

  describe('compound phrases with "and" → direct', () => {
    it('handles "pros and cons"', () => {
      const result = classifyFast('What are the pros and cons?', undefined, defaultConfig);
      expect(result.decision).toBe('direct');
    });

    it('handles "bread and butter"', () => {
      const result = classifyFast('What is the bread and butter of this framework?', undefined, defaultConfig);
      expect(result.decision).toBe('direct');
    });

    it('handles "strengths and weaknesses"', () => {
      const result = classifyFast('What are the strengths and weaknesses of Rust?', undefined, defaultConfig);
      expect(result.decision).toBe('direct');
    });
  });

  describe('edge cases', () => {
    it('empty message → direct', () => {
      const result = classifyFast('', undefined, defaultConfig);
      expect(result.decision).toBe('direct');
    });

    it('single word → direct', () => {
      const result = classifyFast('Help', undefined, defaultConfig);
      expect(result.decision).toBe('direct');
    });

    it('long single-topic question → direct if single question pattern', () => {
      const result = classifyFast(
        'How does the garbage collector in V8 handle concurrent marking and what optimizations does it use for large heap sizes?',
        undefined,
        defaultConfig,
      );
      // This is a single topic (V8 GC) so should be direct
      expect(result.decision).toBe('direct');
    });
  });
});
