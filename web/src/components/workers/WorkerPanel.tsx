import { useState } from 'react';
import type { SerializedWorkerState, AgentPhase, LLMCallStats } from '../../lib/protocol';
import WorkerCard from './WorkerCard';

interface WorkerPanelProps {
  workers: SerializedWorkerState[];
  phase: AgentPhase;
  llmStats: LLMCallStats | null;
}

export default function WorkerPanel({ workers, phase, llmStats }: WorkerPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [allExpanded, setAllExpanded] = useState(false);

  if (workers.length === 0) return null;

  const activeCount = workers.filter(w => w.status === 'working' || w.status === 'verifying').length;
  const passCount = workers.filter(w => w.result?.success === true).length;
  const failResultCount = workers.filter(w => w.result?.success === false).length;

  return (
    <div
      className={`
        border-l border-border bg-surface-1/60 flex flex-col transition-all duration-300 animate-slide-in
        ${collapsed ? 'w-10' : 'w-96'}
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-amber">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="8" y1="21" x2="16" y2="21" strokeLinecap="round" />
              <line x1="12" y1="17" x2="12" y2="21" strokeLinecap="round" />
            </svg>
            <span className="text-xs font-mono font-medium text-text-secondary">Workers</span>
            <span className="text-[10px] font-mono text-text-muted">
              {activeCount > 0 && <span className="text-accent-amber">{activeCount} active</span>}
              {activeCount > 0 && (passCount > 0 || failResultCount > 0) && ' · '}
              {passCount > 0 && <span className="text-accent-green">{passCount}✓</span>}
              {passCount > 0 && failResultCount > 0 && ' '}
              {failResultCount > 0 && <span className="text-accent-red">{failResultCount}✗</span>}
              {activeCount === 0 && passCount === 0 && failResultCount === 0 && (
                <span>{workers.length}</span>
              )}
            </span>
          </div>
        )}

        <div className="flex items-center gap-0.5">
          {/* Expand all / collapse all toggle */}
          {!collapsed && workers.length > 1 && (
            <button
              onClick={() => setAllExpanded(!allExpanded)}
              title={allExpanded ? 'Collapse all' : 'Expand all'}
              className="p-1 rounded hover:bg-surface-2 text-text-muted hover:text-text-secondary transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                {allExpanded ? (
                  <>
                    <polyline points="7 13 12 8 17 13" strokeLinecap="round" strokeLinejoin="round" />
                    <polyline points="7 19 12 14 17 19" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                ) : (
                  <>
                    <polyline points="7 8 12 13 17 8" strokeLinecap="round" strokeLinejoin="round" />
                    <polyline points="7 14 12 19 17 14" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                )}
              </svg>
            </button>
          )}

          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1 rounded hover:bg-surface-2 text-text-muted hover:text-text-secondary transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
            >
              <polyline points="15 18 9 12 15 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Worker list */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
          {workers.map((worker) => (
            <WorkerCard
              key={worker.id}
              worker={worker}
              forceExpanded={allExpanded ? true : undefined}
            />
          ))}
        </div>
      )}

      {/* Summary footer */}
      {!collapsed && llmStats && llmStats.total > 0 && (
        <div className="px-3 py-2 border-t border-border">
          <div className="flex items-center justify-between text-[10px] font-mono text-text-muted">
            <span>
              LLM: <span className="text-text-secondary">{llmStats.total}</span>
            </span>
            <span>
              Tokens: <span className="text-accent-teal">{llmStats.totalTokens.total.toLocaleString()}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
