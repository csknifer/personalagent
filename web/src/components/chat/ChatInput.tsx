import { useState, useRef, useCallback, useEffect } from 'react';

interface ChatInputProps {
  onSend: (content: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

export default function ChatInput({ onSend, onClear, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24; // ~6 lines
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled) return;
    onSend(value.trim());
    setValue('');
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Re-focus when not disabled
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  return (
    <div className="px-5 py-3 border-t border-border bg-surface-1/80 backdrop-blur-sm">
      <div className="flex items-end gap-2 max-w-4xl mx-auto">
        {/* Clear button */}
        <button
          onClick={onClear}
          className="
            flex-shrink-0 p-2 rounded-md text-text-muted
            hover:text-text-secondary hover:bg-surface-2 transition-colors
          "
          title="Clear conversation"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>

        {/* Input area */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={disabled ? 'Processing...' : 'Send a message...'}
            rows={1}
            className="
              w-full resize-none bg-surface-2 border border-border rounded-lg
              px-4 py-2.5 text-sm text-text-primary placeholder-text-muted
              font-sans leading-6
              focus:outline-none focus:border-accent-teal/40 focus:ring-1 focus:ring-accent-teal/20
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors
            "
          />
        </div>

        {/* Send button */}
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="
            flex-shrink-0 p-2.5 rounded-lg transition-all
            bg-accent-teal/15 text-accent-teal border border-accent-teal/20
            hover:bg-accent-teal/25 hover:border-accent-teal/40
            disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-accent-teal/15
          "
          title="Send (Enter)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      <p className="text-[10px] text-text-muted font-mono text-center mt-1.5">
        <kbd className="px-1 py-0.5 rounded bg-surface-2 border border-border text-[10px]">Enter</kbd> send
        {' '}<span className="text-border">|</span>{' '}
        <kbd className="px-1 py-0.5 rounded bg-surface-2 border border-border text-[10px]">Shift+Enter</kbd> newline
      </p>
    </div>
  );
}
