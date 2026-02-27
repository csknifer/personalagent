# Bugfix Sweep Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 39 bugs found during full codebase scan — security vulns, logic errors, resource leaks, and UI freeze bugs.

**Architecture:** Group fixes by area and severity. Security-critical fixes first, then HIGH logic bugs, then MEDIUM/LOW. Each task is a self-contained commit targeting one area.

**Tech Stack:** TypeScript, Node.js, React, Vitest

---

## Phase 1: Security Fixes (CRITICAL + HIGH)

### Task 1: Path Traversal in Static File Serving

**Files:**
- Modify: `src/server/index.ts:124-152`
- Test: `src/server/index.test.ts` (create)

**Step 1: Write the failing test**

```typescript
// src/server/index.test.ts
import { describe, it, expect } from 'vitest';
import { resolve, join, normalize } from 'path';

// Extract the guard as a testable function
import { isPathInsideDir } from './index.js';

describe('isPathInsideDir', () => {
  const staticDir = resolve('/app/web/dist');

  it('allows normal paths', () => {
    expect(isPathInsideDir(join(staticDir, 'index.html'), staticDir)).toBe(true);
    expect(isPathInsideDir(join(staticDir, 'assets/main.js'), staticDir)).toBe(true);
  });

  it('blocks path traversal with ../', () => {
    expect(isPathInsideDir(resolve(staticDir, '../../../etc/passwd'), staticDir)).toBe(false);
  });

  it('blocks exact parent', () => {
    expect(isPathInsideDir(resolve(staticDir, '..'), staticDir)).toBe(false);
  });

  it('allows the dir itself', () => {
    expect(isPathInsideDir(staticDir, staticDir)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/index.test.ts`
Expected: FAIL — `isPathInsideDir` not exported

**Step 3: Implement the fix**

In `src/server/index.ts`, add an exported guard function and use it in static serving:

```typescript
// Export for testing
export function isPathInsideDir(filePath: string, dir: string): boolean {
  const resolved = resolve(filePath);
  const resolvedDir = resolve(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + sep);
}
```

Then in the static file serving section (~line 127), add the guard:

```typescript
let filePath = join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);

// Security: ensure resolved path stays inside staticDir
if (!isPathInsideDir(filePath, staticDir)) {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Forbidden');
  return;
}
```

Import `sep` from `path` at top of file.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/index.ts src/server/index.test.ts
git commit -m "fix(security): add path traversal guard to static file serving"
```

---

### Task 2: SSRF Protection for fetch_url

**Files:**
- Modify: `src/mcp/tools/webSearch.ts:109-131`
- Test: `src/mcp/tools/webSearch.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to existing `src/mcp/tools/webSearch.test.ts`:

```typescript
describe('fetchUrlTool SSRF protection', () => {
  it('blocks localhost URLs', async () => {
    const result = await fetchUrlTool('http://127.0.0.1/admin');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks private network IPs', async () => {
    const result = await fetchUrlTool('http://10.0.0.1/internal');
    expect(result.success).toBe(false);
  });

  it('blocks IPv6 loopback', async () => {
    const result = await fetchUrlTool('http://[::1]/admin');
    expect(result.success).toBe(false);
  });

  it('blocks cloud metadata endpoint', async () => {
    const result = await fetchUrlTool('http://169.254.169.254/latest/meta-data/');
    expect(result.success).toBe(false);
  });

  it('allows normal public URLs', async () => {
    // This will fail to fetch but should NOT be blocked by SSRF check
    const result = await fetchUrlTool('https://example.com');
    // It either succeeds or fails with a network error, NOT an SSRF error
    if (!result.success) {
      expect(result.error).not.toContain('not allowed');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/tools/webSearch.test.ts`
Expected: FAIL — localhost URLs are not blocked

**Step 3: Implement the fix**

In `src/mcp/tools/webSearch.ts`, after the scheme validation block (~line 123), add:

```typescript
// SSRF: block requests to private/internal network addresses
const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
if (isPrivateHost(hostname)) {
  return {
    success: false,
    error: `Fetching internal/private network addresses is not allowed: "${hostname}"`,
  };
}
```

Add the helper function above `fetchUrlTool`:

```typescript
function isPrivateHost(hostname: string): boolean {
  // Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  // IPv4 private ranges
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    if (parts[0] === 10) return true;                                    // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;              // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;              // link-local
    if (parts[0] === 0) return true;                                     // 0.0.0.0/8
  }
  return false;
}
```

Also add `redirect: 'manual'` to the fetch options (~line 125) to prevent redirect-based SSRF:

```typescript
const response = await fetch(url, {
  redirect: 'manual',
  headers: { ... },
});

// Handle redirects manually - validate redirect target
if (response.status >= 300 && response.status < 400) {
  const location = response.headers.get('location');
  if (!location) {
    return { success: false, error: 'Redirect with no Location header' };
  }
  try {
    const redirectUrl = new URL(location, url);
    if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
      return { success: false, error: `Redirect to disallowed scheme: ${redirectUrl.protocol}` };
    }
    const redirectHost = redirectUrl.hostname.replace(/^\[|\]$/g, '');
    if (isPrivateHost(redirectHost)) {
      return { success: false, error: `Redirect to internal address not allowed: ${redirectHost}` };
    }
    // Follow one redirect
    return fetchUrlTool(redirectUrl.toString());
  } catch {
    return { success: false, error: `Invalid redirect URL: ${location}` };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/tools/webSearch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp/tools/webSearch.ts src/mcp/tools/webSearch.test.ts
git commit -m "fix(security): add SSRF protection to fetch_url — block private IPs and validate redirects"
```

---

### Task 3: Glob Pattern Traversal Guard

**Files:**
- Modify: `src/mcp/tools/codeIntelligence.ts:73-96`
- Test: `src/mcp/tools/codeIntelligence.test.ts` (add tests)

**Step 1: Write the failing test**

Add to existing test file:

```typescript
describe('globTool sandbox traversal', () => {
  it('blocks patterns with ../ traversal', async () => {
    const result = await globTool('../../../etc/*', {
      cwd: process.cwd(),
      sandbox: { enabled: true, allowedRoots: [process.cwd()] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('traversal');
  });

  it('allows normal patterns within sandbox', async () => {
    const result = await globTool('**/*.ts', {
      cwd: process.cwd(),
      sandbox: { enabled: true, allowedRoots: [process.cwd()] },
    });
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/tools/codeIntelligence.test.ts`
Expected: FAIL — `../` patterns are not blocked

**Step 3: Implement the fix**

In `src/mcp/tools/codeIntelligence.ts`, in `globTool` after the `cwd` guard (~line 83), add:

```typescript
// Block path traversal in patterns
if (options.sandbox?.enabled && pattern.includes('..')) {
  return {
    success: false,
    error: 'Glob pattern contains path traversal ("..") which is not allowed in sandbox mode',
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/tools/codeIntelligence.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp/tools/codeIntelligence.ts src/mcp/tools/codeIntelligence.test.ts
git commit -m "fix(security): block path traversal in glob patterns when sandbox enabled"
```

---

### Task 4: Ollama Provider — Streaming Tools + supportsTools Fix

**Files:**
- Modify: `src/providers/OllamaProvider.ts:99-135`
- Test: `src/providers/OllamaProvider.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to existing test file:

```typescript
describe('OllamaProvider chatStream with tools', () => {
  it('passes tools to the streaming API call', async () => {
    // Verify the chat call includes tools option
    const mockChat = vi.fn().mockReturnValue((async function* () {
      yield { message: { content: 'response', tool_calls: undefined } };
    })());

    const provider = new OllamaProvider({
      model: 'llama3.1',
      client: { chat: mockChat } as any,
    });

    const tools = [{ name: 'test_tool', description: 'test', inputSchema: { type: 'object', properties: {} } }];
    const gen = provider.chatStream([{ role: 'user', content: 'test' }], { tools });
    for await (const _ of gen) { /* drain */ }

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.any(Array),
      })
    );
  });
});

describe('OllamaProvider supportsTools', () => {
  it('matches model names with version tags', () => {
    const provider = new OllamaProvider({ model: 'llama3.1:8b' } as any);
    expect(provider.supportsTools()).toBe(true);
  });

  it('matches plain model names', () => {
    const provider = new OllamaProvider({ model: 'llama3' } as any);
    expect(provider.supportsTools()).toBe(true);
  });

  it('matches mistral variants', () => {
    const provider = new OllamaProvider({ model: 'mistral:latest' } as any);
    expect(provider.supportsTools()).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/OllamaProvider.test.ts`
Expected: FAIL

**Step 3: Implement the fix**

In `src/providers/OllamaProvider.ts`:

Fix `chatStream` (~line 99-107) — add tools to the API call:

```typescript
async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
  const response = await this.client.chat({
    model: this.model,
    messages: this.convertMessages(messages),
    tools: this.convertTools(options?.tools) as undefined,
    options: {
      temperature: options?.temperature ?? this.defaultTemperature,
    },
    stream: true,
  });
```

Fix `supportsTools` (~line 132-135) — use prefix matching:

```typescript
supportsTools(): boolean {
  const base = this.model.split(':')[0].toLowerCase();
  const toolCapableModels = ['llama3', 'llama3.1', 'llama3.2', 'llama3.3', 'mistral', 'mixtral', 'qwen2.5', 'command-r'];
  return toolCapableModels.some(m => base === m || base.startsWith(m + '.'));
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/OllamaProvider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/OllamaProvider.ts src/providers/OllamaProvider.test.ts
git commit -m "fix: Ollama streaming now passes tools, supportsTools uses prefix matching"
```

---

### Task 5: OpenAI Streaming — Safe JSON Parse + Multi-Tool Fix

**Files:**
- Modify: `src/providers/OpenAIProvider.ts:143-203`
- Test: `src/providers/OpenAIProvider.test.ts` (add tests)

**Step 1: Write the failing test**

Add to existing test file:

```typescript
describe('OpenAI chatStream tool call handling', () => {
  it('uses safeParseToolArgs for the final tool call', async () => {
    // Create a mock stream that produces a truncated tool call
    const mockCreate = vi.fn().mockReturnValue((async function* () {
      yield { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'test', arguments: '{"key": "val' } }] } }] };
      // Stream ends mid-JSON
    })());

    const provider = new OpenAIProvider({ model: 'gpt-4', client: { chat: { completions: { create: mockCreate } } } } as any);
    const chunks: any[] = [];
    const gen = provider.chatStream([{ role: 'user', content: 'test' }]);
    for await (const chunk of gen) {
      chunks.push(chunk);
    }

    // Should not throw, should produce a tool call with graceful parse
    const toolCall = chunks.find(c => c.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCall.arguments).toBeDefined(); // Should not throw
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/OpenAIProvider.test.ts`
Expected: FAIL — `JSON.parse` throws on truncated JSON

**Step 3: Implement the fix**

In `src/providers/OpenAIProvider.ts` line 197, replace:
```typescript
arguments: JSON.parse(currentToolCall.arguments || '{}'),
```
with:
```typescript
arguments: safeParseToolArgs(currentToolCall.arguments),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/OpenAIProvider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/OpenAIProvider.ts src/providers/OpenAIProvider.test.ts
git commit -m "fix: use safeParseToolArgs for final streaming tool call in OpenAI provider"
```

---

## Phase 2: HIGH Logic Bugs

### Task 6: Fix Task/Result Index Misalignment in aggregateResults

**Files:**
- Modify: `src/core/queen/Queen.ts:862-927`

**Step 1: Understand the bug**

`finalResults` (line 862-866) filters tasks that have no result via `if (result)`, making the array shorter than `allTasks`. Then `aggregateResults` (line 921) loops over `tasks` and `results` by index — misaligning them.

**Step 2: Fix the code**

The simplest fix is to make `aggregateResults` receive paired data instead of parallel arrays. Change the `finalResults` building at lines 862-866 to also build paired task data, then pass task-result pairs to `aggregateResults`.

Alternative (simpler, minimal change): change `aggregateResults` to receive `tasks` and a `Map<string, TaskResult>` instead of parallel arrays, and look up by task ID.

In `handleDecomposedRequest` (~line 862-866), change to:

```typescript
// Build final task-result pairs for aggregation
const finalPairs: Array<{ task: Task; result: TaskResult }> = [];
for (const task of allTasks) {
  const result = allResults.get(task.id);
  if (result) finalPairs.push({ task, result });
}
```

Change the call at line 888:
```typescript
return this.aggregateResults(originalRequest, finalPairs);
```

Change `aggregateResults` signature and body:
```typescript
private async aggregateResults(
  originalRequest: string,
  taskResults: Array<{ task: Task; result: TaskResult }>,
): Promise<{ content: string; tokenUsage?: TokenUsage }> {
  const workerTokens: TokenUsage = { input: 0, output: 0, total: 0 };
  for (const { result } of taskResults) {
    if (result.tokenUsage) {
      workerTokens.input += result.tokenUsage.input;
      workerTokens.output += result.tokenUsage.output;
      workerTokens.total += result.tokenUsage.total;
    }
  }

  const successful = taskResults.filter(({ result }) => result.success && result.output.trim());
  const failed = taskResults.filter(({ result }) => !result.success || !result.output.trim());
  // ... rest stays the same but uses successful/failed arrays of {task, result}
```

Also update the only other call site (if any). Search for `this.aggregateResults(` to find all callers.

**Step 3: Run all tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/queen/Queen.ts
git commit -m "fix: aggregateResults uses task-result pairs instead of index alignment"
```

---

### Task 7: Fix WebSocket Error Handling + Mid-Stream Disconnect

**Files:**
- Modify: `web/src/hooks/useQueenSocket.ts:117-134, 222-271, 305-316`

**Step 1: Fix error handling — accept errors without messageId**

At line 117-134, change the error case:

```typescript
case 'error':
  if (msg.messageId && activeMessageIdRef.current === msg.messageId) {
    // Error during specific message processing
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Error: ${msg.error}`,
        timestamp: new Date().toISOString(),
      },
    ]);
  } else if (!msg.messageId && isProcessing) {
    // Generic server error while processing
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Error: ${msg.error}`,
        timestamp: new Date().toISOString(),
      },
    ]);
  }
  // Always reset processing state on any error
  setStreamingContent('');
  setStreamingToolCalls([]);
  streamAccumulatorRef.current = '';
  activeMessageIdRef.current = null;
  setIsProcessing(false);
  break;
```

**Step 2: Fix mid-stream disconnect — reset state on close**

In the `ws.onclose` handler (~line 242), add state cleanup:

```typescript
ws.onclose = () => {
  setConnected(false);
  wsRef.current = null;

  // Reset processing state on disconnect — prevents UI freeze
  if (activeMessageIdRef.current) {
    setStreamingContent('');
    setStreamingToolCalls([]);
    streamAccumulatorRef.current = '';
    activeMessageIdRef.current = null;
    setIsProcessing(false);
  }

  scheduleReconnect();
};
```

**Step 3: Fix connect — guard against CONNECTING state**

At line 222-223, change the guard:

```typescript
const connect = useCallback(() => {
  if (wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING) return;
```

**Step 4: Fix cleanup — prevent post-unmount reconnect**

Add a ref to track intentional close, and check it in onclose:

```typescript
// Add near other refs:
const intentionalCloseRef = useRef(false);

// In ws.onclose:
ws.onclose = () => {
  setConnected(false);
  wsRef.current = null;
  // Reset processing state ...
  if (!intentionalCloseRef.current) {
    scheduleReconnect();
  }
};

// In cleanup:
return () => {
  intentionalCloseRef.current = true;
  if (reconnectTimeoutRef.current) {
    clearTimeout(reconnectTimeoutRef.current);
  }
  wsRef.current?.close();
};
```

**Step 5: Fix clearMessages — reset activeMessageIdRef**

At line 305-316, add the missing reset:

```typescript
const clearMessages = useCallback(() => {
  send({ type: 'clear_conversation' });
  setMessages([]);
  setWorkers([]);
  setPhase('idle');
  setReasoning(null);
  setIsProcessing(false);
  setStreamingContent('');
  setStreamingToolCalls([]);
  setDiscoveryState(null);
  streamAccumulatorRef.current = '';
  activeMessageIdRef.current = null;  // ADD THIS
}, [send]);
```

**Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add web/src/hooks/useQueenSocket.ts
git commit -m "fix: WebSocket error handling, mid-stream disconnect recovery, prevent post-unmount reconnect"
```

---

## Phase 3: MEDIUM Bugs

### Task 8: Fix Timer Leaks in streamWithTimeout and DiscoveryCoordinator

**Files:**
- Modify: `src/core/queen/Queen.ts:33-49`
- Modify: `src/core/queen/DiscoveryCoordinator.ts:104-110`

**Step 1: Fix streamWithTimeout — use clearable timeout pattern**

Replace lines 33-49:

```typescript
async function* streamWithTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  label: string,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out — no response after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (result.done) break;
    yield result.value;
  }
}
```

**Step 2: Fix DiscoveryCoordinator — clear timer on resolution**

Replace lines 104-110:

```typescript
// Execute wave with per-wave timeout
const waveStart = Date.now();
let waveTimer: ReturnType<typeof setTimeout> | undefined;
const results = await Promise.race([
  this.workerPool.executeTasks(currentTasks),
  new Promise<Map<string, TaskResult>>((_, reject) => {
    waveTimer = setTimeout(
      () => reject(new Error(`Wave ${wave} timed out after ${this.config.waveTimeout}ms`)),
      this.config.waveTimeout,
    );
  }),
]).catch(() => new Map<string, TaskResult>())
  .finally(() => {
    if (waveTimer) clearTimeout(waveTimer);
  });
```

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/queen/Queen.ts src/core/queen/DiscoveryCoordinator.ts
git commit -m "fix: clear timeout timers in streamWithTimeout and DiscoveryCoordinator Promise.race"
```

---

### Task 9: Fix Discovery Path Duplicate Memory Storage

**Files:**
- Modify: `src/core/queen/Queen.ts:643-671, 250-261`

**Step 1: Fix the bug**

The fix is to NOT store in memory inside `handleDecomposedRequest` for discovery mode — let `processMessage` handle it.

At line 662-667, remove or guard the memory storage:

```typescript
// Discovery result — don't add to memory here; processMessage/streamMessage will do it
this.emitPhaseChange('idle');
return { content: discoveryResult.content };
```

Remove lines 663-667 (the `this.memory.addMessage` call).

**Step 2: Run tests**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/queen/Queen.ts
git commit -m "fix: remove duplicate memory storage in discovery path"
```

---

### Task 10: Fix setProvider Dropping adaptiveTimeout

**Files:**
- Modify: `src/core/queen/Queen.ts:1460-1466`

**Step 1: Fix the code**

Replace lines 1460-1466:

```typescript
setProvider(provider: LLMProvider): void {
  this.provider = provider;
  const planningProvider = isTrackedProvider(provider)
    ? provider.withPurpose('planning')
    : wrapWithTracking(provider, { defaultPurpose: 'planning' });
  this.taskPlanner = new TaskPlanner(planningProvider, {
    adaptiveTimeout: this.config.hive.ralphLoop.adaptiveTimeout,
  });
}
```

**Step 2: Run tests**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/queen/Queen.ts
git commit -m "fix: setProvider preserves adaptiveTimeout config for TaskPlanner"
```

---

### Task 11: Fix WorkerPool — Handle Rejected Tasks + Clean Up Workers

**Files:**
- Modify: `src/core/worker/WorkerPool.ts:153-168, 246`
- Test: `src/core/worker/WorkerPool.test.ts` (add test)

**Step 1: Fix rejected task handling**

At lines 153-160, add handling for rejected status:

```typescript
for (const settled of batchSettled) {
  if (settled.status === 'fulfilled') {
    const { taskId, result } = settled.value;
    results.set(taskId, result);
    completed.add(taskId);
  } else {
    // Promise itself rejected (unexpected) — record as failure
    const taskId = ready[batchSettled.indexOf(settled)]?.id;
    if (taskId) {
      results.set(taskId, {
        success: false,
        output: '',
        error: settled.reason?.message || 'Unknown execution error',
        iterations: 0,
      });
      completed.add(taskId);
    }
  }
}
```

Wait — the `batchSettled` array maps 1:1 with `ready` by index. So we can use the index. But actually the inner `try/catch` already converts errors to fulfilled results, so `rejected` status should be very rare. Still, let's handle it.

Better approach — iterate with index:

```typescript
for (let i = 0; i < batchSettled.length; i++) {
  const settled = batchSettled[i];
  if (settled.status === 'fulfilled') {
    const { taskId, result } = settled.value;
    results.set(taskId, result);
    completed.add(taskId);
  } else {
    // Promise itself rejected (should not happen due to inner catch, but be safe)
    const taskId = ready[i].id;
    results.set(taskId, {
      success: false,
      output: '',
      error: settled.reason?.message || 'Unknown execution error',
      iterations: 0,
    });
    completed.add(taskId);
  }
}
```

**Step 2: Fix worker cleanup — delete from map after task completes**

In `executeWithWorker` or wherever the worker finishes, add cleanup. Find the method that wraps task execution. Looking at the code, `submitTask` calls `this.getOrCreateWorker(task)` then calls `worker.execute(task)`. We should delete from the workers map after execution.

In `submitTask`, after the worker finishes (find the method body and add cleanup in a finally block):

```typescript
// After worker.execute completes, clean up the worker reference
this.workers.delete(workerId);
```

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/worker/WorkerPool.ts
git commit -m "fix: handle rejected tasks in WorkerPool, clean up workers after execution"
```

---

### Task 12: Fix tokenUsage Mutation by Reference

**Files:**
- Modify: `src/core/worker/RalphLoop.ts:625`

**Step 1: Fix the code**

At line 625, clone the tokenUsage object:

```typescript
let totalTokens = response.tokenUsage
  ? { ...response.tokenUsage }
  : { input: 0, output: 0, total: 0 };
```

**Step 2: Run tests**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/worker/RalphLoop.ts
git commit -m "fix: clone tokenUsage to prevent mutation of provider's internal state"
```

---

### Task 13: Fix SkillTracker Shared DEFAULT_DATA Mutation

**Files:**
- Modify: `src/skills/SkillTracker.ts:45-53, 86, 281-284`
- Test: `src/skills/SkillTracker.test.ts` (add test)

**Step 1: Write the failing test**

Add to existing test file:

```typescript
describe('SkillTracker DEFAULT_DATA isolation', () => {
  it('clearAll does not pollute subsequent instances', async () => {
    const tracker1 = new SkillTracker('/tmp/test-tracker-1.json');
    await tracker1.clearAll();
    tracker1.recordInvocation('test-skill', 'test query', true);

    const tracker2 = new SkillTracker('/tmp/test-tracker-2.json');
    // tracker2 should start fresh, not have tracker1's data
    const stats = tracker2.getAllStats();
    expect(stats).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/skills/SkillTracker.test.ts`
Expected: FAIL — tracker2 inherits tracker1's data via shared DEFAULT_DATA

**Step 3: Implement the fix**

Create a factory function for fresh defaults:

```typescript
function createDefaultData(): SkillTrackerData {
  return {
    version: '1.0.0',
    usage: [],
    unmatchedQueries: [],
    suggestedTriggers: {},
  };
}
```

Then replace all 3 usages:
- Line 53: `private data: SkillTrackerData = createDefaultData();`
- Line 86: `this.data = createDefaultData();`
- Line 282: `this.data = createDefaultData();`

Remove the `DEFAULT_DATA` constant.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/skills/SkillTracker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/skills/SkillTracker.ts src/skills/SkillTracker.test.ts
git commit -m "fix: SkillTracker uses factory function for default data, preventing shared mutation"
```

---

### Task 14: Fix Gemini/Ollama Tool Call ID Collisions

**Files:**
- Modify: `src/providers/GeminiProvider.ts:258`
- Modify: `src/providers/OllamaProvider.ts:120`

**Step 1: Fix the code**

In both files, replace `Date.now()` with a counter + random suffix.

In `GeminiProvider.ts`, add a counter at the top of `chatStream`:
```typescript
async *chatStream(...) {
  let toolCallIdx = 0;
  // ... existing code ...
  // At line 258, replace:
  // id: `call_${Date.now()}`
  // with:
  id: `call_${Date.now()}_${toolCallIdx++}`,
```

Same pattern in `OllamaProvider.ts` at line 120.

**Step 2: Run tests**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/providers/GeminiProvider.ts src/providers/OllamaProvider.ts
git commit -m "fix: unique tool call IDs in Gemini and Ollama streaming via counter suffix"
```

---

## Phase 4: LOW Priority Cleanup

### Task 15: Fix ESLint Config

**Files:**
- Create: `eslint.config.js`
- Delete: any `.eslintrc.*` if present

**Step 1: Check for existing config**

Run: `ls -la .eslintrc* eslint.config.* 2>/dev/null`

**Step 2: Create ESLint v9 flat config**

Create `eslint.config.js` that mirrors the project's existing rules. Keep it minimal — TypeScript + basic rules.

**Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (or only style warnings, no errors)

**Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "chore: migrate to ESLint v9 flat config"
```

---

### Task 16: Remove Dead Code (PreCheck, ToolMemory, StructuredFeedback)

**Files:**
- Delete: `src/core/worker/PreCheck.ts`
- Delete: `src/core/worker/ToolMemory.ts`
- Delete: `src/core/worker/StructuredFeedback.ts`
- Delete: corresponding test files if they exist
- Remove any imports/exports of these modules

**Step 1: Search for imports**

Run: `grep -r "PreCheck\|ToolMemory\|StructuredFeedback" src/ --include="*.ts" -l`

Remove any import lines found.

**Step 2: Delete files**

Delete the dead code files and their tests.

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove dead code — PreCheck, ToolMemory, StructuredFeedback (never wired in)"
```

---

### Task 17: Misc LOW Fixes

**Files:**
- Modify: `src/core/queen/AggregationHeuristic.ts:50` — remove unused `taskDescriptions`
- Modify: `src/core/queen/EscalationClassifier.ts:64-72` — remove dead `!result.success` guard

**Step 1: Remove unused variable in AggregationHeuristic**

Delete line 50: `const taskDescriptions = new Set(taskResults.map(t => t.description));`

**Step 2: Simplify dead guard in EscalationClassifier**

At lines 64-72, the `if (!result.success)` is always true. Remove the inner guard — just keep the body.

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/queen/AggregationHeuristic.ts src/core/queen/EscalationClassifier.ts
git commit -m "chore: remove dead code in AggregationHeuristic and EscalationClassifier"
```
