import type { LLMCallStats, SerializedWorkerState } from '../../lib/protocol';

interface StatsBarProps {
  llmStats: LLMCallStats | null;
  workers: SerializedWorkerState[];
}

/** Rough cost estimate from token counts. Uses Gemini Flash defaults — close enough for a UI indicator. */
function estimateCost(stats: LLMCallStats): string {
  // Default to Gemini 2.5 Flash pricing (most common); accurate enough for a UI hint
  const inputPer1M = 0.15;
  const outputPer1M = 0.60;
  const cost = (stats.totalTokens.input / 1_000_000) * inputPer1M
             + (stats.totalTokens.output / 1_000_000) * outputPer1M;
  if (cost === 0) return '';
  if (cost < 0.01) return `<$0.01`;
  return `~$${cost.toFixed(2)}`;
}

export default function StatsBar({ llmStats, workers }: StatsBarProps) {
  const activeWorkers = workers.filter(w => w.status === 'working' || w.status === 'verifying').length;
  const completedWorkers = workers.filter(w => w.status === 'completed').length;
  const hasActivity = (llmStats && llmStats.total > 0) || workers.length > 0;

  if (!hasActivity) return null;

  const costStr = llmStats ? estimateCost(llmStats) : '';

  return (
    <div className="flex items-center gap-4 px-5 py-1.5 border-t border-border bg-surface-1/60 text-[11px] font-mono text-text-muted">
      {llmStats && llmStats.total > 0 && (
        <>
          <span>
            LLM <span className="text-text-secondary">{llmStats.total}</span> calls
          </span>
          <span className="text-border">|</span>
          <span>
            <span className="text-accent-teal">{llmStats.totalTokens.input.toLocaleString()}</span> in
            {' / '}
            <span className="text-accent-teal">{llmStats.totalTokens.output.toLocaleString()}</span> out
          </span>
          {costStr && (
            <>
              <span className="text-border">|</span>
              <span className="text-accent-amber">{costStr}</span>
            </>
          )}
        </>
      )}
      {workers.length > 0 && (
        <>
          <span className="text-border">|</span>
          <span>
            Workers{' '}
            {activeWorkers > 0 && <span className="text-accent-amber">{activeWorkers} active</span>}
            {activeWorkers > 0 && completedWorkers > 0 && ' / '}
            {completedWorkers > 0 && <span className="text-accent-green">{completedWorkers} done</span>}
          </span>
        </>
      )}
    </div>
  );
}
