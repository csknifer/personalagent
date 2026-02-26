# Personal Agent CLI

A rich CLI-based chat agent with hive architecture, supporting multiple LLM providers.

## Features

- **Hive Architecture**: Queen (orchestrator) + Worker agents with Ralph Loop pattern
- **Multi-Provider Support**: Google Gemini, OpenAI, Anthropic, Ollama
- **MCP Integration**: Model Context Protocol for tools and resources
- **Skills System**: Modular, extensible capabilities
- **Rich CLI**: Beautiful terminal interface powered by Ink/React

## Installation

```bash
npm install
npm run build
npm link  # Makes 'personalagent' and 'pa' commands available globally
```

## Configuration

### Quick Start with .env

Copy the example environment file and add your API keys:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# API Keys
GEMINI_API_KEY=your-gemini-key

# Queen Agent (orchestrator) - use a more capable model
PA_QUEEN_MODEL=gemini-3-pro-preview

# Worker Agents (task executors) - use a faster model
PA_WORKER_MODEL=gemini-3-flash-preview
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `TAVILY_API_KEY` | Tavily web search API key | - |
| `PA_PROVIDER` | Default provider | `gemini` |
| `PA_MODEL` | Default model | `gemini-2.5-flash` |
| `PA_QUEEN_PROVIDER` | Queen agent provider | `gemini` |
| `PA_QUEEN_MODEL` | Queen agent model | `gemini-3-pro-preview` |
| `PA_WORKER_PROVIDER` | Worker agent provider | `gemini` |
| `PA_WORKER_MODEL` | Worker agent model | `gemini-3-flash-preview` |
| `PA_MAX_WORKERS` | Max concurrent workers | `4` |
| `PA_DEBUG` | Enable debug mode | `false` |

### YAML Configuration

You can also use YAML config files:
- Global: `~/.personalagent/config.yaml`
- Project: `./.personalagent/config.yaml`

```yaml
apiKeys:
  gemini: ${GEMINI_API_KEY}

hive:
  queen:
    provider: gemini
    model: gemini-3-pro-preview
  worker:
    provider: gemini
    model: gemini-3-flash-preview
```

## Usage

```bash
# Start interactive chat
personalagent

# Or use the short alias
pa

# With specific provider/model
pa --provider openai --model gpt-4o

# Quick model switch
pa -m gemini-2.5-pro
```

### In-Chat Commands

- `/config show` - Show current configuration
- `/config provider <name>` - Switch provider
- `/config model <name>` - Switch model
- `/help` - Show available commands

## Architecture

```
Queen Agent (Orchestrator)
├── Memory (conversation history)
├── Task Planner (decomposition)
└── Worker Pool
    ├── Worker 1 (Ralph Loop)
    ├── Worker 2 (Ralph Loop)
    └── Worker N (Ralph Loop)
```

## License

MIT
