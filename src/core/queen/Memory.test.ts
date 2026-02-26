import { describe, it, expect, beforeEach } from 'vitest';
import { Memory } from './Memory.js';
import type { Message } from '../types.js';

function createMessage(role: Message['role'], content: string, tokenCount?: number): Message {
  return {
    role,
    content,
    timestamp: new Date(),
    metadata: tokenCount !== undefined ? { tokenCount } : undefined,
  };
}

describe('Memory', () => {
  let memory: Memory;

  beforeEach(() => {
    memory = new Memory();
  });

  describe('addMessage / getMessages', () => {
    it('stores and retrieves messages', () => {
      memory.addMessage(createMessage('user', 'hello'));
      memory.addMessage(createMessage('assistant', 'hi'));
      const messages = memory.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('hello');
      expect(messages[1].content).toBe('hi');
    });

    it('returns a copy of messages (not the internal array)', () => {
      memory.addMessage(createMessage('user', 'test'));
      const messages = memory.getMessages();
      messages.push(createMessage('user', 'extra'));
      expect(memory.getMessages()).toHaveLength(1);
    });
  });

  describe('getContextMessages', () => {
    it('returns all messages including system by default', () => {
      memory.setSystemMessage('system prompt');
      memory.addMessage(createMessage('user', 'hello'));
      expect(memory.getContextMessages()).toHaveLength(2);
    });

    it('excludes system messages when includeSystem is false', () => {
      memory.setSystemMessage('system prompt');
      memory.addMessage(createMessage('user', 'hello'));
      const messages = memory.getContextMessages(false);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });
  });

  describe('getRecentMessages', () => {
    it('returns the last N messages', () => {
      for (let i = 0; i < 5; i++) {
        memory.addMessage(createMessage('user', `msg-${i}`));
      }
      const recent = memory.getRecentMessages(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].content).toBe('msg-3');
      expect(recent[1].content).toBe('msg-4');
    });
  });

  describe('setSystemMessage', () => {
    it('adds system message at the start', () => {
      memory.addMessage(createMessage('user', 'hello'));
      memory.setSystemMessage('system');
      const messages = memory.getMessages();
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('system');
    });

    it('replaces existing system message', () => {
      memory.setSystemMessage('first');
      memory.setSystemMessage('second');
      const system = memory.getMessages().filter(m => m.role === 'system');
      expect(system).toHaveLength(1);
      expect(system[0].content).toBe('second');
    });
  });

  describe('clear', () => {
    it('removes all non-system messages', () => {
      memory.setSystemMessage('system');
      memory.addMessage(createMessage('user', 'hello'));
      memory.addMessage(createMessage('assistant', 'hi'));
      memory.clear();
      const messages = memory.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
    });

    it('resets token count', () => {
      memory.addMessage(createMessage('user', 'hello', 50));
      expect(memory.getTotalTokensUsed()).toBe(50);
      memory.clear();
      expect(memory.getTotalTokensUsed()).toBe(0);
    });

    it('clears key points and preferences', () => {
      memory.addKeyPoint('important');
      memory.setUserPreference('lang', 'en');
      memory.clear();
      expect(memory.getKeyPoints()).toEqual([]);
      expect(memory.getUserPreference('lang')).toBeUndefined();
    });
  });

  describe('key points', () => {
    it('adds and retrieves key points', () => {
      memory.addKeyPoint('point 1');
      memory.addKeyPoint('point 2');
      expect(memory.getKeyPoints()).toEqual(['point 1', 'point 2']);
    });

    it('deduplicates key points', () => {
      memory.addKeyPoint('same');
      memory.addKeyPoint('same');
      expect(memory.getKeyPoints()).toEqual(['same']);
    });

    it('returns a copy', () => {
      memory.addKeyPoint('point');
      const points = memory.getKeyPoints();
      points.push('extra');
      expect(memory.getKeyPoints()).toHaveLength(1);
    });
  });

  describe('user preferences', () => {
    it('sets and gets preferences', () => {
      memory.setUserPreference('theme', 'dark');
      expect(memory.getUserPreference('theme')).toBe('dark');
    });

    it('overwrites existing preference', () => {
      memory.setUserPreference('theme', 'dark');
      memory.setUserPreference('theme', 'light');
      expect(memory.getUserPreference('theme')).toBe('light');
    });

    it('returns all preferences as record', () => {
      memory.setUserPreference('a', '1');
      memory.setUserPreference('b', '2');
      expect(memory.getUserPreferences()).toEqual({ a: '1', b: '2' });
    });
  });

  describe('summary', () => {
    it('sets and gets summary', () => {
      memory.setSummary('conversation about AI');
      expect(memory.getSummary()).toBe('conversation about AI');
    });

    it('returns undefined when no summary set', () => {
      expect(memory.getSummary()).toBeUndefined();
    });
  });

  describe('token tracking', () => {
    it('accumulates token counts from messages', () => {
      memory.addMessage(createMessage('user', 'hello', 10));
      memory.addMessage(createMessage('assistant', 'hi', 20));
      expect(memory.getTotalTokensUsed()).toBe(30);
    });

    it('ignores messages without tokenCount', () => {
      memory.addMessage(createMessage('user', 'hello'));
      expect(memory.getTotalTokensUsed()).toBe(0);
    });
  });

  describe('message count trimming', () => {
    it('trims oldest non-system messages when over maxMessages', () => {
      const mem = new Memory({ maxMessages: 3 });
      mem.setSystemMessage('system');
      for (let i = 0; i < 5; i++) {
        mem.addMessage(createMessage('user', `msg-${i}`));
      }
      const messages = mem.getMessages();
      // System + last 2 messages (maxMessages - 1 for system)
      expect(messages.length).toBeLessThanOrEqual(4);
      expect(messages[0].role).toBe('system');
    });

    it('preserves system message during trim', () => {
      const mem = new Memory({ maxMessages: 2 });
      mem.setSystemMessage('system');
      for (let i = 0; i < 5; i++) {
        mem.addMessage(createMessage('user', `msg-${i}`));
      }
      const messages = mem.getMessages();
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('system');
    });
  });

  describe('searchMessages', () => {
    it('finds messages containing query (case insensitive)', () => {
      memory.addMessage(createMessage('user', 'Hello World'));
      memory.addMessage(createMessage('assistant', 'goodbye'));
      memory.addMessage(createMessage('user', 'hello again'));
      const results = memory.searchMessages('hello');
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no match', () => {
      memory.addMessage(createMessage('user', 'hello'));
      expect(memory.searchMessages('xyz')).toEqual([]);
    });
  });

  describe('export / import', () => {
    it('round-trips memory state', () => {
      memory.setSystemMessage('system');
      memory.addMessage(createMessage('user', 'hello'));
      memory.addKeyPoint('key');
      memory.setUserPreference('pref', 'val');
      memory.setSummary('summary');

      const exported = memory.export();

      const newMemory = new Memory();
      newMemory.import(exported);

      expect(newMemory.getMessages()).toHaveLength(2);
      expect(newMemory.getKeyPoints()).toEqual(['key']);
      expect(newMemory.getUserPreference('pref')).toBe('val');
      expect(newMemory.getSummary()).toBe('summary');
    });
  });

  describe('token-based trimming', () => {
    it('trims oldest non-system messages when over maxTokens', () => {
      const mem = new Memory({ maxTokens: 100 });
      mem.addMessage(createMessage('user', 'msg1', 30));
      mem.addMessage(createMessage('assistant', 'msg2', 30));
      mem.addMessage(createMessage('user', 'msg3', 30));
      // Total = 90, still under 100

      mem.addMessage(createMessage('assistant', 'msg4', 30));
      // Total would be 120, triggers trim
      // Should remove oldest until under 100

      expect(mem.getTotalTokensUsed()).toBeLessThanOrEqual(100);
      expect(mem.getMessageCount()).toBeLessThan(4);
    });

    it('preserves system message during token trim', () => {
      const mem = new Memory({ maxTokens: 50 });
      mem.setSystemMessage('system');
      mem.addMessage(createMessage('user', 'msg1', 30));
      mem.addMessage(createMessage('assistant', 'msg2', 30));
      // Over budget, should trim non-system messages

      const messages = mem.getMessages();
      expect(messages[0].role).toBe('system');
    });

    it('recalculates tokens after message-count trim', () => {
      const mem = new Memory({ maxMessages: 3 });
      mem.addMessage(createMessage('user', 'a', 100));
      mem.addMessage(createMessage('user', 'b', 100));
      mem.addMessage(createMessage('user', 'c', 100));
      // 3 messages, at limit

      mem.addMessage(createMessage('user', 'd', 100));
      // Triggers message-count trim, oldest removed, tokens recalculated

      // Should only count tokens from remaining messages
      const messages = mem.getMessages();
      const expectedTokens = messages.reduce(
        (sum, m) => sum + (m.metadata?.tokenCount ?? 0),
        0
      );
      expect(mem.getTotalTokensUsed()).toBe(expectedTokens);
    });

    it('import recalculates tokens', () => {
      const mem1 = new Memory();
      mem1.addMessage(createMessage('user', 'hello', 50));
      mem1.addMessage(createMessage('assistant', 'hi', 25));
      const exported = mem1.export();

      const mem2 = new Memory();
      mem2.import(exported);
      expect(mem2.getTotalTokensUsed()).toBe(75);
    });
  });

  describe('getMessageCount', () => {
    it('returns correct count', () => {
      expect(memory.getMessageCount()).toBe(0);
      memory.addMessage(createMessage('user', 'hello'));
      expect(memory.getMessageCount()).toBe(1);
    });
  });
});
