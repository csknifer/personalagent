import { useRef, useEffect } from 'react';
import type { SerializedMessage } from '../../lib/protocol';
import MessageBubble from './MessageBubble';
import StreamingMessage from './StreamingMessage';
import ChatInput from './ChatInput';

interface ChatPanelProps {
  messages: SerializedMessage[];
  streamingContent: string;
  streamingToolCalls: Array<{ name: string; id: string }>;
  isProcessing: boolean;
  onSend: (content: string) => void;
  onClear: () => void;
}

export default function ChatPanel({
  messages,
  streamingContent,
  streamingToolCalls,
  isProcessing,
  onSend,
  onClear,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages or streaming content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingContent]);

  const hasMessages = messages.length > 0 || streamingContent;

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {!hasMessages ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="space-y-3 max-w-md">
              <div className="w-12 h-12 mx-auto rounded-xl bg-surface-2 border border-border flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" className="text-accent-teal/60">
                  <path
                    d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h2 className="text-sm font-medium text-text-secondary">
                Personal Agent
              </h2>
              <p className="text-xs text-text-muted leading-relaxed">
                Multi-agent system with hive architecture. Send a message to start a conversation.
                Complex tasks will be decomposed and executed by worker agents.
              </p>
            </div>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4 max-w-4xl mx-auto">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}

            {/* Streaming response */}
            {(streamingContent || streamingToolCalls.length > 0) && (
              <StreamingMessage
                streamingContent={streamingContent}
                toolCalls={streamingToolCalls}
              />
            )}

            {/* Processing indicator without content yet */}
            {isProcessing && !streamingContent && streamingToolCalls.length === 0 && (
              <div className="flex justify-start animate-fade-in-up">
                <div className="bg-surface-2/60 border border-border rounded-lg px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-accent-teal animate-pulse-soft" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-accent-teal animate-pulse-soft" style={{ animationDelay: '200ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-accent-teal animate-pulse-soft" style={{ animationDelay: '400ms' }} />
                    </div>
                    <span className="text-xs font-mono text-text-muted">thinking</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <ChatInput onSend={onSend} onClear={onClear} disabled={isProcessing} />
    </div>
  );
}
