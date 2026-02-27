/**
 * Default configuration values
 */

import type { Config } from './types.js';

export const defaultConfig: Config = {
  apiKeys: {},
  
  providers: {
    default: 'gemini',
    gemini: {
      model: 'gemini-2.5-flash',
      models: [
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
      ],
      temperature: 0.7,
      maxTokens: 8192,
    },
    openai: {
      model: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
      temperature: 0.7,
      maxTokens: 4096,
    },
    anthropic: {
      model: 'claude-sonnet-4-20250514',
      models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-20241022'],
      temperature: 0.7,
      maxTokens: 8192,
    },
    ollama: {
      model: 'llama3',
      models: ['llama3', 'mistral', 'codellama', 'deepseek-coder'],
      host: 'http://localhost:11434',
      temperature: 0.7,
    },
  },
  
  hive: {
    queen: {
      provider: 'gemini',
      model: 'gemini-3-pro-preview',
      systemPrompt: null,
    },
    worker: {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      maxConcurrent: 4,
      timeout: 300000,
    },
    ralphLoop: {
      maxIterations: 10,
      verificationStrategy: 'auto' as const,
      dimensional: {
        enabled: true,
        convergenceThreshold: 0.05,
        passingScore: 0.8,
        stagnationWindow: 2,
        observationMasking: true,
        maxMaskedOutputLength: 200,
        reflexionEnabled: true,
      },
    },
    memory: {
      maxMessages: 100,
      maxTokens: 100000,
    },
  },
  
  prompts: {},
  
  skills: {
    enabled: true,
    paths: ['./skills', '~/.personalagent/skills'],
    autoDiscover: true,
  },
  
  mcp: {
    enabled: true,
    tools: {
      fileSystem: true,
      webSearch: true,
      codeExecution: true,
      shellExecution: {
        enabled: true,
        defaultTimeout: 30000,
        maxTimeout: 300000,
        blockedPatterns: [],
        maxOutputLength: 50000,
      },
    },
    sandbox: true,
    allowedRoots: [],
    servers: [
      {
        name: 'google-search',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'g-search-mcp@latest'],
        enabled: true,
        timeout: 60000,
        namespace: false,
      },
    ],
    expose: {
      enabled: false,
      stdio: { enabled: true },
      http: { enabled: true, path: '/mcp' },
    },
  },

  cli: {
    theme: 'auto',
    showWorkerStatus: true,
    verboseWorkerStatus: false,
    streamResponses: true,
    historyFile: '~/.personalagent/history.json',
    maxHistorySize: 1000,
  },

  server: {
    port: 3100,
    host: 'localhost',
    cors: true,
    eventThrottleMs: 250,
  },

  logging: {
    level: 'info',
    file: '~/.personalagent/logs/agent.log',
    includeTokenUsage: true,
  },
};
