import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { SerializedMessage } from '../../lib/protocol';

interface MessageBubbleProps {
  message: SerializedMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="max-w-[70%] space-y-1">
          <div className="bg-accent-blue/15 border border-accent-blue/20 rounded-lg px-4 py-2.5">
            <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
              {message.content}
            </p>
          </div>
          <p className="text-[10px] font-mono text-text-muted text-right pr-1">
            {time}
          </p>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex justify-start animate-fade-in-up">
      <div className="max-w-[80%] space-y-1">
        <div className="bg-surface-2/60 border border-border rounded-lg px-4 py-3">
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
                ul: ({ children }) => (
                  <ul className="list-disc list-inside text-text-primary mb-2 space-y-0.5">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal list-inside text-text-primary mb-2 space-y-0.5">{children}</ol>
                ),
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-teal hover:text-accent-teal/80 underline underline-offset-2">
                    {children}
                  </a>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2">
                    <table className="w-full text-sm border-collapse border border-border">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border border-border bg-surface-3/30 px-3 py-1.5 text-left font-mono text-xs text-text-secondary">{children}</th>
                ),
                td: ({ children }) => (
                  <td className="border border-border px-3 py-1.5">{children}</td>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-accent-teal/40 pl-3 my-2 text-text-secondary italic">{children}</blockquote>
                ),
                h1: ({ children }) => <h1 className="text-lg font-semibold text-text-primary mt-3 mb-1.5">{children}</h1>,
                h2: ({ children }) => <h2 className="text-base font-semibold text-text-primary mt-3 mb-1.5">{children}</h2>,
                h3: ({ children }) => <h3 className="text-sm font-semibold text-text-primary mt-2 mb-1">{children}</h3>,
                hr: () => <hr className="border-border my-3" />,
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        </div>
        <div className="flex items-center gap-2 pl-1">
          <p className="text-[10px] font-mono text-text-muted">{time}</p>
          {message.metadata?.model && (
            <span className="text-[10px] font-mono text-accent-teal/60">
              {message.metadata.provider}/{message.metadata.model}
            </span>
          )}
          {message.metadata?.skill && (
            <span className="text-[10px] font-mono text-accent-amber/60">
              skill:{message.metadata.skill}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
