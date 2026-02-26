import type { LLMCallStats } from '../../lib/protocol';
import type { QueenConfig } from '../../hooks/useQueenSocket';

interface HeaderProps {
  config: QueenConfig | null;
  connected: boolean;
  llmStats: LLMCallStats | null;
}

export default function Header({ config, connected, llmStats }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface-1/80 backdrop-blur-sm">
      {/* Left: Brand */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" className="text-accent-teal">
            <path
              d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-mono font-semibold text-sm tracking-tight text-text-primary">
            Personal Agent
          </span>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-1.5 ml-2">
          <div
            className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
              connected ? 'bg-accent-green' : 'bg-accent-red'
            }`}
          />
          <span className="text-xs text-text-muted font-mono">
            {connected ? 'connected' : 'disconnected'}
          </span>
        </div>
      </div>

      {/* Center: Provider info — hidden on small screens, truncated on medium */}
      {config && (
        <div className="hidden sm:flex items-center gap-4 text-xs font-mono text-text-muted min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-text-secondary shrink-0">queen</span>
            <span className="text-accent-teal truncate max-w-[200px]" title={`${config.provider}/${config.model}`}>
              {config.provider}/{config.model}
            </span>
          </div>
          <div className="w-px h-3 bg-border shrink-0" />
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-text-secondary shrink-0">workers</span>
            <span className="text-accent-amber truncate max-w-[200px]" title={`${config.workerProvider}/${config.workerModel}`}>
              {config.workerProvider}/{config.workerModel}
            </span>
          </div>
        </div>
      )}

      {/* Right: Stats */}
      <div className="flex items-center gap-4 text-xs font-mono text-text-muted">
        {llmStats && llmStats.total > 0 && (
          <>
            <div className="flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted">
                <path d="M12 20V10M18 20V4M6 20v-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{llmStats.total} calls</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-accent-teal">{formatTokens(llmStats.totalTokens.total)}</span>
              <span>tokens</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
