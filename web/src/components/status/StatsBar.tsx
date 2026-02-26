import type { LLMCallStats, SerializedWorkerState } from '../../lib/protocol';

interface StatsBarProps {
  llmStats: LLMCallStats | null;
  workers: SerializedWorkerState[];
}

export default function StatsBar({ llmStats, workers }: StatsBarProps) {
  const activeWorkers = workers.filter(w => w.status === 'working' || w.status === 'verifying').length;
  const completedWorkers = workers.filter(w => w.status === 'completed').length;
  const hasActivity = (llmStats && llmStats.total > 0) || workers.length > 0;

  if (!hasActivity) return null;

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
