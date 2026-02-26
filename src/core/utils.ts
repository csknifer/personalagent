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
