import { describe, it, expect, beforeEach } from 'vitest';
import { TrackedProvider, wrapWithTracking, isTrackedProvider } from './TrackedProvider.js';
import { MockProvider, createTestLogger } from '../test/helpers.js';
import type { LLMCallLogger } from '../core/progress/LLMCallLogger.js';

describe('TrackedProvider', () => {
  let mockProvider: MockProvider;
  let logger: LLMCallLogger;
  let tracked: TrackedProvider;

  beforeEach(() => {
    mockProvider = new MockProvider();
    logger = createTestLogger();
    tracked = new TrackedProvider(mockProvider, { logger });
  });

  describe('chat', () => {
    it('delegates to underlying provider', async () => {
      mockProvider.defaultResponse = 'hello';
      const result = await tracked.chat([
        { role: 'user', content: 'hi', timestamp: new Date() },
      ]);
      expect(result.content).toBe('hello');
      expect(mockProvider.chatCalls).toHaveLength(1);
    });

    it('returns token usage from underlying provider', async () => {
      const result = await tracked.chat([
        { role: 'user', content: 'hi', timestamp: new Date() },
      ]);
      expect(result.tokenUsage).toEqual({ input: 10, output: 20, total: 30 });
    });

    it('logs call start and end', async () => {
      await tracked.chat([
        { role: 'user', content: 'hi', timestamp: new Date() },
      ]);
      // Logger should have no active calls after completion
      expect(logger.getActiveCallCount()).toBe(0);
    });

    it('propagates errors from underlying provider', async () => {
      mockProvider.errorToThrow = new Error('API failed');
      await expect(
        tracked.chat([{ role: 'user', content: 'hi', timestamp: new Date() }])
      ).rejects.toThrow('API failed');
    });

    it('logs failed calls', async () => {
      mockProvider.errorToThrow = new Error('API failed');
      try {
        await tracked.chat([{ role: 'user', content: 'hi', timestamp: new Date() }]);
      } catch {
        // expected
      }
      expect(logger.getActiveCallCount()).toBe(0);
    });
  });

  describe('chatStream', () => {
    it('delegates to underlying provider and yields chunks', async () => {
      const chunks: string[] = [];
      for await (const chunk of tracked.chatStream([
        { role: 'user', content: 'hi', timestamp: new Date() },
      ])) {
        if (chunk.content) chunks.push(chunk.content);
      }
      expect(chunks).toContain('Mock response');
    });

    it('propagates stream errors', async () => {
      mockProvider.errorToThrow = new Error('Stream failed');
      const gen = tracked.chatStream([
        { role: 'user', content: 'hi', timestamp: new Date() },
      ]);
      await expect(gen.next()).rejects.toThrow('Stream failed');
    });
  });

  describe('complete', () => {
    it('wraps chat call for simple completion', async () => {
      mockProvider.defaultResponse = 'completed';
      const result = await tracked.complete('prompt');
      expect(result).toBe('completed');
      expect(mockProvider.chatCalls).toHaveLength(1);
    });
  });

  describe('supportsTools', () => {
    it('delegates to underlying provider', () => {
      expect(tracked.supportsTools()).toBe(false);
    });
  });

  describe('getAvailableModels', () => {
    it('delegates to underlying provider', () => {
      expect(tracked.getAvailableModels()).toEqual(['mock-model']);
    });
  });

  describe('getUnderlyingProvider', () => {
    it('returns the wrapped provider', () => {
      expect(tracked.getUnderlyingProvider()).toBe(mockProvider);
    });
  });

  describe('name and model', () => {
    it('exposes underlying provider name and model', () => {
      expect(tracked.name).toBe('mock');
      expect(tracked.model).toBe('mock-model');
    });
  });

  describe('withPurpose', () => {
    it('creates a new TrackedProvider with different purpose', async () => {
      const verification = tracked.withPurpose('verification');
      expect(verification).toBeInstanceOf(TrackedProvider);
      expect(verification).not.toBe(tracked);

      // Should still delegate to same underlying provider
      await verification.chat([{ role: 'user', content: 'test', timestamp: new Date() }]);
      expect(mockProvider.chatCalls).toHaveLength(1);
    });
  });

  describe('withWorkerId', () => {
    it('creates a new TrackedProvider with worker ID', async () => {
      const withWorker = tracked.withWorkerId('worker-1');
      expect(withWorker).toBeInstanceOf(TrackedProvider);
      expect(withWorker).not.toBe(tracked);

      await withWorker.chat([{ role: 'user', content: 'test', timestamp: new Date() }]);
      expect(mockProvider.chatCalls).toHaveLength(1);
    });
  });
});

describe('wrapWithTracking', () => {
  it('wraps a regular provider', () => {
    const provider = new MockProvider();
    const tracked = wrapWithTracking(provider);
    expect(tracked).toBeInstanceOf(TrackedProvider);
  });

  it('does not double-wrap TrackedProvider', () => {
    const provider = new MockProvider();
    const tracked = wrapWithTracking(provider);
    const doubleWrapped = wrapWithTracking(tracked);
    expect(doubleWrapped).toBe(tracked);
  });

  it('accepts options', () => {
    const provider = new MockProvider();
    const logger = createTestLogger();
    const tracked = wrapWithTracking(provider, {
      defaultPurpose: 'verification',
      workerId: 'w1',
      logger,
    });
    expect(tracked).toBeInstanceOf(TrackedProvider);
  });
});

describe('isTrackedProvider', () => {
  it('returns true for TrackedProvider', () => {
    const provider = new MockProvider();
    const tracked = new TrackedProvider(provider);
    expect(isTrackedProvider(tracked)).toBe(true);
  });

  it('returns false for regular provider', () => {
    const provider = new MockProvider();
    expect(isTrackedProvider(provider)).toBe(false);
  });
});
