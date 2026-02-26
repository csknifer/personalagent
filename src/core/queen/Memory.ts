/**
 * Conversation memory management for the Queen agent
 */

import type { Message, TokenUsage } from '../types.js';

interface MemoryOptions {
  maxMessages?: number;
  maxTokens?: number;
}

interface ConversationContext {
  summary?: string;
  keyPoints: string[];
  userPreferences: Map<string, string>;
}

export class Memory {
  private messages: Message[] = [];
  private context: ConversationContext = {
    keyPoints: [],
    userPreferences: new Map(),
  };
  private maxMessages: number;
  private maxTokens: number;
  private totalTokensUsed: number = 0;

  constructor(options: MemoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 100;
    this.maxTokens = options.maxTokens ?? 100000;
  }

  /**
   * Add a message to memory
   */
  addMessage(message: Message): void {
    this.messages.push(message);
    
    // Track token usage
    if (message.metadata?.tokenCount) {
      this.totalTokensUsed += message.metadata.tokenCount;
    }

    // Trim if exceeds limits
    this.trimIfNeeded();
  }

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get messages formatted for LLM context
   */
  getContextMessages(includeSystem: boolean = true): Message[] {
    if (includeSystem) {
      return this.messages;
    }
    return this.messages.filter(m => m.role !== 'system');
  }

  /**
   * Get recent messages up to a limit
   */
  getRecentMessages(count: number): Message[] {
    return this.messages.slice(-count);
  }

  /**
   * Set the system message
   */
  setSystemMessage(content: string): void {
    // Remove existing system message if any
    this.messages = this.messages.filter(m => m.role !== 'system');
    
    // Add new system message at the start
    this.messages.unshift({
      role: 'system',
      content,
      timestamp: new Date(),
    });
  }

  /**
   * Clear all messages except system
   */
  clear(): void {
    const systemMessage = this.messages.find(m => m.role === 'system');
    this.messages = systemMessage ? [systemMessage] : [];
    this.context = {
      keyPoints: [],
      userPreferences: new Map(),
    };
    this.totalTokensUsed = 0;
  }

  /**
   * Add a key point to remember
   */
  addKeyPoint(point: string): void {
    if (!this.context.keyPoints.includes(point)) {
      this.context.keyPoints.push(point);
    }
  }

  /**
   * Get key points
   */
  getKeyPoints(): string[] {
    return [...this.context.keyPoints];
  }

  /**
   * Set a user preference
   */
  setUserPreference(key: string, value: string): void {
    this.context.userPreferences.set(key, value);
  }

  /**
   * Get a user preference
   */
  getUserPreference(key: string): string | undefined {
    return this.context.userPreferences.get(key);
  }

  /**
   * Get all user preferences
   */
  getUserPreferences(): Record<string, string> {
    return Object.fromEntries(this.context.userPreferences);
  }

  /**
   * Set conversation summary
   */
  setSummary(summary: string): void {
    this.context.summary = summary;
  }

  /**
   * Get conversation summary
   */
  getSummary(): string | undefined {
    return this.context.summary;
  }

  /**
   * Get total token usage
   */
  getTotalTokensUsed(): number {
    return this.totalTokensUsed;
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Export memory state for persistence
   */
  export(): {
    messages: Message[];
    context: {
      summary?: string;
      keyPoints: string[];
      userPreferences: Record<string, string>;
    };
  } {
    return {
      messages: this.messages,
      context: {
        summary: this.context.summary,
        keyPoints: this.context.keyPoints,
        userPreferences: Object.fromEntries(this.context.userPreferences),
      },
    };
  }

  /**
   * Import memory state
   */
  import(data: ReturnType<Memory['export']>): void {
    this.messages = data.messages;
    this.context = {
      summary: data.context.summary,
      keyPoints: data.context.keyPoints,
      userPreferences: new Map(Object.entries(data.context.userPreferences)),
    };
    this.recalculateTokenCount();
  }

  /**
   * Trim messages if limits exceeded
   */
  private trimIfNeeded(): void {
    // Trim by message count — remove oldest logical units until within limit
    if (this.messages.length > this.maxMessages) {
      const systemIdx = this.messages.findIndex(m => m.role === 'system');
      const startIdx = systemIdx === 0 ? 1 : 0;
      while (this.messages.length > this.maxMessages) {
        if (!this.removeOldestLogicalUnit(startIdx)) break;
      }
      this.recalculateTokenCount();
    }

    // Trim by token budget — remove oldest logical units until within budget
    if (this.totalTokensUsed > this.maxTokens) {
      const systemIdx = this.messages.findIndex(m => m.role === 'system');
      const startIdx = systemIdx === 0 ? 1 : 0;
      while (this.totalTokensUsed > this.maxTokens && this.messages.length > startIdx + 1) {
        if (!this.removeOldestLogicalUnit(startIdx)) break;
      }
    }
  }

  /**
   * Remove the oldest "logical unit" starting at the given index.
   * A logical unit is either a plain message, or an [assistant+toolCalls] +
   * [user+toolResults] pair that must be removed atomically.
   */
  private removeOldestLogicalUnit(startIdx: number): boolean {
    if (startIdx >= this.messages.length) return false;
    const msg = this.messages[startIdx];

    // If this is an assistant message with tool calls, check if the next
    // message is the paired tool-result message and remove both together.
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const next = this.messages[startIdx + 1];
      if (next?.role === 'user' && next.toolResults && next.toolResults.length > 0) {
        const [a, b] = this.messages.splice(startIdx, 2);
        if (a.metadata?.tokenCount) this.totalTokensUsed -= a.metadata.tokenCount;
        if (b.metadata?.tokenCount) this.totalTokensUsed -= b.metadata.tokenCount;
        return true;
      }
    }

    // Plain message — remove just this one
    const [removed] = this.messages.splice(startIdx, 1);
    if (removed.metadata?.tokenCount) this.totalTokensUsed -= removed.metadata.tokenCount;
    return true;
  }

  /**
   * Recalculate total token count from current messages
   */
  private recalculateTokenCount(): void {
    this.totalTokensUsed = this.messages.reduce(
      (sum, m) => sum + (m.metadata?.tokenCount ?? 0),
      0
    );
  }

  /**
   * Search messages for content
   */
  searchMessages(query: string): Message[] {
    const lowerQuery = query.toLowerCase();
    return this.messages.filter(m => 
      m.content.toLowerCase().includes(lowerQuery)
    );
  }
}
