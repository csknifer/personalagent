/**
 * Ralph Loop utility functions — pure helpers with no LLM dependencies.
 */

/** Default per-API-call timeout (60 seconds) */
export const DEFAULT_CALL_TIMEOUT = 60_000;

/** Default per-tool-call timeout (0 = disabled; rely on worker-level timeout + AbortSignal) */
export const DEFAULT_TOOL_TIMEOUT = 0;

/**
 * Pass through tool result strings without truncation.
 * Modern LLMs have large context windows — truncating tool output
 * starves the model of data it needs to produce accurate results.
 */
export function truncateToolResult(result: string, _maxLength?: number): string {
  return result;
}

/**
 * Yield to the event loop so the UI can render pending state updates.
 * Without this, all synchronous progress updates before an await are
 * batched by React and may not render until after the long API call.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with a clear error if the promise doesn't resolve within
 * the given milliseconds, or if the abort signal fires.
 */
export function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  if (timeoutMs <= 0 && !signal) return promise;
  return new Promise<T>((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new Error('Task cancelled'));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error('Task cancelled'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/**
 * Classify a tool error string into a structured category.
 * Used to distinguish infrastructure failures (auth, quota) from transient issues.
 */
export function classifyToolError(error: string): import('../types.js').ToolErrorCategory {
  const lower = error.toLowerCase();
  if (/401|403|forbidden|unauthorized/.test(lower)) return 'auth';
  if (/429|rate.?limit|quota|exceeded/.test(lower)) return 'quota';
  if (/econnrefused|enotfound|dns|network|econnreset/.test(lower)) return 'network';
  if (/404|not.?found/.test(lower)) return 'not_found';
  if (/timed?\s*out|timeout|etimedout/.test(lower)) return 'timeout';
  return 'unknown';
}

/**
 * Compute similarity between two strings using word-trigram Jaccard index.
 * Returns 0.0 (completely different) to 1.0 (identical).
 */
export function computeStringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const trigrams = (s: string): Set<string> => {
    const words = s.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) return new Set(words);
    const set = new Set<string>();
    for (let i = 0; i <= words.length - 3; i++) {
      set.add(words.slice(i, i + 3).join(' '));
    }
    return set;
  };

  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Max findings extracted per iteration */
const MAX_FINDINGS_PER_ITERATION = 15;

/** Max character length for a single finding */
const MAX_FINDING_LENGTH = 500;

/**
 * Extract key findings from a worker's output.
 * Looks for a tagged ## KEY FINDINGS section with bullet points.
 * Returns an empty array if no section is found — all consumers
 * must handle the empty case gracefully.
 */
export function extractFindings(output: string): string[] {
  if (!output) return [];

  // Match the KEY FINDINGS section — everything from the header to the next ## heading or end of string
  const match = output.match(/## KEY FINDINGS\s*\n([\s\S]*?)(?=\n## |\n```|$)/i);
  if (!match) return [];

  const section = match[1];
  const findings = section
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(line => line.length > 0 && line.length <= MAX_FINDING_LENGTH);

  return findings.slice(0, MAX_FINDINGS_PER_ITERATION);
}

/** Max scratchpad entries per iteration */
const MAX_SCRATCHPAD_ENTRIES_PER_ITERATION = 10;

/** Max character length for a single scratchpad entry */
const MAX_SCRATCHPAD_ENTRY_LENGTH = 500;

/**
 * Extract scratchpad entries from a worker's output.
 * Looks for a ## SCRATCHPAD section with bullet points.
 * Scratchpad entries are reasoning state (hypotheses, dead ends, strategy notes)
 * as opposed to findings which are facts for the final output.
 */
export function extractScratchpad(output: string): string[] {
  if (!output) return [];

  const match = output.match(/## SCRATCHPAD\s*\n([\s\S]*?)(?=\n## |\n```|$)/i);
  if (!match) return [];

  const section = match[1];
  return section
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(line => line.length > 0 && line.length <= MAX_SCRATCHPAD_ENTRY_LENGTH)
    .slice(0, MAX_SCRATCHPAD_ENTRIES_PER_ITERATION);
}

/**
 * Extract retention markers from a worker's output.
 * Workers mark critical tool results for retention with: RETAIN: <identifier>
 */
export function extractRetentionMarkers(output: string): string[] {
  if (!output) return [];
  const matches = [...output.matchAll(/RETAIN:\s*(\S+)/gi)];
  return matches.map(m => m[1]);
}

/**
 * Extract worker signals from output.
 * Workers can emit signals: ## SIGNAL: <type>\n<payload>
 */
export function extractSignals(
  output: string,
  workerId: string,
  taskId: string,
): import('../types.js').WorkerSignal[] {
  if (!output) return [];

  const signals: import('../types.js').WorkerSignal[] = [];
  const signalPattern = /## SIGNAL:\s*(scope_change|discovery|blocked)\s*\n([\s\S]*?)(?=\n## |$)/gi;

  for (const match of output.matchAll(signalPattern)) {
    signals.push({
      workerId,
      taskId,
      type: match[1].toLowerCase() as 'scope_change' | 'discovery' | 'blocked',
      payload: match[2].trim().slice(0, 500),
      timestamp: new Date(),
    });
  }

  return signals;
}
