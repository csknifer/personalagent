/**
 * MCPConfigManager tests
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MCPConfigManager } from './MCPConfigManager.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Use a temp directory to avoid touching real config
const testDir = join(tmpdir(), `pa-mcp-test-${Date.now()}`);
const testProjectDir = join(testDir, 'project', '.personalagent');
const testUserDir = join(testDir, 'user', '.personalagent');

// Patch getPath to use test directories
const originalGetPath = MCPConfigManager.getPath.bind(MCPConfigManager);
const testPaths = {
  user: join(testUserDir, 'mcp.json'),
  project: join(testProjectDir, 'mcp.json'),
};

beforeAll(async () => {
  // Monkey-patch getPath for testing
  MCPConfigManager.getPath = ((scope: 'user' | 'project') => testPaths[scope]) as typeof MCPConfigManager.getPath;
  await mkdir(testProjectDir, { recursive: true });
  await mkdir(testUserDir, { recursive: true });
});

afterAll(async () => {
  MCPConfigManager.getPath = originalGetPath;
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean up test files between tests
  for (const path of Object.values(testPaths)) {
    if (existsSync(path)) {
      await rm(path);
    }
  }
});

describe('MCPConfigManager', () => {
  describe('read', () => {
    it('returns empty mcpServers when file does not exist', async () => {
      const data = await MCPConfigManager.read('project');
      expect(data.mcpServers).toEqual({});
    });

    it('reads existing mcp.json', async () => {
      await writeFile(testPaths.project, JSON.stringify({
        mcpServers: {
          test: { type: 'stdio', command: 'echo' },
        },
      }));

      const data = await MCPConfigManager.read('project');
      expect(data.mcpServers.test).toBeDefined();
      expect(data.mcpServers.test.command).toBe('echo');
    });
  });

  describe('addServer', () => {
    it('creates mcp.json and adds server', async () => {
      await MCPConfigManager.addServer('my-server', {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'some-package'],
      }, 'project');

      const data = await MCPConfigManager.read('project');
      expect(data.mcpServers['my-server']).toBeDefined();
      expect(data.mcpServers['my-server'].command).toBe('npx');
    });

    it('adds multiple servers to same file', async () => {
      await MCPConfigManager.addServer('first', { type: 'stdio', command: 'a' }, 'project');
      await MCPConfigManager.addServer('second', { type: 'http', url: 'https://example.com' }, 'project');

      const data = await MCPConfigManager.read('project');
      expect(Object.keys(data.mcpServers)).toHaveLength(2);
    });

    it('overwrites existing server with same name', async () => {
      await MCPConfigManager.addServer('test', { type: 'stdio', command: 'old' }, 'project');
      await MCPConfigManager.addServer('test', { type: 'stdio', command: 'new' }, 'project');

      const data = await MCPConfigManager.read('project');
      expect(data.mcpServers.test.command).toBe('new');
    });
  });

  describe('removeServer', () => {
    it('removes an existing server', async () => {
      await MCPConfigManager.addServer('to-remove', { type: 'stdio', command: 'x' }, 'project');
      const removed = await MCPConfigManager.removeServer('to-remove', 'project');

      expect(removed).toBe(true);
      const data = await MCPConfigManager.read('project');
      expect(data.mcpServers['to-remove']).toBeUndefined();
    });

    it('returns false for non-existent server', async () => {
      const removed = await MCPConfigManager.removeServer('nonexistent', 'project');
      expect(removed).toBe(false);
    });
  });

  describe('getServer', () => {
    it('returns server entry when found', async () => {
      await MCPConfigManager.addServer('target', { type: 'stdio', command: 'test' }, 'project');
      const entry = await MCPConfigManager.getServer('target', 'project');
      expect(entry).not.toBeNull();
      expect(entry!.command).toBe('test');
    });

    it('returns null when not found', async () => {
      const entry = await MCPConfigManager.getServer('missing', 'project');
      expect(entry).toBeNull();
    });
  });

  describe('listAll', () => {
    it('returns servers from both scopes', async () => {
      await MCPConfigManager.addServer('user-server', { type: 'stdio', command: 'a' }, 'user');
      await MCPConfigManager.addServer('project-server', { type: 'stdio', command: 'b' }, 'project');

      const all = await MCPConfigManager.listAll();
      expect(all).toHaveLength(2);
      expect(all.find(s => s.name === 'user-server')?.scope).toBe('user');
      expect(all.find(s => s.name === 'project-server')?.scope).toBe('project');
    });

    it('project scope overrides user scope on name collision', async () => {
      await MCPConfigManager.addServer('shared', { type: 'stdio', command: 'user-cmd' }, 'user');
      await MCPConfigManager.addServer('shared', { type: 'stdio', command: 'project-cmd' }, 'project');

      const all = await MCPConfigManager.listAll();
      const shared = all.find(s => s.name === 'shared');
      expect(shared?.scope).toBe('project');
      expect(shared?.entry.command).toBe('project-cmd');
    });

    it('returns empty array when no servers configured', async () => {
      const all = await MCPConfigManager.listAll();
      expect(all).toEqual([]);
    });
  });
});
