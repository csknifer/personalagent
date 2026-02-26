/**
 * MCPJsonLoader tests
 */
import { describe, it, expect } from 'vitest';
import { MCPJsonLoader } from './MCPJsonLoader.js';
import type { MCPJsonFile } from './types.js';

describe('MCPJsonLoader', () => {
  describe('toExternalServers', () => {
    it('converts mcpServers object to MCPExternalServer array', () => {
      const file: MCPJsonFile = {
        mcpServers: {
          'my-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@org/server'],
            enabled: true,
            timeout: 15000,
            namespace: false,
          },
        },
      };

      const result = MCPJsonLoader.toExternalServers(file);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('my-server');
      expect(result[0].transport).toBe('stdio');
      expect(result[0].command).toBe('npx');
      expect(result[0].args).toEqual(['-y', '@org/server']);
      expect(result[0].enabled).toBe(true);
      expect(result[0].timeout).toBe(15000);
      expect(result[0].namespace).toBe(false);
    });

    it('converts http server entry', () => {
      const file: MCPJsonFile = {
        mcpServers: {
          'remote-api': {
            type: 'http',
            url: 'https://api.example.com/mcp',
            timeout: 60000,
          },
        },
      };

      const result = MCPJsonLoader.toExternalServers(file);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('remote-api');
      expect(result[0].transport).toBe('http');
      expect(result[0].url).toBe('https://api.example.com/mcp');
      expect(result[0].timeout).toBe(60000);
    });

    it('applies defaults for optional fields', () => {
      const file: MCPJsonFile = {
        mcpServers: {
          minimal: {
            type: 'stdio',
            command: 'my-tool',
          },
        },
      };

      const result = MCPJsonLoader.toExternalServers(file);
      expect(result[0].enabled).toBe(true);
      expect(result[0].timeout).toBe(30000);
      expect(result[0].namespace).toBe(false);
    });

    it('converts multiple servers', () => {
      const file: MCPJsonFile = {
        mcpServers: {
          first: { type: 'stdio', command: 'tool-a' },
          second: { type: 'http', url: 'https://example.com/mcp' },
          third: { type: 'stdio', command: 'tool-b', enabled: false },
        },
      };

      const result = MCPJsonLoader.toExternalServers(file);
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('first');
      expect(result[1].name).toBe('second');
      expect(result[2].name).toBe('third');
      expect(result[2].enabled).toBe(false);
    });

    it('preserves toolFilter', () => {
      const file: MCPJsonFile = {
        mcpServers: {
          filtered: {
            type: 'stdio',
            command: 'tool',
            toolFilter: {
              blocklist: ['dangerous_tool'],
            },
          },
        },
      };

      const result = MCPJsonLoader.toExternalServers(file);
      expect(result[0].toolFilter).toEqual({ blocklist: ['dangerous_tool'] });
    });

    it('returns empty array for empty mcpServers', () => {
      const file: MCPJsonFile = { mcpServers: {} };
      const result = MCPJsonLoader.toExternalServers(file);
      expect(result).toEqual([]);
    });
  });

  describe('toJsonEntry', () => {
    it('converts MCPExternalServer back to JSON entry format', () => {
      const entry = MCPJsonLoader.toJsonEntry({
        name: 'test',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        enabled: true,
        timeout: 30000,
        namespace: false,
      });

      expect(entry.type).toBe('stdio');
      expect(entry.command).toBe('npx');
      expect(entry.args).toEqual(['-y', 'server']);
      expect(entry.enabled).toBe(true);
      // No 'name' field in JSON entry format
      expect('name' in entry).toBe(false);
    });
  });
});
