/**
 * Renders markdown as ANSI-formatted terminal output
 */

import React from 'react';
import { Text } from 'ink';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked with terminal renderer (once)
marked.use(markedTerminal({ reflowText: true, tab: 2 }));

interface MarkdownTextProps {
  children: string;
}

export const MarkdownText: React.FC<MarkdownTextProps> = ({ children }) => {
  const rendered = marked.parse(children) as string;
  // Trim trailing newlines that marked adds
  return <Text>{rendered.trimEnd()}</Text>;
};
