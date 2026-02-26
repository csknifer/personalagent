/**
 * Header component showing agent status and token usage
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TokenUsage } from '../../core/types.js';

interface LLMStats {
  total: number;
  totalTokens: TokenUsage;
}

interface HeaderProps {
  provider: string;
  model: string;
  llmStats?: LLMStats | null;
}

/**
 * Format a token count for display.
 * Uses compact notation: 1234 → "1.2k", 1234567 → "1.2M"
 */
function formatTokens(count: number): string {
  if (count === 0) return '0';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (count / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

/**
 * Get color based on token usage thresholds
 */
function getTokenColor(total: number): string {
  if (total === 0) return 'gray';
  if (total < 10_000) return 'green';
  if (total < 50_000) return 'yellow';
  if (total < 200_000) return 'rgb(255,165,0)'; // orange — fallback to yellow in terminals
  return 'red';
}

export const Header: React.FC<HeaderProps> = ({ provider, model, llmStats }) => {
  const hasStats = llmStats && llmStats.total > 0;
  const tokenColor = hasStats ? getTokenColor(llmStats.totalTokens.total) : 'gray';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>Personal Agent</Text>
          <Text color="gray"> | </Text>
          <Text color="green">{provider}</Text>
          <Text color="gray">/</Text>
          <Text color="yellow">{model}</Text>
        </Box>
        {hasStats && (
          <Box>
            <Text color="gray" dimColor>tokens: </Text>
            <Text color={tokenColor}>{formatTokens(llmStats.totalTokens.total)}</Text>
            <Text color="gray" dimColor> ({formatTokens(llmStats.totalTokens.input)} in / {formatTokens(llmStats.totalTokens.output)} out)</Text>
            <Text color="gray" dimColor> | calls: {llmStats.total}</Text>
          </Box>
        )}
      </Box>
      <Text color="gray" dimColor>
        Type /help for commands, /quit to exit
      </Text>
    </Box>
  );
};
