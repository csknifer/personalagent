import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import ToolCallBadge from './ToolCallBadge';

interface StreamingMessageProps {
  streamingContent: string;
  toolCalls: Array<{ name: string; id: string }>;
}

export default function StreamingMessage({ streamingContent, toolCalls }: StreamingMessageProps) {
  if (!streamingContent && toolCalls.length === 0) return null;

  return (
    <div className="flex justify-start animate-fade-in-up">
      <div className="max-w-[80%] space-y-1">
        <div className="bg-surface-2/60 border border-accent-teal/15 rounded-lg px-4 py-3">
          {/* Tool call badges */}
          {toolCalls.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {toolCalls.map((tc) => (
                <ToolCallBadge key={tc.id} name={tc.name} active />
              ))}
            </div>
          )}

          {/* Streaming content */}
          {streamingContent && (
            <div className="prose-agent text-sm leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre: ({ children }) => (
                    <pre className="bg-surface-0 border border-border rounded-md p-3 my-2 overflow-x-auto text-[13px] font-mono">
                      {children}
                    </pre>
                  ),
                  code: ({ className, children, ...props }) => {
                    const isInline = !className;
                    if (isInline) {
                      return (
                        <code className="bg-surface-3/50 text-accent-teal px-1.5 py-0.5 rounded text-[13px] font-mono" {...props}>
                          {children}
                        </code>
                      );
                    }
                    return <code className={className} {...props}>{children}</code>;
                  },
                  p: ({ children }) => (
                    <p className="text-text-primary mb-2 last:mb-0">{children}</p>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-teal hover:text-accent-teal/80 underline underline-offset-2">
                      {children}
                    </a>
                  ),
                }}
              >
                {streamingContent}
              </ReactMarkdown>
            </div>
          )}

          {/* Blinking cursor */}
          <span className="inline-block w-2 h-4 bg-accent-teal ml-0.5 -mb-0.5 animate-blink rounded-sm" />
        </div>
      </div>
    </div>
  );
}
