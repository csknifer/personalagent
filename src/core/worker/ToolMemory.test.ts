import { describe, it, expect } from 'vitest';
import { ToolMemory } from './ToolMemory.js';

describe('ToolMemory', () => {
  it('should track consecutive failures per tool', () => {
    const memory = new ToolMemory();
    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    memory.recordResult('read_file', { success: true });
    expect(memory.isBlocked('web_search')).toBe(true);
    expect(memory.isBlocked('read_file')).toBe(false);
  });

  it('should unblock tool after a successful call', () => {
    const memory = new ToolMemory();
    memory.recordResult('web_search', { success: false, error: 'Timeout', category: 'network' });
    memory.recordResult('web_search', { success: false, error: 'Timeout', category: 'network' });
    memory.recordResult('web_search', { success: true });
    expect(memory.isBlocked('web_search')).toBe(false);
  });

  it('should render tool status for prompt injection', () => {
    const memory = new ToolMemory();
    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    memory.recordResult('web_search', { success: false, error: 'Rate limit', category: 'quota' });
    const status = memory.renderForPrompt();
    expect(status).toContain('web_search');
    expect(status).toContain('UNAVAILABLE');
    expect(status).toContain('quota');
  });

  it('should not block after a single failure', () => {
    const memory = new ToolMemory();
    memory.recordResult('web_search', { success: false, error: 'Temporary', category: 'network' });
    expect(memory.isBlocked('web_search')).toBe(false);
  });

  it('should return empty string when no tools are blocked', () => {
    const memory = new ToolMemory();
    memory.recordResult('web_search', { success: true });
    expect(memory.renderForPrompt()).toBe('');
  });
});
