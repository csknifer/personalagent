/**
 * Chat input component with text input and command handling
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface ChatInputProps {
  onSubmit: (message: string) => void;
  onCommand: (command: string, args: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSubmit,
  onCommand,
  disabled = false,
  placeholder = 'Type a message...',
}) => {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [history, setHistory] = useState<string[]>([]);

  const handleSubmit = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Add to history
    setHistory(prev => [...prev.slice(-99), trimmed]);
    setHistoryIndex(-1);
    setValue('');

    // Check if it's a command
    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      onCommand(command, args);
    } else {
      onSubmit(trimmed);
    }
  }, [onSubmit, onCommand]);

  // Handle up/down arrows for history
  useInput((input, key) => {
    if (disabled) return;

    if (key.upArrow && history.length > 0) {
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setValue(history[newIndex] || '');
    } else if (key.downArrow && historyIndex !== -1) {
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setValue('');
      } else {
        setHistoryIndex(newIndex);
        setValue(history[newIndex] || '');
      }
    }
  });

  if (disabled) {
    return (
      <Box>
        <Text color="gray">{'> '}</Text>
        <Text color="gray" dimColor>Waiting for response...</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="green" bold>{'> '}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
};
