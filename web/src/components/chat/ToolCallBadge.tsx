interface ToolCallBadgeProps {
  name: string;
  active?: boolean;
}

export default function ToolCallBadge({ name, active = true }: ToolCallBadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-mono
        border transition-all duration-300
        ${active
          ? 'bg-accent-amber/10 border-accent-amber/30 text-accent-amber animate-pulse-soft'
          : 'bg-surface-2 border-border text-text-muted'
        }
      `}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      {name}
    </span>
  );
}
