# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run dev          # Development mode with hot reload (tsx src/index.tsx)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled version (node dist/index.js)
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint on src/**/*.{ts,tsx}
npm test             # Run all tests (vitest run)
npm run test:watch   # Run tests in watch mode
npx vitest run src/core/utils.test.ts  # Run a single test file
```

### Web UI Commands

```bash
npm run dev:web      # Start backend + frontend concurrently (server:3100, vite:5173)
npm run dev:server   # Backend only (tsx src/index.tsx serve)
npm run dev:client   # Frontend only (cd web && npm run dev)
npm run build:web    # Build frontend (cd web && npm run build)
npm run serve        # Run compiled backend (node dist/index.js serve)
```

CLI binary names: `personalagent` or `pa` (available after `npm link`). Subcommands: default (Ink TUI), `serve` (web server). CLI flags: `--provider`, `--model` (`-m`), `--config`, `--no-stream`, `--debug`. The `serve` subcommand adds `--port` and `--host`.

## Architecture

This is a **multi-agent CLI chat system** using a hive architecture (Queen/Worker pattern) with two frontends: a React/Ink terminal UI and a React web UI.

### Core Data Flow

```
User Input → Queen.processMessage() / Queen.streamMessage()
  → TaskPlanner.plan()
    ├─ Direct: executeDirectRequest() — up to 5 tool-call rounds with MCP tools
    └─ Decomposed: WorkerPool → Worker[N] × ralphLoop() → Queen.aggregateResults()
```

Agent phases: `idle` → `planning` → `executing` → `verifying` → `aggregating` → `idle`. When 2+ workers complete, Queen makes an additional LLM call to synthesize results. Single worker results pass through directly.

### Key Layers

- **`src/cli/`** — React/Ink TUI. `App.tsx` is the root component. `useQueen.ts` hook bridges UI to core.
- **`src/server/`** — Web UI backend. `WebSocketHandler.ts` bridges browser clients to Queen via WebSocket. `protocol.ts` defines typed client/server message types. Serves static files from `web/dist/` in production. REST: `GET /api/health`, `GET /api/config`. WebSocket at `/ws`.
- **`web/`** — React + Vite + Tailwind CSS v4 frontend. `useQueenSocket.ts` manages WebSocket with exponential backoff reconnection. Components: `ChatPanel`, `WorkerPanel`, `PhaseIndicator`, `StatsBar`.
- **`src/core/queen/`** — Orchestrator. `Queen.ts` plans tasks via `TaskPlanner.ts`, manages conversation `Memory.ts`, dispatches to workers, and aggregates results. Skill context is injected as a system message when a skill matches.
- **`src/core/worker/`** — Task executors. `WorkerPool.ts` manages concurrency. Each `Worker.ts` runs tasks through `RalphLoop.ts`.
- **`src/providers/`** — LLM abstraction layer. `LLMProvider` is the abstract base class (`Provider.ts`). Concrete: `GeminiProvider`, `OpenAIProvider`, `AnthropicProvider`, `OllamaProvider`, plus `openai-compatible` (uses OpenAIProvider with custom `baseUrl`). `TrackedProvider` wraps any provider for call analytics via `ProgressTracker`.
- **`src/mcp/`** — MCP server. Tools: `read_file`, `write_file`, `list_directory`, `file_exists`, `delete_file`, `create_directory`, `web_search` (Tavily), `fetch_url`. File operations sandboxed to `mcp.allowedRoots` (defaults to `cwd()`).
- **`src/skills/`** — Extensible skill system. `SkillLoader` discovers skills from `./skills` and `~/.personalagent/skills`. Built-in skills: `research`, `code-assistant`, `file-organizer`, `git-assistant`, `skill-creator`, `task-planner`. Each skill has a `SKILL.md` and `resources/`. Matching uses keyword triggers from `skill.metadata.triggers`.
- **`src/config/`** — Multi-layer config: defaults → `~/.personalagent/config.yaml` → `./.personalagent/config.yaml` → custom file → env vars → CLI flags. Schema validated with Zod.
- **`src/bootstrap.ts`** — Shared initialization for both CLI and web server. Creates all core components and returns a `BootstrapResult`.
- **`prompts/`** — Overridable system prompts (`queen-system.md`, `worker-system.md`, `task-planning.md`, `research-system.md`). Referenced via `config.prompts` in YAML config.

### Ralph Loop Pattern

The core execution pattern in `RalphLoop.ts`: workers iterate on tasks with external verification until objectively complete or limits are hit. Each iteration can make up to 5 tool-call rounds. Configurable via `hive.ralphLoop.maxIterations` and `hive.worker.timeout`.

**Verification modes:**
- **LLMVerifier** (default) — single-criterion pass/fail with Reflexion: after a failed verification, a second LLM call generates strategic guidance injected into the next iteration.
- **DimensionalVerifier** (DCL) — activates when `hive.ralphLoop.dimensional.enabled: true` AND the task has multiple success criteria. Evaluates each criterion independently (scores 0.0–1.0) with convergence tracking (`converging | diverging | stagnating`).

Individual LLM calls have a 60-second timeout (`callWithTimeout`), separate from the overall worker timeout. Verbose tool outputs from previous iterations are observation-masked to control token usage. `yieldToEventLoop()` is called before each LLM call so React/Ink can render state updates.

### Provider System

Queen and Worker agents can use **different providers/models** (e.g., a capable model for Queen orchestration, a faster model for Worker execution). Provider factory in `src/providers/index.ts` creates instances by name. The `openai-compatible` provider type lets you point at any OpenAI-compatible API endpoint. `TrackedProvider` emits `llm_call` events with a `purpose` field (`planning | execution | verification | tool_followup | aggregation | direct`).

### Other Key Components

- **`ProgressTracker`** (`src/core/progress/`) — Global singleton tracking agent phases, per-worker progress, and LLM call stats by purpose/provider. Used by both CLI and web UI.
- **`HistoryManager`** (`src/core/HistoryManager.ts`) — Persists conversation to `~/.personalagent/history.json`. Uses dirty-flag pattern; trims to `cli.maxHistorySize` (default 1000) on save.
- **`ShutdownManager`** — Priority-based cleanup (higher number runs first). Each handler has a 5-second timeout. Second SIGINT forces `process.exit(1)`.
- **`DebugLogger`** — Writes to `~/.personalagent/debug.log` (not stderr) to avoid interfering with Ink UI. Enabled via `--debug` or `PA_LOG_LEVEL=debug`.

## TypeScript Conventions

- ES Modules (`"type": "module"`) — all local imports use `.js` extension
- Path alias `@/*` maps to `src/*` (configured in tsconfig but not widely used)
- JSX runtime: `react-jsx` for Ink components
- Target: ES2022, strict mode enabled

## Testing

Tests use Vitest with `describe`/`it` syntax and `globals: true` (no imports needed for `describe`/`it`/`expect`). Test files live alongside source files as `*.test.ts`. Config in `vitest.config.ts` (node environment, `vite-tsconfig-paths` plugin).

## Configuration

API keys via `.env` file or environment variables (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`). Copy `.env.example` for reference. `TAVILY_API_KEY` is optional (enables web search tool). Additional env vars: `OLLAMA_HOST`, `PA_TEMPERATURE`, `PA_MAX_TOKENS`, `PA_WORKER_TIMEOUT`, `PA_RALPH_MAX_ITERATIONS`, `PA_LOG_LEVEL`. Agent-specific overrides via `PA_QUEEN_*` / `PA_WORKER_*` env vars. See `config/default.yaml` for full schema.
