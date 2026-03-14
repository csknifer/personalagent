/**
 * Format a compact per-request summary line with cost estimation.
 */

import type { TokenUsage } from '../types.js';
import { CostRegistry } from '../cost/CostRegistry.js';

export interface RequestSummaryInput {
  calls: number;
  tokens: TokenUsage;
  durationMs: number;
  provider: string;
  model: string;
}

const registry = new CostRegistry();

function formatTokens(count: number): string {
  if (count === 0) return '0';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (count / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = Math.round(seconds % 60);
  return `${minutes}m ${remainingSec}s`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '';
  if (usd < 0.01) return `~$${(usd * 100).toFixed(1)}\u00A2`; // cents with ¢
  if (usd < 1) return `~$${usd.toFixed(2)}`;
  return `~$${usd.toFixed(2)}`;
}

/**
 * Format a one-line request summary.
 * Example: "3 calls · 12.4k tokens · ~$0.04 · 2.1s"
 */
export function formatRequestSummary(input: RequestSummaryInput): string {
  const parts: string[] = [];

  parts.push(`${input.calls} call${input.calls !== 1 ? 's' : ''}`);
  parts.push(`${formatTokens(input.tokens.total)} tokens`);

  const cost = registry.calculateCost(input.provider, input.model, input.tokens);
  const costStr = formatCost(cost);
  if (costStr) parts.push(costStr);

  parts.push(formatDuration(input.durationMs));

  return parts.join(' \u00B7 '); // middle dot separator
}
