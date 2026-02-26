/**
 * Message list component for displaying chat history
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../../core/types.js';
import { MarkdownText } from './MarkdownText.js';

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
}

export const MessageList: React.FC<MessageListProps> = ({ messages, streamingContent }) => {
  return (
    <Box flexDirection="column" gap={1}>
      {messages.map((message, index) => (
        <MessageItem key={index} message={message} />
      ))}
      {streamingContent && (
        <Box flexDirection="column">
          <Text color="magenta" bold>Assistant:</Text>
          <Box marginLeft={2}>
            <MarkdownText>{streamingContent}</MarkdownText>
            <Text color="cyan">▌</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

interface MessageItemProps {
  message: Message;
}

const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const getRoleColor = (role: Message['role']) => {
    switch (role) {
      case 'user':
        return 'blue';
      case 'assistant':
        return 'magenta';
      case 'system':
        return 'yellow';
      default:
        return 'white';
    }
  };

  const getRoleLabel = (role: Message['role']) => {
    switch (role) {
      case 'user':
        return 'You';
      case 'assistant':
        return 'Assistant';
      case 'system':
        return 'System';
      default:
        return role;
    }
  };

  // Don't display system messages in the UI
  if (message.role === 'system') {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Text color={getRoleColor(message.role)} bold>
        {getRoleLabel(message.role)}:
      </Text>
      <Box marginLeft={2}>
        {message.role === 'assistant' ? (
          <MarkdownText>{message.content}</MarkdownText>
        ) : (
          <Text wrap="wrap">{message.content}</Text>
        )}
      </Box>
    </Box>
  );
};
