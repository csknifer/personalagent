import { useState, useEffect, useRef } from 'react';
import type { SerializedWorkerState, SerializedToolCall, WorkerLogEntry } from '../../lib/protocol';
import ProgressRing from './ProgressRing';

interface WorkerCardProps {
  worker: SerializedWorkerState;
  forceExpanded?: boolean;
}

type Tab = 'overview' | 'tools' | 'activity';

export default function WorkerCard({ worker, forceExpanded }: WorkerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const isExpanded = forceExpanded ?? expanded;

  const percent = worker.maxIterations > 0
    ? (worker.iteration / worker.maxIterations) * 100
    : 0;

  const isActive = worker.status === 'working' || worker.status === 'verifying';

  return (
    <div
      className={`
        rounded-lg border transition-all duration-300 animate-slide-in
        ${isActive ? 'bg-surface-2/80 border-accent-amber/20' : ''}
        ${worker.status === 'completed' ? 'bg-surface-2/40 border-accent-green/15' : ''}
        ${worker.status === 'failed' ? 'bg-surface-2/40 border-accent-red/15' : ''}
        ${worker.status === 'idle' ? 'bg-surface-2/30 border-border' : ''}
      `}
    >
      {/* Main row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
      >
        {/* Status indicator */}
        <StatusIcon status={worker.status} />

        {/* Task description */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-text-primary truncate">
            {worker.currentTask?.description || 'Idle'}
          </p>
          {worker.currentAction && isActive && (
            <p className="text-[10px] font-mono text-text-muted truncate mt-0.5">
              {worker.currentAction}
            </p>
          )}
          {/* Inline result summary for completed/failed workers */}
          {!isActive && worker.result && (
            <p className={`text-[10px] font-mono truncate mt-0.5 ${
              worker.result.success ? 'text-accent-green/70' : 'text-accent-red/70'
            }`}>
              {worker.result.success ? '✓ ' : '✗ '}
              {worker.result.summary.split('\n')[0]}
            </p>
          )}
        </div>

        {/* Iteration badge + progress ring for active */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isActive && (
            <ProgressRing percent={percent} size={28} strokeWidth={2.5} />
          )}
          <span className="text-[10px] font-mono text-text-muted">
            {worker.iteration}/{worker.maxIterations}
          </span>
        </div>

        {/* Expand arrow */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-muted transition-transform duration-200 flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-border/50">
          {/* Tab bar */}
          <div className="flex px-3 pt-1.5 gap-0.5">
            <TabButton label="Overview" tab="overview" active={activeTab} onClick={setActiveTab} />
            <TabButton
              label="Tools"
              tab="tools"
              active={activeTab}
              onClick={setActiveTab}
              count={worker.toolHistory?.filter(t => t.status !== 'started').length}
            />
            <TabButton
              label="Activity"
              tab="activity"
              active={activeTab}
              onClick={setActiveTab}
              count={worker.activityLog?.length}
            />
          </div>

          {/* Tab content */}
          <div className="px-3 pb-2.5 pt-1.5">
            {activeTab === 'overview' && <OverviewTab worker={worker} />}
            {activeTab === 'tools' && <ToolsTab toolHistory={worker.toolHistory} />}
            {activeTab === 'activity' && <ActivityTab activityLog={worker.activityLog} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab Button ──────────────────────────────────────────────────

function TabButton({ label, tab, active, onClick, count }: {
  label: string;
  tab: Tab;
  active: Tab;
  onClick: (tab: Tab) => void;
  count?: number;
}) {
  const isActive = active === tab;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(tab); }}
      className={`
        text-[10px] font-mono px-2 py-1 rounded-t transition-colors
        ${isActive
          ? 'text-text-primary bg-surface-0/50 border-b-2 border-accent-teal'
          : 'text-text-muted hover:text-text-secondary hover:bg-surface-0/30'
        }
      `}
    >
      {label}
      {count != null && count > 0 && (
        <span className="ml-1 text-[9px] text-text-muted">{count}</span>
      )}
    </button>
  );
}

// ─── Status Icon ─────────────────────────────────────────────────

function StatusIcon({ status }: { status: SerializedWorkerState['status'] }) {
  return (
    <div className="flex-shrink-0">
      {status === 'working' && (
        <div className="w-5 h-5 border-2 border-accent-amber/40 border-t-accent-amber rounded-full animate-spin-slow" />
      )}
      {status === 'verifying' && (
        <div className="w-5 h-5 flex items-center justify-center text-accent-amber">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" strokeLinecap="round" />
            <line x1="12" y1="16" x2="12.01" y2="16" strokeLinecap="round" />
          </svg>
        </div>
      )}
      {status === 'completed' && (
        <div className="w-5 h-5 flex items-center justify-center text-accent-green">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
      {status === 'failed' && (
        <div className="w-5 h-5 flex items-center justify-center text-accent-red">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
            <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
          </svg>
        </div>
      )}
      {status === 'idle' && (
        <div className="w-5 h-5 flex items-center justify-center text-text-muted">
          <div className="w-2 h-2 rounded-full bg-text-muted/40" />
        </div>
      )}
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────

function OverviewTab({ worker }: { worker: SerializedWorkerState }) {
  const shortId = worker.id.length > 8 ? worker.id.slice(0, 8) : worker.id;

  return (
    <div className="space-y-2">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="id" value={shortId} />
        <Stat label="iter" value={`${worker.iteration}/${worker.maxIterations}`} />
        <Stat label="status" value={worker.status} />
        <Stat label="llm" value={String(worker.llmCalls)} />
        <Stat label="tools" value={String(worker.toolCalls)} />
        {worker.startedAt && (
          <ElapsedStat startedAt={worker.startedAt} status={worker.status} />
        )}
      </div>

      {/* Success criteria */}
      {worker.currentTask && (
        <div className="pt-2 border-t border-border/30">
          <p className="text-[10px] font-mono text-text-muted mb-0.5">success criteria</p>
          <p className="text-[11px] font-mono text-text-secondary">
            {worker.currentTask.successCriteria}
          </p>
        </div>
      )}

      {/* Result details */}
      {worker.result && (
        <div className="pt-2 border-t border-border/30">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <p className="text-[10px] font-mono text-text-muted">result</p>
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full ${
              worker.result.success
                ? 'bg-accent-green/10 text-accent-green'
                : 'bg-accent-red/10 text-accent-red'
            }`}>
              {worker.result.success ? 'PASS' : 'FAIL'}
            </span>
            {!worker.result.success && worker.result.exitReason && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-accent-amber/10 text-accent-amber uppercase tracking-wider">
                {worker.result.exitReason.replace(/_/g, ' ')}
              </span>
            )}
            {!worker.result.success && worker.result.bestScore != null && worker.result.bestScore > 0 && (
              <span className="text-[9px] font-mono text-text-muted">
                best: {Math.round(worker.result.bestScore * 100)}%
              </span>
            )}
          </div>
          <div className="max-h-60 overflow-y-auto">
            <p className="text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
              {worker.result.summary}
            </p>
          </div>
          {worker.result.error && !worker.result.success && (
            <p className="text-[10px] font-mono text-accent-red/80 mt-1">
              {worker.result.error}
            </p>
          )}
          {worker.result.toolsUsed && worker.result.toolsUsed.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {worker.result.toolsUsed.map((tool, i) => (
                <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-surface-0/80 text-text-muted border border-border/50">
                  {tool}
                </span>
              ))}
            </div>
          )}
          {worker.result.toolErrors && worker.result.toolErrors.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              <p className="text-[9px] font-mono text-accent-red/60 uppercase tracking-wider">tool errors</p>
              {worker.result.toolErrors.map((te, i) => (
                <p key={i} className="text-[10px] font-mono text-accent-red/70">
                  <span className="text-text-muted">{te.tool}:</span> {te.error}
                </p>
              ))}
            </div>
          )}
          {worker.result.bestOutput && !worker.result.success && (
            <div className="mt-1.5">
              <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider mb-0.5">partial output</p>
              <pre className="text-[10px] font-mono text-text-secondary/70 whitespace-pre-wrap break-words bg-surface-0/50 rounded p-1.5 max-h-48 overflow-y-auto border border-border/30">
                {worker.result.bestOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tools Tab ───────────────────────────────────────────────────

function ToolsTab({ toolHistory }: { toolHistory?: SerializedToolCall[] }) {
  if (!toolHistory || toolHistory.length === 0) {
    return (
      <p className="text-[10px] font-mono text-text-muted py-2">No tool calls yet.</p>
    );
  }

  // Filter out 'started' entries — show only completed/failed
  const completedCalls = toolHistory.filter(t => t.status !== 'started');

  if (completedCalls.length === 0) {
    return (
      <div className="py-2">
        <p className="text-[10px] font-mono text-accent-amber animate-pulse-soft">Tools executing...</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-h-72 overflow-y-auto">
      {completedCalls.map((tool, i) => (
        <ToolCallEntry key={i} tool={tool} />
      ))}
    </div>
  );
}

function ToolCallEntry({ tool }: { tool: SerializedToolCall }) {
  const [showArgs, setShowArgs] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const isFailed = tool.status === 'failed';

  return (
    <div className={`rounded border p-1.5 ${
      isFailed ? 'border-accent-red/20 bg-accent-red/5' : 'border-border/40 bg-surface-0/30'
    }`}>
      {/* Header row */}
      <div className="flex items-center gap-1.5">
        {/* Status dot */}
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          isFailed ? 'bg-accent-red' : 'bg-accent-green'
        }`} />
        {/* Tool name */}
        <span className="text-[10px] font-mono font-medium text-text-primary">
          {tool.toolName}
        </span>
        {/* Duration */}
        {tool.durationMs != null && (
          <span className="text-[9px] font-mono text-text-muted ml-auto">
            {tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {/* Error */}
      {isFailed && tool.error && (
        <p className="text-[9px] font-mono text-accent-red/80 mt-0.5 ml-3">
          {tool.error}
        </p>
      )}

      {/* Expandable arguments */}
      {tool.arguments && Object.keys(tool.arguments).length > 0 && (
        <div className="mt-1 ml-3">
          <button
            onClick={(e) => { e.stopPropagation(); setShowArgs(!showArgs); }}
            className="text-[9px] font-mono text-accent-teal/70 hover:text-accent-teal transition-colors"
          >
            {showArgs ? '▾ args' : '▸ args'}
          </button>
          {showArgs && (
            <pre className="text-[9px] font-mono text-text-secondary/70 bg-surface-0/50 rounded p-1 mt-0.5 max-h-32 overflow-auto border border-border/20">
              {JSON.stringify(tool.arguments, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Expandable result preview */}
      {tool.resultPreview && !isFailed && (
        <div className="mt-1 ml-3">
          <button
            onClick={(e) => { e.stopPropagation(); setShowResult(!showResult); }}
            className="text-[9px] font-mono text-accent-teal/70 hover:text-accent-teal transition-colors"
          >
            {showResult ? '▾ result' : '▸ result'}
          </button>
          {showResult && (
            <pre className="text-[9px] font-mono text-text-secondary/70 bg-surface-0/50 rounded p-1 mt-0.5 max-h-32 overflow-auto border border-border/20 whitespace-pre-wrap break-words">
              {tool.resultPreview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Activity Tab ────────────────────────────────────────────────

function ActivityTab({ activityLog }: { activityLog?: WorkerLogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activityLog?.length]);

  if (!activityLog || activityLog.length === 0) {
    return (
      <p className="text-[10px] font-mono text-text-muted py-2">No activity yet.</p>
    );
  }

  return (
    <div ref={scrollRef} className="space-y-0.5 max-h-72 overflow-y-auto">
      {activityLog.map((entry, i) => (
        <ActivityEntry key={i} entry={entry} />
      ))}
    </div>
  );
}

function ActivityEntry({ entry }: { entry: WorkerLogEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const colorClass = {
    iteration_start: 'text-accent-amber',
    tool_call: 'text-accent-blue',
    tool_result: 'text-accent-teal',
    verification: 'text-accent-amber',
    feedback: 'text-accent-red/70',
    status: 'text-text-muted',
  }[entry.type] || 'text-text-muted';

  const icon = {
    iteration_start: '◆',
    tool_call: '→',
    tool_result: '←',
    verification: '◎',
    feedback: '✗',
    status: '·',
  }[entry.type] || '·';

  return (
    <div className="flex gap-1.5 items-start">
      <span className="text-[8px] font-mono text-text-muted/60 flex-shrink-0 mt-0.5 w-14 text-right">
        {time}
      </span>
      <span className={`text-[10px] flex-shrink-0 ${colorClass}`}>{icon}</span>
      <p className={`text-[10px] font-mono ${colorClass} leading-snug break-words min-w-0`}>
        {entry.content}
      </p>
    </div>
  );
}

// ─── Shared Components ───────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-[11px] font-mono text-text-secondary">{value}</p>
    </div>
  );
}

function ElapsedStat({ startedAt, status }: { startedAt: string; status: string }) {
  const [elapsed, setElapsed] = useState('');
  const isActive = status === 'working' || status === 'verifying';

  useEffect(() => {
    const start = new Date(startedAt).getTime();

    const update = () => {
      const diff = Date.now() - start;
      const secs = Math.floor(diff / 1000);
      if (secs < 60) {
        setElapsed(`${secs}s`);
      } else {
        const mins = Math.floor(secs / 60);
        const remainSecs = secs % 60;
        setElapsed(`${mins}m ${remainSecs}s`);
      }
    };

    update();

    if (isActive) {
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    }
  }, [startedAt, isActive]);

  return (
    <div>
      <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">elapsed</p>
      <p className="text-[11px] font-mono text-text-secondary">{elapsed}</p>
    </div>
  );
}
