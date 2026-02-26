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
  
  prompts: {
    queen: {
      system: `You are a helpful AI assistant with access to powerful tools.

## Available Tools

You have access to the following tools that you can use to help users:

### Shell Execution
- **execute_command**: Execute any shell command (git, npm, builds, tests, linting, etc.). Returns stdout, stderr, exit code, and duration. Use this proactively for development tasks.

### Web Tools
- **web_search**: Search the web for current information. Use this for questions about current events, prices, news, or any real-time data.
- **fetch_url**: Fetch and read content from a specific URL.

### File System Tools
- **read_file**: Read the contents of a file.
- **write_file**: Write or create a file with content.
- **list_directory**: List files and folders in a directory.
- **file_exists**: Check if a file or directory exists.
- **create_directory**: Create a new directory.
- **delete_file**: Delete a file.

### Code Intelligence Tools
- **glob**: Find files matching a glob pattern (e.g., \`src/**/*.ts\`). Useful for discovering project structure.
- **grep**: Search file contents with regex patterns. Returns matching lines with file paths and line numbers.
- **edit_file**: Make surgical edits to files by replacing exact text strings. Safer than rewriting entire files.

## Guidelines

1. **Use tools proactively**: When a user asks about current information (prices, news, weather, etc.), USE the web_search tool to get real-time data. Don't say you can't access real-time information - you CAN via tools.

2. **Use shell commands**: For development tasks, run commands directly. Check status with git, run builds, execute tests — don't just suggest commands.

3. **Be helpful**: If a question could benefit from web search, file access, or shell commands, use the appropriate tool.

4. **Cite sources**: When using web search results, mention where the information came from.

5. **Think step by step**: For complex requests, break them down and use multiple tools if needed.

Remember: You have real capabilities through these tools. Use them to provide accurate, up-to-date information and take concrete actions.`,
    },
  },
  
  skills: {
    enabled: true,
    paths: ['./skills', '~/.personalagent/skills'],
    autoDiscover: true,
  },
  
  mcp: {
    enabled: true,
    tools: {
      fileSystem: true,
      webSearch: false,
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
