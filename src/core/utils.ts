/**
 * Core utility functions
 */

/**
 * Estimate token count from text using the ~4 chars/token heuristic.
 * Used when provider-reported token counts aren't available.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract a clean, human-readable error message from potentially nested
 * API error objects. Handles common patterns:
 * - Nested JSON strings in error.message
 * - { error: { message: "..." } } structures
 * - Plain string messages
 */
export function formatErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // Try to parse nested JSON error structures
  try {
    const parsed = JSON.parse(raw);
    const msg = extractNestedMessage(parsed);
    if (msg) return msg;
  } catch {
    // Not JSON — try to extract from stringified JSON embedded in the message
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const msg = extractNestedMessage(parsed);
        if (msg) return msg;
      } catch { /* not parseable */ }
    }
  }

  // Strip "Error: " prefix if already prepended upstream
  return raw.replace(/^Error:\s*/i, '') || 'An unknown error occurred';
}

function extractNestedMessage(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  // { error: { message: "..." } }
  if (o.error && typeof o.error === 'object') {
    const inner = o.error as Record<string, unknown>;
    if (typeof inner.message === 'string') {
      // The message itself might be a JSON string
      try {
        const deeper = JSON.parse(inner.message);
        const deepMsg = extractNestedMessage(deeper);
        if (deepMsg) return deepMsg;
      } catch { /* not nested further */ }
      return inner.message;
    }
  }

  // { message: "..." }
  if (typeof o.message === 'string') return o.message;

  return null;
}
