/**
 * Tests for iteration prompt builders.
 */

import { describe, it, expect } from 'vitest';
import { buildToolSystemPrompt } from './iterationPrompt.js';

describe('buildToolSystemPrompt', () => {
  it('should include fetch_url preference when both fetch_url and execute_command are available', () => {
    const tools = [
      { name: 'fetch_url', description: 'Fetch URL content', parameters: {} },
      { name: 'execute_command', description: 'Run shell command', parameters: {} },
      { name: 'web_search', description: 'Search the web', parameters: {} },
    ];
    const prompt = buildToolSystemPrompt(tools);
    expect(prompt).toContain('fetch_url');
    expect(prompt).toMatch(/not.*curl/i);
  });

  it('should not mention curl preference when fetch_url is absent', () => {
    const tools = [
      { name: 'execute_command', description: 'Run shell command', parameters: {} },
    ];
    const prompt = buildToolSystemPrompt(tools);
    expect(prompt).not.toMatch(/not.*curl/i);
  });

  it('should not mention curl preference when execute_command is absent', () => {
    const tools = [
      { name: 'fetch_url', description: 'Fetch URL content', parameters: {} },
    ];
    const prompt = buildToolSystemPrompt(tools);
    expect(prompt).not.toMatch(/not.*curl/i);
  });

  it('should include tool descriptions for all provided tools', () => {
    const tools = [
      { name: 'web_search', description: 'Search the web', parameters: {} },
      { name: 'read_file', description: 'Read a file', parameters: {} },
    ];
    const prompt = buildToolSystemPrompt(tools);
    expect(prompt).toContain('**web_search**');
    expect(prompt).toContain('**read_file**');
  });
});
